/* All fixtures in this file are synthetic. No network, production store or real plant data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const Assistant = require('../assets/app/assistant-core-v1.js');
const Core = require('../assets/app/overtemperature-core-v1.js');
const sourceURL = new URL('../assets/app/overtemperature-core-v1.js', import.meta.url);
const assistantURL = new URL('../assets/app/assistant-core-v1.js', import.meta.url);
const source = fs.readFileSync(sourceURL, 'utf8');
const assistantSource = fs.readFileSync(assistantURL, 'utf8');
const mainSource = fs.readFileSync(new URL('../assets/app/app-v7.9.js', import.meta.url), 'utf8');
const mainMatrixMatch = mainSource.match(/const matrix\s*=\s*(\[[\s\S]*?\n\]);/);
assert.ok(mainMatrixMatch, 'main matrix must remain discoverable');
const mainMatrix = vm.runInNewContext('(' + mainMatrixMatch[1] + ')');
const plain = value => JSON.parse(JSON.stringify(value));
const ms = Core.parseTime;
const H = 3600000;
const t0 = ms('2026-01-31T22:00');
const now = ms('2026-03-01T00:00');
const point = (id = 'synthetic-point-1', unit = '1') => ({ id, unit, tag:'SYNTH-TW-001', name:'Synthetic tube wall point', measurementType:'tube_wall', location:'Synthetic only', active:true, revision:1, createdAt:t0, updatedAt:t0, createdBy:'synthetic-test', updatedBy:'synthetic-test' });
const region = (patch = {}) => ({ sys:'GGRQ', comp:'GQ', wall:null, spaces:null, posFrom:1, posTo:1, pos2From:null, pos2To:null, tubeFrom:1, tubeTo:1, dirs:['F'], parts:['Q'], corners:null, layers:null, nozzles:null, ...patch });
const config = (patch = {}) => ({ id:'synthetic-config-1', pointId:'synthetic-point-1', effectiveFrom:t0 - H, revision:1, regions:[region()], mappingConfirmed:true, mappingBasis:'Synthetic mapping drawing; not operational', limitC:600, limitBasis:'Synthetic test threshold; not operational', createdAt:t0-H, createdBy:'synthetic-test', ...patch });
const record = (patch = {}) => ({ id:'synthetic-record-1', pointId:'synthetic-point-1', configId:'synthetic-config-1', kind:'interval', startAt:t0, endAt:t0+H, temperatureC:620, verified:true, note:'Synthetic fixture only', status:'active', revision:1, createdAt:t0+H, updatedAt:t0+H, createdBy:'synthetic-test', updatedBy:'synthetic-test', ...patch });
const observation = (patch = {}) => record({ kind:'observation', endAt:null, verified:false, ...patch });
const good = output => { assert.equal(output.ok, true, output.errors.join('; ')); return output.value; };
const bad = (output, pattern) => { assert.equal(output.ok, false); assert.equal(output.value, null); assert.ok(output.errors.length); if (pattern) assert.match(output.errors.join('; '), pattern); };
const inputCode = '1G-GGRQ-GQ-L001-F001-Q';

test('stable public API; IIFE exposes browser, worker globalThis and CommonJS', async () => {
  const expected = ['parseTime','formatTime','toInputTime','validateRegion','expandRegion','matchesRegion','validateConfig','resolveConfig','validateRecord','mergeIntervals','summarize','summarizeTube'];
  expected.forEach(key => assert.equal(typeof Core[key], 'function', key));
  assert.equal(globalThis.BTOvertemperatureCore, Core);
  const sandbox = { window:{}, module:{ exports:{} } };
  vm.runInNewContext(assistantSource, sandbox);
  vm.runInNewContext(source, sandbox);
  assert.equal(sandbox.window.BTOvertemperatureCore, sandbox.module.exports);
  assert.equal(sandbox.BTOvertemperatureCore, sandbox.module.exports);
  const workerContext = {};
  vm.runInNewContext(assistantSource, workerContext);
  vm.runInNewContext(source, workerContext);
  assert.equal(typeof workerContext.BTOvertemperatureCore.summarizeTube, 'function');
  assert.throws(() => vm.runInNewContext(source, {}), /requires BTAssistantCore/);
  const worker = new Worker(`(async () => { await import(${JSON.stringify(assistantURL.href)}); await import(${JSON.stringify(sourceURL.href)}); require('node:worker_threads').parentPort.postMessage(typeof globalThis.BTOvertemperatureCore.summarizeTube); })().catch(e => { throw e; });`, { eval:true });
  const message = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  assert.equal(message, 'function');
  await worker.terminate();
});

test('matrix mirror preserves all main structural fields, removing only spec/mat/badge', () => {
  const stripped = plain(mainMatrix).map(({ spec, mat, badge, ...rest }) => rest);
  assert.deepEqual(plain(Core.MATRIX), stripped);
  assert.equal(Object.isFrozen(Core.MATRIX), true);
  assert.equal(Object.isFrozen(Core.MATRIX[0].dirs), true);
});

test('assistant exports are reused, including validation parts fallback', () => {
  assert.equal(typeof Assistant.canonicalTubeCode, 'function');
  assert.equal(typeof Assistant.validateTubeCode, 'function');
  assert.equal(Assistant.validateTubeCode(inputCode, Core.MATRIX).parts.boiler, '1');
  let canonicalCalls = 0, validationCalls = 0;
  const wrapped = { ...Assistant, canonicalTubeCode(...args) { canonicalCalls++; return Assistant.canonicalTubeCode(...args); }, validateTubeCode(...args) { validationCalls++; return Assistant.validateTubeCode(...args); } };
  const box = { BTAssistantCore:wrapped };
  vm.runInNewContext(source, box);
  assert.equal(box.BTOvertemperatureCore.matchesRegion(inputCode, region(), '1'), true);
  assert.ok(canonicalCalls > 0 && validationCalls > 0);
  let parserCalls = 0;
  wrapped.parseTubeCodeParts = code => { parserCalls++; return Assistant.validateTubeCode(code).parts; };
  assert.equal(box.BTOvertemperatureCore.matchesRegion(inputCode, region(), '1'), true);
  assert.ok(parserCalls > 0);
});

test('strict epoch and Beijing datetime parsing', () => {
  const expected = Date.UTC(2026, 0, 31, 14, 0, 0);
  assert.equal(ms('2026-01-31T22:00'), expected);
  assert.equal(ms('2026-01-31T22:00:00'), expected);
  assert.equal(ms('2026-01-31T22:00:00+08:00'), expected);
  assert.equal(ms('2026-01-31T22:00:00+0800'), expected);
  assert.equal(ms('2026-01-31T14:00:00Z'), expected);
  assert.equal(ms('2026-01-31T09:00:00-05:00'), expected);
  assert.equal(ms('2026-01-31T14:00:00.125Z'), expected+125);
  assert.equal(ms(0), 0);
  assert.equal(ms(-1), -1);
  assert.equal(ms(expected), expected);
  assert.equal(Core.formatTime(expected), '2026-01-31 22:00:00 +08:00');
  assert.equal(Core.toInputTime(expected), '2026-01-31T22:00:00');
});

test('invalid time and calendar overflow never silently normalize', () => {
  const invalid = [null, undefined, '', ' ', '1700000000000', true, new Date(), NaN, Infinity, -Infinity, 1.25, 8640000000000001, '2026-02-29T00:00', '2024-02-30T00:00', '1900-02-29T00:00', '2026-04-31T00:00', '2026-00-01T00:00', '2026-13-01T00:00', '2026-01-00T00:00', '2026-01-32T00:00', '2026-01-01T24:00', '2026-01-01T23:60', '2026-01-01T23:00:60', '2026-01-01', '2026-1-01T00:00', '2026-01-01 00:00', '2026-01-01T00:00:00.1', '2026-01-01T00:00:00.1234Z', '2026-01-01T00:00+24:00', '2026-01-01T00:00+08:60', '2026-01-01T00:00junk', ' 2026-01-01T00:00', '0000-01-01T00:00'];
  invalid.forEach(value => assert.equal(ms(value), null, String(value)));
  assert.notEqual(ms('2000-02-29T00:00'), null);
  assert.notEqual(ms('2024-02-29T00:00'), null);
  assert.notEqual(ms('0001-01-01T08:00'), null);
  assert.equal(Core.formatTime(null), '');
  assert.equal(Core.toInputTime('bad'), '');
});

test('region validates explicit null wildcards and rejects silently widened inputs', () => {
  good(Core.validateRegion(region()));
  const wildcard = region({ posFrom:null, posTo:null, tubeFrom:null, tubeTo:null, dirs:null, parts:null });
  good(Core.validateRegion(wildcard));
  const missing = region(); delete missing.tubeTo; bad(Core.validateRegion(missing), /tubeTo/);
  [undefined, null, [], 'x'].forEach(r => bad(Core.validateRegion(r)));
  bad(Core.validateRegion(region({ sys:'SMQ', comp:'GQ' })));
  bad(Core.validateRegion(region({ sys:'GGRQ', comp:'EXIN' })));
  bad(Core.validateRegion(region({ sys:'GGRQ', typo:1 })), /未知/);
  for (const patch of [{ posFrom:0 }, { posFrom:1.5 }, { posFrom:'1' }, { posFrom:Infinity }, { posFrom:2,posTo:1 }, { posTo:33 }, { tubeTo:13 }, { dirs:[] }, { parts:[] }, { dirs:['X'] }, { parts:['A'] }, { parts:'Q' }, { posFrom:undefined }]) bad(Core.validateRegion(region(patch)));
  assert.deepEqual(good(Core.validateRegion(region({ dirs:['F','F'] }))).dirs, ['F']);
});

test('inapplicable fields and invalid matrix combinations fail closed', () => {
  for (const patch of [{ wall:'F000' }, { spaces:[1] }, { pos2From:1 }, { corners:[1] }, { layers:['A'] }, { nozzles:[1] }]) bad(Core.validateRegion(region(patch)));
  const wall = region({ sys:'SLB', comp:'WB', wall:'F000', posFrom:null,posTo:null,dirs:['R'] });
  good(Core.validateRegion(wall));
  bad(Core.validateRegion({ ...wall, posFrom:1 }));
  bad(Core.validateRegion({ ...wall, tubeTo:193 }));
  bad(Core.validateRegion({ ...wall, dirs:['L'] }));
  bad(Core.validateRegion({ ...wall, wall:null, tubeTo:190, dirs:null }));        /* 未声明方向：四墙全部参与上限（侧墙169） */
  good(Core.validateRegion({ ...wall, wall:null, tubeTo:190, dirs:['R'] }));      /* 声明R向：仅L/R向墙(tMax192)适用，F/B向墙不产生R码、不纳入上限 */
  bad(Core.validateRegion({ ...wall, wall:null, tubeTo:193, dirs:['R'] }));
  bad(Core.validateRegion(region(), []));
  bad(Core.validateRegion(region(), {}));
});

