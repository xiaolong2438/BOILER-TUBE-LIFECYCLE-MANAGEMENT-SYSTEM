/* 超温累计可视化契约：月度并集、星期×小时热力图、排行筛选。
 * 只检查源码接线与数据口径，不启动浏览器；实际渲染由本地验收覆盖。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ui = readFileSync(new URL('../assets/app/overtemperature-v1.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../assets/app/overtemperature-v1.css', import.meta.url), 'utf8');

assert.match(ui, /function monthlySeries\(intervals, limit\)/, '月度序列函数必须存在');
assert.match(ui, /function heatmapBuckets\(intervals\)/, '时段热力图数据函数必须存在');
assert.match(ui, /function renderMonthlyTrend\(intervals\)/, '月度趋势图必须存在');
assert.match(ui, /function renderHeatmap\(intervals\)/, '时段热力图必须存在');
assert.match(ui, /renderMonthlyTrend\(s\.intervals\)/, '月度趋势必须使用服务端已裁剪的并集区间');
assert.match(ui, /renderHeatmap\(s\.intervals\)/, '热力图必须使用服务端已裁剪的并集区间');
assert.match(ui, /Math\.min\(end, interval\.endAt\) - Math\.max\(start, interval\.startAt\)/, '月度时长必须按区间交集累加，不能把跨月区间整段计入');
assert.match(ui, /Array\.from\(\{ length: 7 \}/, '热力图必须是 7 个星期行');
assert.match(ui, /Array\(24\)\.fill\(0\)/, '热力图必须是 24 个小时列');
assert.match(ui, /data-action="filterMonth"/, '月度条形应可筛选该月');
assert.match(ui, /data-action="focusPoint"/, '排行条形应可筛选该测点');
assert.match(ui, /name === 'filterMonth'/, '月份筛选动作必须接线');
assert.match(ui, /name === 'focusPoint'/, '测点筛选动作必须接线');
assert.match(ui, /有超温证据 /, '分析页应显示有证据的测点数量');

assert.match(css, /\.ot-viz-grid\s*\{[^}]*grid-template-columns/, '可视化网格样式必须存在');
assert.match(css, /\.ot-viz-card\s*\{/, '可视化卡片样式必须存在');
assert.match(css, /\.ot-heat-legend\s*\{/, '热力图图例样式必须存在');
assert.match(css, /\.ot-bar-row\s*\{[^}]*cursor:\s*pointer/, '可点击条形必须有指针提示');
assert.match(css, /@media \(min-width: 1700px\)[\s\S]*\.ot-viz-grid\s*\{[^}]*repeat\(2/, '宽屏才并排，窄屏保持单列可读');

console.log('ok - overtemperature visualization uses union intervals, 7x24 heatmap and clickable filters');
