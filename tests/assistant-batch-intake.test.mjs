import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/**
 * T2 接入层验收：一次选中/拖入多张图片 → 批量识别 → 复用既有「清洗 → 确认导入 → 撤销」链路。
 * 契约见共享任务 task-2「冻结接口契约 v2」的 B（接线层）/ C（UI 层）两节。
 * 文档识别层（BTAssistantDocs.imagesToRows）由 T1 并行实现，这里按冻结签名打桩，
 * 只验证接线层与 UI 层的行为；T1 就绪后由浏览器端到端用例（T3）做真实联调。
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const wiringSource = read("assets/app/assistant-v1.js");
const uiSource = read("assets/app/assistant-ui-v1.js");
const coreSource = read("assets/app/assistant-core-v1.js");

const IMAGE_ACCEPT = ".csv,.xlsx,.xls,.png,.jpg,.jpeg,.webp,.pdf";
const MIXED_TIP = "请一次只上传同一类型文件；多张图片可以一起选择";
const BATCH_LIMIT = 8;

/* 与 CSV/Excel 导入完全一致的样例网格：多图识别结果最终要进 core.cleanRows 做清洗 */
const sampleRows = read("tests/fixtures/assistant-events-sample.csv")
  .trim()
  .split(/\r?\n/)
  .map((line) => line.split(","));

const checks = [];
const check = (name, fn) => checks.push([name, fn]);
const asyncChecks = [];
const checkAsync = (name, fn) => asyncChecks.push([name, fn]);
const has = (source, needle, label) => assert.ok(source.includes(needle), label || ("缺少 " + needle));

/* ---------------- 1. 源码契约 ---------------- */

check("接线层新增 handleFiles 并保留 handleFile 单文件入口", () => {
  has(wiringSource, "function handleFiles(fileList)", "必须新增 handleFiles");
  has(wiringSource, "handleFile: handleFile,", "必须保留 api.handleFile");
  has(wiringSource, "handleFiles: handleFiles,", "api 必须导出 handleFiles 供 UI 派发");
  has(wiringSource, "event.kind === 'files'", "dispatch 必须处理 files 事件");
});