test('canonical code matching enforces unit, not prefix guessing', () => {
  assert.equal(Core.matchesRegion(inputCode, region(), '1'), true);
  assert.equal(Core.matchesRegion(inputCode, region(), '2'), false);
  assert.equal(Core.matchesRegion(inputCode.replace('1G','2G'), region(), '2'), true);
  assert.equal(Core.matchesRegion(inputCode, region(), 1), false);
  assert.equal(Core.matchesRegion('1G-GGRQ-GQ-L010-F001-Q', region(), '1'), false);
  assert.equal(Core.matchesRegion('1G-GGRQ-GQ-L001-F001-Q003', region(), '1'), true);
  assert.equal(Core.matchesRegion('bad', region(), '1'), false);
});

test('R/L position mirror and historical loop-leg migration reuse assistant rules', () => {
  assert.equal(Core.matchesRegion('1G-GGRQ-GQ-R032-F001-Q', region(), '1'), true);
  assert.equal(Core.matchesRegion('1G-GGRQ-GQ-R001-F001-Q', region(), '1'), false);
  const back = region({ dirs:['B'], tubeFrom:12,tubeTo:12 });
  assert.equal(Core.matchesRegion('1G-GGRQ-GQ-R032-F013-Q001', back, '1'), true);
  const dp = region({ sys:'DPGRQ', pos2From:1, pos2To:1 });
  assert.equal(Core.matchesRegion('1G-DPGRQ-GQ-R006-F001-F001-Q', dp, '1'), true);
  assert.equal(Core.matchesRegion('1G-DPGRQ-GQ-R006-F004-F001-Q', dp, '1'), false);
  assert.equal(Core.matchesRegion('1G-DPGRQ-GQ-R006-B004-F001-Q', dp, '1'), true, '小屏号炉后起算 B004 镜像为 F001');
  assert.equal(Core.matchesRegion('1G-DPGRQ-GQ-R006-L001-F001-Q', dp, '1'), false, '小屏号台账 F001–F004，L 方向不是别名');
});

