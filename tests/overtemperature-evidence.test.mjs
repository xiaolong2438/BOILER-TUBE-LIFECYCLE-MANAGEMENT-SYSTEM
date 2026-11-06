import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'assets/app/overtemperature-evidence-v1.js'), 'utf8');
const app = readFileSync(resolve(root, 'assets/app/app-v7.9.js'), 'utf8');
const html = readFileSync(resolve(root, '炉管全生命周期管理系统.html'), 'utf8');
const now = Date.now();
const summary = { recordCount: 3, observationCount: 1, intervalRecordCount: 2, openCount: 0, mergedCount: 1, durationMs: 7200000, longestMs: 7200000, peakC: 520, maxExcessC: 20, intervals: [], latestAt: now, partial: false };
// All data in this file are isolated synthetic fixtures, never field records.
const point = { id: 'synthetic-point', unit: '1', tag: 'SYNTHETIC-01', name: '合成测试集箱壁温', measurementType: 'header_wall' };
const config = { id: 'synthetic-config', revision: 1, effectiveFrom: 1735660800000, limitC: 500, limitBasis: '合成测试限值，非工程依据', mappingBasis: '合成测试区域' };
const payload = () => ({ serverTime: now, tubeEvidence: { status: 'available', points: [{ point, configs: [config], summary: { ...summary } }], summary: { ...summary }, areaSummary: { ...summary, durationMs: 10800000 }, installedAt: null } });
function setup(request = async () => payload(), replacements = []) {
  const context = vm.createContext({
    console, Date, Map, Promise, URLSearchParams, AbortController, setTimeout, clearTimeout, queueMicrotask,
    BTOvertemperature: { request },
    BTOvertemperatureCore: {
      parseTime: value => { const ms = Date.parse(value + '+08:00'); return Number.isFinite(ms) ? ms : null; },
      formatTime: value => new Date(value).toISOString()
    },
    normalizedTubeCode: value => String(value).trim().toUpperCase().replace(/-([QW])\d{1,3}$/, '-$1'),
    tubePositionKey: value => String(value).trim().toUpperCase().replace(/-[QW]\d*$/, ''),
    userDB: { replacements }
  });
  vm.runInContext(source, context);
  return { api: context.BTTemperatureEvidence, context };
}
const code = '1G-DGRQ-GQ-1KJ-L001-D001-Q';

