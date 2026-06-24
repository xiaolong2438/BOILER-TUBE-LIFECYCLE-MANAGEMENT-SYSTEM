import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const htmlPath = "C:/Users/DLX/Desktop/炉管全生命周期管理系统.html";
const html = readFileSync(htmlPath, "utf8");

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
  ["AI target list refreshes when lifecycle data changes and on startup", () => {
    assert.match(html, /function saveDB\s*\(\)\s*\{[\s\S]*populateAIThicknessTargets\(\)/);
    const initBlock = html.slice(html.indexOf("// ========== INIT =========="));
    assert.match(initBlock, /updateLifecycleDropdown\(\);[\s\S]*populateAIThicknessTargets\(\);/);
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