test('wall tube directions use matrix first direction including asymmetric defaults', () => {
  const front = region({ sys:'SLB', comp:'WB', wall:'F000', posFrom:null,posTo:null,dirs:['R'] });
  assert.equal(Core.matchesRegion('1G-SLB-WB-F000-R001-Q', front, '1'), true);
  assert.equal(Core.matchesRegion('1G-SLB-WB-F000-L192-Q', front, '1'), true);
  assert.equal(Core.matchesRegion('1G-SLB-WB-B000-R001-Q', front, '1'), false);
  const hopper = { ...front, comp:'LHD', dirs:['L'] };
  assert.equal(Core.matchesRegion('1G-SLB-LHD-F000-R096-Q', hopper, '1'), true);
  assert.deepEqual(Core.expandRegion(front, '1').codes, ['1G-SLB-WB-F000-R001-Q']);
});

test('low-temperature omitted 1KJ is space one, not a wildcard', () => {
  const low = region({ sys:'DGRQ', spaces:[1], dirs:['D'], tubeFrom:2,tubeTo:2 });
  assert.equal(Core.matchesRegion('1G-DGRQ-GQ-L001-D002-Q', low, '1'), true);
  assert.equal(Core.matchesRegion('1G-DGRQ-GQ-1KJ-L001-D002-Q', low, '1'), true);
  assert.equal(Core.matchesRegion('1G-DGRQ-GQ-L001-D002-Q', { ...low,spaces:[2] }, '1'), false);
  assert.equal(Core.matchesRegion('1G-DGRQ-GQ-2KJ-L001-D002-Q', { ...low,spaces:null }, '1'), true);
  assert.equal(Core.matchesRegion('1G-DGRQ-GQ-1KJ-R112-U004-Q', low, '1'), true);
  assert.equal(Core.expandRegion({ ...low,spaces:null }, '1', undefined, 1).count, 5);
  bad(Core.validateRegion({ ...low, spaces:[6] }));
});

test('DZRQ unspecified tube never becomes a specified single tube', () => {
  const low = region({ sys:'DZRQ', spaces:[1], dirs:['D'] });
  assert.equal(Core.matchesRegion('1G-DZRQ-GQ-L001-Q', low, '1'), false);
  assert.equal(Core.matchesRegion('1G-DZRQ-GQ-L001-Q', { ...low,tubeFrom:null,tubeTo:null }, '1'), false);
  assert.equal(Core.matchesRegion('1G-DZRQ-GQ-L001-Q', { ...low,tubeFrom:null,tubeTo:null,dirs:null }, '1'), true);
  assert.equal(Core.matchesRegion('1G-DZRQ-GQ-R112-Q', { ...low,tubeFrom:null,tubeTo:null,dirs:null }, '1'), true);
  assert.equal(Core.matchesRegion('1G-DZRQ-GQ-L001-Q', { ...low,spaces:[2],tubeFrom:null,tubeTo:null,dirs:null }, '1'), false);
  assert.equal(Core.matchesRegion('1G-DZRQ-GQ-L001-D001-Q', low, '1'), true);
});

test('suspended F/B Q are separate legs and W has only F canonical identity', () => {
  assert.equal(Core.matchesRegion(inputCode.replace('F001','B001'), region(), '1'), false);
  assert.equal(Core.matchesRegion(inputCode.replace('F001','B001'), region({ dirs:['B'] }), '1'), true);
  const bend = region({ parts:['W'] });
  assert.equal(Core.matchesRegion('1G-GGRQ-GQ-L001-B001-W', bend, '1'), true);
  assert.equal(Core.matchesRegion('1G-GGRQ-GQ-L001-F001-W009', bend, '1'), true);
  const all = region({ dirs:null, parts:null });
  const expanded = Core.expandRegion(all, '1', undefined, 99);
  assert.equal(expanded.count, 3);
  assert.deepEqual(new Set(expanded.codes), new Set([inputCode, inputCode.replace('F001','B001'), inputCode.replace('-Q','-W')]));
  assert.equal(Core.expandRegion({ ...all, parts:['W'] }, '1').count, 1);
  assert.equal(Core.expandRegion({ ...all, dirs:['B'] }, '1').count, 1);
  bad(Core.validateRegion(region({ dirs:['B'],parts:['W'] })));
});

