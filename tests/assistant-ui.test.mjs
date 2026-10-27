import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../assets/app/assistant-ui-v1.js"), "utf8");

/** 最小 DOM 桩：只实现 mount() 用到的 API，避免引入任何第三方依赖。 */
function createElement(doc) {
  const el = {
    style: {},
    children: [],
    parentNode: null,
    hidden: false,
    className: "",
    id: "",
    value: "",
    disabled: false,
    _html: "",
    _attrs: {},
    _handlers: {},
    set innerHTML(value) { this._html = String(value); },
    get innerHTML() { return this._html; },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((item) => item !== child); },
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    removeEventListener() {},
    setAttribute(name, value) { this._attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null; },
    querySelector(selector) {
      if (selector.charAt(0) === "#") {
        const id = selector.slice(1);
        const idIndex = this._html.indexOf('id="' + id + '"');
        if (idIndex < 0) return null;
        const el = createElement(doc);
        // 还原初始 hidden 属性：真实浏览器里 <section ... hidden> 的 .hidden 为 true
        const tagStart = this._html.lastIndexOf("<", idIndex);
        const tagEnd = this._html.indexOf(">", idIndex);
        const tag = tagStart >= 0 && tagEnd > tagStart ? this._html.slice(tagStart, tagEnd) : "";
        if (/(^|\s)hidden(\s|$|=)/.test(tag)) el.hidden = true;
        return el;
      }
      if (selector.charAt(0) === ".") {
        return this._html.indexOf(selector.slice(1)) >= 0 ? createElement(doc) : null;
      }
      return null;
    },
    querySelectorAll() { return []; },
    focus() {},
    click() {},
    scrollIntoView() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }
  };
  return el;
}

function createDocument() {
  const doc = {
    readyState: "complete",
    activeElement: null,
    _handlers: {},
    addEventListener(type, fn) { (doc._handlers[type] = doc._handlers[type] || []).push(fn); },
    removeEventListener() {},
    createElement: () => createElement(doc)
  };
  doc.body = createElement(doc);
  return doc;
}

const sandbox = { console };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const UI = sandbox.BTAssistantUI;

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

/* ---------------- 导出与纯渲染 ---------------- */

check("UI 模块导出契约要求的全部渲染函数", () => {
  ["escapeHtml", "launcherMarkup", "panelMarkup", "messageMarkup", "cleaningMarkup", "operationMarkup", "quickPromptMarkup", "historyMarkup", "mount"].forEach((name) => {
    assert.equal(typeof UI[name], "function", name + " 必须是函数");
  });
});

check("悬浮入口带完整可访问性属性", () => {
  const markup = UI.launcherMarkup({});
  assert.match(markup, /id="assistantLauncher"/);
  assert.match(markup, /class="assistant-launcher"/);
  assert.match(markup, /aria-label="打开 AI 数据助手"/);
  assert.match(markup, /aria-controls="assistantPanel"/);
  assert.match(markup, /aria-expanded="false"/);
});

check("面板骨架包含契约要求的全部节点且默认隐藏", () => {
  const markup = UI.panelMarkup({ configured: true, role: "editor" });
  const ids = [
    "assistantPanel", "assistantClose", "assistantHistoryBtn", "assistantNewChat",
    "assistantTitle", "assistantStatus", "assistantMessages", "assistantQuick",
    "assistantInput", "assistantSend", "assistantAttach", "assistantFile",
    "assistantHistory", "assistantModelHint", "assistantTyping"
  ];
  ids.forEach((id) => assert.match(markup, new RegExp('id="' + id + '"'), "缺少 #" + id));
  assert.match(markup, /role="dialog"/);
  assert.match(markup, /aria-modal="true"/);
  assert.match(markup, /\bhidden\b/);
  assert.match(markup, /aria-live="polite"/);
  assert.match(markup, /type="file"/);
  assert.match(markup, /accept="\.csv,\.xlsx,\.xls,\.docx,\.doc,\.png,\.jpg,\.jpeg,\.webp,\.pdf"/);
  assert.match(markup, /data-assistant="export-chat"/, "缺少导出对话按钮");
});

check("消息渲染对用户输入做 HTML 转义", () => {
  const markup = UI.messageMarkup({ id: "m1", role: "user", text: '<script>alert("x")</script>', createdAt: "2026-10-23T00:00:00.000Z" });
  assert.ok(markup.indexOf("<script>") < 0, "不能原样输出 script 标签");
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /data-role="user"/);
  const assistant = UI.messageMarkup({ id: "m2", role: "assistant", text: "好的", createdAt: "2026-10-23T00:00:00.000Z", source: "rules" });
  assert.match(assistant, /data-role="assistant"/);
  assert.match(assistant, /规则解析/);
});

check("清洗报告渲染错误/警告数量与动作按钮", () => {
  const report = {
    datasetType: "events",
    fileName: "寿命数据.csv",
    summary: { totalRows: 10, cleanRows: 8, errorCount: 2, warningCount: 1, duplicateRows: 0, issueCount: 3, importable: false },
    checks: [{ id: "missing_required", severity: "error", title: "缺少管段编码", detail: "第 3 行缺少管段编码", rows: [3], suggestion: "补齐后重试" }],
    normalizations: ["日期已归一为 YYYY-MM-DD"],
    actions: [{ id: "export-cleaned", label: "导出清洗后数据", tone: "ghost" }]
  };
  const markup = UI.cleaningMarkup(report);
  assert.match(markup, /assistant-cleaning/);
  assert.match(markup, /缺少管段编码/);
  assert.match(markup, /data-action-id="export-cleaned"/);
  assert.match(markup, /导出清洗后数据/);
});