check("批量图片走 docs.imagesToRows 且结果流回既有 runCleaning", () => {
  has(wiringSource, "docs.imagesToRows(files, {", "多张图片必须调用 docs.imagesToRows");
  has(wiringSource, "runCleaning(rows, batchName, sheetName);", "批量识别结果必须流回 runCleaning");
  has(wiringSource, "正在识别第 ", "识别过程必须有阶段反馈");
  has(wiringSource, "识别备注", "识别备注必须展示给用户");
  has(wiringSource, "MAX_BATCH_IMAGES = " + BATCH_LIMIT, "批量上限必须是 " + BATCH_LIMIT + " 张");
  has(wiringSource, "handleFile(files[0])", "单个文件必须转调 handleFile");
  /* 禁止另写导入：批量路径不得出现第二个导入执行器 */
  assert.equal(
    (wiringSource.match(/function runImportGrid\(/g) || []).length,
    1,
    "导入执行器必须只有 runImportGrid 一处"
  );
});

check("混合类型只给中文提示且不进入清洗", () => {
  has(wiringSource, MIXED_TIP, "混合类型必须给出约定文案");
  const block = wiringSource.slice(
    wiringSource.indexOf("function handleFiles(fileList)"),
    wiringSource.indexOf("function pendingCleaningImportable()")
  );
  const mixedAt = block.indexOf(MIXED_TIP);
  const cleanAt = block.indexOf("runCleaning(rows, batchName, sheetName)");
  assert.ok(mixedAt >= 0 && cleanAt > mixedAt, "混合类型分支必须早于清洗调用返回");
  assert.ok(block.indexOf("reply(", mixedAt) < cleanAt, "混合类型必须直接提示后 return");
});

check("UI 文件输入支持多选且 accept 字符串逐字不变", () => {
  has(uiSource, 'type="file" multiple accept="' + IMAGE_ACCEPT + '"', "文件输入必须加 multiple 且 accept 不变");
  has(uiSource, 'data-assistant="export-chat"', "导出对话按钮必须保留");
  has(uiSource, "addEventListener('dragenter', onPanelDragEnter)", "拖拽进入必须保留");
  has(uiSource, "addEventListener('drop', onPanelDrop)", "拖拽释放必须保留");
  const ids = [
    "assistantLauncher", "assistantPanel", "assistantClose", "assistantHistoryBtn", "assistantNewChat",
    "assistantTitle", "assistantStatus", "assistantMessages", "assistantQuick", "assistantInput",
    "assistantSend", "assistantAttach", "assistantFile", "assistantHistory", "assistantModelHint", "assistantTyping"
  ];
  ids.forEach((id) => has(uiSource, 'id="' + id + '"', "缺少既有节点 #" + id));
});

check("UI 单选/多选分别派发 file 与 files 事件", () => {
  has(uiSource, "emit({ kind: 'file', file: files[0] })", "单个文件必须派发 kind='file'");
  has(uiSource, "emit({ kind: 'files', files: files })", "多个文件必须派发 kind='files'");
  has(uiSource, "els.file.value = ''", "选择后必须清空 input.value");
  has(uiSource, "emitFiles(collectFiles(event.dataTransfer && event.dataTransfer.files))", "拖拽必须复用同一分流函数");
});

/* ---------------- 2. 最小沙箱 ---------------- */

/** 最小 DOM 桩：querySelector 按选择器记忆化，便于测试直接驱动真实事件处理器。 */
function createElement(doc) {
  const el = {
    style: {}, children: [], parentNode: null, hidden: false, className: "", id: "",
    value: "", disabled: false, files: null, textContent: "",
    _html: "", _attrs: {}, _handlers: {}, _registry: {},
    set innerHTML(value) {
      this._html = String(value);
      if (doc && doc._writes) doc._writes.push({ id: this.id, html: this._html });
    },
    get innerHTML() { return this._html; },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((item) => item !== child); },
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    removeEventListener(type, fn) {
      if (this._handlers[type]) this._handlers[type] = this._handlers[type].filter((item) => item !== fn);
    },
    setAttribute(name, value) { this._attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null; },
    querySelector(selector) {
      if (this._registry[selector]) return this._registry[selector];
      let found = null;
      if (selector.charAt(0) === "#") {
        const id = selector.slice(1);
        const index = this._html.indexOf('id="' + id + '"');
        if (index < 0) return null;
        found = createElement(doc);
        found.id = id;
        const tagStart = this._html.lastIndexOf("<", index);
        const tagEnd = this._html.indexOf(">", index);
        const tag = tagStart >= 0 && tagEnd > tagStart ? this._html.slice(tagStart, tagEnd) : "";
        if (/(^|\s)hidden(\s|$|=)/.test(tag)) found.hidden = true;
      } else if (selector.charAt(0) === ".") {
        if (this._html.indexOf(selector.slice(1)) < 0) return null;
        found = createElement(doc);
      } else {
        return null;
      }
      this._registry[selector] = found;
      return found;
    },
    querySelectorAll() { return []; },
    focus() {}, click() {}, scrollIntoView() {}, contains() { return false; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }
  };
  return el;
}

function createDocument() {
  const doc = {
    readyState: "complete",
    activeElement: null,
    _handlers: {},
    _writes: [],
    addEventListener(type, fn) { (doc._handlers[type] = doc._handlers[type] || []).push(fn); },
    removeEventListener() {},
    createElement: () => createElement(doc)
  };
  doc.body = createElement(doc);
  return doc;
}

function fire(el, type, event) {
  (el._handlers[type] || []).forEach((fn) => fn(event));
}

const messagesHtml = (doc) => {
  const hits = doc._writes.filter((item) => item.id === "assistantMessages");
  return hits.length ? hits[hits.length - 1].html : "";
};
const messageWrites = (doc) => doc._writes.filter((item) => item.id === "assistantMessages").length;