test('GZRQ seven loops keep F/B straight legs separate and canonicalize bends', () => {
  const highReheat = region({ sys:'GZRQ',tubeFrom:null,tubeTo:null,dirs:null });
  assert.equal(Core.expandRegion(highReheat, '1').count, 14);
  for (const code of ['1G-GZRQ-GQ-L001-F007-Q', '1G-GZRQ-GQ-R064-B007-Q']) {
    assert.equal(Core.matchesRegion(code, highReheat, '1'), true);
    assert.notEqual(Assistant.validateTubeCode(code, Core.MATRIX).fieldPosition, true);
  }
  assert.equal(Core.matchesRegion('1G-GZRQ-GQ-L001-B001-Q', { ...highReheat, dirs:['F'] }, '1'), false);
  assert.equal(Core.matchesRegion('1G-GZRQ-GQ-L001-B001-Q', { ...highReheat, dirs:['B'] }, '1'), true);
  assert.equal(Core.matchesRegion('1G-GZRQ-GQ-L001-B001-W', { ...highReheat, dirs:['F'], parts:['W'] }, '1'), true);
  for (const code of ['1G-GZRQ-GQ-L001-F008-Q','1G-GZRQ-GQ-L001-B014-Q']) {
    assert.equal(Assistant.validateTubeCode(code, Core.MATRIX).matched, null);
    assert.equal(Assistant.canonicalTubeCode(code, Core.MATRIX), null);
    assert.equal(Core.matchesRegion(code, highReheat, '1'), false);
  }
  good(Core.validateRegion({ ...highReheat, dirs:['B'] }));
  bad(Core.validateRegion({ ...highReheat, tubeTo:8 }));
});

test('RSQ uses structural corner/layer/nozzle matching and validates its own fields', () => {
  const rsq = region({ sys:'SLB',comp:'RSQ',posFrom:null,posTo:null,tubeFrom:null,tubeTo:null,dirs:null,corners:[1,2],layers:['A','C'],nozzles:[1,3] });
  good(Core.validateRegion(rsq));
  assert.equal(Core.expandRegion(rsq, '2', undefined, 3).count, 8);
  assert.equal(Core.expandRegion(rsq, '2', undefined, 3).codes.length, 3);
  assert.equal(Core.matchesRegion('2G-SLB-RSQ-J2-C03-Q', rsq, '2'), true);
  assert.equal(Core.matchesRegion('2G-SLB-RSQ-J2-C3-Q002', rsq, '2'), true);
  assert.equal(Core.matchesRegion('2G-SLB-RSQ-J3-C03-Q', rsq, '2'), false);
  assert.equal(Core.matchesRegion('2G-SLB-RSQ-J2-B03-Q', rsq, '2'), false);
  for (const patch of [{ corners:[5] }, { layers:['G'] }, { nozzles:[9] }, { corners:['1'] }, { tubeFrom:1 }, { wall:'F000' }, { spaces:[1] }]) bad(Core.validateRegion({ ...rsq,...patch }));
});

test('SMQ U/D mirror and component separation', () => {
  /* 集箱行维持镜像口径：D001≡U001（tMax 1，非 dualDir） */
  for (const comp of ['EXIN','EXOUT']) {
    const eco = region({ sys:'SMQ', comp, dirs:['U'] });
    assert.equal(Core.matchesRegion(`1G-SMQ-${comp}-R124-D001-Q`, eco, '1'), true);
    assert.equal(Core.expandRegion(eco, '1').count, 1);
  }
  /* 蛇形管新口径（2026-11-08）：U=上组/D=下组是不同物理管段（dualDir），组别不镜像，只镜像屏号 R↔L */
  const up = region({ sys:'SMQ', comp:'SG', dirs:['U'] });
  assert.equal(Core.matchesRegion('1G-SMQ-SG-R124-U001-Q', up, '1'), true, '屏号R124镜像到L001，上组圈1');
  assert.equal(Core.matchesRegion('1G-SMQ-SG-R124-D001-Q', up, '1'), false, '下组D001不属于上组区域（组别不镜像）');
  assert.equal(Core.expandRegion(up, '1').count, 1);
  const down = region({ sys:'SMQ', comp:'SG', dirs:['D'], tubeFrom:1, tubeTo:3 });
  assert.equal(Core.matchesRegion('1G-SMQ-SG-L001-D003-Q', down, '1'), true, '下组圈3合法');
  assert.equal(Core.matchesRegion('1G-SMQ-SG-L001-F001-Q', down, '1'), false, '吊挂管F码不属于蛇形管区域');
  assert.equal(Core.expandRegion(down, '1').count, 3, '下组圈1~3双向展开');
});

test('expansion counts all unique canonical identities independent of preview limit', () => {
  const r = region({ posFrom:null,posTo:null,tubeFrom:null,tubeTo:null,dirs:null,parts:null });
  const full = Core.expandRegion(r, '1', undefined, 10000);
  assert.equal(full.count, 32*12*3);
  assert.equal(full.codes.length, full.count);
  assert.equal(new Set(full.codes).size, full.count);
  for (const limit of [0,1,20]) { const x = Core.expandRegion(r, '1', undefined, limit); assert.equal(x.count, full.count); assert.equal(x.codes.length, limit); }
  const duplicateRows = Core.MATRIX.concat(Core.MATRIX.filter(x => x.sys === 'GGRQ'));
  assert.equal(Core.expandRegion(r, '1', duplicateRows, 0).count, full.count);
  assert.deepEqual(Core.expandRegion(r, '3'), { count:0,codes:[] });
  assert.deepEqual(Core.expandRegion({ ...r,posTo:99 }, '1'), { count:0,codes:[] });
});

test('all default rows agree with supplied main matrix and generated identities round-trip', () => {
  Core.MATRIX.forEach(row => {
    const r = region({ sys:row.sys,comp:row.comp,wall:row.pos || null,posFrom:null,posTo:null,tubeFrom:null,tubeTo:null,dirs:null,parts:null });
    const x = Core.expandRegion(r, '2', undefined, 8);
    assert.ok(x.count > 0, row.name);
    assert.deepEqual(x, Core.expandRegion(r, '2', mainMatrix, 8), row.name);
    x.codes.forEach(code => assert.equal(Core.matchesRegion(code, r, '2'), true, code));
  });
});

