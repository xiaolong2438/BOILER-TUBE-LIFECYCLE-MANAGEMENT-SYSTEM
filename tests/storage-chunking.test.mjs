import test from 'node:test';
import assert from 'node:assert/strict';
import { D1 } from './fixtures/temperature/d1-adapter.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onRequestGet, onRequestPut, onRequestDelete } from '../functions/api/storage/[key].js';

const schema = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8');

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'bt-storage-'));
  const db = new D1(join(directory, 'isolated.sqlite'));
  db.sql.exec(schema);
  t.after(() => { db.sql.close(); rmSync(directory, { recursive: true, force: true }); });
  return { db };
}

async function call(db, handler, method, key, body, query = '') {
  const request = new Request('https://synthetic.example/api/storage/' + encodeURIComponent(key) + query, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  });
  const response = await handler({ env: { DB: db }, request, params: { key } });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function countRows(db, pattern) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM app_kv WHERE key LIKE ?").bind(pattern).first();
  return row.n;
}

async function mainRow(db, key) {
  return db.prepare('SELECT value, updated_at FROM app_kv WHERE key = ?').bind(key).first();
}

test('小值直接单行存储并可回读', async (t) => {
  const { db } = fixture(t);
  const value = { items: ['甲', '乙'], count: 2 };
  const put = await call(db, onRequestPut, 'PUT', 'small_key', { value, baseUpdatedAt: null });
  assert.equal(put.status, 200);
  assert.equal(put.body.ok, true);
  assert.equal(put.body.key, 'small_key');
  assert.equal(typeof put.body.updatedAt, 'string');

  const get = await call(db, onRequestGet, 'GET', 'small_key');
  assert.equal(get.status, 200);
  assert.equal(get.body.found, true);
  assert.deepEqual(get.body.value, value);
  assert.equal(get.body.updatedAt, put.body.updatedAt);
  assert.equal(await countRows(db, 'small_key%'), 1, '不应产生分块行');
});

test('大值自动分块存储，GET 透明拼回且内容逐字节一致', async (t) => {
  const { db } = fixture(t);
  /* 混入多字节中文与 ASCII base64，覆盖 UTF-8 边界切分 */
  const value = {
    drawings: [
      { id: 'dw1', name: '高温过热器材料分界图', data: 'data:image/png;base64,' + 'Q'.repeat(60000) },
      { id: 'dw2', name: '省煤器总图'.repeat(9000), data: 'data:application/pdf;base64,' + 'Z'.repeat(30000) }
    ]
  };
  const put = await call(db, onRequestPut, 'PUT', 'boiler_design_drawings', { value, baseUpdatedAt: null });
  assert.equal(put.status, 200);
  assert.equal(put.body.chunked, true, '超过阈值应走分块');
  assert.ok(put.body.parts >= 3, '应切成多块，实际 parts=' + put.body.parts);

  const meta = JSON.parse((await mainRow(db, 'boiler_design_drawings')).value);
  assert.equal(meta.__chunked, true);
  assert.equal(meta.parts, put.body.parts);
  assert.match(meta.gen, /^[a-f0-9]{8,32}$/, '主行必须记录分块代次');

  const get = await call(db, onRequestGet, 'GET', 'boiler_design_drawings');
  assert.equal(get.status, 200);
  assert.deepEqual(get.body.value, value, '拼回后的值必须与原值完全一致');

  const chunkRows = await countRows(db, 'boiler\_design\_drawings#%');
  assert.equal(chunkRows, put.body.parts, '分块行数应与 parts 一致');
});

