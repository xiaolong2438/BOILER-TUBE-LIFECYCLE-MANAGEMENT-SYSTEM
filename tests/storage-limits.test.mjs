import test from 'node:test';
import { strict as assert } from 'node:assert';
import { onRequestPut } from '../functions/api/storage/[key].js';

const LIMIT = 1_500_000;

function request(body, key = 'boiler_user_db') {
  return new Request(`https://synthetic.example/api/storage/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

function unusedDB() {
  return {
    prepare() { throw new Error('D1 must not be touched for rejected payloads'); }
  };
}

function recordingDB() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      calls.push(sql);
      return {
        bind(...args) { this.args = args; return this; },
        async run() { return { success: true, results: [], meta: { changes: 1 } }; }
      };
    }
  };
}

test('oversized app_kv value returns 413 without touching D1', async () => {
  const env = { DB: unusedDB() };
  const response = await onRequestPut({
    env,
    request: request({ value: 'x'.repeat(LIMIT + 1) }),
    params: { key: 'boiler_user_db' }
  });
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(body.limitBytes, LIMIT);
  assert.match(body.error, /1,?500,?000|1500000/);
});

test('invalid JSON returns 400 without touching D1', async () => {
  const response = await onRequestPut({
    env: { DB: unusedDB() },
    request: request('{not-json'),
    params: { key: 'boiler_user_db' }
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, 'INVALID_JSON');
});

test('small value is persisted through the existing app_kv upsert', async () => {
  const db = recordingDB();
  const response = await onRequestPut({
    env: { DB: db },
    request: request({ value: { events: [{ code: '1G-SLB-WB-F000-R001-Q' }], replacements: [] } }),
    params: { key: 'boiler_user_db' }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, key: 'boiler_user_db' });
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0], /INSERT INTO app_kv/);
});