test('config permits explicit unknown mapping and limit without inventing defaults', () => {
  const draft = config({ mappingConfirmed:false,mappingBasis:'',regions:[],limitC:null,limitBasis:'' });
  const value = good(Core.validateConfig(draft, point()));
  assert.equal(value.limitC, null);
  assert.equal(value.mappingConfirmed, false);
  good(Core.validateConfig(config(), point()));
  good(Core.validateConfig(config({ effectiveFrom:'2026-01-31T21:00' }), point()));
});

test('config validates basis, types, regions, point identity and immutable versions', () => {
  for (const patch of [{ limitC:undefined },{ limitC:'' },{ limitC:'600' },{ limitC:Infinity },{ limitBasis:'' },{ mappingBasis:'' },{ regions:[] },{ mappingConfirmed:'true' },{ effectiveFrom:'' },{ effectiveFrom:'2026-02-30T00:00' },{ pointId:'other' },{ revision:0 },{ revision:2 },{ effectiveTo:t0+H }]) bad(Core.validateConfig(config(patch), point()));
  const c = config();
  good(Core.validateConfig(c, point(), [c]));
  bad(Core.validateConfig({ ...c,limitC:601 }, point(), [c]), /不可修改/);
  bad(Core.validateConfig(config(), point('synthetic-point-1', '3')));
  bad(Core.validateConfig(config({ regions:[{ ...region(),spaces:[1] }] }), point()));
});

test('configuration version resolution uses exact half-open effective boundaries', () => {
  const c1 = config(), c2 = config({ id:'synthetic-config-2',revision:2,effectiveFrom:t0+2*H,limitC:630 });
  good(Core.validateConfig(c2, point(), [c1]));
  assert.equal(Core.resolveConfig([c2,c1], point().id, t0-H-1), null);
  assert.equal(Core.resolveConfig([c2,c1], point().id, t0+2*H-1).id, c1.id);
  assert.equal(Core.resolveConfig([c2,c1], point().id, t0+2*H).id, c2.id);
  assert.equal(Core.resolveConfig([c1,c2], 'other', t0), null);
  assert.equal(Core.getConfigEffectiveTo(c1, [c1,c2]), t0+2*H);
  assert.equal(Core.getConfigEffectiveTo(c2, [c1,c2]), null);
  bad(Core.validateConfig({ ...c2,effectiveFrom:c1.effectiveFrom }, point(), [c1]), /生效时间/);
  bad(Core.validateConfig({ ...c2,revision:1 }, point(), [c1]), /序号/);
  assert.equal(Core.resolveConfig([c1,config({ id:'ambiguous' })], point().id, t0), null);
});

test('new configs never reassign existing records, including void historical evidence', () => {
  const c1 = config(), r = record();
  const crossing = config({ id:'synthetic-config-2',revision:2,effectiveFrom:t0+H/2 });
  bad(Core.validateConfig(crossing, point(), [c1], [r]), /既有记录|跨越/);
  good(Core.validateConfig({ ...crossing,effectiveFrom:t0+H }, point(), [c1], [r]));
  bad(Core.validateConfig({ ...crossing,effectiveFrom:t0 }, point(), [c1], [observation()]), /既有记录/);
  bad(Core.validateConfig(crossing, point(), [c1], [record({ status:'void' })]), /既有记录/);
  bad(Core.validateConfig({ ...crossing,effectiveFrom:t0+2*H }, point(), [c1], [record({ endAt:null,verified:false })]), /既有记录/);
});

test('record validation rejects empty, nonfinite, future and malformed time/temperature', () => {
  good(Core.validateRecord(record(), point(), [config()], now));
  good(Core.validateRecord(observation({ temperatureC:590 }), point(), [config()], now));
  for (const patch of [{ startAt:'' },{ startAt:null },{ startAt:'2026-02-30T00:00' },{ endAt:'' },{ endAt:t0 },{ endAt:t0-1 },{ temperatureC:'' },{ temperatureC:null },{ temperatureC:'620' },{ temperatureC:NaN },{ temperatureC:Infinity },{ pointId:'other' },{ configId:'missing' },{ kind:'peak' },{ status:'deleted' },{ verified:'true' },{ revision:0 },{ note:null }]) bad(Core.validateRecord(record(patch), point(), [config()], now));
  bad(Core.validateRecord(observation({ startAt:now+1 }), point(), [config()], now), /未来/);
  bad(Core.validateRecord(record({ endAt:now+1 }), point(), [config()], now), /未来/);
  bad(Core.validateRecord(record(), point(), [config()], ''), /now/);
});

test('interval reaches an evidenced limit and closed intervals are verified', () => {
  good(Core.validateRecord(record({ temperatureC:600 }), point(), [config()], now));
  bad(Core.validateRecord(record({ temperatureC:599 }), point(), [config()], now), /不得低于/);
  bad(Core.validateRecord(record(), point(), [config({ limitC:null,limitBasis:'' })], now), /确认限值/);
  bad(Core.validateRecord(record(), point(), [config({ limitBasis:'' })], now), /确认限值/);
  bad(Core.validateRecord(record({ verified:false }), point(), [config()], now), /人工核定/);
  good(Core.validateRecord(record({ endAt:null,verified:false }), point(), [config()], now));
  good(Core.validateRecord(observation({ temperatureC:600 }), point(), [config({ limitC:null,limitBasis:'' })], now));
  bad(Core.validateRecord(observation({ endAt:t0 }), point(), [config()], now), /时点/);
  good(Core.validateRecord(record(), point(), [config({ mappingConfirmed:false,mappingBasis:'',regions:[] })], now));
});

