import test from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../assets/app/app-v7.9.js', import.meta.url), 'utf8');

function functionSource(name) {
  const start = app.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} must exist`);
  const rest = app.slice(start);
  const firstLine = rest.split('\n')[0].trimEnd();
  if (firstLine.endsWith('}')) return firstLine;
  const end = /^}/m.exec(rest);
  assert.ok(end, `${name} must have a closing brace`);
  return rest.slice(0, end.index + 1);
}

const NAMES = [
  'cloudEventContentKey', 'cloudEventKey', 'cloudReplacementKey', 'mergeCountNotice',
  'mergeUserDBValues', 'mergeMaterialValues', 'mergeDrawingMetaValues', 'mergeCloudValue',
  'currentCloudValue', 'applyCloudValue', 'notifyCloudMerge', 'saveCloudValueWithMerge',
  'flushCloudStorageSave', 'queueCloudStorageSave', 'cloudStorageWrite', 'cloudStorageRequest',
  'normalizeDrawingMeta'
];

function harness(options = {}) {
  const store = new Map();
  const calls = { writes: [], reads: [], toasts: [], logs: [], invalidations: [], renders: [] };
  let userDB = options.userDB || { events: [], replacements: [] };
  let designDrawings = options.designDrawings || [];
  store.set('boiler_material_library', JSON.stringify(options.materialLibrary || []));
  const ctx = vm.createContext({
    console,
    Map, Set, JSON, Date, Promise, Object, String, Number, Boolean, Array, Error,
    CLOUD_STORAGE_ENDPOINT: '/api/storage',
    CLOUD_CONFLICT_KEYS: new Set(['boiler_user_db', 'boiler_material_library', 'boiler_design_drawings_meta']),
    MATERIAL_LIBRARY_KEY: 'boiler_material_library',
    DESIGN_DRAWINGS_META_KEY: 'boiler_design_drawings_meta',
    DRAWING_ID_RE: /^[A-Za-z0-9_-]{1,64}$/,
    LOCAL_DB_AT_KEY: 'boiler_user_db_local_at',
    cloudSaveTimers: new Map(),
    cloudPendingValues: new Map(),
    cloudSaveChains: new Map(),
    cloudRevisions: new Map(),
    designDrawings,
    localStorage: {
      getItem: key => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key)
    },
    cloudStorageEnabled: () => true,
    mat: null,
    materialKey: item => [item.component, item.position, item.spec, item.material].map(v => String(v || '').trim()).join('|'),
    invalidateTubeViews: () => calls.invalidations.push('tube'),
    invalidateViews: ids => calls.invalidations.push(...ids),
    renderDesignDrawings: () => calls.renders.push('drawings'),
    showToast: (msg, tone) => calls.toasts.push({ msg: String(msg), tone }),
    window: { BTMaintenanceLog: { hook: (kind, payload) => calls.logs.push({ kind, payload }) } },
    fetch: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      if(!init.method || init.method === 'GET') {
        calls.reads.push(url);
        const remote = options.remote ? options.remote(url, calls.reads.length) : null;
        if(remote === null) return new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify(remote), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      calls.writes.push({ url, body });
      const reply = options.write ? options.write(url, body, calls.writes.length) : { status: 200, body: { ok: true, updatedAt: 'v' + calls.writes.length } };
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
    }
  });
  ctx.setUserDB = value => { userDB = value; };
  Object.defineProperty(ctx, 'userDB', { get: () => userDB, set: value => { userDB = value; } });
  vm.runInContext(NAMES.map(functionSource).join('\n'), ctx);
  return { ctx, store, calls, userDB: () => ctx.userDB, designDrawings: () => ctx.designDrawings };
}

test('事件合并：按来源ID去重，同键保留本机，云端独有记录并入', () => {
  const h = harness();
  const merged = vm.runInContext(`mergeUserDBValues(
    { events: [
      { sourceId: 's1', code: 'A', ts: 1, desc: '本机版本' },
      { ts: 2, code: 'B', desc: '手工录入' }
    ], replacements: [] },
    { events: [
      { sourceId: 's1', code: 'A', ts: 9, desc: '云端旧版本' },
      { ts: 2, code: 'B', desc: '手工录入' },
      { ts: 3, code: 'C', desc: '云端新增' }
    ], replacements: [] }
  )`, h.ctx);
  assert.equal(merged.value.events.length, 3);
  assert.equal(merged.value.events.find(e => e.sourceId === 's1').desc, '本机版本', '同来源ID保留本机版本');
  assert.ok(merged.value.events.some(e => e.code === 'C'), '云端独有事件必须并入');
  assert.equal(merged.addedFromCloud, 1);
  assert.equal(merged.conflicts, 2);
  assert.match(merged.notice, /云端新增 1 条已并入/);
  assert.match(merged.notice, /同键冲突 2 条保留本机版本/);
});

test('更换合并：按 ts 与内容键去重', () => {
  const h = harness();
  const merged = vm.runInContext(`mergeUserDBValues(
    { events: [], replacements: [{ ts: 5, oldCode: 'A', newCode: 'A', date: '2026-01-01', reason: '更换' }] },
    { events: [], replacements: [
      { ts: 5, oldCode: 'A', newCode: 'A', date: '2026-01-01', reason: '更换' },
      { oldCode: 'B', newCode: 'B', date: '2026-02-02', reason: '爆管' }
    ] }
  )`, h.ctx);
  assert.equal(merged.value.replacements.length, 2);
  assert.equal(merged.addedFromCloud, 1);
  assert.equal(merged.conflicts, 1);
});

test('材料库与图纸元数据按业务键取并集，同键本机优先', () => {
  const h = harness();
  const material = vm.runInContext(`mergeMaterialValues(
    [{ component: '省煤器', position: '1', spec: 'Φ51×6', material: 'SA-210C', stockQty: '本机' }],
    [
      { component: '省煤器', position: '1', spec: 'Φ51×6', material: 'SA-210C', stockQty: '云端' },
      { component: '高过', position: '2', spec: 'Φ51×8', material: 'T91' }
    ]
  )`, h.ctx);
  assert.equal(material.value.length, 2);
  assert.equal(material.value[0].stockQty, '本机');
  assert.equal(material.addedFromCloud, 1);
  assert.equal(material.conflicts, 1);

  const drawings = vm.runInContext(`mergeDrawingMetaValues(
    [{ id: 'a', name: '本机A', fileType: 'image' }],
    [
      { id: 'a', name: '云端A', fileType: 'image', data: 'data:image/png;base64,QUJD' },
      { id: 'b', name: '云端B', fileType: 'pdf' },
      { id: '<img src=x>', name: '恶意', fileType: 'image' }
    ]
  )`, h.ctx);
  assert.deepEqual(Array.from(drawings.value, d => d.id), ['a', 'b']);
  assert.equal(drawings.value[0].name, '本机A');
  assert.equal(drawings.value[0].data, undefined, '元数据不得保留 base64');
});

test('409 冲突后自动合并并重试成功', async () => {
  let attempt = 0;
  const h = harness({
    userDB: { events: [{ sourceId: 's1', code: 'A', ts: 1, desc: '本机' }], replacements: [] },
    write(url, body) {
      attempt += 1;
      if(attempt === 1) return { status: 409, body: { error: 'conflict', updatedAt: 'remote-v1' } };
      return { status: 200, body: { ok: true, updatedAt: 'v' + attempt } };
    },
    remote(url) {
      return {
        found: true,
        updatedAt: 'remote-v1',
        value: { events: [{ sourceId: 's1', code: 'A', ts: 1, desc: '云端' }, { ts: 7, code: 'B', desc: '云端新增' }], replacements: [] }
      };
    }
  });
  h.ctx.cloudPendingValues.set('boiler_user_db', h.userDB());
  await h.ctx.flushCloudStorageSave('boiler_user_db');
  assert.equal(h.calls.writes.length, 2, '冲突后必须重试一次');
  assert.equal(h.userDB().events.length, 2, '合并后本机应包含云端新增记录');
  assert.equal(h.userDB().events.find(e => e.sourceId === 's1').desc, '本机');
  assert.match(h.calls.toasts[0].msg, /云端新增 1 条已并入/);
  assert.equal(h.calls.logs.length, 1, '合并结果必须写入维护日志');
  assert.ok(h.calls.writes[1].body.baseUpdatedAt === 'remote-v1', '重试必须基于冲突后读取的最新版本');
});

test('连续冲突时保留本机数据并提示，不静默覆盖', async () => {
  const h = harness({
    userDB: { events: [{ ts: 1, code: 'LOCAL' }], replacements: [] },
    write: () => ({ status: 409, body: { error: 'conflict', updatedAt: 'always-newer' } }),
    remote: () => ({ found: true, updatedAt: 'always-newer', value: { events: [], replacements: [] } })
  });
  h.ctx.cloudPendingValues.set('boiler_user_db', h.userDB());
  await h.ctx.flushCloudStorageSave('boiler_user_db');
  assert.equal(h.calls.writes.length, 3, '最多尝试 3 次后停止');
  assert.equal(h.userDB().events.length, 1, '本机数据必须保留');
  const errorToast = h.calls.toasts.find(item => item.tone === 'error');
  assert.ok(errorToast, '必须明确提示保存失败');
  assert.match(errorToast.msg, /请导出备份并刷新页面后重试/);
});

test('非业务键仍按原有无条件写入，不读取云端版本', async () => {
  const h = harness();
  h.ctx.cloudPendingValues.set('boiler_maintenance_log', [{ id: 'x' }]);
  await h.ctx.flushCloudStorageSave('boiler_maintenance_log');
  assert.equal(h.calls.reads.length, 0, '不应为普通键读取版本');
  assert.equal(h.calls.writes.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(h.calls.writes[0].body, 'baseUpdatedAt'), false);
});

test('网络错误时保留本机并告警，不尝试合并', async () => {
  const h = harness({
    userDB: { events: [{ ts: 1, code: 'LOCAL' }], replacements: [] },
    write: () => { throw new Error('offline'); }
  });
  h.ctx.cloudRevisions.set('boiler_user_db', 'v0');
  h.ctx.cloudPendingValues.set('boiler_user_db', h.userDB());
  await h.ctx.flushCloudStorageSave('boiler_user_db');
  assert.equal(h.userDB().events.length, 1);
  assert.equal(h.calls.writes.length, 1, '网络错误不重试');
  assert.equal(h.calls.reads.length, 0, '已有版本时网络错误不再读取云端');
});

console.log('ok - cloud conflict: union merge for events/replacements/material/drawings');
