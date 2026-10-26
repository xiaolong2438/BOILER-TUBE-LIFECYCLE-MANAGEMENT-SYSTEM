import { readFileSync, existsSync } from "node:fs";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 集成验收：把「领域层 / UI 层 / 接线层 / 页面挂载 / 部署工作流 / dist 产物」拉到一起做交叉校验。
 * 只断言契约（docs/ai-assistant-spec.md），不重复各层自己的单测。
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const readOrEmpty = (p) => (existsSync(resolve(root, p)) ? read(p) : "");

const html = read("炉管全生命周期管理系统.html");
const appJs = read("assets/app/app-v7.9.js");
const coreJs = readOrEmpty("assets/app/assistant-core-v1.js");
const uiJs = readOrEmpty("assets/app/assistant-ui-v1.js");
const wiringJs = readOrEmpty("assets/app/assistant-v1.js");
const analysisJs = readOrEmpty("assets/app/assistant-analysis-v1.js");
const css = readOrEmpty("assets/app/assistant-v1.css");
const baseCss = read("assets/app/app-v8.0.css");
const workflow = read(".github/workflows/deploy-cloudflare-pages.yml");

const checks = [];
const check = (name, fn) => checks.push([name, fn]);
const has = (source, needle, label) => {
  assert.ok(source.includes(needle), label || `缺少 ${needle}`);
};

/* ---------------- 1. 页面挂载 ---------------- */
check("页面按依赖顺序加载助手资源", () => {
  const order = [
    "assets/app/app-v8.0.css",
    "assets/app/assistant-v1.css",
    "assets/app/app-v7.9.js",
    "assets/app/xlsx-export-v1.js",
    "assets/app/assistant-core-v1.js",
    "assets/app/assistant-analysis-v1.js",
    "assets/app/assistant-docs-v1.js",
    "assets/app/assistant-attachments-v1.js",
    "assets/app/assistant-ui-v1.js",
    "assets/app/assistant-v1.js"
  ];
  const positions = order.map((asset) => {
    const index = html.indexOf(asset);
    assert.notEqual(index, -1, `页面缺少资源引用：${asset}`);
    return index;
  });
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] > positions[i - 1], `资源顺序错误：${order[i]} 必须晚于 ${order[i - 1]}`);
  }
  for (const asset of ["assistant-core-v1.js", "assistant-analysis-v1.js", "assistant-ui-v1.js", "assistant-v1.js"]) {
    has(html, `<script src="assets/app/${asset}" defer></script>`, `${asset} 必须以 defer 加载`);
  }
  has(html, '<link rel="stylesheet" href="assets/app/assistant-v1.css">');
  // 面板由 assistant-ui-v1.js 动态挂载，HTML 里不应硬编码，避免与既有结构冲突
  assert.ok(!html.includes('id="assistantPanel"'), "面板不应硬编码进 HTML");
  assert.ok(!html.includes('id="assistantLauncher"'), "悬浮入口不应硬编码进 HTML");
});

/* ---------------- 2. 既有应用未被破坏 ---------------- */
check("既有导入/导出/LLM 入口原样保留", () => {
  for (const fn of ["function importCSV", "function importMaterialCSV", "function exportCSV", "function callLLMChatCompletions", "function runLLMAnalysis", "function saveDB"]) {
    has(appJs, fn, `app-v7.9.js 缺少 ${fn}`);
  }
  has(appJs, "const LLM_CONFIG_KEY = 'boiler_llm_config'");
  has(appJs, "const EVENT_CSV_COLUMNS = [");
  has(appJs, "const MATERIAL_COLUMNS = [");
  has(appJs, "if(!item.component || !item.spec || !item.material) continue;", "材料库行过滤口径不能被改动");
});

check("app-v7.9.js 暴露助手所需的桥接函数", () => {
  const required = [
    ["importLifecycleRows", "function importLifecycleRows"],
    ["importMaterialRows", "function importMaterialRows"],
    ["sendLLMMessages", "function sendLLMMessages"],
    ["callAssistantChatCompletions", "function callAssistantChatCompletions"],
    ["updateEventRecord", "function updateEventRecord"],
    ["collectAssistantSnapshot", "function collectAssistantSnapshot"],
    ["getAssistantRole", "function getAssistantRole"]
  ];
  for (const [label, needle] of required) has(appJs, needle, `app-v7.9.js 缺少 ${label}`);

  // importCSV / importMaterialCSV 必须真的委托给抽出的行处理函数，避免两份口径
  const importCsvBlock = appJs.slice(appJs.indexOf("function importCSV"), appJs.indexOf("function backupLocalData"));
  has(importCsvBlock, "importLifecycleRows(", "importCSV 必须复用 importLifecycleRows");
  const importMaterialBlock = appJs.slice(appJs.indexOf("function importMaterialCSV"), appJs.indexOf("function renderMaterialLibrary"));
  has(importMaterialBlock, "importMaterialRows(", "importMaterialCSV 必须复用 importMaterialRows");
});