test('record version, cross-boundary, exact endpoint and open interval rules', () => {
  const c1 = config(), c2 = config({ id:'synthetic-config-2',revision:2,effectiveFrom:t0+H,limitC:630 });
  good(Core.validateRecord(record(), point(), [c1,c2], now));
  bad(Core.validateRecord(record({ endAt:t0+H+1 }), point(), [c1,c2], now), /跨配置/);
  bad(Core.validateRecord(observation({ startAt:t0+H }), point(), [c1,c2], now), /生效期/);
  good(Core.validateRecord(observation({ startAt:t0+H,configId:c2.id }), point(), [c1,c2], now));
  bad(Core.validateRecord(record({ endAt:null }), point(), [c1,c2], now), /未结束/);
  bad(Core.validateRecord(record({ configId:c2.id }), point(), [c1,c2], now), /生效期/);
  bad(Core.validateRecord(record({ startAt:t0+H,endAt:t0+2*H,configId:c2.id,temperatureC:620 }), point(), [c1,c2], now), /不得低于/);
});

test('merge handles overlap, adjacency, duplicates, sorting, midnight and month rollover', () => {
  const intervals = [{ startAt:t0+H,endAt:t0+3*H },{ startAt:t0,endAt:t0+2*H },{ startAt:t0+3*H,endAt:t0+4*H },{ startAt:t0,endAt:t0+2*H },{ startAt:t0+6*H,endAt:t0+7*H }];
  const before = plain(intervals);
  assert.deepEqual(Core.mergeIntervals(intervals), [{ startAt:t0,endAt:t0+4*H },{ startAt:t0+6*H,endAt:t0+7*H }]);
  assert.deepEqual(intervals, before);
  assert.equal(Core.formatTime(t0+4*H), '2026-02-01 02:00:00 +08:00');
});

test('merge clips windows before merging and never invents open duration', () => {
  const r = [{ startAt:t0,endAt:t0+4*H },{ startAt:t0+5*H,endAt:null },{ startAt:t0,endAt:t0 },{ startAt:null,endAt:t0+H }];
  assert.deepEqual(Core.mergeIntervals(r, { from:t0+H,to:t0+2*H }), [{ startAt:t0+H,endAt:t0+2*H }]);
  assert.deepEqual(Core.mergeIntervals(r, { from:t0+4*H,to:t0+5*H }), []);
  assert.deepEqual(Core.mergeIntervals(r, { from:t0,to:t0 }), []);
  assert.deepEqual(Core.mergeIntervals(r, { from:'bad' }), []);
  assert.deepEqual(Core.mergeIntervals(r, { from:t0+H,to:t0 }), []);
  assert.deepEqual(Core.mergeIntervals(r, { from:'2026-01-31T23:00',to:'2026-02-01T00:00' }), [{ startAt:t0+H,endAt:t0+2*H }]);
});

test('summary counts evidence records but unions overlap and adjacent durations', () => {
  const records = [record({ id:'a',endAt:t0+2*H }),record({ id:'b',startAt:t0+H,endAt:t0+3*H,temperatureC:640 }),record({ id:'c',startAt:t0+3*H,endAt:t0+4*H }),record({ id:'d',startAt:t0+6*H,endAt:t0+7*H }),observation({ id:'obs',startAt:t0+5*H,temperatureC:650 }),record({ id:'open',startAt:t0+8*H,endAt:null,verified:false,temperatureC:700 })];
  const s = Core.summarize(records, [config()]);
  assert.equal(s.recordCount, 6);
  assert.equal(s.intervalRecordCount, 5);
  assert.equal(s.observationCount, 1);
  assert.equal(s.openCount, 1);
  assert.equal(s.mergedCount, 2);
  assert.equal(s.durationMs, 5*H);
  assert.equal(s.longestMs, 4*H);
  assert.equal(s.peakC, 650);
  assert.equal(s.maxExcessC, 50);
  assert.equal(s.peakIncludesObservations, true);
  assert.equal(s.estimatedPeakC, 700);
  assert.equal(s.latestAt, t0+8*H);
});

test('observations/open records never accumulate, at-limit counts and below/missing do not', () => {
  const records = [observation({ id:'obs',temperatureC:900 }),record({ id:'open',endAt:null }),record({ id:'equal',temperatureC:600 }),record({ id:'below',temperatureC:590 }),record({ id:'unverified',verified:false })];
  const s = Core.summarize(records, [config()]);
  assert.equal(s.durationMs, H);
  assert.equal(s.mergedCount, 1);
  assert.equal(s.openCount, 1);
  assert.equal(s.excludedIntervalCount, 2);
  assert.equal(s.peakC, 900);
  for (const c of [config({ limitC:null,limitBasis:'' }),config({ limitBasis:'' })]) {
    const x = Core.summarize([record()], [c]);
    assert.equal(x.durationMs, 0);
    assert.equal(x.maxExcessC, null);
  }
  const empty = Core.summarize([], [config()]);
  assert.equal(empty.peakC, null);
  assert.equal(empty.latestAt, null);
  assert.equal(empty.recordCount, 0);
});

test('window clipping carries explicit uncertainty instead of claiming exact peak', () => {
  const records = [record({ id:'crossing',endAt:t0+4*H,temperatureC:900 }),observation({ id:'outside',startAt:t0,temperatureC:950 }),observation({ id:'inside',startAt:t0+H,temperatureC:630 }),observation({ id:'exclusive-end',startAt:t0+2*H,temperatureC:980 })];
  const s = Core.summarize(records, [config()], { from:t0+H,to:t0+2*H });
  assert.equal(s.recordCount, 2);
  assert.equal(s.durationMs, H);
  assert.equal(s.peakC, 630);
  assert.equal(s.maxExcessC, 30);
  assert.equal(s.estimatedPeakC, 900);
  assert.equal(s.estimatedMaxExcessC, 300);
  assert.equal(s.partialPeak, true);
  assert.equal(s.peakFromClippedInterval, true);
  assert.equal(s.partialIntervalCount, 1);
  const onlyCrossing = Core.summarize([records[0]], [config()], { from:t0+H,to:t0+2*H });
  assert.equal(onlyCrossing.peakC, null);
  assert.equal(onlyCrossing.maxExcessC, null);
});