{
  let calls = 0;
  const { api } = setup(async () => { calls += 1; return payload(); });
  const [one, two] = await Promise.all([api.load(code), api.load(code)]);
  assert.equal(calls, 1, 'same-code simultaneous loads share one request');
  assert.equal(one, two);
  assert.equal(one.status, 'available');
  await api.load(code);
  assert.equal(calls, 1);
  await api.load(code, { force: true });
  assert.equal(calls, 2);
  const text = api.toText(one);
  assert.match(text, /人工登记/);
  assert.match(text, /服役起点未登记/);
  assert.match(text, /不折算寿命/);
  assert.match(text, /合成测试限值/);
  assert.match(text, /2 h/);
  assert.match(api.bodyHTML(one), /集箱壁温（区域代表）/);
}
{
  const { api } = setup(async path => {
    const query = new URLSearchParams(path.split('?')[1]);
    assert.equal(Number(query.get('installedAt')), Date.parse('2025-02-01T00:00:00+08:00'));
    return payload();
  }, [{ oldCode: code, newCode: code, date: '2025-01-01' }, { oldCode: code, newCode: code, date: '2025-02-01' }]);
  const result = await api.load(code);
  assert.equal(result.installedAt, Date.parse('2025-02-01T00:00:00+08:00'));
  assert.match(api.toText(result), /最近换管日/);
  assert.match(api.toText(result), /日精度/);
}
{
  const { api } = setup();
  const before = { target: code, report: '壁厚原报告', rateValue: 0.04, rul: 32000, thresholdYear: '2030.2', replacementWarning: { level: 'normal' }, compositeScore: 2, compositeRisk: '关注', compositeSignals: { riskAdditions: 0 }, prediction: [{ year: 2027, val: 5.8 }] };
  const invariant = JSON.stringify([before.rateValue, before.rul, before.thresholdYear, before.replacementWarning, before.compositeScore, before.compositeRisk, before.prediction]);
  await api.attachAnalysis(before);
  assert.equal(JSON.stringify([before.rateValue, before.rul, before.thresholdYear, before.replacementWarning, before.compositeScore, before.compositeRisk, before.prediction]), invariant);
  assert.equal(before.compositeSignals.riskAdditions, 0);
  assert.match(before.report, /^壁厚原报告/);
  assert.match(before.report, /关联温度与超温辅助证据/);
  await api.attachAnalysis(before);
  assert.equal(before.report.split('【关联温度与超温辅助证据】').length, 2, 'refresh replaces the evidence chapter, not appends a duplicate');
}
{
  const { api } = setup(async () => { throw new Error('温度数据库尚未迁移'); });
  const result = await api.load(code);
  assert.equal(result.status, 'error');
  assert.match(api.toText(result), /不可用/);
  assert.doesNotMatch(api.toText(result), /已确认超温时长 0/);
  assert.match(api.bodyHTML(result), /尚未迁移/);
}
{
  const { api } = setup(async () => ({ tubeEvidence: null }));
  assert.equal((await api.load(code)).status, 'error');
}
{
  const { api } = setup(async () => ({ ...payload(), tubeEvidence: { ...payload().tubeEvidence, status: 'unmapped' } }));
  const result = await api.load(code);
  assert.match(api.toText(result), /尚无已确认/);
  assert.doesNotMatch(api.toText(result), /正常/);
}
{
  const { api } = setup(async () => ({ ...payload(), tubeEvidence: { ...payload().tubeEvidence, status: 'no-records' } }));
  const result = await api.load(code);
  assert.match(api.toText(result), /没有有效登记/);
  assert.match(api.toText(result), /不能据此判为正常/);
}
{
  const data = payload();
  data.tubeEvidence.summary.partial = true;
  data.tubeEvidence.summary.estimatedPeakC = 530;
  data.tubeEvidence.summary.peakC = null;
  data.tubeEvidence.points[0].point = { ...point, name: '<synthetic-name>' };
  const { api } = setup(async () => data);
  const result = await api.load(code);
  assert.match(api.toText(result), /不代表窗口内峰值/);
  assert.match(api.bodyHTML(result), /&lt;synthetic-name&gt;/);
  assert.doesNotMatch(api.bodyHTML(result), /<synthetic-name>/);
}
{
  let finish;
  const { api } = setup(() => new Promise(resolve => { finish = resolve; }));
  const analysis = { target: code, report: '原报告' };
  const waiting = api.attachAnalysis(analysis);
  api.invalidate();
  finish(payload());
  await waiting;
  assert.equal(analysis.report, '原报告', 'old in-flight generation cannot attach stale evidence');
}
{
  const data = payload();
  data.tubeEvidence.points[0].configs = [{ ...config, limitC: null, limitBasis: '' }];
  const { api } = setup(async () => data);
  const result = await api.load(code);
  assert.match(api.bodyHTML(result), /限值未配，不可判定/);
  assert.match(api.toText(result), /缺限值不能解释为0超温/);
}
{
  const { api } = setup(async () => ({ ...payload(), tubeEvidence: { ...payload().tubeEvidence, errors: ['测试窗口错误，不可忽略'] } }));
  const result = await api.load(code);
  assert.equal(result.status, 'error');
  assert.match(api.toText(result), /测试窗口错误/);
}
assert.match(html, /data-view="overtemperature"/);
assert.match(html, /id="view-overtemperature"/);
assert.match(html, /id="ai-thermal-evidence"/);
const lazy = readFileSync(resolve(root, 'assets/app/lazy-v1.js'), 'utf8');
assert.ok(lazy.indexOf('assets/app/assistant-core-v1.js') < lazy.indexOf('assets/app/overtemperature-core-v1.js'), '超温组必须先加载 assistant-core');
assert.ok(lazy.indexOf('assets/app/overtemperature-core-v1.js') < lazy.indexOf('assets/app/overtemperature-v1.js'), '超温核心模块必须先于视图模块');
assert.ok(!html.includes('src="assets/app/overtemperature-v1.js"'), '超温模块必须懒加载，不能随首屏加载');
assert.match(app, /BTTemperatureEvidence\?\.profileHTML\(code\)/);
assert.match(app, /await window\.BTTemperatureEvidence\.attachAnalysis\(data/);
assert.match(app, /不得凭集箱壁温、区域温度或累计超温时长生成寿命折减系数/);
assert.match(app, /auditLLMText\(text, evidenceText\)/);
assert.match(app, /filter\(btn => btn.dataset.view !== 'overtemperature'\)/, 'existing keyboard shortcuts stay mapped');
console.log('ok - temperature evidence: async state, tube history, unchanged predictions, and UI integration');
