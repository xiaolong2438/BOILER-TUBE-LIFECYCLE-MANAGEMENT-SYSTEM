import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// v6.7 起样式与脚本拆分为外部文件，改为合并检索 HTML + JS + CSS
const readFileOrEmpty = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const html = [
  readFileOrEmpty(resolve(here, "../炉管全生命周期管理系统.html")),
  readFileOrEmpty(resolve(here, "../assets/app/app-v7.9.js")),
  readFileOrEmpty(resolve(here, "../assets/app/app-v8.0.css"))
].join("\n");

const checks = [
  ["AI target selector is populated from tubes with thickness history", () => {
    assert.match(html, /function collectAIThicknessTargets\s*\(/);
    assert.match(html, /function populateAIThicknessTargets\s*\(/);
    assert.match(html, /<select id="ai-target"[^>]*><\/select>/);
    assert.match(html, /const thicknessData = extractThicknessData\(code,\s*\{\s*includeSystem:\s*false\s*\}\)/);
    assert.match(html, /thicknessData\.length >= 2/);
    assert.match(html, /本地暂无具备分析条件的炉管/);
  }],
  ["AI workflow predicts trend before deep model analysis", () => {
    assert.match(html, /function predictThicknessTrendFromHistory\s*\(/);
    assert.match(html, /function buildTrendAnalysisPrompt\s*\(/);
    assert.match(html, /async function runDeepAIAnalysisFromTrend\s*\(/);
    assert.match(html, /await runDeepAIAnalysisFromTrend\(data\)/);
    assert.match(html, /趋势预测结果/);
    assert.match(html, /测厚历史/);
  }],
  ["AI targets refresh through view invalidation and first tube-analysis visit", () => {
    const saveDB = html.slice(html.indexOf('function saveDB('), html.indexOf('\n', html.indexOf('function saveDB(')));
    assert.match(saveDB, /invalidateTubeViews\(\)/);
    const lifecycle = html.slice(html.indexOf('const viewLifecycle ='), html.indexOf('function activeViewId'));
    assert.match(lifecycle, /'tube-analysis':\s*\{\s*refresh:\s*refreshTubeAnalysisView\s*\}/);
    const refresh = html.slice(html.indexOf('function refreshTubeAnalysisView'), html.indexOf('function activeViewId'));
    assert.match(refresh, /updateLifecycleDropdown\(\);\s*populateAIThicknessTargets\(\);/);
    assert.match(refresh, /predictThicknessTrendFromHistory\(/, '数据刷新重算已有本地预测');
    assert.doesNotMatch(refresh, /loadLifecycle\(|runDeepAIAnalysisFromTrend\(/, '数据刷新不自动请求大模型');
    const invalidation = html.slice(html.indexOf('function invalidateTubeViews'), html.indexOf('function switchView'));
    assert.match(invalidation, /invalidateViews\(\[[^\]]*'tube-analysis'/);
    const initBlock = html.slice(html.indexOf("// ========== INIT =========="));
    assert.match(initBlock, /initNav\(\);/);
    assert.doesNotMatch(initBlock, /updateLifecycleDropdown\(\);|populateAIThicknessTargets\(\);/, 'hidden AI controls wait for navigation; view-lifecycle.test.mjs covers refresh and selection preservation');
  }],
  ["legacy static mock target list is removed", () => {
    assert.doesNotMatch(html, /<option value="BATCH-HSH-012">/);
    assert.doesNotMatch(html, /生成演示预测/);
  }],
];

for (const [name, check] of checks) {
  check();
  console.log(`ok - ${name}`);
}
