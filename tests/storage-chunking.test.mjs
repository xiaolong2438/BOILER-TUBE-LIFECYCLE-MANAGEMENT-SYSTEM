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

async function call(db, handler, method, key, body) {
  const request = new Request('https://synthetic.example/api/storage/' + encodeURIComponent(key), {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  });
  const response = await handler({ env: { DB: db }, request, params: { key } });
  return { status: response.status, body: await response.json() };
}

async function countRows(db, pattern) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM app_kv WHERE key LIKE ?").bind(pattern).first();
  return row.n;
}

test('小值直接单行存储并可回读', async (t) => {
  const { db } = fixture(t);
  const value = { items: ['甲', '乙'], count: 2 };
  const put = await call(db, onRequestPut, 'PUT', 'small_key', { value });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body, { ok: true, key: 'small_key' });

  const get = await call(db, onRequestGet, 'GET', 'small_key');
  assert.equal(get.status, 200);
  assert.equal(get.body.found, true);
  assert.deepEqual(get.body.value, value);
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
  const put = await call(db, onRequestPut, 'PUT', 'boiler_design_drawings', { value });
  assert.equal(put.status, 200);
  assert.equal(put.body.chunked, true, '超过阈值应走分块');
  assert.ok(put.body.parts >= 3, '应切成多块，实际 parts=' + put.body.parts);

  const metaRow = await db.prepare("SELECT value FROM app_kv WHERE key = ?").bind('boiler_design_drawings').first();
  const meta = JSON.parse(metaRow.value);
  assert.equal(meta.__chunked, true);
  assert.equal(meta.parts, put.body.parts);

  const get = await call(db, onRequestGet, 'GET', 'boiler_design_drawings');
  assert.equal(get.status, 200);
  assert.deepEqual(get.body.value, value, '拼回后的值必须与原值完全一致');

  const chunkRows = await countRows(db, 'boiler\_design\_drawings#p%');
  assert.equal(chunkRows, put.body.parts, '分块行数应与 parts 一致');
});

test('分块键被大值覆盖后再写小值时清理分块行', async (t) => {
  const { db } = fixture(t);
  const bigValue = { data: '图'.repeat(30000) }; /* 90KB UTF-8 */
  await call(db, onRequestPut, 'PUT', 'mixed_key', { value: bigValue });
  assert.ok(await countRows(db, 'mixed\_key#p%') >= 2, '先制造分块行');

  const put = await call(db, onRequestPut, 'PUT', 'mixed_key', { value: { data: '小' } });
  assert.equal(put.status, 200);
  assert.equal(put.body.chunked, undefined, '小值不再分块');
  assert.equal(await countRows(db, 'mixed\_key#p%'), 0, '旧分块行应被清理');
  assert.equal(await countRows(db, 'mixed_key%'), 1);

  const get = await call(db, onRequestGet, 'GET', 'mixed_key');
  assert.deepEqual(get.body.value, { data: '小' });
});

test('删除分块键时主行与分块行一并清理', async (t) => {
  const { db } = fixture(t);
  await call(db, onRequestPut, 'PUT', ' doomed ', { value: { data: '块'.repeat(20000) } });
  assert.ok(await countRows(db, 'doomed#p%') >= 2);

  const del = await call(db, onRequestDelete, 'DELETE', 'doomed');
  assert.equal(del.status, 200);
  assert.equal(await countRows(db, 'doomed%'), 0, '删除后不应残留任何行');

  const get = await call(db, onRequestGet, 'GET', 'doomed');
  assert.equal(get.status, 404);
  assert.equal(get.body.found, false);
});

test('缺失的分块返回 500 而非拼出错值', async (t) => {
  const { db } = fixture(t);
  await call(db, onRequestPut, 'PUT', 'broken_key', { value: { data: '残'.repeat(20000) } });
  await db.prepare("DELETE FROM app_kv WHERE key LIKE ?").bind('broken\_key#p001%').run();

  const get = await call(db, onRequestGet, 'GET', 'broken_key');
  assert.equal(get.status, 500);
  assert.match(get.body.error, /incomplete/);
});

test('非法键被拒绝（含 # 的键保留给分块命名空间）', async (t) => {
  const { db } = fixture(t);
  const put = await call(db, onRequestPut, 'PUT', 'evil#p000', { value: { a: 1 } });
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
