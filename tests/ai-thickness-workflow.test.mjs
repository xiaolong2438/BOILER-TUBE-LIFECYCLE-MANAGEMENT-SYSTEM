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