check("清洗报告：未识别数据集不把「保留行数」显示成「可导入」", () => {
  const report = {
    datasetType: "unknown",
    fileName: "无关表格-供应商清单.csv",
    summary: { totalRows: 2, cleanRows: 2, errorCount: 0, warningCount: 0, duplicateRows: 0, issueCount: 1, importable: false },
    checks: [{ id: "unknown_type", severity: "warning", title: "未识别数据集", detail: "不会导入", rows: [] }],
    normalizations: [],
    actions: [{ id: "export-cleaned", label: "导出清洗后数据", tone: "ghost" }]
  };
  const markup = UI.cleaningMarkup(report);
  assert.match(markup, /未识别数据集/, "必须标出未识别数据集");
  assert.match(markup, /可导入<\/span>\s*<span[^>]*>—</, "可导入指标必须显示占位符而不是行数");
  assert.ok(!/可导入<\/span>\s*<span[^>]*>2</.test(markup), "未识别数据集绝不能显示可导入 2 行");
  assert.ok(markup.indexOf('data-action-id="import-confirm"') < 0, "未识别数据集不能出现确认导入按钮");
});

check("清洗报告：已识别数据集仍正常显示可导入行数（不误伤）", () => {
  const report = {
    datasetType: "events",
    fileName: "寿命数据.csv",
    summary: { totalRows: 5, cleanRows: 3, errorCount: 0, warningCount: 2, duplicateRows: 0, issueCount: 2, importable: true },
    checks: [],
    normalizations: [],
    actions: []
  };
  const markup = UI.cleaningMarkup(report);
  assert.match(markup, /可导入<\/span>\s*<span[^>]*>3</, "已识别数据集必须显示真实可导入行数");
});

check("操作卡片渲染主次动作与状态", () => {
  const markup = UI.operationMarkup({
    tool: "data.import",
    datasetType: "events",
    title: "导入预览",
    detail: "将写入 8 行",
    metrics: [{ label: "可导入行", value: "8" }],
    warnings: ["有警告行"],
    status: "ready",
    primaryAction: { id: "import-confirm", label: "确认导入" },
    secondaryActions: [{ id: "clean-cancel", label: "取消", tone: "ghost" }]
  });
  assert.match(markup, /class="assistant-op"/);
  assert.match(markup, /data-status="ready"/);
  assert.match(markup, /data-action-id="import-confirm"/);
  assert.match(markup, /data-tool="data.import"/);
  assert.match(markup, /data-action-id="clean-cancel"/);
  assert.match(markup, /有警告行/);
});

check("快捷指令与历史会话渲染", () => {
  const quick = UI.quickPromptMarkup(["现在数据质量怎么样", "帮助"]);
  assert.equal((quick.match(/data-assistant="quick"/g) || []).length, 2);
  assert.match(quick, /data-prompt="现在数据质量怎么样"/);

  const empty = UI.historyMarkup([], null);
  assert.match(empty, /暂无历史会话/);

  const list = UI.historyMarkup([
    { id: "c1", title: "查询高过记录", updatedAt: "2026-10-23T10:00:00.000Z", messages: [{ role: "user", text: "查询" }] }
  ], "c1");
  assert.match(list, /data-conversation-id="c1"/);
  assert.match(list, /is-active/);
});

/* ---------------- 面板控制器 ---------------- */

check("mount 在最小 DOM 桩下可开关、Esc 关闭、重复挂载不叠加", () => {
  const doc = createDocument();
  const root = createElement(doc);
  const dispatchLog = [];
  const controller = UI.mount({
    root: root,
    document: doc,
    state: () => ({ messages: [], busy: false, quickPrompts: ["帮助"], conversations: [], configured: false, role: "editor" }),
    dispatch: (event) => dispatchLog.push(event)
  });
  assert.equal(typeof controller.open, "function");
  assert.equal(controller.isOpen(), false);
  controller.open();
  assert.equal(controller.isOpen(), true);
  controller.close();
  assert.equal(controller.isOpen(), false);
  controller.toggle();
  assert.equal(controller.isOpen(), true);

  // Esc 关闭
  (doc._handlers.keydown || []).forEach((fn) => fn({ key: "Escape", preventDefault() {} }));
  assert.equal(controller.isOpen(), false);

  // 重复挂载：旧控制器销毁，新控制器接管，root 只保留一个挂载点
  const second = UI.mount({
    root: root,
    document: doc,
    state: () => ({ messages: [], busy: false, quickPrompts: [], conversations: [], configured: false, role: "editor" }),
    dispatch: () => {}
  });
  assert.notEqual(second, controller);
  assert.equal(root.children.length, 1, "重复挂载不能叠加面板");
  assert.equal(dispatchLog.length, 0, "开关面板本身不应派发业务事件");
});

check("mount 缺少 document 时给出明确错误", () => {
  assert.throws(() => UI.mount({ root: createElement(null) }), /document/);
});

for (const [name, fn] of checks) {
  fn();
  console.log("ok - " + name);
}
console.log("ok - assistant ui: " + checks.length + "/" + checks.length + " checks passed");
