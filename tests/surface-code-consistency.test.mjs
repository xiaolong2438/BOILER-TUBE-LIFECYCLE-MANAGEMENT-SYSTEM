import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 受热面字母缩写必须与编码系统码一致（SLB/GGRQ/GZRQ/...），
 * 不允许再使用旧的 ASME 风格缩写（HSH/HRH/LSH/...）。
 * 检修计划的受热面筛选值直接参与 row.sys 比较，写错会导致筛选结果为空。
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
const html = read('炉管全生命周期管理系统.html');
const app = read('assets/app/app-v7.9.js');

/* 编码系统码：CODE_SYSTEMS + 仅存在于材料库的顶棚/包墙 */
const codeSystems = [...app.matchAll(/\{ sys:'([A-Z]+)', label:'[^']+'/g)].map((m) => m[1]);
for (const sys of ['SLB', 'GZRQ', 'GGRQ', 'HPGRQ', 'DPGRQ', 'DGRQ', 'DZRQ', 'SMQ', 'RSH', 'WSH']) {
  assert.ok(codeSystems.includes(sys), `CODE_SYSTEMS 缺少 ${sys}`);
}
const allowed = new Set([...codeSystems, 'all']);

/* 1. 检修计划受热面筛选：值必须与编码系统码一致 */
const selectStart = html.indexOf('id="maintenanceSurfaceFilter"');
assert.notEqual(selectStart, -1, '检修计划缺少受热面筛选');
const selectBlock = html.slice(selectStart, html.indexOf('</select>', selectStart));
const filterValues = [...selectBlock.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
assert.ok(filterValues.length >= 10, '受热面筛选选项数量异常');
for (const value of filterValues) {
  assert.ok(allowed.has(value), `筛选值 ${value} 不是编码系统码`);
}

/* 2. 炉管分布图：标注使用系统码，不再出现旧缩写 */
for (const [label, code] of [['全大屏', 'DPGRQ'], ['后屏', 'HPGRQ'], ['高过', 'GGRQ'], ['高再', 'GZRQ'], ['顶棚过热器', 'RSH']]) {
  assert.ok(html.includes(`${label} ${code}`), `分布图「${label}」标注应为 ${code}`);
}
for (const code of ['DZRQ', 'DGRQ']) {
  assert.ok(new RegExp(`>${code}</text>`).test(html), `分布图低温受热面标注应为 ${code}`);
}
for (const legacy of ['PSH', 'ISH', 'HSH', 'HRH', 'LRH', 'LSH', 'ECO', 'WW']) {
  assert.ok(!new RegExp(`\\b${legacy}\\b`).test(html), `页面不应再出现旧缩写 ${legacy}`);
}

/* 3. 台账统计卡与助手示例同样使用系统码 */
assert.match(html, /水冷壁 \(SLB\)/, '台账统计卡应显示 SLB');
assert.ok(!/水冷壁 \(WW\)/.test(html), '台账统计卡不应显示 WW');
const ui = read('assets/app/assistant-ui-v1.js');
const wiring = read('assets/app/assistant-v1.js');
assert.ok(!/\bHSH\b/.test(ui), '助手示例不应使用 HSH');
assert.ok(!/\bHSH\b/.test(wiring), '助手快捷问句不应使用 HSH');
assert.match(ui, /GGRQ/, '助手示例应使用 GGRQ');

console.log('ok - surface abbreviations use the same system codes as tube codes');
