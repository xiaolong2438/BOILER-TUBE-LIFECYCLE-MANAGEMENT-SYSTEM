/* 合成数据的导入解析测试：不读取真实月报、不连接共享服务、不写业务库。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
require('../assets/app/assistant-core-v1.js');
const Core = require('../assets/app/overtemperature-core-v1.js');
const Import = require('../assets/app/overtemperature-import-v1.js');
const ms = Core.parseTime;

function point(id, tag, unit = '1') {
  return { id, unit, tag, name: '合成测点 ' + id, measurementType: 'tube_wall', location: '合成位置', active: true, revision: 1 };
}
function config(id, pointId, effectiveFrom, limitC, revision = 1) {
  return { id, pointId, effectiveFrom, revision, regions: [], mappingConfirmed: false, mappingBasis: '', limitC, limitBasis: '合成测试依据' };
}
function reportItem(overrides = {}) {
  return Object.assign({
    row: 2, tag: 'DCS1_SYN001', unit: '1', name: '合成壁温1', limitC: 498,
    temperatureC: 499.4, startAt: ms('2026-10-16T00:48:59'), endAt: ms('2026-10-16T00:50:04'),
    durationSeconds: 65, crew: '丙班', meanC: 498.8, overType: '越高限', errors: []
  }, overrides);
}

/* 1. 表头与时长解析 */
assert.equal(Import.headerKey('限值 ?'), '限值');
assert.equal(Import.headerKey(' 总时长(秒) '), '总时长(秒)');
assert.equal(Import.headerKey('限值（℃）'), '限值(℃)');
assert.deepEqual(Import.parseDurationSeconds('00:01:23'), { seconds: 83, kind: 'clock' });
assert.deepEqual(Import.parseDurationSeconds('83'), { seconds: 83, kind: 'seconds' });
assert.deepEqual(Import.parseDurationSeconds(0.5), { seconds: 43200, kind: 'excel-time' });
assert.equal(Import.parseDurationSeconds('不是时间').kind, 'invalid');
console.log('ok - header and duration parsing');

/* 2. 时间解析：文本、Date、Excel 序列号 */
assert.equal(Import.parseTimestamp('2026-10-09 12:59:19', ms), ms('2026-10-09T12:59:19'));
assert.equal(Import.parseTimestamp('2026/10/9 12:59', ms), ms('2026-10-09T12:59:00'));
assert.equal(Import.parseTimestamp(new Date(2026, 9, 9, 12, 59, 19), ms), ms('2026-10-09T12:59:19'));
const serial = (Date.UTC(2026, 9, 9, 12, 59, 19) - Date.UTC(1899, 11, 30)) / 86400000;
assert.equal(Import.parseTimestamp(serial, ms), ms('2026-10-09T12:59:19'));
assert.equal(Import.parseTimestamp('2026-10-09 12:59:19 +08:00', ms), ms('2026-10-09T12:59:19'));
console.log('ok - timestamp parsing');

/* 3. 月报行归一化：表头带空格/问号也能识别，时长与起止时间互相核对 */
const reportMatrix = [
  ['序号', '点位', '描述', '班组', '限值 ?', '最值', '最值持续时间 ?', '均值', '越限类型', '开始时间', '结束时间', '总时长(秒)'],
  ['18', 'DCS1_SYN001', '合成壁温1', '丁班', '498', '499.40', '00:00:21', '498.80', '越高限', '2026-10-16 00:48:59', '2026-10-16 00:50:04', '00:01:05'],
  ['19', 'DCS1_SYN002', '合成壁温2', '丁班', '498', '499.00', '00:00:20', '498.50', '越高限', '2026-10-16 00:48:59', '2026-10-16 00:50:00', '00:00:30']
];
const report = Import.normalizeReportMatrix(reportMatrix, ms);
assert.equal(report.items.length, 2);
assert.equal(report.items[0].tag, 'DCS1_SYN001');
assert.equal(report.items[0].unit, '1');
assert.equal(report.items[0].limitC, 498);
assert.equal(report.items[0].temperatureC, 499.4);
assert.equal(report.items[0].durationSeconds, 65);
assert.equal(report.items[0].startAt, ms('2026-10-16T00:48:59'));
assert.equal(report.items[0].errors.length, 0);
assert.equal(report.items[1].errors.length, 1);
assert.match(report.items[1].errors[0], /总时长/);
console.log('ok - monthly report normalization and duration cross-check');