/* ---------------- 3. 三层脚本可解析、命名空间正确 ---------------- */
check("四个助手脚本语法合法且命名空间符合契约", () => {
  const files = ["assets/app/assistant-core-v1.js", "assets/app/assistant-analysis-v1.js", "assets/app/assistant-docs-v1.js", "assets/app/assistant-attachments-v1.js", "assets/app/assistant-ui-v1.js", "assets/app/assistant-v1.js"];
  for (const file of files) {
    assert.ok(existsSync(resolve(root, file)), `缺少文件 ${file}`);
    execFileSync(process.execPath, ["--check", resolve(root, file)], { stdio: "pipe" });
  }
  has(coreJs, "BTAssistantCore", "领域层必须挂到 window.BTAssistantCore");
  has(uiJs, "BTAssistantUI", "UI 层必须挂到 window.BTAssistantUI");
  has(wiringJs, "BTAssistant", "接线层必须挂到 window.BTAssistant");
  has(analysisJs, "BTAssistantAnalysis", "分析层必须挂到 window.BTAssistantAnalysis");
  has(coreJs, "module.exports", "core 需要同时支持 Node 测试加载");
});

check("领域层导出契约要求的全部 API", () => {
  const api = [
    "toolCatalog", "toolsForRole", "requiredRole", "toolRank", "roleLabel",
    "parseIntent", "cleanRows", "parseQuery", "parseEdit", "buildStats",
    "normalizeText", "normalizeDateText", "normalizeEventType", "normalizeCode",
    "validateTubeCode", "formatNumber", "escapeHtml"
  ];
  for (const name of api) has(coreJs, name, `领域层缺少 ${name}`);
});

check("UI 层导出契约要求的全部渲染函数与 DOM id", () => {
  const fns = ["escapeHtml", "launcherMarkup", "panelMarkup", "messageMarkup", "cleaningMarkup", "operationMarkup", "analysisMarkup", "quickPromptMarkup", "historyMarkup", "attachmentBarMarkup", "mount"];
  for (const name of fns) has(uiJs, name, `UI 层缺少 ${name}`);
  /* 附件项声明了 role="button" tabindex="0"，必须能用键盘激活，否则等于一个假按钮 */
  has(uiJs, "function onAttachmentsKeyDown(event)", "附件条必须支持键盘激活");
  has(uiJs, "els.attachments.addEventListener('keydown', onAttachmentsKeyDown)", "附件条键盘监听必须挂载");
  has(uiJs, "els.attachments.removeEventListener('keydown', onAttachmentsKeyDown)", "附件条键盘监听必须可解绑");
  const ids = [
    "assistantLauncher", "assistantPanel", "assistantClose", "assistantHistoryBtn", "assistantNewChat",
    "assistantTitle", "assistantStatus", "assistantMessages", "assistantQuick", "assistantInput",
    "assistantSend", "assistantAttach", "assistantFile", "assistantHistory", "assistantModelHint", "assistantTyping", "assistantAttachments"
  ];
  for (const id of ids) has(uiJs, id, `UI 层缺少契约 DOM id：${id}`);
});

/* ---------------- 3.5 维护记录模块 ---------------- */
check("维护记录模块资源齐备、dist 同步且工作流已校验", () => {
  const assets = ["maintenance-log-v1.js", "maintenance-log-v1.css"];
  for (const asset of assets) {
    assert.ok(existsSync(resolve(root, "assets/app", asset)), `缺少源文件 ${asset}`);
    assert.ok(existsSync(resolve(root, "dist/assets/app", asset)), `dist 缺少 ${asset}`);
    assert.equal(read(`assets/app/${asset}`), read(`dist/assets/app/${asset}`), `${asset} 与 dist 不一致`);
    has(html, asset, `页面缺少 ${asset} 引用`);
    has(workflow, `test -f dist/assets/app/${asset}`, `工作流缺少 ${asset} 校验`);
  }
  assert.ok(html.indexOf("maintenance-log-v1.js") > html.indexOf("app-v7.9.js"), "日志模块必须晚于主应用加载");
  assert.ok(html.includes('data-view="maintainlog"'), "缺少维护记录导航项");
  assert.ok(html.includes('id="view-maintainlog"'), "缺少维护记录视图");
  execFileSync(process.execPath, ["--check", resolve(root, "assets/app/maintenance-log-v1.js")], { stdio: "pipe" });
});