test('分块键被大值覆盖后再写小值时清理旧代次分块', async (t) => {
  const { db } = fixture(t);
  const bigValue = { data: '图'.repeat(30000) }; /* 90KB UTF-8 */
  const first = await call(db, onRequestPut, 'PUT', 'mixed_key', { value: bigValue, baseUpdatedAt: null });
  assert.equal(first.status, 200);
  assert.ok(await countRows(db, 'mixed\_key#%') >= 2, '先制造分块行');

  const put = await call(db, onRequestPut, 'PUT', 'mixed_key', {
    value: { data: '小' },
    baseUpdatedAt: first.body.updatedAt
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.chunked, undefined, '小值不再分块');
  assert.equal(await countRows(db, 'mixed\_key#%'), 0, '旧代次分块应被清理');
  assert.equal(await countRows(db, 'mixed_key%'), 1);

  const get = await call(db, onRequestGet, 'GET', 'mixed_key');
  assert.deepEqual(get.body.value, { data: '小' });
});

test('删除分块键时主行与分块行一并清理', async (t) => {
  const { db } = fixture(t);
  await call(db, onRequestPut, 'PUT', ' doomed ', { value: { data: '块'.repeat(20000) }, baseUpdatedAt: null });
  assert.ok(await countRows(db, 'doomed#%') >= 2);

  const del = await call(db, onRequestDelete, 'DELETE', 'doomed');
  assert.equal(del.status, 200);
  assert.equal(await countRows(db, 'doomed%'), 0, '删除后不应残留任何行');

  const get = await call(db, onRequestGet, 'GET', 'doomed');
  assert.equal(get.status, 404);
  assert.equal(get.body.found, false);
});

test('缺失的分块返回 500 而非拼出错值', async (t) => {
  const { db } = fixture(t);
  const put = await call(db, onRequestPut, 'PUT', 'broken_key', { value: { data: '残'.repeat(20000) }, baseUpdatedAt: null });
  assert.equal(put.status, 200);
  const meta = JSON.parse((await mainRow(db, 'broken_key')).value);
  await db.prepare('DELETE FROM app_kv WHERE key = ?').bind(`broken_key#v${meta.gen}#p001`).run();

  const get = await call(db, onRequestGet, 'GET', 'broken_key');
  assert.equal(get.status, 500);
  assert.match(get.body.error, /incomplete/);
});

test('非法键被拒绝（含 # 的键保留给分块命名空间）', async (t) => {
  const { db } = fixture(t);
  const put = await call(db, onRequestPut, 'PUT', 'evil#p000', { value: { a: 1 }, baseUpdatedAt: null });
  assert.equal(put.status, 400);
  const get = await call(db, onRequestGet, 'GET', 'bad key!');
  assert.equal(get.status, 400);
});

test('分块行读写使用主键范围而非 LIKE（避免全表扫描 app_kv）', () => {
  const source = readFileSync(new URL('../functions/api/storage/[key].js', import.meta.url), 'utf8');
  assert.match(source, /SELECT key, value FROM app_kv WHERE key >= \? AND key < \? ORDER BY key/);
  assert.match(source, /DELETE FROM app_kv WHERE key >= \? AND key < \?/);
  assert.doesNotMatch(source, /LIKE \? ESCAPE/, '分块 SQL 不得再使用无法命中主键索引的 LIKE');
});

test('图纸内容 GET 允许浏览器缓存，元数据仍不缓存', async (t) => {
  const { db } = fixture(t);
  await call(db, onRequestPut, 'PUT', 'boiler_drawing_content:demo', { value: 'data:image/png;base64,' + 'A'.repeat(60000) });
  const content = await call(db, onRequestGet, 'GET', 'boiler_drawing_content:demo');
  assert.equal(content.status, 200);
  assert.equal(content.headers.get('Cache-Control'), 'private, max-age=86400');
  const meta = await call(db, onRequestPut, 'PUT', 'boiler_design_drawings_meta', { value: [{ id: 'a' }] });
  assert.equal(meta.status, 200);
  const metaGet = await call(db, onRequestGet, 'GET', 'boiler_design_drawings_meta');
  assert.equal(metaGet.headers.get('Cache-Control'), null, '元数据键不得被浏览器缓存');

  await call(db, onRequestPut, 'PUT', 'boiler_drawing_thumb:demo', { value: 'data:image/jpeg;base64,' + 'B'.repeat(40000) });
  const thumb = await call(db, onRequestGet, 'GET', 'boiler_drawing_thumb:demo');
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get('Cache-Control'), 'private, max-age=604800', '缩略图缓存更久（列表频繁读取且体积小）');
});

test('probe=1 只返回存在性与版本，不返回内容', async (t) => {
  const { db } = fixture(t);
  await call(db, onRequestPut, 'PUT', 'probe_key', { value: { data: 'x'.repeat(60000) }, baseUpdatedAt: null });

  const probe = await call(db, onRequestGet, 'GET', 'probe_key', undefined, '?probe=1');
  assert.equal(probe.status, 200);
  assert.equal(probe.body.found, true);
  assert.equal(probe.body.value, undefined, '探测不得回传内容');
  assert.equal(probe.headers.get('Cache-Control'), 'no-store');

  const missing = await call(db, onRequestGet, 'GET', 'probe_missing', undefined, '?probe=1');
  assert.equal(missing.status, 404);
});

