import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const js = readFileSync(resolve(here, "../assets/app/app-v7.9.js"), "utf8");
const html = readFileSync(resolve(here, "../炉管全生命周期管理系统.html"), "utf8");

// 先验速率表：单测点兜底，所有受热面都有区间，明确标注为可修订的行业经验值。
assert.match(js, /const PRIOR_THINNING_RATES = \{/);
["SLB", "GGRQ", "GZRQ", "SMQ", "DGRQ", "DZRQ"].forEach(sys =>
  assert.ok(js.indexOf(sys + ":") > 0, "缺少 " + sys + " 先验速率"));
assert.match(js, /function getPriorThinningRates\(code, materialHint\)/);

// 两年后劣化预测：实测/先验两种口径统一输出区间、裕量与触阈判定。
assert.match(js, /function buildTwoYearForecast\(current, threshold, slowRate, fastRate, basis\)/);
assert.match(js, /wallHigh: twoYearHigh, wallLow: twoYearLow/);
assert.match(js, /certainlyBelow: thresh !== null \? twoYearHigh <= thresh : null/);
assert.match(js, /function formatTwoYearText\(twoYear\)/);
assert.match(js, /（先验）/);

// 单测点先验分支：出预测序列、触阈年份区间、两年后数据，且绝不冒充实测（reliable 恒为 false）。
assert.match(js, /if\(sorted\.length === 1 && thresholdInfo\.matched\) \{/);
assert.match(js, /rate: `\$\{prior\.slow\.toFixed\(2\)\}~\$\{prior\.fast\.toFixed\(2\)\} mm\/y（行业先验\$\{prior\.basis === 'material' \? '·' \+ prior\.label : ''\}）`/);
assert.match(js, /reliable: false, priorBased: true/);
assert.match(js, /先验结论仅供参考，积累 2 个及以上测点后自动切换为实测趋势/);

// 实测分支：两年后区间由基准/加速速率驱动，挂进 trendData。
assert.match(js, /buildTwoYearForecast\(last\.val, threshold, conservativeRate, acceleratedRate, 'measured'\)/);

// 展示与 LLM：指标卡 + 趋势报告行。
assert.match(html, /id="ai-twoyear"/);
assert.match(js, /twoYearEl\.textContent = data\.twoYear \? formatTwoYearText\(data\.twoYear\) : '--';/);
assert.match(js, /\$\{twoYear \? '两年后预测：' \+ formatTwoYearText\(twoYear\) : ''\}/);

console.log("ok - prior-rate fallback and two-year degradation forecast wired end to end");

// 硬度增强预测：逐年点位 + 残差MAD决定的不确定性区间带，图上成带绘制。
assert.match(js, /const bandHalf = Math\.max\(3, \(hardnessModel\.residualMad \|\| 0\) \* 1\.4826\)/);
assert.match(js, /points, bandHalf: Math\.round\(bandHalf\)/);
assert.match(js, /fill="var\(--chart-violet\)" fill-opacity="0\.13"/);
assert.match(js, /带=不确定性区间/);
assert.match(js, /（区间 \$\{pt\.low\}~\$\{pt\.high\}\）/);

console.log("ok - hardness forecast carries per-year points with a MAD-based uncertainty band");

// 材质级先验优先于受热面默认：识别材质后速率按材料家族细化，并在速率/报告中标注依据。
assert.match(js, /const PRIOR_RATE_MATERIAL_RULES = \[/);
assert.match(js, /function getTubeMaterialText\(code\)/);
assert.match(js, /function getPriorThinningRates\(code, materialHint\)/);
assert.match(js, /label: '马氏体耐热钢\(T91级\)'/);
assert.match(js, /（行业先验\$\{prior\.basis === 'material' \? '·' \+ prior\.label : ''\}\）/);
assert.match(js, /未识别材质，可录入材质后细化/);

// 硬度材质维度：典型区间参考带 + 测点不足时的材质先验趋势提示（占位经验值可修订）。
assert.match(js, /const HARDNESS_MATERIAL_REFERENCE = \[/);
assert.match(js, /function getHardnessMaterialRef\(material\)/);
assert.match(js, /function hardnessPriorHint\(code\)/);
assert.match(js, /label: '马氏体耐热钢\(T91级\)', low: 180, high: 250/);
assert.match(js, /\$\{materialRef\.label\}典型 \$\{materialRef\.low\}~\$\{materialRef\.high\}HB（参考）/);
assert.match(js, /按材质（' \+ materialRef\.label \+ '）经验：' \+ materialRef\.direction/);
assert.match(js, /先验参考，需复测确认/);

// 硬度参考区间按标准核实：奥氏体上限 192（ASME SA-213），铬钼上限 180（GB/T 5310 ≤179 取整档）。
assert.match(js, /label: '奥氏体不锈钢', low: 140, high: 192/);
assert.match(js, /label: '低合金铬钼钢', low: 135, high: 180/);
assert.match(js, /label: '马氏体耐热钢\(T91级\)', low: 180, high: 250/);
