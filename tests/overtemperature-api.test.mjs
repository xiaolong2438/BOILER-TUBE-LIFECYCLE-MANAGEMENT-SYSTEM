import test from 'node:test';
import assert from 'node:assert/strict';
import { D1 } from './fixtures/temperature/d1-adapter.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onRequestGet as pointsGet, onRequestPost as pointsPost } from '../functions/api/temperature/points.js';
import { onRequestPut as pointPut } from '../functions/api/temperature/points/[id].js';
import { onRequestPost as configPost } from '../functions/api/temperature/points/[id]/configs.js';
import { onRequestGet as recordsGet, onRequestPost as recordPost } from '../functions/api/temperature/records.js';
import { onRequestPut as recordPut } from '../functions/api/temperature/records/[id].js';
import { onRequestGet as summaryGet } from '../functions/api/temperature/summary.js';
import { onRequestGet as historyGet } from '../functions/api/temperature/history.js';

const schema = readFileSync(new URL('../migrations/0002_temperature.sql', import.meta.url), 'utf8');
const authSchema = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8');
const core = globalThis.BTOvertemperatureCore;
const BASE = 1704067200000;
const HOUR = 3600000;

function fixture(t, migrate = true) {
  const directory = mkdtempSync(join(tmpdir(), 'bt-temperature-'));
  const file = join(directory, 'isolated.sqlite');
  const db = new D1(file);
  db.sql.exec(authSchema);
  if (migrate) db.sql.exec(schema);
  const insertUser = db.sql.prepare('INSERT INTO users (username, role, password_hash, salt, iterations) VALUES (?, ?, ?, ?, ?)');
  const insertSession = db.sql.prepare('INSERT INTO sessions (token, username, expires_at) VALUES (?, ?, ?)');
  for (const username of ['alice', 'bob']) {
    insertUser.run(username, 'user', 'fixture-not-a-password', 'fixture-salt', 1);
    insertSession.run('session-' + username, username, '2999-01-01 00:00:00');
  }
  const second = new D1(file);
  t.after(() => { db.sql.close(); second.sql.close(); rmSync(directory, { recursive: true, force: true }); });
  return { db, second };
}
async function call(db, handler, method, path, body, actor = 'alice', params = {}) {
  const request = new Request('https://synthetic.example/api/temperature/' + path, { method, headers: { ...(actor ? { Cookie: 'bt_session=session-' + actor } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const response = await handler({ env: { DB: db }, request, params });
  return { status: response.status, body: await response.json() };
}
function region(sys = 'SLB') {
  const row = core.MATRIX.find(item => item.sys === sys);
  assert.ok(row, 'matrix fixture system exists');
  return { sys: row.sys, comp: row.comp, wall: row.wall ?? null, spaces: null, posFrom: null, posTo: null, pos2From: null, pos2To: null, tubeFrom: 1, tubeTo: 1, dirs: null, parts: null, corners: null, layers: null, nozzles: null };
}
function config(configId, effectiveFrom = BASE, sys = 'SLB') {
  return { id: configId, effectiveFrom, regions: [region(sys)], mappingConfirmed: true, mappingBasis: '隔离合成矩阵映射', limitC: 500, limitBasis: '合成验收阈值，非生产定值' };
}
function point(pointId = 'p1', options = {}) {
  return { id: pointId, unit: '1', tag: 'SYNTH-' + pointId, name: '合成测点 ' + pointId, measurementType: 'tube_wall', location: '隔离测试', active: true, config: config('c-' + pointId), ...options };
}
async function seed(db, items = [point()]) {
  const result = await call(db, pointsPost, 'POST', 'points', { requestId: 'seed-' + items.map(item => item.id).join('-'), points: items });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
function record(recordId = 'r1', pointId = 'p1', startAt = BASE + HOUR, endAt = BASE + 3 * HOUR, options = {}) {
  return { id: recordId, pointId, configId: 'c-' + pointId, kind: 'interval', startAt, endAt, temperatureC: 550, verified: true, note: '隔离合成记录', ...options };
}
async function addRecord(db, item, requestId = 'create-' + item.id) {
  return call(db, recordPost, 'POST', 'records', { requestId, record: item });
}
function count(db, table) { return db.sql.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n; }

test('session validation, missing binding and missing migration give explicit errors', async t => {
  const { db } = fixture(t, false);
  const unauthorized = await call(db, pointsGet, 'GET', 'points', undefined, null);
  assert.equal(unauthorized.status, 401);
  const missing = await call(db, pointsGet, 'GET', 'points');
  assert.equal(missing.status, 503);
  assert.equal(missing.body.code, 'DATABASE_UNAVAILABLE');
  const response = await pointsGet({ env: {}, request: new Request('https://synthetic.example/api/temperature/points') });
  assert.equal(response.status, 503);
});

test('batch creation is all-or-none, tags unique per unit, internal ids stable, and request retries exact', async t => {
  const { db, second } = fixture(t);
  const payload = { requestId: 'batch-1', points: [point('p1', { tag: '' }), point('p2')] };
  const first = await call(db, pointsPost, 'POST', 'points', payload);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.items[0].tag, 'INTERNAL-p1');
  assert.equal(first.body.items[0].createdBy, 'alice');
  const retry = await call(second, pointsPost, 'POST', 'points', { points: payload.points, requestId: payload.requestId });
  assert.deepEqual(retry, first);
  assert.equal(count(db, 'temperature_points'), 2);
  assert.equal(count(db, 'temperature_audit'), 4);
  const changed = await call(second, pointsPost, 'POST', 'points', { ...payload, points: [point('p3')] });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'IDEMPOTENCY_CONFLICT');
  const otherActor = await call(second, pointsPost, 'POST', 'points', payload, 'bob');
  assert.equal(otherActor.status, 409);
  const duplicate = await call(db, pointsPost, 'POST', 'points', { requestId: 'invalid-batch', points: [point('p3'), point('p4', { tag: 'SYNTH-p2' })] });
  assert.equal(duplicate.status, 409);
  assert.equal(count(db, 'temperature_points'), 2);
  const invalid = await call(db, pointsPost, 'POST', 'points', { requestId: 'invalid-region', points: [point('p3'), point('p4', { config: { ...config('c4'), regions: [{ sys: 'SLB', comp: 'WW' }] } })] });
  assert.equal(invalid.status, 422);
  assert.equal(count(db, 'temperature_points'), 2);
  const otherUnit = await seed(db, [point('p5', { unit: '2', tag: 'SYNTH-p2' })]);
  assert.equal(otherUnit.items[0].unit, '2');
});

test('two clients retry same request while first response is in flight without duplicate data', async t => {
  const { db, second } = fixture(t);
  const payload = { requestId: 'same-concurrent-request', points: [point()] };
  let winner;
  db.beforeWrite = async () => { winner = await call(second, pointsPost, 'POST', 'points', payload); };
  const retry = await call(db, pointsPost, 'POST', 'points', payload);
  assert.equal(winner.status, 200);
  assert.deepEqual(retry, winner);
  assert.equal(count(db, 'temperature_points'), 1);
  assert.equal(count(db, 'temperature_requests'), 1);
  assert.equal(count(db, 'temperature_audit'), 2);
  assert.equal(count(db, 'temperature_tx_guard'), 0);
});

test('two-client revision conflict preserves winning point and writes no phantom audit', async t => {
  const { db, second } = fixture(t);
  await seed(db);
  let winner;
  db.beforeWrite = async () => {
    winner = await call(second, pointPut, 'PUT', 'points/p1', { requestId: 'winner', revision: 1, name: '先提交者', reason: '业务更正' }, 'bob', { id: 'p1' });
  };
  const loser = await call(db, pointPut, 'PUT', 'points/p1', { requestId: 'loser', revision: 1, name: '过期修改', reason: '业务更正' }, 'alice', { id: 'p1' });
  assert.equal(winner.status, 200);
  assert.equal(loser.status, 409);
  assert.equal(loser.body.current.name, '先提交者');
  assert.equal(loser.body.current.updatedBy, 'bob');
  assert.equal(count(db, 'temperature_audit'), 3);
  assert.equal(count(db, 'temperature_requests'), 2);
  assert.equal(count(db, 'temperature_tx_guard'), 0);
  const identity = await call(db, pointPut, 'PUT', 'points/p1', { requestId: 'identity-change', revision: 2, unit: '2', reason: '修改机组' }, 'alice', { id: 'p1' });
  assert.equal(identity.status, 422);
  const disabled = await call(db, pointPut, 'PUT', 'points/p1', { requestId: 'disable', revision: 2, active: false, reason: '停用' }, 'alice', { id: 'p1' });
  assert.equal(disabled.status, 200);
  assert.equal((await call(db, pointsGet, 'GET', 'points')).body.total, 1);
  assert.equal((await call(db, pointsGet, 'GET', 'points?active=true')).body.total, 0);
});

test('append-only configs preserve historic system evidence and cannot cut existing records', async t => {
  const { db } = fixture(t);
  const created = await seed(db);
  assert.equal((await addRecord(db, record())).status, 200);
  const cut = await call(db, configPost, 'POST', 'points/p1/configs', { requestId: 'config-cut', revision: 1, reason: '阈值变更', config: config('c-cut', BASE + 2 * HOUR, 'GGRQ') }, 'alice', { id: 'p1' });
  assert.equal(cut.status, 422);
  const appended = await call(db, configPost, 'POST', 'points/p1/configs', { requestId: 'config-next', revision: 1, reason: '区域变更', config: config('c-next', BASE + 4 * HOUR, 'GGRQ') }, 'alice', { id: 'p1' });
  assert.equal(appended.status, 200, JSON.stringify(appended.body));
  assert.equal(appended.body.item.revision, 2);
  assert.equal(appended.body.config.revision, 2);
  const old = JSON.parse(db.sql.prepare('SELECT payload FROM temperature_configs WHERE id = ?').get('c-p1').payload);
  assert.deepEqual(old, created.configs[0]);
  const historical = await call(db, pointsGet, 'GET', 'points?sys=SLB');
  assert.equal(historical.body.total, 1);
  assert.equal(historical.body.configs.length, 2);
  const historicSummary = await call(db, summaryGet, 'GET', 'summary?sys=SLB');
  assert.equal(historicSummary.body.summary.durationMs, 2 * HOUR);
  const stale = await addRecord(db, record('r2', 'p1', BASE + 5 * HOUR, BASE + 6 * HOUR));
  assert.equal(stale.status, 422);
});

test('concurrent config append and record create guard both ordering directions', async t => {
  const { db, second } = fixture(t);
  await seed(db);
  let winner;
  db.beforeWrite = async () => { winner = await addRecord(second, record()); };
  const blockedConfig = await call(db, configPost, 'POST', 'points/p1/configs', { requestId: 'raced-config', revision: 1, reason: '配置生效', config: config('c-race', BASE + 2 * HOUR) }, 'alice', { id: 'p1' });
  assert.equal(winner.status, 200);
  assert.equal(blockedConfig.status, 409);
  assert.equal(count(db, 'temperature_configs'), 1);
  assert.equal(count(db, 'temperature_audit'), 3);
  db.beforeWrite = async () => { winner = await call(second, configPost, 'POST', 'points/p1/configs', { requestId: 'config-wins', revision: 1, reason: '配置生效', config: config('c-wins', BASE + 4 * HOUR) }, 'bob', { id: 'p1' }); };
  const blockedRecord = await addRecord(db, record('r2', 'p1', BASE + 5 * HOUR, BASE + 6 * HOUR));
  assert.equal(winner.status, 200, JSON.stringify(winner.body));
  assert.equal(blockedRecord.status, 409);
  assert.equal(count(db, 'temperature_records'), 1);
  assert.equal(count(db, 'temperature_audit'), 5);
});

test('keyset pagination includes all multi-point records and full summary unions overlapping points', async t => {
  const { db } = fixture(t);
  await seed(db, [point('p1'), point('p2')]);
  for (let n = 0; n < 55; n++) {
    const item = record('r' + String(n).padStart(3, '0'), n % 2 ? 'p2' : 'p1', BASE + HOUR, BASE + 3 * HOUR);
    assert.equal((await addRecord(db, item)).status, 200);
  }
  assert.equal((await addRecord(db, record('single', 'p1', BASE + 2 * HOUR, null, { kind: 'observation', temperatureC: 600 }))).status, 200);
  assert.equal((await addRecord(db, record('open', 'p2', BASE + 2 * HOUR, null))).status, 200);
  const query = 'records?pointId=p1,p2&limit=7&from=' + (BASE + HOUR) + '&to=' + (BASE + 4 * HOUR);
  let cursor, ids = [], pages = 0;
  do {
    const response = await call(db, recordsGet, 'GET', query + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    assert.equal(response.status, 200);
    assert.equal(response.body.total, 57);
    ids.push(...response.body.items.map(item => item.id));
    cursor = response.body.nextCursor; pages++;
  } while (cursor);
  assert.equal(new Set(ids).size, 57);
  assert.ok(pages > 1);
  const summary = await call(db, summaryGet, 'GET', 'summary?pointId=p1,p2&from=' + (BASE + HOUR) + '&to=' + (BASE + 4 * HOUR));
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.equal(summary.body.summary.durationMs, 2 * HOUR);
  assert.equal(summary.body.byPoint.reduce((sum, item) => sum + item.summary.durationMs, 0), 4 * HOUR);
  assert.equal(summary.body.summary.openCount, 1);
  assert.equal(summary.body.summary.observationCount, 1);
  const narrow = await call(db, recordsGet, 'GET', 'records?from=' + (BASE + 3 * HOUR) + '&to=' + (BASE + 4 * HOUR));
  assert.deepEqual(narrow.body.items.map(item => item.id), ['open']);
  const firstPage = await call(db, recordsGet, 'GET', 'records?limit=1');
  const wrongScope = await call(db, recordsGet, 'GET', 'records?unit=2&limit=1&cursor=' + encodeURIComponent(firstPage.body.nextCursor));
  assert.equal(wrongScope.status, 400);
});

test('record corrections and void preserve before/after actor history and enforce revisions', async t => {
  const { db, second } = fixture(t);
  await seed(db);
  const initial = await addRecord(db, record());
  assert.equal(initial.status, 200);
  const changed = await call(second, recordPut, 'PUT', 'records/r1', { requestId: 'record-correct', revision: 1, record: { temperatureC: 560 }, reason: '核实温度' }, 'bob', { id: 'r1' });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.item.revision, 2);
  const stale = await call(db, recordPut, 'PUT', 'records/r1', { requestId: 'record-stale', revision: 1, record: { note: '过期编辑' }, reason: '核实' }, 'alice', { id: 'r1' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.temperatureC, 560);
  const voided = await call(second, recordPut, 'PUT', 'records/r1', { requestId: 'record-void', revision: 2, record: { status: 'void' }, reason: '数据重复确认作废' }, 'bob', { id: 'r1' });
  assert.equal(voided.status, 200, JSON.stringify(voided.body));
  assert.equal(count(db, 'temperature_records'), 1);
  assert.equal((await call(db, recordsGet, 'GET', 'records')).body.total, 0);
  assert.equal((await call(db, recordsGet, 'GET', 'records?includeVoid=true')).body.total, 1);
  assert.equal((await call(db, summaryGet, 'GET', 'summary')).body.summary.durationMs, 0);
  const history = await call(db, historyGet, 'GET', 'history?entityId=r1');
  assert.equal(history.body.total, 3);
  const event = history.body.items.find(item => item.action === 'void');
  assert.equal(event.actor, 'bob');
  assert.equal(event.before.status, 'active');
  assert.equal(event.after.status, 'void');
  assert.equal(event.reason, '数据重复确认作废');
  assert.ok(Number.isSafeInteger(event.at));
});

test('SQLite batch rollback removes data, audit, and request when a late conflict occurs', async t => {
  const { db, second } = fixture(t);
  db.beforeWrite = async () => { await seed(second, [point('winner', { tag: 'shared-tag' })]); };
  const batch = await call(db, pointsPost, 'POST', 'points', { requestId: 'rollback-batch', points: [point('first'), point('loser', { tag: 'shared-tag' })] });
  assert.equal(batch.status, 409);
  assert.equal(count(db, 'temperature_points'), 1);
  assert.equal(count(db, 'temperature_configs'), 1);
  assert.equal(count(db, 'temperature_requests'), 1);
  assert.equal(count(db, 'temperature_audit'), 2);
  assert.equal(count(db, 'temperature_tx_guard'), 0);
});

test('migration rerun preserves all records, immutable configs, history and retry responses', async t => {
  const { db } = fixture(t);
  await seed(db);
  const first = await addRecord(db, record());
  assert.equal(first.status, 200);
  db.sql.exec(schema);
  const retry = await addRecord(db, record());
  assert.deepEqual(retry, first);
  assert.equal(count(db, 'temperature_records'), 1);
  assert.equal(count(db, 'temperature_configs'), 1);
  assert.equal(count(db, 'temperature_audit'), 3);
});


test('idempotent response survives a commit between lookup and snapshot validation', async t => {
  const { db, second } = fixture(t);
  const payload = { requestId: 'snapshot-retry', points: [point()] };
  const batch = db.batch.bind(db);
  let winner, injected = false;
  db.batch = async statements => {
    if (!injected && statements[0].sql.startsWith('SELECT * FROM temperature_points')) {
      injected = true; winner = await call(second, pointsPost, 'POST', 'points', payload);
    }
    return batch(statements);
  };
  const response = await call(db, pointsPost, 'POST', 'points', payload);
  assert.equal(winner.status, 200);
  assert.deepEqual(response, winner);
  assert.equal(count(db, 'temperature_audit'), 2);
});

test('concurrent corrections preserve the winner without duplicate audits', async t => {
  const { db, second } = fixture(t);
  await seed(db);
  assert.equal((await addRecord(db, record())).status, 200);
  let winner;
  db.beforeWrite = async () => { winner = await call(second, recordPut, 'PUT', 'records/r1', { requestId: 'correct-wins', revision: 1, record: { note: '已核实' }, reason: '核对记录' }, 'bob', { id: 'r1' }); };
  const loser = await call(db, recordPut, 'PUT', 'records/r1', { requestId: 'correct-loses', revision: 1, record: { note: '旧版本更正' }, reason: '核对记录' }, 'alice', { id: 'r1' });
  assert.equal(winner.status, 200);
  assert.equal(loser.status, 409);
  assert.equal(loser.body.current.note, '已核实');
  assert.equal(loser.body.current.revision, 2);
  assert.equal(count(db, 'temperature_audit'), 4);
  assert.equal(count(db, 'temperature_requests'), 3);
});

test('record dates, point/config association and unverified observations use core validation', async t => {
  const { db } = fixture(t);
  await seed(db, [point('p1'), point('p2')]);
  const otherConfig = await addRecord(db, record('wrong-config', 'p1', BASE + HOUR, BASE + 2 * HOUR, { configId: 'c-p2' }));
  assert.equal(otherConfig.status, 422);
  const reversed = await addRecord(db, record('reversed', 'p1', BASE + 3 * HOUR, BASE + HOUR));
  assert.equal(reversed.status, 422);
  const dateText = await addRecord(db, record('text-time', 'p1', '2024-01-01 00:00', null, { kind: 'observation' }));
  assert.equal(dateText.status, 422);
  const future = await addRecord(db, record('future', 'p1', Date.now() + HOUR, null, { kind: 'observation' }));
  assert.equal(future.status, 422);
  assert.equal((await addRecord(db, record('pending', 'p1', BASE + HOUR, BASE + 3 * HOUR, { verified: false }))).status, 422);
  assert.equal((await addRecord(db, record('observation', 'p1', BASE + HOUR, null, { kind: 'observation', temperatureC: 600 }))).status, 200);
  assert.equal((await addRecord(db, record('at-limit', 'p2', BASE + HOUR, BASE + 3 * HOUR, { temperatureC: 500 }))).status, 200);
  const summary = await call(db, summaryGet, 'GET', 'summary');
  assert.equal(summary.body.summary.durationMs, 2 * HOUR);
  assert.equal(summary.body.summary.observationCount, 1);
});

test('point and history keyset pages have complete unique totals and page configs', async t => {
  const { db } = fixture(t);
  await seed(db, [point('p1'), point('p2'), point('p3')]);
  const first = await call(db, pointsGet, 'GET', 'points?limit=1');
  assert.equal(first.body.items[0].id, 'p1');
  assert.equal(first.body.configs.length, 1);
  const second = await call(db, pointsGet, 'GET', 'points?limit=1&cursor=' + encodeURIComponent(first.body.nextCursor));
  assert.equal(second.body.items[0].id, 'p2');
  assert.equal(second.body.total, 3);
  assert.equal((await addRecord(db, record())).status, 200);
  let cursor, ids = [];
  do {
    const result = await call(db, historyGet, 'GET', 'history?entityId=p1&limit=1' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    assert.equal(result.status, 200);
    assert.equal(result.body.total, 3);
    ids.push(...result.body.items.map(item => item.id)); cursor = result.body.nextCursor;
  } while (cursor);
  assert.equal(new Set(ids).size, 3);
});

test('summary rejects an oversized data set explicitly rather than silently truncating', async t => {
  const { db } = fixture(t);
  await seed(db);
  const result = await addRecord(db, record());
  assert.equal(result.status, 200);
  const item = result.body.item;
  const insert = db.sql.prepare('INSERT INTO temperature_records (id, point_id, config_id, kind, start_at, end_at, status, revision, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  db.sql.exec('BEGIN');
  for (let n = 0; n < 20000; n++) {
    const value = { ...item, id: 'bulk-' + n };
    insert.run(value.id, value.pointId, value.configId, value.kind, value.startAt, value.endAt, value.status, value.revision, value.createdAt, value.updatedAt, JSON.stringify(value));
  }
  db.sql.exec('COMMIT');
  const summary = await call(db, summaryGet, 'GET', 'summary');
  assert.equal(summary.status, 422);
  assert.equal(summary.body.code, 'DATASET_TOO_LARGE');
  assert.equal(summary.body.summary, undefined);
});


test('tube evidence reuses core matching across historical configs and installation clipping', async t => {
  const { db } = fixture(t);
  const created = await seed(db);
  const observation = await addRecord(db, record());
  assert.equal(observation.status, 200);
  const next = await call(db, configPost, 'POST', 'points/p1/configs', { requestId: 'tube-system-change', revision: 1, reason: '新增区域版本', config: config('tube-next', BASE + 4 * HOUR, 'GGRQ') }, 'alice', { id: 'p1' });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  const expansion = core.expandRegion(created.configs[0].regions[0], '1', core.MATRIX, 1000);
  assert.ok(expansion.codes.length > 0);
  const tubeCode = expansion.codes[0];
  const response = await call(db, summaryGet, 'GET', 'summary?tubeCode=' + encodeURIComponent(tubeCode) + '&installedAt=' + (BASE + 2 * HOUR));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const expected = core.summarizeTube(tubeCode, [next.body.item], [created.configs[0], next.body.config], [observation.body.item], { installedAt: BASE + 2 * HOUR });
  assert.deepEqual(response.body.tubeEvidence, JSON.parse(JSON.stringify(expected)));
  assert.equal(response.body.tubeEvidence.summary.durationMs, HOUR);
  assert.equal(response.body.tubeEvidence.areaSummary.durationMs, 2 * HOUR);
  assert.equal(response.body.tubeEvidence.summary.partialPeak, true);
});

test('server assigns record config when omitted and retains original metadata on correction', async t => {
  const { db } = fixture(t);
  await seed(db);
  const input = record('assigned');
  delete input.configId;
  const first = await addRecord(db, input);
  assert.equal(first.status, 200);
  assert.equal(first.body.item.configId, 'c-p1');
  const corrected = await call(db, recordPut, 'PUT', 'records/assigned', { requestId: 'metadata-correct', revision: 1, record: { note: '复核完成', createdAt: 1, createdBy: 'replacement', revision: 999 }, reason: '复核' }, 'bob', { id: 'assigned' });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.body.item.createdAt, first.body.item.createdAt);
  assert.equal(corrected.body.item.createdBy, 'alice');
  assert.equal(corrected.body.item.updatedBy, 'bob');
  assert.equal(corrected.body.item.revision, 2);
});


test('maximum 100-point batch succeeds atomically while 101 points is rejected', async t => {
  const { db } = fixture(t);
  const points = Array.from({ length: 100 }, (_, n) => point('p' + n));
  const result = await call(db, pointsPost, 'POST', 'points', { requestId: 'max-batch', points });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.items.length, 100);
  assert.equal(result.body.configs.length, 100);
  assert.equal(count(db, 'temperature_points'), 100);
  assert.equal(count(db, 'temperature_configs'), 100);
  assert.equal(count(db, 'temperature_audit'), 200);
  assert.equal(count(db, 'temperature_tx_guard'), 0);
  const tooMany = await call(db, pointsPost, 'POST', 'points', { requestId: 'oversized-batch', points: [...points, point('extra')] });
  assert.equal(tooMany.status, 422);
  assert.equal(count(db, 'temperature_requests'), 1);
});

test('unconfirmed mapping and unknown limit remain explicit and do not invent exposure', async t => {
  const { db } = fixture(t);
  const input = point('unknown', { config: { ...config('c-unknown'), limitC: null, limitBasis: '', mappingConfirmed: false, mappingBasis: '' } });
  const initial = await seed(db, [input]);
  assert.equal(initial.configs[0].limitC, null);
  assert.equal(initial.configs[0].mappingConfirmed, false);
  const unknownInterval = await addRecord(db, record('unknown-interval', 'unknown'));
  assert.equal(unknownInterval.status, 422);
  const added = await addRecord(db, record('unknown-r', 'unknown', BASE + HOUR, null, { kind: 'observation' }));
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const summary = await call(db, summaryGet, 'GET', 'summary?pointId=unknown');
  assert.equal(summary.status, 200);
  assert.equal(summary.body.summary.durationMs, 0);
  assert.equal(summary.body.byPoint[0].configs[0].limitC, null);
});


test('inserting config cannot reassign an existing observation or void record to another version', async t => {
  const { db } = fixture(t);
  const created = await seed(db);
  assert.equal((await addRecord(db, record('historic-observation', 'p1', BASE + 3 * HOUR, null, { kind: 'observation' }))).status, 200);
  const attempt = async requestId => call(db, configPost, 'POST', 'points/p1/configs', { requestId, revision: 1, reason: '插入历史版本', config: config('historical-insert', BASE + 2 * HOUR) }, 'alice', { id: 'p1' });
  assert.equal((await attempt('insert-before-active')).status, 422);
  const voided = await call(db, recordPut, 'PUT', 'records/historic-observation', { requestId: 'void-historical', revision: 1, record: { status: 'void' }, reason: '重复记录作废' }, 'alice', { id: 'historic-observation' });
  assert.equal(voided.status, 200);
  assert.equal((await attempt('insert-before-void')).status, 422);
  const data = await call(db, pointsGet, 'GET', 'points');
  assert.deepEqual(data.body.configs, created.configs);
  assert.equal(data.body.items[0].revision, 1);
  assert.equal(count(db, 'temperature_configs'), 1);
});

test('many points mapped to one tube retain their evidence while duration is a union', async t => {
  const { db } = fixture(t);
  const created = await seed(db, [point('p1'), point('p2')]);
  assert.equal((await addRecord(db, record('first-area', 'p1', BASE + HOUR, BASE + 3 * HOUR))).status, 200);
  assert.equal((await addRecord(db, record('second-area', 'p2', BASE + 2 * HOUR, BASE + 4 * HOUR))).status, 200);
  const tubeCode = core.expandRegion(created.configs[0].regions[0], '1', core.MATRIX, 1000).codes[0];
  const response = await call(db, summaryGet, 'GET', 'summary?tubeCode=' + encodeURIComponent(tubeCode));
  assert.equal(response.status, 200);
  assert.equal(response.body.summary.durationMs, 3 * HOUR);
  assert.equal(response.body.byPoint.reduce((sum, item) => sum + item.summary.durationMs, 0), 4 * HOUR);
  assert.equal(response.body.tubeEvidence.points.length, 2);
  assert.equal(response.body.tubeEvidence.summary.durationMs, 3 * HOUR);
  assert.equal(response.body.tubeEvidence.summary.mergedCount, 1);
  assert.equal(response.body.durationSemantics, 'union_across_points_not_sum');
});

test('config append and record correction cannot race to create a crossing interval', async t => {
  const { db, second } = fixture(t);
  await seed(db);
  assert.equal((await addRecord(db, record())).status, 200);
  let winner;
  db.beforeWrite = async () => { winner = await call(second, recordPut, 'PUT', 'records/r1', { requestId: 'extend-first', revision: 1, record: { endAt: BASE + 5 * HOUR }, reason: '确认结束时间' }, 'bob', { id: 'r1' }); };
  const blockedConfig = await call(db, configPost, 'POST', 'points/p1/configs', { requestId: 'crossing-config', revision: 1, reason: '新限值生效', config: config('c-crossing', BASE + 4 * HOUR) }, 'alice', { id: 'p1' });
  assert.equal(winner.status, 200);
  assert.equal(blockedConfig.status, 409);
  assert.equal(count(db, 'temperature_configs'), 1);
  db.beforeWrite = async () => { winner = await call(second, configPost, 'POST', 'points/p1/configs', { requestId: 'boundary-first', revision: 1, reason: '新限值生效', config: config('c-boundary', BASE + 6 * HOUR) }, 'bob', { id: 'p1' }); };
  const blockedCorrection = await call(db, recordPut, 'PUT', 'records/r1', { requestId: 'extend-second', revision: 2, record: { endAt: BASE + 7 * HOUR }, reason: '确认结束时间' }, 'alice', { id: 'r1' });
  assert.equal(winner.status, 200);
  assert.equal(blockedCorrection.status, 409);
  assert.equal(blockedCorrection.body.current.endAt, BASE + 5 * HOUR);
  assert.equal(blockedCorrection.body.current.revision, 2);
  assert.equal(count(db, 'temperature_configs'), 2);
  assert.equal(count(db, 'temperature_audit'), 6);
  assert.equal(count(db, 'temperature_requests'), 4);
});

test('closed and open intervals require a nonblank note without writing rejected data', async t => {
  const { db } = fixture(t);
  await seed(db);
  let n = 0;
  for (const endAt of [BASE + 3 * HOUR, null]) {
    for (const note of ['', ' \t\n ', undefined]) {
      const input = record('blank-note-' + n++, 'p1', BASE + HOUR, endAt, { note });
      const response = await addRecord(db, input);
      assert.equal(response.status, 422, JSON.stringify(response.body));
      assert.equal(response.body.code, 'VALIDATION_FAILED');
      assert.ok(response.body.errors.length > 0);
    }
  }
  assert.equal(count(db, 'temperature_records'), 0);
  assert.equal(count(db, 'temperature_audit'), 2);
  assert.equal(count(db, 'temperature_requests'), 1);
  assert.equal(count(db, 'temperature_tx_guard'), 0);
});

test('clearing closed or open interval notes is rejected without changing revisions or history', async t => {
  const { db } = fixture(t);
  await seed(db);
  for (const [recordId, endAt] of [['closed-note', BASE + 3 * HOUR], ['open-note', null]]) {
    const created = await addRecord(db, record(recordId, 'p1', BASE + HOUR, endAt));
    assert.equal(created.status, 200);
    const beforeAudit = count(db, 'temperature_audit');
    const beforeRequests = count(db, 'temperature_requests');
    const response = await call(db, recordPut, 'PUT', 'records/' + recordId, { requestId: 'clear-' + recordId, revision: 1, record: { note: ' \t ' }, reason: '业务编辑' }, 'bob', { id: recordId });
    assert.equal(response.status, 422, JSON.stringify(response.body));
    assert.equal(response.body.code, 'VALIDATION_FAILED');
    const saved = JSON.parse(db.sql.prepare('SELECT payload FROM temperature_records WHERE id = ?').get(recordId).payload);
    assert.deepEqual(saved, created.body.item);
    assert.equal(count(db, 'temperature_audit'), beforeAudit);
    assert.equal(count(db, 'temperature_requests'), beforeRequests);
  }
});

test('observations allow blank notes on creation and correction and never accumulate duration', async t => {
  const { db } = fixture(t);
  await seed(db);
  const created = await addRecord(db, record('blank-observation', 'p1', BASE + HOUR, null, { kind: 'observation', note: '' }));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.item.note, '');
  const corrected = await call(db, recordPut, 'PUT', 'records/blank-observation', { requestId: 'blank-observation-edit', revision: 1, record: { note: '  ', temperatureC: 560 }, reason: '复核温度' }, 'bob', { id: 'blank-observation' });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
  assert.equal(corrected.body.item.note, '');
  assert.equal(corrected.body.item.revision, 2);
  const summary = await call(db, summaryGet, 'GET', 'summary');
  assert.equal(summary.body.summary.durationMs, 0);
  assert.equal(summary.body.summary.observationCount, 1);
});
