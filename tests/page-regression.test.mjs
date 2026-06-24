import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const htmlPath = "C:/Users/DLX/Desktop/炉管全生命周期管理系统.html";
const html = readFileSync(htmlPath, "utf8");

const checks = [
  ["AI output uses local evidence and configured LLM rather than old demo inference", () => {
    assert.match(html, /综合寿命风险分析（本地证据 \+ 大模型）/);
    assert.match(html, /collectAICompositeSignals|runDeepAIAnalysisFromTrend/);
    assert.doesNotMatch(html, />🚀 启动 AI 推理</);
  }],
  ["user content rendering is escaped before innerHTML insertion", () => {
    assert.match(html, /function escapeHTML\s*\(/);
    assert.match(html, /escapeHTML\(r\.desc\)/);
    assert.match(html, /escapeHTML\(e\.desc\)/);
  }],
  ["code generator options are populated from the inventory matrix", () => {
    assert.match(html, /function populateCodeGeneratorOptions\s*\(/);
    assert.match(html, /populateCodeGeneratorOptions\(\)/);
    const initBlock = html.slice(html.indexOf("// ========== INIT =========="));
    assert.ok(initBlock.indexOf("populateCodeGeneratorOptions();") < initBlock.indexOf("genCode();"));
    assert.match(html, /<select id="f-system"><\/select>/);
  }],
  ["code generator uses complete coding-zone rules separate from the inventory matrix", () => {
    assert.match(html, /const CODE_SYSTEMS\s*=/);
    assert.match(html, /PSH[\s\S]*zones:\s*\['E','M','O'\]/);
    assert.match(html, /ISH[\s\S]*zones:\s*\['E','M','O'\]/);
    assert.match(html, /HSH[\s\S]*zones:\s*\['E','M','O'\]/);
    assert.match(html, /HRH[\s\S]*zones:\s*\['E','M','O'\]/);
    assert.doesNotMatch(html, /matrix\.filter\(m => m\.sys === sysSelect\.value\)\.map\(m => m\.zone\)/);
  }],
  ["search can identify legal inventory codes without local events", () => {
    assert.match(html, /function validateCodeAgainstMatrix\s*\(/);
    assert.match(html, /function validateCodeAgainstRules\s*\(/);
    assert.match(html, /const inventoryMatch = validateCodeAgainstMatrix\(code\)/);
    assert.match(html, /const ruleMatch = validateCodeAgainstRules\(code\)/);
    assert.match(html, /管段存在，但暂无检测或寿命事件记录/);
    assert.match(html, /编码规则有效，但暂无台账矩阵映射/);
  }],
  ["destructive local-data clear exports a backup first", () => {
    assert.match(html, /function backupLocalData\s*\(/);
    assert.match(html, /backupLocalData\(\)/);
    assert.match(html, /清空前将自动导出备份/);
  }],
  ["narrow screens have dedicated responsive rules", () => {
    assert.match(html, /@media \(max-width: 600px\)/);
    assert.match(html, /\.ai-metric-grid\s*\{\s*grid-template-columns: 1fr/);
    assert.match(html, /header\s*\{\s*flex-direction: column/);
  }],
  ["top navigation is grouped by workflow", () => {
    assert.match(html, /<div class="nav-group" aria-label="总览监控">/);
    assert.match(html, /<div class="nav-group" aria-label="台账与编码">/);
    assert.match(html, /<div class="nav-group" aria-label="设备资料">/);
  }],
  ["inventory matrix header stays fixed while its table scrolls", () => {
    assert.match(html, /class="table-wrap inventory-matrix-wrap"/);
    assert.match(html, /\.inventory-matrix-wrap\s+th\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/s);
    assert.match(html, /\.inventory-matrix-wrap\s*\{[^}]*max-height:\s*400px[^}]*overflow-y:\s*auto/s);
  }],
];

for (const [name, check] of checks) {
  check();
  console.log(`ok - ${name}`);
}