test('baseUpdatedAt 并发冲突返回 409，且旧值保持不变', async (t) => {
  const { db } = fixture(t);
  const created = await call(db, onRequestPut, 'PUT', 'conflict_key', { value: { v: 1 }, baseUpdatedAt: null });
  assert.equal(created.status, 200);

  const stale = await call(db, onRequestPut, 'PUT', 'conflict_key', {
    value: { v: 2 },
    baseUpdatedAt: '2000-01-01 00:00:00'
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'conflict');
  assert.equal(stale.body.updatedAt, created.body.updatedAt);
  assert.deepEqual((await call(db, onRequestGet, 'GET', 'conflict_key')).body.value, { v: 1 });

  const updated = await call(db, onRequestPut, 'PUT', 'conflict_key', {
    value: { v: 2 },
    baseUpdatedAt: created.body.updatedAt
  });
  assert.equal(updated.status, 200);
  assert.deepEqual((await call(db, onRequestGet, 'GET', 'conflict_key')).body.value, { v: 2 });
});

test('分块写入中途失败不会破坏上一次已提交的值', async (t) => {
  const { db } = fixture(t);
  const initial = await call(db, onRequestPut, 'PUT', 'atomic_key', { value: { data: 'old' }, baseUpdatedAt: null });
  assert.equal(initial.status, 200);

  const originalBatch = db.batch.bind(db);
  let batchCalls = 0;
  db.batch = async (statements) => {
    batchCalls += 1;
    if (batchCalls === 2) throw new Error('synthetic batch failure');
    return originalBatch(statements);
  };
  const failed = await call(db, onRequestPut, 'PUT', 'atomic_key', {
    value: { data: 'x'.repeat(1000000) }, /* ~1MB，至少两批 */
    baseUpdatedAt: initial.body.updatedAt
  });
  db.batch = originalBatch;
  assert.equal(failed.status, 500);
  assert.deepEqual((await call(db, onRequestGet, 'GET', 'atomic_key')).body.value, { data: 'old' }, '旧值必须仍可读');
  assert.equal(await countRows(db, 'atomic\_key#%'), 0, '失败的新代次分块应被清理');

  const retried = await call(db, onRequestPut, 'PUT', 'atomic_key', {
    value: { data: 'x'.repeat(1000000) },
    baseUpdatedAt: initial.body.updatedAt
  });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal((await call(db, onRequestGet, 'GET', 'atomic_key')).body.value.data.length, 1000000);
});

test('旧格式 key#pNNN 分块仍可读取，并在下次写入时清理', async (t) => {
  const { db } = fixture(t);
  const serialized = JSON.stringify({ legacy: '旧格式' });
  await db.prepare('INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?)')
    .bind('legacy_key', JSON.stringify({ __chunked: true, parts: 2, size: serialized.length }), '2026-01-01 00:00:00')
    .run();
  const half = Math.ceil(serialized.length / 2);
  await db.prepare('INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
    .bind('legacy_key#p000', JSON.stringify(serialized.slice(0, half))).run();
  await db.prepare('INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
    .bind('legacy_key#p001', JSON.stringify(serialized.slice(half))).run();

  const get = await call(db, onRequestGet, 'GET', 'legacy_key');
  assert.equal(get.status, 200);
  assert.deepEqual(get.body.value, { legacy: '旧格式' });

  const put = await call(db, onRequestPut, 'PUT', 'legacy_key', {
    value: { replaced: true },
    baseUpdatedAt: '2026-01-01 00:00:00'
  });
  assert.equal(put.status, 200);
  assert.equal(await countRows(db, 'legacy\_key#%'), 0, '旧格式分块应被清理');
});

test('两个分块写入并发时仅一个提交成功，胜者值可完整读回', async (t) => {
  const { db } = fixture(t);
  const initial = await call(db, onRequestPut, 'PUT', 'race_key', { value: { data: 'base' }, baseUpdatedAt: null });
  assert.equal(initial.status, 200);

  const a = { data: 'A'.repeat(500000) };
  const b = { data: 'B'.repeat(500000) };
  const [left, right] = await Promise.all([
    call(db, onRequestPut, 'PUT', 'race_key', { value: a, baseUpdatedAt: initial.body.updatedAt }),
    call(db, onRequestPut, 'PUT', 'race_key', { value: b, baseUpdatedAt: initial.body.updatedAt })
  ]);
  assert.deepEqual([left.status, right.status].sort(), [200, 409]);

  const get = await call(db, onRequestGet, 'GET', 'race_key');
  assert.equal(get.status, 200);
  assert.ok(get.body.value.data === a.data || get.body.value.data === b.data, '必须完整读回胜者的值');
  const meta = JSON.parse((await mainRow(db, 'race_key')).value);
  assert.equal(await countRows(db, `race\_key#v${meta.gen}#%`), meta.parts, '胜者分块必须完整');
});