/** BTAssistantDocs 打桩：签名与冻结契约 v2 一致，串行调用 onProgress。 */
function docsStub() {
  const calls = { imageToRows: [], imagesToRows: [] };
  const docs = {
    version: "v2",
    isImageFile: (name) => /\.(png|jpe?g|webp)$/i.test(String(name)),
    isPdfFile: (name) => /\.pdf$/i.test(String(name)),
    imageToRows(file) {
      calls.imageToRows.push(file);
      return Promise.resolve({ rows: sampleRows, sheetName: "图片识别(1张)", notes: "" });
    },
    imagesToRows(files, options) {
      const list = Array.from(files);
      calls.imagesToRows.push({ files: list, options: options });
      list.forEach((file, index) => {
        if (options && typeof options.onProgress === "function") options.onProgress(index, list.length, file.name);
      });
      return Promise.resolve({
        rows: sampleRows,
        sheetName: "图片识别(" + list.length + "张)",
        notes: "成功 " + list.length + " 张、失败 0 张",
        results: list.map((file) => ({ name: file.name, ok: true }))
      });
    }
  };
  return { docs, calls };
}

/** 接线层 + UI 层 + 领域层 + docs 打桩：观察真实渲染结果与清洗层入参。 */
async function bootWiring() {
  const storage = {};
  const doc = createDocument();
  const stub = docsStub();
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    document: doc,
    localStorage: {
      getItem: (key) => (Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null),
      setItem: (key, value) => { storage[key] = String(value); },
      removeItem: (key) => { delete storage[key]; }
    },
    confirm: () => true,
    fetch: () => { throw new Error("测试不应发起网络请求"); }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.BTAssistantDocs = stub.docs;
  vm.createContext(sandbox);
  vm.runInContext(coreSource, sandbox);
  const cleanCalls = [];
  const realCleanRows = sandbox.BTAssistantCore.cleanRows;
  sandbox.BTAssistantCore.cleanRows = function (payload) {
    cleanCalls.push(payload);
    return realCleanRows(payload);
  };
  vm.runInContext(uiSource, sandbox);
  vm.runInContext(wiringSource, sandbox);
  await new Promise((resolve) => setTimeout(resolve, 20)); /* 等待 DOMContentLoaded 后的自动挂载 */
  const assistant = sandbox.BTAssistant;
  assert.ok(assistant && typeof assistant.handleFiles === "function", "接线层必须导出 handleFiles");
  assistant.open();
  const host = doc.body.children[0].children[0];
  return { sandbox, assistant, doc, calls: stub.calls, cleanCalls, host };
}

/** 只加载 UI 层：用 dispatch 日志验证选择/拖拽的派发口径。 */
function bootUI(stateOverride) {
  const doc = createDocument();
  const events = [];
  const sandbox = { console, setTimeout, clearTimeout, Promise, document: doc };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(uiSource, sandbox);
  const root = createElement(doc);
  const controller = sandbox.BTAssistantUI.mount({
    root,
    document: doc,
    state: () => Object.assign(
      { messages: [], busy: false, quickPrompts: [], conversations: [], configured: false, role: "editor" },
      stateOverride || {}
    ),
    dispatch: (event) => events.push(event)
  });
  const host = root.children[0];
  return { controller, events, host, file: host._registry["#assistantFile"], panel: host._registry["#assistantPanel"] };
}

const imageFile = (name, size) => ({ name: name, size: size || 1024 });

/* ---------------- 3. 运行时行为：handleFiles ---------------- */

checkAsync("handleFiles 空列表直接返回、无任何副作用", async () => {
  const ctx = await bootWiring();
  const before = messageWrites(ctx.doc);
  const returned = ctx.assistant.handleFiles([]);
  assert.equal(returned, undefined, "空列表不应返回待处理任务");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(messageWrites(ctx.doc), before, "空列表不能产生新消息");
  assert.equal(ctx.calls.imageToRows.length + ctx.calls.imagesToRows.length, 0, "空列表不得调用识别");
  assert.equal(ctx.cleanCalls.length, 0, "空列表不得进入清洗");
});

