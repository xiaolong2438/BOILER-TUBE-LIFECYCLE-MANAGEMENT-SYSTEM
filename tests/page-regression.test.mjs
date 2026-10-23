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
  readFileOrEmpty(resolve(here, "../assets/app/ui-shell-v8.js")),
  readFileOrEmpty(resolve(here, "../assets/app/app-v8.0.css"))
].join("\n");

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
    assert.match(html, /\.app-topbar\s*\{\s*flex-wrap:\s*wrap/);
    assert.match(html, /@media \(max-width: 960px\)[\s\S]*\.app-rail\s*\{[^}]*position:\s*fixed/);
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
  ["visible application version is consistently v8.x", () => {
    assert.match(html, /<title>锅炉炉管全生命周期管理系统 \| v8\.\d+<\/title>/);
    assert.match(html, /BOILER-TUBE LCMS · v8\.\d+/);
    assert.match(html, /BOILER-TUBE LIFE CYCLE MANAGEMENT SYSTEM v8\.\d+ · 2026/);
    assert.doesNotMatch(html, /<footer>[^<]*v7\.0/);
  }],
  ["LLM config is read from storage, not from the form DOM", () => {
    assert.ok(html.includes('function readLLMConfigFromStorage'), "必须提供只读存储的配置读取函数");
    assert.ok(html.includes('function getLLMFormConfig'), "必须提供表单配置（允许未保存输入）");
    assert.ok(html.includes('function syncLLMConfigStatus'), "必须提供配置状态同步");
    const start = html.indexOf('function getLLMConfig(');
    const end = html.indexOf('function getLLMFormConfig(');
    assert.ok(start > 0 && end > start, "getLLMConfig 与 getLLMFormConfig 必须相邻定义");
    const body = html.slice(start, end);
    assert.ok(!body.includes("getElementById('llm-model')"), "getLLMConfig 不得从 DOM 读模型");
    assert.ok(body.includes('readLLMConfigFromStorage'), "getLLMConfig 必须读已保存配置");
    assert.ok(html.includes('loadLLMConfigToForm();'), "INIT 必须把已保存配置回填到表单");
    assert.ok(html.includes('models: saved.models'), "保存配置时必须保留已识别模型列表");
  }],
  ["LLM reports are audited against locally computed numbers", () => {
    assert.ok(html.includes('function auditLLMText'), "缺少模型输出数值审计入口");
    assert.ok(html.includes('auditNumericClaims'), "必须复用分析层的数值审计实现");
    assert.ok(html.includes('function auditLLMNotice'), "缺少审计结论文案");
    assert.ok(html.includes('function prependLLMNotice'), "缺少审计提示渲染");
    const overview = html.slice(html.indexOf('async function runLLMAnalysis'), html.indexOf('async function runWarningTrendAnalysis'));
    assert.ok(overview.includes('auditLLMText(text, promptText)'), "总览页深度分析必须审计模型输出");
    const single = html.slice(html.indexOf('async function runDeepAIAnalysisFromTrend'), html.indexOf('function scrollToAIResults'));
    assert.ok(single.includes('auditLLMText(text, evidenceText)'), "单管综合分析必须审计模型输出");
    assert.ok(single.includes('const evidenceText = buildTrendAnalysisPrompt(data)'), "单管分析应复用同一份证据文本，避免两次生成不一致");
  }],
  ["cloud load never silently overwrites local edits", () => {
    assert.ok(html.includes('const LOCAL_DB_AT_KEY'), "必须记录本机最近写入时间");
    assert.ok(html.includes('const DB_BACKUP_KEY'), "必须提供本机数据库备份键");
    assert.ok(html.includes('function parseCloudTime'), "必须能解析云端的 updated_at");
    const boot = html.slice(html.indexOf('async function bootstrapCloudStorage'), html.indexOf('async function loadAuthSession'));
    assert.ok(boot.includes('localAt > remoteAt + 2000'), "本机更新时应保留本机版本");
    assert.ok(boot.includes('DB_BACKUP_KEY'), "云端更新时应先备份本机数据");
    assert.ok(boot.includes('本机数据比云端新'), "需要提示本机更新被保留");
    assert.ok(boot.includes('云端数据比本机新'), "需要提示已载入云端版本并备份");
    assert.ok(html.includes("localStorage.setItem(LOCAL_DB_AT_KEY"), "saveDB 必须刷新本机写入时间");
  }],
  ["top bar keeps the application title instead of repeating the active view", () => {
    assert.match(html, /id="topbar-title">锅炉炉管全生命周期管理系统<\/div>/);
    assert.match(html, /const APP_TITLE = '锅炉炉管全生命周期管理系统'/);
    assert.match(html, /window\.switchView = function/);
    assert.match(html, /new MutationObserver\(keepApplicationTitle\)/);
  }],
];

for (const [name, check] of checks) {
  check();
  console.log(`ok - ${name}`);
}