/* ---------------- 4. 接线层必须复用三层，不得重复实现 ---------------- */
check("接线层复用领域层与 UI 层，而不是另起一套", () => {
  has(wiringJs, "BTAssistantCore", "接线层必须调用领域层");
  has(wiringJs, "BTAssistantUI", "接线层必须调用 UI 层");
  has(wiringJs, "importLifecycleRows(", "导入必须复用既有行处理");
  assert.ok(wiringJs.includes("saveDB(") || wiringJs.includes("saveMaterialLibrary("), "写库后必须落盘");
  has(wiringJs, "boiler_assistant_history", "会话历史键名必须符合契约");
  has(wiringJs, "boiler_assistant_last_import", "撤销导入需要记录最近一次导入");
  has(wiringJs, "boiler_llm_config", "LLM 增强必须复用既有模型配置");
});

check("接线层落实二次确认、撤销与降级", () => {
  assert.ok(/confirm/i.test(wiringJs), "写操作必须二次确认");
  assert.ok(wiringJs.includes("撤销") || /undo/i.test(wiringJs), "必须支持撤销");
  assert.ok(wiringJs.includes("降级"), "模型失败必须降级并标注");
  assert.ok(wiringJs.includes("AbortController") || wiringJs.includes("timeout") || wiringJs.includes("setTimeout"), "模型调用必须有超时保护");
  assert.ok(wiringJs.includes("DOMContentLoaded"), "必须在页面加载后自动挂载");
});

/* ---------------- 5. 样式 ---------------- */
check("助手样式只用已定义的设计令牌且括号配平", () => {
  assert.ok(css.length > 2000, "样式文件过小，疑似未编写");
  const declared = new Set();
  const collect = (source) => {
    for (const match of source.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) declared.add(match[1]);
  };
  collect(baseCss);
  collect(css);
  const missing = new Set();
  for (const match of css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
    if (!declared.has(match[1])) missing.add(match[1]);
  }
  assert.equal(missing.size, 0, `样式使用了未定义变量：${[...missing].join(", ")}`);

  let depth = 0;
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const ch of stripped) {
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    assert.ok(depth >= 0, "样式大括号不配平");
  }
  assert.equal(depth, 0, "样式大括号不配平");
  for (const cls of [".assistant-launcher", ".assistant-panel", ".assistant-messages", ".assistant-composer", ".assistant-operation", ".assistant-cleaning"]) {
    has(css, cls, `样式缺少 ${cls}`);
  }
  assert.ok(css.includes("@media"), "移动端必须适配");
});

/* ---------------- 6. 部署工作流 ---------------- */
check("部署工作流校验并发布助手资源", () => {
  for (const asset of ["assistant-core-v1.js", "assistant-analysis-v1.js", "assistant-ui-v1.js", "assistant-v1.js", "assistant-v1.css"]) {
    has(workflow, `test -f dist/assets/app/${asset}`, `工作流缺少 ${asset} 存在性校验`);
    has(workflow, `grep -q 'assets/app/${asset}' dist/index.html`, `工作流缺少 ${asset} 引用校验`);
  }
  has(workflow, "cp -R assets/. dist/assets/", "工作流必须整体拷贝 assets");
});

/* ---------------- 7. dist 产物与源码一致 ---------------- */
check("dist 产物包含助手资源且与源码同步", () => {
  const distIndex = read("dist/index.html");
  assert.equal(distIndex, html, "dist/index.html 必须与源码页面完全一致（发布前请重新生成 dist）");
  for (const asset of ["assistant-core-v1.js", "assistant-analysis-v1.js", "assistant-docs-v1.js", "assistant-attachments-v1.js", "assistant-ui-v1.js", "assistant-v1.js", "assistant-v1.css"]) {
    assert.ok(existsSync(resolve(root, "dist/assets/app", asset)), `dist 缺少 ${asset}`);
    assert.equal(read(`dist/assets/app/${asset}`), read(`assets/app/${asset}`), `dist/${asset} 与源码不一致`);
  }
});

/* ---------------- 8. 文案与依赖口径 ---------------- */
check("入口文案为中文且不引入未定义的外部依赖", () => {
  assert.ok(uiJs.includes("AI 数据助手") || uiJs.includes("数据助手"), "入口必须有中文名称");
  for (const script of [coreJs, analysisJs, uiJs, wiringJs]) {
    assert.ok(!/^\s*import\s+[\w{*]/m.test(script), "经典脚本里不能出现 ESM import");
    assert.ok(!/^\s*export\s+(default|const|function|class)/m.test(script), "经典脚本里不能出现 ESM export");
    assert.ok(!script.includes("cdn.jsdelivr") && !script.includes("unpkg.com"), "不得引入新的外部 CDN 依赖");
  }
});

/* ---------------- run ---------------- */
for (const [name, fn] of checks) {
  fn();
  console.log(`ok - ${name}`);
}
console.log("ok - assistant integration wiring (page + workflow + dist + cross-layer contract)");
