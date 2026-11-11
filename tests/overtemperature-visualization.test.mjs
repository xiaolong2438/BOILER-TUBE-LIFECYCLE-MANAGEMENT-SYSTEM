/* 超温累计可视化契约：同一测点先月后年累加、不同测点永不合并、时段热力图、排行筛选。
 * 只检查源码接线与数据口径，不启动浏览器；实际渲染由本地验收覆盖。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ui = readFileSync(new URL('../assets/app/overtemperature-v1.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../assets/app/overtemperature-v1.css', import.meta.url), 'utf8');

assert.match(ui, /function heatmapBuckets\(intervals\)/, '时段热力图数据函数必须存在');
assert.match(ui, /function renderMonthlyPointTrend\(rows\)/, '按测点分月的趋势图必须存在');
assert.doesNotMatch(ui, /renderMonthlyTrend/, '不得保留跨测点合并的月度趋势图');
assert.match(ui, /function renderHeatmap\(intervals\)/, '时段热力图必须存在');
assert.match(ui, /renderMonthlyPointTrend\(rows\)/, '月度趋势必须按测点分行，不能合并不同点位');
assert.match(ui, /renderHeatmap\(s\.intervals\)/, '热力图必须使用服务端已裁剪的并集区间');
assert.match(ui, /Math\.min\(end, interval\.endAt\) - Math\.max\(start, interval\.startAt\)/, '月度时长必须按区间交集累加，不能把跨月区间整段计入');
assert.match(ui, /Array\.from\(\{ length: 7 \}/, '热力图必须是 7 个星期行');
assert.match(ui, /Array\(24\)\.fill\(0\)/, '热力图必须是 24 个小时列');
assert.match(ui, /同一测点跨月累加，不同测点不合并/, '趋势图必须写明同点跨月规则');
assert.match(ui, /该点跨月累计/, '矩阵合计列必须是单点跨月累计');
assert.match(ui, /不进入点位累计/, '热力图必须说明不参与点位累计');
assert.match(ui, /data-action="focusMonthPoint"/, '趋势图与矩阵应可筛选该月该测点');
assert.match(ui, /data-action="focusPoint"/, '排行与图例应可筛选该测点');
assert.match(ui, /name === 'focusMonthPoint'/, '月份×测点下钻动作必须接线');
assert.match(ui, /name === 'focusPoint'/, '测点筛选动作必须接线');
assert.match(ui, /有超温证据 /, '分析页应显示有证据的测点数量');
assert.match(ui, /同一测点不同时间都相加/, '分析卡片必须说明同一测点不同时间都要累加');

assert.match(css, /\.ot-viz-grid\s*\{[^}]*grid-template-columns/, '可视化网格样式必须存在');
assert.match(css, /\.ot-viz-card\s*\{/, '可视化卡片样式必须存在');
assert.match(css, /\.ot-heat-legend\s*\{/, '热力图图例样式必须存在');
assert.match(css, /\.ot-point-legend\s*\{/, '测点图例样式必须存在');
assert.match(css, /\.ot-bar-row\s*\{[^}]*cursor:\s*pointer/, '可点击条形必须有指针提示');
assert.match(css, /@media \(min-width: 1700px\)[\s\S]*\.ot-viz-grid\s*\{[^}]*repeat\(2/, '宽屏才并排，窄屏保持单列可读');

/* 月份 × 测点矩阵：按点按月做区间并集，管屏留空待检修确认，单元格可下钻。 */
assert.match(ui, /function monthPointMatrix\(rows, limit\)/, '月份 × 测点矩阵数据函数必须存在');
assert.match(ui, /function renderMonthPointMatrix\(rows\)/, '月份 × 测点矩阵渲染函数必须存在');
assert.match(ui, /renderMonthPointMatrix\(rows\)/, '分析页必须渲染月份 × 测点矩阵');
assert.match(ui, /data-action="focusMonthPoint"/, '矩阵单元格应可筛选该月该测点');
assert.match(ui, /name === 'focusMonthPoint'/, '矩阵下钻动作必须接线');
assert.match(ui, /p\.panel \? esc\(p\.panel\) : badge\('待确认', 'warn'\)/, '管屏未确认时必须显示待确认');
assert.match(ui, /待机组检修时确认/, '矩阵应说明管屏留空含义');
assert.match(ui, /function clockDuration\(ms\)/, '矩阵单元格应显示精确到秒的累计时长');
assert.match(ui, /clockDuration\(cell\.ms\)/, '矩阵单元格必须使用秒级时长');
assert.match(css, /\.ot-matrix-scroll\s*\{/, '矩阵需要横向滚动容器');
assert.match(css, /\.ot-matrix-cell\s*\{[^}]*cursor:\s*pointer/, '矩阵可点击单元格必须有指针提示');

/* 年度 × 测点矩阵：先按自然月累加，再把同一测点的各月合计汇入年度。 */
assert.match(ui, /function yearPointMatrix\(rows, limit\)/, '年度 × 测点矩阵数据函数必须存在');
assert.match(ui, /function renderYearPointMatrix\(rows\)/, '年度 × 测点矩阵渲染函数必须存在');
assert.match(ui, /renderYearPointMatrix\(rows\)/, '分析页必须渲染年度 × 测点矩阵');
assert.match(ui, /data-action="focusYearPoint"/, '年度矩阵单元格应可筛选该年该测点');
assert.match(ui, /name === 'focusYearPoint'/, '年度下钻动作必须接线');
assert.match(ui, /先按月累加，再把同一测点的各月合计汇入所属年度/, '年度矩阵必须写明先月后年');
assert.match(ui, /年度累计 = 该测点该年度各月累计之和/, '年度矩阵必须说明年度由该点同年度月度合计相加');
assert.match(ui, /月度合计为所示月份之和/, '月度矩阵必须说明合计口径');
assert.match(ui, /同一测点的各月合计再按年度累加/, '分析页必须写明先月后年的累计口径');

/* 投产以来 × 超限分档：精确点位终身累计，分档只做筛查，不折算寿命。 */
assert.match(ui, /function lifetimeMatrix\(rows\)/, '投产以来矩阵数据函数必须存在');
assert.match(ui, /function renderLifetimeMatrix\(rows\)/, '投产以来矩阵渲染函数必须存在');
assert.match(ui, /renderLifetimeMatrix\(rows\)/, '分析页必须渲染投产以来累计');
assert.match(ui, /“机组 \+ DCS Tag”完全一致/, '投产以来累计必须写明精确点位身份');
assert.match(ui, /跨年度持续累加且不受上方时间筛选限制/, '投产以来累计必须不受筛选窗口限制');
assert.match(ui, /Larson-Miller/, '规范口径必须引用寿命评定方法');
assert.match(ui, /筛查模板，不是规范强制阈值/, '分档必须声明不是规范强制阈值');
assert.match(ui, /不能折算成寿命损耗或剩余寿命/, '分档不得被解释为寿命损耗');
assert.match(ui, /beforeStartRecordCount/, '必须标注投产日期之前的记录被排除');
assert.match(ui, /未登记投产日期[\s\S]*最早登记记录起算/, '缺少投产日期时必须明确回退口径');
assert.match(ui, /lifetimeMatrix\s*\}/, 'lifetimeMatrix 必须导出供契约测试');
assert.match(css, /\.ot-band-danger\s*\{/, '高幅度分档必须有独立样式');
assert.match(css, /\.ot-band-warn\s*\{/, '中幅度分档必须有独立样式');

const box = { console, document: null };
box.window = box;
vm.runInContext(ui, vm.createContext(box));
const at = value => Date.parse(value + '+08:00');
const rows = [
  { point: { id: 'p1', name: '测点一', unit: '1', tag: 'T1', panel: '' }, summary: { intervals: [
    { startAt: at('2026-09-30T23:30:00'), endAt: at('2026-10-01T00:30:00') },
    { startAt: at('2026-10-16T00:48:59'), endAt: at('2026-10-16T02:48:59') }
  ] } },
  { point: { id: 'p2', name: '测点一', unit: '1', tag: 'T2', panel: '前屏' }, summary: { intervals: [
    { startAt: at('2026-10-10T00:00:00'), endAt: at('2026-10-10T01:00:00') }
  ] } },
  { point: { id: 'p3', name: '测点二', unit: '1', tag: 'T3', panel: '' }, summary: { intervals: [] } }
];
const matrix = box.BTOvertemperature.monthPointMatrix(rows, 12);
assert.deepEqual([...matrix.months], ['2026-09', '2026-10'], '矩阵列应为存在区间的月份');
assert.equal(matrix.items.length, 2, '没有区间的测点不占矩阵行；同名不同点位必须分行');
assert.deepEqual(Array.from(matrix.items[0].cells, cell => cell.ms), [1800000, 9000000], '跨月区间必须按月拆分，不能整段计入首月');
assert.equal(matrix.items[0].totalMs, 10800000, '同一测点的跨月累计应为各月时长之和');
assert.equal(matrix.items[1].point.id, 'p2', '同名不同点位不能合并到同一行');
assert.equal(matrix.items[1].totalMs, 3600000, '不同测点各自累计，即使描述相同也不能相加');
assert.equal(matrix.items[0].point.panel, '', '管屏保持留空供检修确认');
assert.equal(box.BTOvertemperature.monthPointMatrix(rows, 1).truncated, true, '超过窗口的历史月份应标记截断');
assert.deepEqual([...box.BTOvertemperature.monthPointMatrix(rows, 1).months], ['2026-10'], '截断时保留最近月份');

const crossYearRows = [
  { point: { id: 'a1', name: '年度测点', unit: '1', tag: 'A1', panel: '' }, summary: { intervals: [
    { startAt: at('2025-12-31T23:30:00'), endAt: at('2026-01-01T00:30:00') },
    { startAt: at('2026-02-01T00:00:00'), endAt: at('2026-02-01T01:00:00') }
  ] } },
  { point: { id: 'a2', name: '年度测点', unit: '1', tag: 'A2', panel: '前屏' }, summary: { intervals: [
    { startAt: at('2026-03-01T00:00:00'), endAt: at('2026-03-01T00:30:00') }
  ] } }
];
const annual = box.BTOvertemperature.yearPointMatrix(crossYearRows, 5);
assert.deepEqual([...annual.years], ['2025', '2026'], '年度列应为存在区间的年份');
assert.equal(annual.items.length, 2, '同名不同点位在年度矩阵中也必须分行');
const a1 = annual.items.find(item => item.point.id === 'a1');
assert.deepEqual(Array.from(a1.cells, cell => cell.ms), [1800000, 5400000], '跨年区间必须先按自然月拆入各年，年度为该点同年各月合计');
assert.equal(a1.totalMs, 7200000, '同一测点不同年份的合计应累加');
const a2 = annual.items.find(item => item.point.id === 'a2');
assert.equal(a2.totalMs, 1800000, '不同测点各自累计，即使描述相同也不能相加');
assert.equal(box.BTOvertemperature.yearPointMatrix(crossYearRows, 1).truncated, true, '超过窗口的历史年度应标记截断');
assert.deepEqual([...box.BTOvertemperature.yearPointMatrix(crossYearRows, 1).years], ['2026'], '截断时保留最近年度');
const monthlyCrossYear = box.BTOvertemperature.monthPointMatrix(crossYearRows, 240);
const a1Months = monthlyCrossYear.items.find(item => item.point.id === 'a1');
assert.equal(a1.cells[1].ms, a1Months.cells.find(cell => cell.key === '2026-01').ms + a1Months.cells.find(cell => cell.key === '2026-02').ms, '年度累计必须等于该点同年各月累计之和');

const band = (key, fromC, toC, ms) => ({ key, fromC, toC, ms, recordCount: ms ? 1 : 0 });
const lifetime = (patch = {}) => ({ basis: 'commissioned', fromAt: at('2024-01-01T00:00:00'), toAt: at('2026-11-01T00:00:00'), durationMs: 7200000, recordCount: 2, intervalRecordCount: 2, openCount: 0, beforeStartRecordCount: 0, lastEvidenceAt: at('2026-10-16T02:48:59'), bands: [band('b0', 0, 5, 0), band('b1', 5, 10, 1800000), band('b2', 10, 20, 0), band('b3', 20, null, 5400000)], bandDurationMs: 7200000, ...patch });
const lifeRows = [
  { point: { id: 'life1', name: '测点一', unit: '1', tag: 'DCS1_LBA10CT003', panel: '' }, lifetime: lifetime() },
  { point: { id: 'life2', name: '测点一', unit: '1', tag: 'DCS1_LBA10CT004', panel: '前屏' }, lifetime: lifetime({ durationMs: 3600000, intervalRecordCount: 1, bands: [band('b0', 0, 5, 0), band('b1', 5, 10, 0), band('b2', 10, 20, 3600000), band('b3', 20, null, 0)], bandDurationMs: 3600000 }) },
  { point: { id: 'life3', name: '无证据测点', unit: '1', tag: 'DCS1_LBA10CT005', panel: '' }, lifetime: lifetime({ durationMs: 0, recordCount: 0, intervalRecordCount: 0, bands: [], bandDurationMs: 0 }) }
];
const lifetimeRows = box.BTOvertemperature.lifetimeMatrix(lifeRows);
assert.equal(lifetimeRows.length, 2, '同名但 DCS Tag 不同的测点必须分行，无记录点不占行');
assert.deepEqual(Array.from(lifetimeRows, item => item.point.id), ['life1', 'life2'], '按投产以来累计降序排列');
assert.equal(lifetimeRows[0].bands.b1.ms + lifetimeRows[0].bands.b3.ms, lifetimeRows[0].lifetime.durationMs, '各档之和必须等于终身累计');
assert.equal(box.BTOvertemperature.lifetimeMatrix([]).length, 0, '空输入必须安全返回空矩阵');

console.log('ok - overtemperature visualization accumulates monthly, yearly and lifetime per exact point with screening bands');