test('summaries deduplicate record ids by newest revision and ignore void/bad references', () => {
  const r = record();
  assert.equal(Core.summarize([r,r], [config()]).recordCount, 1);
  assert.equal(Core.summarize([r,record({ revision:2,status:'void' })], [config()]).recordCount, 0);
  assert.equal(Core.summarize([record({ revision:2,status:'void' }),r], [config()]).recordCount, 0);
  assert.equal(Core.summarize([record({ configId:'unknown' }),record({ id:'badtemp',temperatureC:null })], [config()]).recordCount, 0);
  assert.equal(Core.summarize([r], [config()], { from:'' }).recordCount, 0);
  assert.equal(Core.summarize([r], [config()], { from:t0,to:t0 }).recordCount, 0);
});

test('summary respects historical limits and excludes cross-configuration duration', () => {
  const c1 = config(), c2 = config({ id:'synthetic-config-2',revision:2,effectiveFrom:t0+H,limitC:700 });
  const rs = [record(),record({ id:'next',configId:c2.id,startAt:t0+H,endAt:t0+2*H,temperatureC:710 }),record({ id:'cross',endAt:t0+2*H,temperatureC:999 })];
  const s = Core.summarize(rs, [c1,c2]);
  assert.equal(s.recordCount, 2);
  assert.equal(s.durationMs, 2*H);
  assert.equal(s.peakC, 710);
  assert.equal(s.maxExcessC, 20);
});

test('summaries union durations across distinct points rather than adding duplicated exposure', () => {
  const c2 = config({ id:'second-point-config',pointId:'synthetic-point-2' });
  const rs = [record({ endAt:t0+2*H }),record({ id:'second-point-record',pointId:c2.pointId,configId:c2.id,startAt:t0+H,endAt:t0+3*H })];
  const s = Core.summarize(rs, [config(),c2]);
  assert.equal(s.durationMs, 3*H);
  assert.equal(s.mergedCount, 1);
  assert.equal(s.recordCount, 2);
});

test('tube summary distinguishes unmapped, mapped without records and available', () => {
  assert.equal(Core.summarizeTube(inputCode, [], [], []).status, 'unmapped');
  const noData = Core.summarizeTube(inputCode, [point()], [config()], []);
  assert.equal(noData.status, 'no-records');
  assert.equal(noData.points.length, 1);
  assert.equal(noData.summary.peakC, null);
  assert.equal(Core.summarizeTube(inputCode, [point()], [config()], [record()]).status, 'available');
  assert.equal(Core.summarizeTube('bad', [point()], [config()], [record()]).status, 'unmapped');
  assert.equal(Core.summarizeTube(inputCode, [point()], [config({ mappingConfirmed:false })], [record()]).status, 'unmapped');
  assert.equal(Core.summarizeTube(inputCode, [point()], [config({ mappingBasis:'' })], [record()]).status, 'unmapped');
});

test('tube matching uses record historical config, never current mapping or point unit guess', () => {
  const c1 = config(), c2 = config({ id:'synthetic-config-2',revision:2,effectiveFrom:t0+H,regions:[region({ posFrom:2,posTo:2 })] });
  const first = record(), second = record({ id:'new-record',configId:c2.id,startAt:t0+H,endAt:t0+2*H });
  const old = Core.summarizeTube(inputCode, [point()], [c1,c2], [first,second]);
  assert.equal(old.status, 'available');
  assert.equal(old.summary.recordCount, 1);
  assert.equal(old.summary.durationMs, H);
  assert.deepEqual(old.points[0].configs.map(c => c.id), [c1.id]);
  const next = Core.summarizeTube(inputCode.replace('L001','L002'), [point()], [c1,c2], [first,second]);
  assert.equal(next.summary.recordCount, 1);
  assert.equal(next.summary.latestAt, t0+2*H);
  assert.equal(Core.summarizeTube(inputCode.replace('1G','2G'), [point()], [c1,c2], [first,second]).status, 'unmapped');
  assert.equal(Core.summarizeTube(inputCode, [point('synthetic-point-1','2')], [c1], [first]).status, 'unmapped');
});

test('unconfirmed historical mapping does not borrow a later confirmed config', () => {
  const c1 = config({ mappingConfirmed:false }), c2 = config({ id:'synthetic-config-2',revision:2,effectiveFrom:t0+H });
  const s = Core.summarizeTube(inputCode, [point()], [c1,c2], [record()]);
  assert.equal(s.status, 'no-records');
  assert.equal(s.summary.recordCount, 0);
  assert.equal(s.points.length, 1);
});

test('replacement boundary clips current tube only and retains area history and peak uncertainty', () => {
  const rs = [record({ endAt:t0+4*H,temperatureC:900 }),observation({ id:'new-observation',startAt:t0+3*H,temperatureC:630 })];
  const s = Core.summarizeTube(inputCode, [point()], [config()], rs, { installedAt:t0+2*H });
  assert.equal(s.installedAt, t0+2*H);
  assert.equal(s.summary.durationMs, 2*H);
  assert.equal(s.areaSummary.durationMs, 4*H);
  assert.equal(s.summary.peakC, 630);
  assert.equal(s.summary.estimatedPeakC, 900);
  assert.equal(s.summary.partialPeak, true);
  assert.equal(s.areaSummary.peakC, 900);
  assert.equal(s.points[0].summary.durationMs, 2*H);
  assert.equal(s.points[0].areaSummary.durationMs, 4*H);
  const oldOnly = Core.summarizeTube(inputCode, [point()], [config()], [record()], { installedAt:t0+2*H });
  assert.equal(oldOnly.status, 'no-records');
  assert.equal(oldOnly.summary.recordCount, 0);
  assert.equal(oldOnly.areaSummary.recordCount, 1);
});