/* 4. 月报匹配与状态：可导入、未匹配、缺配置、限值不一致、未超限、跨配置、重复 */
const p1 = point('tp-syn-1', 'DCS1_SYN001');
const p2 = point('tp-syn-2', 'DCS1_SYN002');
const p3 = point('tp-syn-3', 'DCS1_SYN003');
const c1 = config('tc-syn-1', p1.id, ms('2026-01-01T00:00:00'), 498);
const c3a = config('tc-syn-3a', p3.id, ms('2026-01-01T00:00:00'), 498, 1);
const c3b = config('tc-syn-3b', p3.id, ms('2026-10-20T00:00:00'), 498, 2);
const configs = new Map([[p1.id, [c1]], [p2.id, []], [p3.id, [c3a, c3b]]]);
const pointsByTag = { '1|DCS1_SYN001': p1, '1|DCS1_SYN002': p2, '1|DCS1_SYN003': p3 };
const duplicateExisting = new Set([[p1.id, ms('2026-10-21T19:49:29'), ms('2026-10-21T19:51:41'), 'interval'].join('|')]);
const evaluated = Import.evaluateReport([
  reportItem(),
  reportItem({ row: 3, tag: 'DCS1_SYN999' }),
  reportItem({ row: 4, tag: 'DCS1_SYN002' }),
  reportItem({ row: 5, limitC: 500 }),
  reportItem({ row: 6, temperatureC: 497 }),
  reportItem({ row: 7, tag: 'DCS1_SYN003', startAt: ms('2026-10-19T23:00:00'), endAt: ms('2026-10-20T01:00:00') }),
  reportItem(),
  reportItem({ row: 8, startAt: ms('2026-10-21T19:49:29'), endAt: ms('2026-10-21T19:51:41') }),
  reportItem({ row: 9, startAt: ms('2026-10-23T09:03:31'), endAt: ms('2026-10-23T09:03:58'), durationSeconds: 27, temperatureC: 498, meanC: 498 })
], {
  core: Core, now: ms('2026-11-01T00:00:00'), pointsByTag, existing: duplicateExisting,
  configsFor: id => configs.get(id) || []
});
const status = row => evaluated.rows[row].status;
assert.equal(status(0), 'ok');
assert.equal(status(1), 'error');
assert.match(evaluated.rows[1].messages[0], /未找到/);
assert.equal(status(2), 'error');
assert.match(evaluated.rows[2].messages[0], /配置/);
assert.equal(status(3), 'error');
assert.match(evaluated.rows[3].messages[0], /不一致/);
assert.equal(status(4), 'error');
assert.match(evaluated.rows[4].messages[0], /低于限值/);
assert.equal(status(5), 'error');
assert.match(evaluated.rows[5].messages[0], /配置生效边界/);
assert.equal(status(6), 'duplicate');
assert.equal(status(7), 'duplicate');
assert.equal(status(8), 'ok');
assert.deepEqual(evaluated.summary, { total: 9, ok: 2, duplicate: 2, error: 5 });
console.log('ok - report matching, limits, config boundary and duplicates');

/* 4b. 未登记点位：按报表自动建点草稿，管屏留空待检修确认 */
assert.equal(Import.inferMeasurementType('全大屏过热器出口壁温8'), 'tube_wall');
assert.equal(Import.inferMeasurementType('低温过热器出口集箱壁温'), 'header_wall');
assert.equal(Import.inferMeasurementType('过热蒸汽温度1'), 'steam');
assert.equal(Import.inferSystem('全大屏过热器出口壁温8'), 'DPGRQ');
assert.equal(Import.inferSystem('低温再热器入口管壁'), 'DZRQ');
const auto = Import.evaluateReport([
  reportItem({ row: 2, tag: 'DCS1_HAH61CT008', name: '全大屏过热器出口壁温8' }),
  reportItem({ row: 3, tag: 'DCS1_SYN010', name: '合成壁温10', limitC: null }),
  reportItem({ row: 4, tag: 'DCS1_SYN011', name: '' }),
  reportItem({ row: 5, tag: 'DCS1_HAH61CT008', name: '全大屏过热器出口壁温8' })
], {
  core: Core, now: ms('2026-11-01T00:00:00'), pointsByTag: {}, existing: new Set(),
  configsFor: () => [], autoCreate: true
});
assert.equal(auto.rows[0].status, 'ok');
assert.equal(auto.rows[0].willCreate, true);
assert.deepEqual(auto.rows[0].draftPoint, {
  unit: '1', tag: 'DCS1_HAH61CT008', name: '全大屏过热器出口壁温8',
  measurementType: 'tube_wall', system: 'DPGRQ', location: '', panel: '', active: true
});
assert.equal(auto.rows[1].status, 'error');
assert.match(auto.rows[1].messages[0], /有效限值/);
assert.equal(auto.rows[2].status, 'error');
assert.match(auto.rows[2].messages[0], /缺少描述/);
assert.equal(auto.rows[3].status, 'duplicate');
assert.deepEqual(auto.summary, { total: 4, ok: 1, duplicate: 1, error: 2 });
console.log('ok - unregistered points become blank-panel drafts for maintenance confirmation');