checkAsync("handleFiles 单个文件转调 handleFile，保持既有单文件路径", async () => {
  const ctx = await bootWiring();
  const single = imageFile("单张.png", 2048);
  ctx.assistant.handleFiles([single]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ctx.calls.imageToRows.length, 1, "单个图片必须走既有 imageToRows");
  assert.equal(ctx.calls.imageToRows[0], single, "必须把原文件对象交给 imageToRows");
  assert.equal(ctx.calls.imagesToRows.length, 0, "单个文件不应走批量识别");
  assert.equal(ctx.cleanCalls.length, 1, "单文件路径必须照旧进入清洗");
  assert.equal(ctx.cleanCalls[0].fileName, "单张.png", "单文件命名必须保持原文件名");
  assert.match(messagesHtml(ctx.doc), /上传文件：单张\.png/);
});

checkAsync("handleFiles 多张图片批量识别并流入既有清洗链路（FileList 兼容）", async () => {
  const ctx = await bootWiring();
  const first = imageFile("现场1.png", 1000);
  const second = imageFile("现场2.jpg", 2000);
  const fileList = { length: 2, 0: first, 1: second }; /* FileList 形状（非数组） */
  const pending = ctx.assistant.handleFiles(fileList);
  assert.ok(pending && typeof pending.then === "function", "批量路径应返回可等待的 Promise");
  await pending;

  assert.equal(ctx.calls.imagesToRows.length, 1, "只允许一次批量调用");
  const batch = ctx.calls.imagesToRows[0];
  assert.deepEqual(batch.files, [first, second], "必须把整批文件按原顺序交给 imagesToRows");
  assert.equal(batch.options.maxFiles, BATCH_LIMIT, "必须把批量上限透传给 docs");
  assert.equal(typeof batch.options.onProgress, "function", "必须提供 onProgress 阶段反馈");

  const html = messagesHtml(ctx.doc);
  assert.match(html, /正在识别第 1\/2 张图片/, "必须有第 1 张的阶段反馈");
  assert.match(html, /正在识别第 2\/2 张图片/, "必须有第 2 张的阶段反馈");
  assert.match(html, /上传文件：批量图片\(2张\)\.png/, "批量附件名必须是「批量图片(n张).png」");
  assert.match(html, /识别备注：成功 2 张、失败 0 张/, "识别备注必须展示给用户");

  assert.equal(ctx.cleanCalls.length, 1, "批量结果必须进入清洗（runCleaning）");
  const clean = ctx.cleanCalls[0];
  assert.equal(clean.fileName, "批量图片(2张).png", "清洗入参文件名必须是批量命名");
  assert.equal(clean.sheetName, "图片识别(2张)", "sheetName 必须用 docs 返回值");
  assert.equal(clean.rows.length, sampleRows.length, "清洗入参必须是合并后的整张网格");
  assert.deepEqual(Array.from(clean.rows[0]), sampleRows[0], "表头必须原样传给清洗层");
  assert.match(html, /assistant-cleaning/, "必须复用既有清洗报告卡片");
  assert.match(html, /已检查 10 行数据/, "必须复用既有清洗文案");
});

checkAsync("handleFiles 混合类型只提示、不调用识别、不进入清洗", async () => {
  const ctx = await bootWiring();
  ctx.assistant.handleFiles([imageFile("现场.png"), { name: "寿命数据.csv", size: 10 }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ctx.calls.imagesToRows.length, 0, "混合类型不得调用批量识别");
  assert.equal(ctx.calls.imageToRows.length, 0, "混合类型不得调用单图识别");
  assert.equal(ctx.cleanCalls.length, 0, "混合类型不得进入清洗");
  const html = messagesHtml(ctx.doc);
  assert.ok(html.includes(MIXED_TIP), "必须给出约定中文提示，实际：" + html);
  assert.doesNotMatch(html, /assistant-cleaning/, "混合类型不得出现清洗卡片");
});

checkAsync("handleFiles 超过 " + BATCH_LIMIT + " 张图片只提示上限、不调用识别", async () => {
  const ctx = await bootWiring();
  const many = [];
  for (let i = 0; i < BATCH_LIMIT + 1; i += 1) many.push(imageFile("现场" + i + ".png"));
  ctx.assistant.handleFiles(many);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ctx.calls.imagesToRows.length, 0, "超限不得调用批量识别");
  assert.equal(ctx.cleanCalls.length, 0, "超限不得进入清洗");
  const html = messagesHtml(ctx.doc);
  assert.match(html, new RegExp("最多上传 " + BATCH_LIMIT + " 张"), "必须给出写明上限的中文提示，实际：" + html);
  assert.match(html, new RegExp("当前 " + (BATCH_LIMIT + 1) + " 张"), "提示里应说明本批张数");
  assert.doesNotMatch(html, /正在识别第/, "超限不得出现识别阶段反馈");
});