test('replacement and reporting window compose without using pre-replacement observations', () => {
  const rs = [record({ endAt:t0+6*H }),observation({ id:'old-observation',startAt:t0+2*H,temperatureC:999 })];
  const s = Core.summarizeTube(inputCode, [point()], [config()], rs, { from:t0+H,to:t0+5*H,installedAt:t0+3*H }, mainMatrix);
  assert.equal(s.summary.durationMs, 2*H);
  assert.equal(s.summary.observationCount, 0);
  assert.equal(s.areaSummary.durationMs, 4*H);
  assert.equal(s.areaSummary.observationCount, 1);
  assert.equal(s.summary.peakC, null);
  assert.equal(s.areaSummary.peakC, 999);
  assert.equal(Core.summarizeTube(inputCode, [point()], [config()], rs, { from:t0,to:t0+H,installedAt:t0+2*H }).summary.durationMs, 0);
  const invalid = Core.summarizeTube(inputCode, [point()], [config()], rs, { installedAt:'bad' });
  assert.equal(invalid.summary.durationMs, 0);
  assert.ok(invalid.errors.length);
});

test('multiple mapped points union durations and inactive point keeps historical evidence', () => {
  const p1 = point(), p2 = point('synthetic-point-2');
  const c2 = config({ id:'second-point-config',pointId:p2.id });
  const rs = [record({ endAt:t0+2*H }),record({ id:'second-point-record',pointId:p2.id,configId:c2.id,startAt:t0+H,endAt:t0+3*H })];
  const s = Core.summarizeTube(inputCode, [{ ...p1,active:false },p2], [config(),c2], rs);
  assert.equal(s.points.length, 2);
  assert.equal(s.summary.durationMs, 3*H);
  assert.equal(s.areaSummary.durationMs, 3*H);
  assert.equal(s.summary.recordCount, 2);
});

test('interval evidence notes are mandatory and blank-note intervals never accumulate', () => {
  for (const note of ['', '   ', '\t\n']) {
    bad(Core.validateRecord(record({ note }), point(), [config()], now), /人工核定依据/);
    bad(Core.validateRecord(record({ note,endAt:null,verified:false }), point(), [config()], now), /人工核定依据/);
    const summary = Core.summarize([record({ note })], [config()]);
    assert.equal(summary.durationMs, 0);
    assert.equal(summary.excludedIntervalCount, 1);
  }
  good(Core.validateRecord(observation({ note:'' }), point(), [config()], now));
  good(Core.validateRecord(record({ note:' Synthetic operator-verified interval evidence ' }), point(), [config()], now));
});

test('RSQ output uses standard A1 nozzle identity while accepting historical A01', () => {
  const rsq = region({ sys:'SLB',comp:'RSQ',posFrom:null,posTo:null,tubeFrom:null,tubeTo:null,dirs:null,corners:[1],layers:['A'],nozzles:[1] });
  assert.deepEqual(Core.expandRegion(rsq, '1'), { count:1,codes:['1G-SLB-RSQ-J1-A1-Q'] });
  assert.equal(Core.matchesRegion('1G-SLB-RSQ-J1-A01-Q001', rsq, '1'), true);
  const c = config({ regions:[rsq] });
  const s = Core.summarizeTube('1G-SLB-RSQ-J1-A01-Q001', [point()], [c], [record()], { now });
  assert.equal(s.code, '1G-SLB-RSQ-J1-A1-Q');
  assert.equal(s.status, 'available');
});

test('current empty associations exclude future mappings and expired mappings without active evidence', () => {
  const c1 = config(), c2 = config({ id:'synthetic-config-2',revision:2,effectiveFrom:t0+H,regions:[region({ posFrom:2,posTo:2 })] });
  const futureOnly = config({ effectiveFrom:now+H });
  assert.equal(Core.summarizeTube(inputCode, [point()], [futureOnly], [], { now }).status, 'unmapped');
  assert.equal(Core.summarizeTube(inputCode, [point()], [futureOnly], [], { now:now+H }).status, 'no-records');
  assert.equal(Core.summarizeTube(inputCode, [point()], [c1,c2], [], { now }).status, 'unmapped');
  assert.equal(Core.summarizeTube(inputCode, [point()], [c1,c2], [record({ status:'void' })], { now }).status, 'unmapped');
  assert.equal(Core.summarizeTube(inputCode, [point()], [c1,c2], [], { now:t0 }).status, 'no-records');
  assert.equal(Core.summarizeTube(inputCode.replace('L001','L002'), [point()], [c1,c2], [], { now }).status, 'no-records');
  const historical = Core.summarizeTube(inputCode, [point()], [c1,c2], [record()], { now,installedAt:t0+H,from:t0+H,to:t0+2*H });
  assert.equal(historical.points.length, 1);
  assert.equal(historical.status, 'no-records');
  assert.equal(historical.summary.recordCount, 0);
  assert.equal(historical.areaSummary.recordCount, 0, 'areaSummary obeys requested window, not unrestricted history');
  const retained = Core.summarizeTube(inputCode, [point()], [c1,c2], [record()], { now,installedAt:t0+H });
  assert.equal(retained.points.length, 1);
  assert.equal(retained.areaSummary.recordCount, 1);
  assert.equal(retained.summary.recordCount, 0);
  const invalidNow = Core.summarizeTube(inputCode, [point()], [c1], [], { now:'invalid' });
  assert.equal(invalidNow.status, 'unmapped');
  assert.ok(invalidNow.errors.length);
});

test('domain calls do not mutate caller-owned inputs', () => {
  const p = point(), c = config(), r = record(), rg = region();
  const before = plain([p,c,r,rg]);
  Core.validateRegion(rg); Core.expandRegion(rg,'1'); Core.matchesRegion(inputCode,rg,'1');
  Core.validateConfig(c,p); Core.validateRecord(r,p,[c],now); Core.resolveConfig([c],p.id,t0);
  Core.summarize([r],[c]); Core.summarizeTube(inputCode,[p],[c],[r],{ installedAt:t0+100 });
  assert.deepEqual([p,c,r,rg], before);
});