/* 5. 记录构造：稳定 id、人工核定、来源备注 */
const record = Import.recordFrom(reportItem(), p1, c1, '合成月报.xls');
assert.match(record.id, /^tr-[0-9a-f]{16}$/);
assert.equal(record.pointId, p1.id);
assert.equal(record.configId, c1.id);
assert.equal(record.kind, 'interval');
assert.equal(record.verified, true);
assert.equal(record.temperatureC, 499.4);
assert.match(record.note, /班组：丙班/);
assert.match(record.note, /来源：合成月报\.xls/);
assert.equal(Import.recordFrom(reportItem(), p1, c1, '合成月报.xls').id, record.id);
assert.notEqual(Import.recordFrom(reportItem({ startAt: ms('2026-10-22T00:00:00') }), p1, c1, '合成月报.xls').id, record.id);
console.log('ok - stable record identity and source note');

/* 6. 测点台账归一化：机组、限值依据、Tag 重复 */
const pointMatrix = [
  ['机组', '测点分组', 'DCS Tag', '测点名称', '测量类型', '测量类型代码', '系统码', '安装位置', '温度限值(℃)', '限值依据', '启用状态'],
  ['1号机组', '低温过热器出口集箱管壁温度', 'DCS1_SYN001', '合成集箱壁温1', '集箱壁温', 'header_wall', 'DGRQ', '1号机组 · 合成集箱', '472', '合成依据', '启用'],
  ['1号机组', '低温过热器出口集箱管壁温度', 'DCS1_SYN002', '合成集箱壁温2', '集箱壁温', 'header_wall', 'DGRQ', '1号机组 · 合成集箱', '472', '', '启用'],
  ['2号机组', '低温过热器出口集箱管壁温度', 'DCS1_SYN003', '合成集箱壁温3', '集箱壁温', 'header_wall', 'DGRQ', '2号机组 · 合成集箱', '472', '合成依据', '停用']
];
const points = Import.normalizePointMatrix(pointMatrix);
assert.equal(points.items.length, 3);
assert.equal(points.items[0].unit, '1');
assert.equal(points.items[0].measurementType, 'header_wall');
assert.equal(points.items[0].limitC, 472);
assert.equal(points.items[0].errors.length, 0);
assert.equal(points.items[1].errors.length, 1);
assert.match(points.items[1].errors[0], /限值依据/);
assert.equal(points.items[2].active, false);
assert.match(points.items[2].errors[0], /机组列与 DCS Tag 前缀不一致/);
const pointPreview = Import.evaluatePoints(points.items, new Set(['1|DCS1_SYN001']));
assert.deepEqual(pointPreview.summary, { total: 3, ok: 0, duplicate: 1, error: 2 });
assert.equal(pointPreview.rows[0].status, 'duplicate');
console.log('ok - point ledger normalization and duplicate detection');

/* 6b. 投产日期：有效日期进入终身累计起算，空白允许，非法日期阻断导入 */
const commissionedMatrix = [
  ['机组', 'DCS Tag', '测点名称', '测量类型', '投产日期'],
  ['1号机组', 'DCS1_LBA10CT003', '合成测点', '管壁温度', '2019/06/30'],
  ['1号机组', 'DCS1_LBA10CT004', '合成测点二', '管壁温度', '2020-13-40'],
  ['1号机组', 'DCS1_LBA10CT005', '合成测点三', '管壁温度', '']
];
const commissioned = Import.normalizePointMatrix(commissionedMatrix, ms);
assert.equal(commissioned.items[0].commissionedAt, ms('2019-06-30T00:00:00'));
assert.equal(commissioned.items[0].errors.length, 0);
assert.equal(commissioned.items[1].commissionedAt, null);
assert.match(commissioned.items[1].errors[0], /投产日期无效/);
assert.equal(commissioned.items[2].commissionedAt, null);
assert.equal(commissioned.items[2].errors.length, 0, '投产日期可留空，由后续补填');
console.log('ok - commissioning date parses strictly and stays optional');

/* 7. UI 接线：两个入口、文件/粘贴解析、确认后才写入 */
const ui = readFileSync(new URL('../assets/app/overtemperature-v1.js', import.meta.url), 'utf8');
assert.match(ui, /action\('导入测点台账', 'importPoints'\)/);
assert.match(ui, /action\('导入月度报表', 'importReport'/);
assert.match(ui, /id="ot-import-file"/);
assert.match(ui, /id="ot-import-confirm"/);
assert.match(ui, /BTLazy\.ensure\('xlsx'\)/);
assert.match(ui, /if \(!imp\.confirmed\)/);
assert.match(ui, /normalizePointMatrix\(matrix, core\(\)\.parseTime\)/, '测点导入必须显式传入时间解析函数');
assert.match(ui, /point\.commissionedAt = item\.commissionedAt/, '测点导入必须写入投产日期');
console.log('ok - import UI wiring requires explicit confirmation');

console.log('ok - overtemperature import parsing');