checkAsync("正好 " + BATCH_LIMIT + " 张图片允许批量识别（边界内）", async () => {
  const ctx = await bootWiring();
  const many = [];
  for (let i = 0; i < BATCH_LIMIT; i += 1) many.push(imageFile("现场" + i + ".png"));
  await ctx.assistant.handleFiles(many);
  assert.equal(ctx.calls.imagesToRows.length, 1, "边界内必须允许批量识别");
  assert.equal(ctx.cleanCalls.length, 1, "边界内必须进入清洗");
});

/* ---------------- 4. 运行时行为：UI 选择 / 拖拽 ---------------- */

checkAsync("UI 选择 1 个文件派发 file、多个派发 files，并清空 input.value", async () => {
  const ui = bootUI();
  const first = imageFile("a.png");
  const second = imageFile("b.png");

  ui.file.files = [first];
  ui.file.value = "C:\\fakepath\\a.png";
  fire(ui.file, "change");
  assert.equal(ui.events.length, 1, "单选只派发一个事件");
  assert.equal(ui.events[0].kind, "file");
  assert.equal(ui.events[0].file, first);
  assert.equal(ui.file.value, "", "选择后必须清空 input.value");

  ui.events.length = 0;
  ui.file.files = [first, second];
  ui.file.value = "C:\\fakepath\\b.png";
  fire(ui.file, "change");
  assert.equal(ui.events.length, 1, "多选只派发一个批量事件");
  assert.equal(ui.events[0].kind, "files");
  assert.deepEqual(Array.from(ui.events[0].files), [first, second]);
  assert.equal(ui.file.value, "", "同一批文件必须能再次选择");
});

checkAsync("UI 拖拽多个文件派发批量事件、单个文件仍派发单文件事件", async () => {
  const ui = bootUI();
  const first = imageFile("a.png");
  const second = imageFile("b.png");
  const dropEvent = (files) => ({
    dataTransfer: { files: files, types: ["Files"] },
    preventDefault() {},
    stopPropagation() {}
  });

  fire(ui.panel, "drop", dropEvent([first]));
  assert.equal(ui.events.length, 1);
  assert.equal(ui.events[0].kind, "file");
  assert.equal(ui.events[0].file, first);

  ui.events.length = 0;
  fire(ui.panel, "drop", dropEvent([first, second]));
  assert.equal(ui.events.length, 1, "拖入多个文件只派发一个批量事件");
  assert.equal(ui.events[0].kind, "files");
  assert.deepEqual(Array.from(ui.events[0].files), [first, second]);

  ui.events.length = 0;
  fire(ui.panel, "drop", dropEvent([]));
  assert.equal(ui.events.length, 0, "空拖拽不得派发事件");
});

checkAsync("UI 忙碌时既不派发也不进入链路，但仍清空 input.value", async () => {
  const ui = bootUI({ busy: true });
  ui.file.files = [imageFile("a.png"), imageFile("b.png")];
  ui.file.value = "C:\\fakepath\\a.png";
  fire(ui.file, "change");
  assert.equal(ui.events.length, 0, "忙碌时不得派发文件事件");
  assert.equal(ui.file.value, "", "清空动作必须照旧发生");
});

/* ---------------- run ---------------- */

for (const [name, fn] of checks) {
  fn();
  console.log("ok - " + name);
}
for (const [name, fn] of asyncChecks) {
  await fn();
  console.log("ok - " + name);
}
const total = checks.length + asyncChecks.length;
console.log("ok - assistant batch intake: " + total + "/" + total + " checks passed");
