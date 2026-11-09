import test from 'node:test';
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import vm from 'node:vm';

const app = readFileSync(new URL('../assets/app/app-v7.9.js', import.meta.url), 'utf8');

function functionSource(name) {
  const start = app.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} exists`);
  const bodyStart = app.indexOf('{', start);
  assert.ok(bodyStart >= 0, `${name} has a body`);
  let depth = 0;
  for (let i = bodyStart; i < app.length; i += 1) {
    if (app[i] === '{') depth += 1;
    else if (app[i] === '}') {
      depth -= 1;
      if (depth === 0) return app.slice(start, i + 1);
    }
  }
  throw new Error(`${name} body is not closed`);
}

function context(overrides = {}) {
  const ctx = vm.createContext({
    console,
    Date,
    JSON,
    Map,
    setTimeout: () => 1,
    clearTimeout: () => {},
    ...overrides
  });
  vm.runInContext("var CLOUD_STORAGE_ENDPOINT = '/api/storage'; var cloudStorageEnabled = () => true;", ctx);
  return ctx;
}

test('cloudStorageRequest keeps the HTTP status and server error code', async () => {
  const ctx = context({
    fetch: async () => ({
      status: 413,
      ok: false,
      json: async () => ({ error: '存储内容超过单键上限 1500000 字节', code: 'PAYLOAD_TOO_LARGE' })
    })
  });
  vm.runInContext(functionSource('cloudStorageRequest'), ctx);
  const result = await ctx.cloudStorageRequest('boiler_design_drawings', 'PUT', { value: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 413);
  assert.equal(result.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(result.error, '存储内容超过单键上限 1500000 字节');
});

test('cloudStorageRequest still returns null for a network failure', async () => {
  const ctx = context({
    fetch: async () => { throw new Error('offline'); }
  });
  vm.runInContext(functionSource('cloudStorageRequest'), ctx);
  assert.equal(await ctx.cloudStorageRequest('boiler_user_db'), null);
});

test('queueCloudStorageSave surfaces a failed PUT once per key', async () => {
  const toasts = [];
  const ctx = context({
    showToast: (...args) => toasts.push(args),
    cloudStorageRequest: async () => ({ ok: false, status: 413, code: 'PAYLOAD_TOO_LARGE', error: '内容过大' })
  });
  vm.runInContext(
    "var cloudSaveTimers = new Map(); var cloudSaveErrorAt = new Map();\n" +
    ['cloudStorageLabel', 'notifyCloudSaveFailure', 'queueCloudStorageSave'].map(functionSource).join('\n'),
    ctx
  );
  let timer = null;
  ctx.setTimeout = fn => { timer = fn; return 1; };
  ctx.queueCloudStorageSave('boiler_user_db', { events: [], replacements: [] });
  assert.equal(typeof timer, 'function');
  await timer();
  ctx.queueCloudStorageSave('boiler_user_db', { events: [], replacements: [] });
  await timer();
  assert.equal(toasts.length, 1);
  assert.match(toasts[0][0], /云端保存失败（业务台账）/);
  assert.match(toasts[0][0], /数据仍在本机/);
});
