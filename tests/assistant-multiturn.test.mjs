import { readFileSync, existsSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/**
 * T2 验收：会话附件上下文接线（task-5）
 *   上传即登记 → 后续轮次可指代引用 → 图片追问（视觉重发原图 + 多轮历史）→ 重复导入保护 → 会话生命周期。
 * 运行时优先加载 T1 的真实模块 assets/app/assistant-attachments-v1.js（零 DOM / 零网络，node:vm 直接加载）。
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const wiringSource = read("assets/app/assistant-v1.js");
const uiSource = read("assets/app/assistant-ui-v1.js");
const coreSource = read("assets/app/assistant-core-v1.js");
const cssSource = read("assets/app/assistant-v1.css");

const ATTACHMENTS_PATH = "assets/app/assistant-attachments-v1.js";
const attachmentsReady = existsSync(resolve(root, ATTACHMENTS_PATH));
const attachmentsSource = attachmentsReady ? read(ATTACHMENTS_PATH) : "";

const checks = [];
const check = (name, fn) => checks.push([name, fn]);
const asyncChecks = [];
const checkAsync = (name, fn) => asyncChecks.push([name, fn]);
const has = (source, needle, label) => assert.ok(source.includes(needle), label || ("缺少 " + needle));

/* ---------------- 1. 源码契约 ---------------- */

check("接线层依赖附件模块并保留既有门面与入口字符串", () => {
  assert.ok(attachmentsReady, "缺少 T1 模块 " + ATTACHMENTS_PATH);
  has(wiringSource, "global.BTAssistantAttachments", "接线层必须读取 window.BTAssistantAttachments");
  has(wiringSource, "function attachmentRegistry()", "registry 必须惰性创建");
  has(wiringSource, "function registerAttachment(", "上传成功后必须登记附件");
  has(wiringSource, "function registerImageAttachment(", "图片必须单独登记（压缩原图）");
  has(wiringSource, "function registerBatchAttachments(", "批量图片必须逐张登记");
  has(wiringSource, "function askAboutImage(", "必须实现图片追问");
  has(wiringSource, "module.buildVisionMessages(", "图片追问必须走 buildVisionMessages");
  has(wiringSource, "global.callVisionLLM(messages, VISION_MAX_TOKENS)", "图片追问必须调用视觉模型");
  has(wiringSource, "import-again", "重复导入保护必须有「再次导入」动作");
  has(wiringSource, "markAttachmentImported(", "导入成功后必须记录 importedAt");
  /* 既有断言字符串逐字保留（其他测试依赖） */
  has(wiringSource, "var docKind = docs && docs.isImageFile(name) ? 'image' : docs && docs.isPdfFile(name) ? 'pdf' : ''");
  has(wiringSource, "if (event.kind === 'files') { handleFiles(event.files); return; }");
  has(wiringSource, "runCleaning(rows, batchName, sheetName);");
  has(wiringSource, "return Boolean(global.__llmServerKey)");
  has(wiringSource, "handleFiles: handleFiles,");
  has(wiringSource, "handleFile: handleFile,");
  assert.equal((wiringSource.match(/function runImportGrid\(/g) || []).length, 1, "导入执行器必须只有一处");
});

check("接线层新增事件、上下文与门面", () => {
  ["select-attachment", "remove-attachment", "clear-attachments"].forEach((kind) => {
    has(wiringSource, "event.kind === '" + kind + "'", "dispatch 必须处理 " + kind);
  });
  has(wiringSource, "hasAttachments:", "buildContext 必须暴露 hasAttachments");
  has(wiringSource, "currentAttachment:", "buildContext 必须暴露 currentAttachment");
  has(wiringSource, "attachments: attachmentsForLlm()", "意图消息必须带附件摘要");
  has(wiringSource, "history: conversationHistoryForLlm(HISTORY_FOR_LLM_TURNS, true)", "意图消息必须带脱敏历史");
  has(wiringSource, "listAttachments: function () { return attachmentList(); }", "门面必须导出 listAttachments");
  has(wiringSource, "selectAttachment: selectAttachment,", "门面必须导出 selectAttachment");
  has(wiringSource, "askAboutImage: askAboutImage,", "门面必须导出 askAboutImage");
});

check("会话生命周期持久化附件摘要并按摘要回填", () => {
  has(wiringSource, "function attachmentStorageSummary()", "必须只持久化附件摘要");
  has(wiringSource, "attachments: restoreAttachmentsFromSummary(item.attachments)", "loadHistory 必须回填摘要");
  has(wiringSource, "conv.attachments = attachmentStorageSummary();", "syncConversation 必须写入摘要");
  has(wiringSource, "clearAttachmentRegistry();", "新会话/切换会话必须清空内存 registry");
});

check("UI 层新增附件条渲染与派发", () => {
  has(uiSource, "function attachmentBarMarkup(attachments, currentId)", "必须新增 attachmentBarMarkup");
  has(uiSource, '<div class="assistant-attachments" id="assistantAttachments" hidden></div>', "附件条容器必须逐字符合契约");
  has(uiSource, "attachmentBarMarkup: attachmentBarMarkup,", "UI 必须导出 attachmentBarMarkup");
  has(uiSource, "data-attachment-action=\"select\"");
  has(uiSource, "data-attachment-action=\"remove\"");
  has(uiSource, "emit({ kind: 'remove-attachment', id: attachmentId })");
  has(uiSource, "emit({ kind: 'select-attachment', id: attachmentId })");
  has(uiSource, 'multiple accept=".csv,.xlsx,.xls,.png,.jpg,.jpeg,.webp,.pdf"', "既有 accept 字符串不得改动");
  [
    "assistantLauncher", "assistantPanel", "assistantClose", "assistantHistoryBtn", "assistantNewChat",
    "assistantTitle", "assistantStatus", "assistantMessages", "assistantQuick", "assistantInput",
    "assistantSend", "assistantAttach", "assistantFile", "assistantHistory", "assistantModelHint", "assistantTyping"
  ].forEach((id) => has(uiSource, 'id="' + id + '"', "缺少既有节点 #" + id));
});

check("样式新增附件条类名且只用既有令牌", () => {
  [".assistant-attachments", ".assistant-attachment-chip", ".is-current", ".assistant-attachment-label", ".assistant-attachment-remove"].forEach((cls) => {
    has(cssSource, cls, "样式缺少 " + cls);
  });
});

/* ---------------- 2. 最小沙箱（真实附件模块 + 打桩 docs/模型） ---------------- */

const NL = String.fromCharCode(10);
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* 与浏览器冒烟用例同源的干净数据行（炉号与管段编码首段一致） */
const CLEAN_ROWS = [
  ["数据分类", "炉号", "日期", "管段编码", "规格", "材质", "厚度(mm)", "硬度(HB)", "事件类型/更换原因", "关联新管码", "详细描述/结论"],
  ["事件", "1", "2025-01-10", "1-WW-FR-009-0007-000", "Φ63.5×7.5", "SA-210C", "7.05", "183", "测厚", "", "接线回归一"],
  ["事件", "2", "2025-02-11", "2-HSH-E-013-0006-W01", "Φ51×8", "SA-213T91", "6.85", "205", "测厚", "", "接线回归二"]
];

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
    classList: {
      _set: {},
      add(name) { this._set[name] = true; },
      remove(name) { delete this._set[name]; },
      toggle(name, on) { if (on === undefined) this._set[name] = !this._set[name]; else if (on) this._set[name] = true; else delete this._set[name]; },
      contains(name) { return !!this._set[name]; }
    }
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
const attachmentsHtml = (doc) => {
  const hits = doc._writes.filter((item) => item.id === "assistantAttachments");
  return hits.length ? hits[hits.length - 1].html : "";
};

/* docs 层打桩：签名与冻结契约一致，返回带 rows 与原图的识别结果 */
function docsStub(calls) {
  const imageResult = (file, index) => ({
    rows: CLEAN_ROWS,
    sheetName: "图片识别",
    notes: "第 " + ((index || 0) + 1) + " 张识别备注",
    dataUrl: "data:image/jpeg;base64,IMG" + ((index || 0) + 1)
  });
  return {
    version: "v2",
    isImageFile: (name) => /\.(png|jpe?g|webp)$/i.test(String(name)),
    isPdfFile: (name) => /\.pdf$/i.test(String(name)),
    imageToDataUrl(file) {
      calls.dataUrl.push(file && file.name);
      if (file && file.dataUrlFailure) return Promise.reject(new Error("模拟压缩失败"));
      return Promise.resolve("data:image/jpeg;base64,FALLBACK");
    },
    imageToRows(file) {
      calls.imageToRows.push(file);
      return Promise.resolve(imageResult(file, 0));
    },
    imagesToRows(files, options) {
      const list = Array.from(files);
      calls.imagesToRows.push({ files: list, options: options });
      list.forEach((file, index) => {
        if (options && typeof options.onProgress === "function") options.onProgress(index, list.length, file.name);
      });
      return Promise.resolve({
        rows: CLEAN_ROWS,
        sheetName: "图片识别(" + list.length + "张)",
        notes: "成功 " + list.length + " 张、失败 0 张",
        results: list.map((file, index) => ({
          name: file.name,
          ok: true,
          rows: CLEAN_ROWS,
          sheetName: "图片识别",
          notes: "第 " + (index + 1) + " 张识别备注",
          dataUrl: "data:image/jpeg;base64,IMG" + (index + 1)
        }))
      });
    },
    pdfToRows(file) {
      calls.pdfToRows.push(file);
      return Promise.resolve({ rows: CLEAN_ROWS, sheetName: "PDF 提取", notes: "" });
    }
  };
}

async function boot(extra) {
  const storage = {};
  const doc = createDocument();
  const calls = { imageToRows: [], imagesToRows: [], pdfToRows: [], dataUrl: [], vision: [], imports: [] };
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
    confirm: () => true
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.BTAssistantDocs = docsStub(calls);
  sandbox.importLifecycleRows = (rows) => {
    const dataRows = Math.max(0, rows.length - 1);
    calls.imports.push({ rows: rows, kind: "events" });
    return {
      importedEvents: dataRows,
      importedReplacements: 0,
      skippedDuplicates: 0,
      addedEventTs: rows.slice(1).map((_, index) => 900000 + index)
    };
  };
  sandbox.importMaterialRows = (rows) => {
    calls.imports.push({ rows: rows, kind: "material_library" });
    return { imported: Math.max(0, rows.length - 1) };
  };
  sandbox.saveDB = () => {};
  if (extra && typeof extra === "object") Object.assign(sandbox, extra);
  vm.createContext(sandbox);
  vm.runInContext(coreSource, sandbox);
  vm.runInContext(attachmentsSource, sandbox);
  vm.runInContext(uiSource, sandbox);
  vm.runInContext(wiringSource, sandbox);
  await tick(25); /* 等待 DOMContentLoaded 后的自动挂载 */
  const assistant = sandbox.BTAssistant;
  assert.ok(assistant && typeof assistant.handleFile === "function", "接线层必须导出 handleFile");
  assistant.open();
  const host = doc.body.children[0].children[0];
  return { sandbox, assistant, doc, host, calls, storage };
}

function clickWith(ctx, attrs) {
  const target = createElement(ctx.doc);
  target._attrs = attrs;
  target.parentNode = ctx.host;
  fire(ctx.host, "click", { target, preventDefault() {}, stopPropagation() {} });
}

const clickAction = (ctx, actionId) => clickWith(ctx, { "data-assistant": "action", "data-action-id": actionId });
const clickAttachment = (ctx, action, id) => clickWith(ctx, {
  "data-assistant": "attachment",
  "data-attachment-action": action,
  "data-attachment-id": id
});

/* ---------------- 3. 运行时：上传即登记 / 指代 / 图片追问 ---------------- */

checkAsync("上传图片即登记附件，current 指向它且附件条渲染出来", async () => {
  const ctx = await boot();
  ctx.assistant.handleFile({ name: "现场1.png", size: 1111 });
  await tick(30);
  const list = ctx.assistant.listAttachments();
  assert.equal(list.length, 1, "上传成功后必须登记 1 个附件");
  assert.equal(list[0].name, "现场1.png");
  assert.equal(list[0].kind, "image");
  assert.equal(list[0].rowCount, 2, "rowCount 应为表头之外的数据行");
  assert.equal(list[0].headers.length, 11);
  assert.equal(list[0].hasDataUrl, true, "图片附件必须带压缩原图（用于多轮追问）");
  assert.equal(list[0].current, true, "新登记必须成为当前附件");
  const bar = attachmentsHtml(ctx.doc);
  assert.match(bar, /data-attachment-id="att-1"/);
  assert.match(bar, /data-attachment-action="select"/);
  assert.match(bar, /data-attachment-action="remove"/);
  assert.match(bar, /is-current/);
  assert.match(bar, /现场1\.png/);
  assert.match(bar, /图片 · 2 行/);
  assert.match(messagesHtml(ctx.doc), /已直接导入|assistant-cleaning/, "上传后必须照旧走清洗链路");
});

checkAsync("追问「这张图里有几个测点」走视觉模型、重发原图并带多轮历史", async () => {
  const visionCalls = [];
  const ctx = await boot({
    getLLMConfig: () => ({ baseUrl: "https://llm.example/v1", apiKey: "k", model: "m" }),
    callVisionLLM: (messages, maxTokens) => {
      visionCalls.push({ messages, maxTokens });
      return Promise.resolve("图中可以辨认出 6 个测点。");
    }
  });
  ctx.assistant.handleFile({ name: "现场1.png", size: 1111 });
  await tick(30);
  ctx.assistant.send("这张图里有几个测点");
  await tick(30);
  assert.equal(visionCalls.length, 1, "必须调用一次视觉模型");
  assert.equal(visionCalls[0].maxTokens, 1200, "视觉追问的 token 预算应为 1200");
  const serialized = JSON.stringify(visionCalls[0].messages);
  assert.ok(serialized.indexOf("image_url") >= 0, "视觉请求必须带 image_url");
  assert.ok(serialized.indexOf("data:image/jpeg;base64,IMG1") >= 0, "必须重发当前图片的压缩原图");
  assert.equal(visionCalls[0].messages[0].role, "system");
  const last = visionCalls[0].messages[visionCalls[0].messages.length - 1];
  assert.equal(last.role, "user");
  assert.ok(Array.isArray(last.content), "末条必须是 text + image_url 数组");
  assert.equal(last.content[0].text, "这张图里有几个测点");
  assert.equal(last.content[1].type, "image_url");
  assert.match(messagesHtml(ctx.doc), /【基于图片 现场1\.png】/);
  assert.match(messagesHtml(ctx.doc), /6 个测点/);

  /* 第二轮：历史必须带上一轮问答 */
  ctx.assistant.send("图中测点的最薄处是多少");
  await tick(30);
  assert.equal(visionCalls.length, 2, "第二次追问应再调用一次视觉模型");
  const second = visionCalls[1].messages;
  assert.ok(second.some((item) => item.role === "user" && item.content === "这张图里有几个测点"), "历史必须包含上一轮提问");
  assert.ok(second.some((item) => item.role === "assistant" && String(item.content).indexOf("6 个测点") >= 0), "历史必须包含上一轮回答");
});

checkAsync("未配置模型时图片追问给明确提示：不调用模型、不静默降级到规则", async () => {
  const visionCalls = [];
  const ctx = await boot({
    callVisionLLM: (messages) => { visionCalls.push(messages); return Promise.resolve("不应被调用"); }
  });
  ctx.assistant.handleFile({ name: "现场1.png", size: 1111 });
  await tick(30);
  ctx.assistant.send("这张图里有几个测点");
  await tick(20);
  assert.equal(visionCalls.length, 0, "未配置模型不得调用视觉模型");
  const html = messagesHtml(ctx.doc);
  assert.match(html, /模型接口配置/, "必须提示去配置支持视觉的模型");
  assert.doesNotMatch(html, /没太听懂/, "禁止静默降级到规则回答");
});

checkAsync("非图片附件追问给明确提示，而不是答非所问", async () => {
  const visionCalls = [];
  const ctx = await boot({
    getLLMConfig: () => ({ baseUrl: "https://llm.example/v1", apiKey: "k", model: "m" }),
    callVisionLLM: (messages) => { visionCalls.push(messages); return Promise.resolve("x"); }
  });
  ctx.assistant.handleFile({ name: "说明书.pdf", size: 2048 });
  await tick(30);
  ctx.assistant.send("这张图里有几个测点");
  await tick(20);
  assert.equal(visionCalls.length, 0, "非图片附件不得调用视觉模型");
  const html = messagesHtml(ctx.doc);
  assert.match(html, /不是图片/);
  assert.doesNotMatch(html, /没太听懂/);
});

/* ---------------- 4. 运行时：批量登记 / 指代切换 / 事件 ---------------- */

checkAsync("批量图片逐张登记（current=最后一张）并给出清单，指代可切换", async () => {
  const visionCalls = [];
  const ctx = await boot({
    getLLMConfig: () => ({ baseUrl: "https://llm.example/v1", apiKey: "k", model: "m" }),
    callVisionLLM: (messages, maxTokens) => { visionCalls.push({ messages, maxTokens }); return Promise.resolve("看起来有 4 个测点。"); }
  });
  await ctx.assistant.handleFiles([{ name: "现场1.png", size: 1001 }, { name: "现场2.png", size: 1002 }]);
  await tick(30);
  const list = ctx.assistant.listAttachments();
  assert.equal(list.length, 2, "两张图片必须逐张登记");
  assert.deepEqual(Array.from(list, (item) => item.name), ["现场1.png", "现场2.png"]);
  assert.equal(list[0].current, false);
  assert.equal(list[1].current, true, "current 必须落在最后一张");
  assert.equal(list[0].hasDataUrl, true, "每张图都要有自己的原图");
  assert.equal(list[1].hasDataUrl, true);
  const html = messagesHtml(ctx.doc);
  assert.match(html, /已登记 2 个会话附件/);
  assert.match(html, /现场2\.png（图片，2 行） · 当前/);

  /* 纯指代切换 */
  ctx.assistant.send("第二张图呢");
  await tick(20);
  assert.equal(ctx.assistant.listAttachments()[1].current, true, "「第二张图」必须切到第二张");
  assert.match(messagesHtml(ctx.doc), /已切换到附件「现场2\.png」/);

  /* 指代 + 追问：视觉请求必须用被指代的那张图 */
  ctx.assistant.send("第一张图里有几个测点");
  await tick(30);
  assert.equal(visionCalls.length, 1, "指代追问必须走视觉模型");
  assert.ok(JSON.stringify(visionCalls[0].messages).indexOf("base64,IMG1") >= 0, "必须重发第一张的原图");
  assert.equal(ctx.assistant.listAttachments()[0].current, true, "追问后当前附件应停在被指代的那张");
});

checkAsync("select / remove 附件事件生效，移除当前项后 current 回退", async () => {
  const ctx = await boot();
  await ctx.assistant.handleFiles([{ name: "现场1.png", size: 1001 }, { name: "现场2.png", size: 1002 }]);
  await tick(30);
  let list = ctx.assistant.listAttachments();
  const firstId = list[0].id;
  const secondId = list[1].id;

  clickAttachment(ctx, "select", firstId);
  list = ctx.assistant.listAttachments();
  assert.equal(list[0].current, true, "select 事件必须切换当前附件");
  assert.match(attachmentsHtml(ctx.doc), new RegExp('data-attachment-id="' + firstId + '"[^>]*'), "附件条必须重绘");

  clickAttachment(ctx, "remove", firstId);
  list = ctx.assistant.listAttachments();
  assert.equal(list.length, 1, "remove 事件必须移除附件");
  assert.equal(list[0].id, secondId);
  assert.equal(list[0].current, true, "移除当前项后 current 回退到剩下的一条");
  const bar = attachmentsHtml(ctx.doc);
  assert.ok(bar.indexOf(firstId) < 0, "被移除的附件不得再出现在附件条里");

  clickAttachment(ctx, "remove", secondId);
  assert.equal(ctx.assistant.listAttachments().length, 0);
  assert.equal(attachmentsHtml(ctx.doc), "", "空列表时附件条必须为空（容器 hidden）");
});

/* ---------------- 5. 运行时：重复导入保护 ---------------- */

checkAsync("已导入附件再说「导入」不重复写库，点「再次导入」才重新清洗入库", async () => {
  const ctx = await boot();
  ctx.assistant.handleFile({ name: "现场1.png", size: 1111 });
  await tick(30);
  if (messagesHtml(ctx.doc).indexOf('data-action-id="import-confirm"') >= 0) {
    clickAction(ctx, "import-confirm");
    await tick(20);
  }
  const afterFirst = ctx.calls.imports.length;
  assert.ok(afterFirst >= 1, "首次导入必须写入一次，实际 " + afterFirst);
  assert.ok(ctx.assistant.listAttachments()[0].importedAt, "导入成功后附件必须打上 importedAt");

  ctx.assistant.send("导入");
  await tick(20);
  assert.equal(ctx.calls.imports.length, afterFirst, "已导入附件不得重复写库");
  const html = messagesHtml(ctx.doc);
  assert.match(html, /已于/);
  assert.match(html, /导入过（2 行）/);
  assert.match(html, /data-action-id="import-again"/);
  assert.match(html, /再次导入/);

  clickAction(ctx, "import-again");
  await tick(30);
  if (ctx.calls.imports.length === afterFirst && messagesHtml(ctx.doc).indexOf('data-action-id="import-confirm"') >= 0) {
    clickAction(ctx, "import-confirm");
    await tick(20);
  }
  assert.ok(ctx.calls.imports.length > afterFirst, "点「再次导入」后必须重新走清洗 → 确认导入");
});

/* ---------------- 6. 运行时：会话生命周期与摘要回填 ---------------- */

checkAsync("新会话清空附件，历史会话按摘要回填（无原图只能用提示兜底）", async () => {
  const visionCalls = [];
  const ctx = await boot({
    getLLMConfig: () => ({ baseUrl: "https://llm.example/v1", apiKey: "k", model: "m" }),
    callVisionLLM: (messages) => { visionCalls.push(messages); return Promise.resolve("x"); }
  });
  await ctx.assistant.handleFiles([{ name: "现场1.png", size: 1001 }, { name: "现场2.png", size: 1002 }]);
  await tick(30);

  const stored = JSON.parse(ctx.storage["boiler_assistant_history"]);
  const withAttachments = stored.find((item) => Array.isArray(item.attachments) && item.attachments.length === 2);
  assert.ok(withAttachments, "会话历史必须持久化附件摘要");
  assert.deepEqual(
    Object.keys(withAttachments.attachments[0]).sort(),
    ["at", "importedAt", "kind", "name", "notes", "rowCount", "seq"],
    "摘要字段必须符合契约（seq/name/kind/rowCount/notes/at/importedAt）"
  );

  clickWith(ctx, { "data-assistant": "new-chat" });
  await tick(20);
  assert.equal(ctx.assistant.listAttachments().length, 0, "新会话必须清空附件");
  assert.equal(attachmentsHtml(ctx.doc), "", "新会话的附件条必须为空");

  clickWith(ctx, { "data-assistant": "history-item", "data-conversation-id": withAttachments.id });
  await tick(20);
  const restored = ctx.assistant.listAttachments();
  assert.equal(restored.length, 2, "切换回历史会话必须按摘要回填附件");
  assert.equal(restored[0].restored, true);
  assert.equal(restored[0].rowCount, 2);
  assert.equal(restored[0].hasDataUrl, false, "摘要不含原图");
  assert.match(attachmentsHtml(ctx.doc), /现场1\.png/, "回填的附件必须出现在附件条里");

  ctx.assistant.send("这张图里有几个测点");
  await tick(20);
  assert.equal(visionCalls.length, 0, "回填附件没有原图，不得调用视觉模型");
  assert.match(messagesHtml(ctx.doc), /重新上传/, "必须提示重新上传原图");
});

/* ---------------- 7. 运行时：离线元信息与回归 ---------------- */

checkAsync("附件元信息（几个附件 / 多少行 / 有哪些列）离线可答", async () => {
  const ctx = await boot();
  ctx.assistant.handleFile({ name: "现场1.png", size: 1111 });
  await tick(30);
  ctx.assistant.send("这个表多少行");
  await tick(20);
  assert.match(messagesHtml(ctx.doc), /共 2 行数据/);
  ctx.assistant.send("有哪些列");
  await tick(20);
  assert.match(messagesHtml(ctx.doc), /共 11 列/);
  ctx.assistant.send("有几个附件");
  await tick(20);
  assert.match(messagesHtml(ctx.doc), /会话附件：1\) 现场1\.png/);
});

checkAsync("没有附件时不劫持既有规则路由", async () => {
  const ctx = await boot();
  ctx.assistant.send("帮助");
  await tick(20);
  assert.match(messagesHtml(ctx.doc), /锅炉炉管数据助手/);
  ctx.assistant.send("有几个附件");
  await tick(20);
  assert.doesNotMatch(messagesHtml(ctx.doc), /会话附件：/, "没有附件时不得接管这类问法");
  assert.equal(ctx.assistant.listAttachments().length, 0);
});

checkAsync("原图压缩失败只记备注，不阻断上传与清洗", async () => {
  const cleanDocs = {
    isImageFile: (name) => /\.(png|jpe?g|webp)$/i.test(String(name)),
    isPdfFile: () => false,
    imageToRows: () => Promise.resolve({ rows: CLEAN_ROWS, sheetName: "图片识别", notes: "" }),
    imageToDataUrl: () => Promise.reject(new Error("模拟压缩失败"))
  };
  const ctx = await boot({ BTAssistantDocs: cleanDocs });
  ctx.assistant.handleFile({ name: "坏图.png", size: 999 });
  await tick(40);
  const list = ctx.assistant.listAttachments();
  assert.equal(list.length, 1, "压缩失败也必须登记附件");
  assert.equal(list[0].hasDataUrl, false);
  assert.match(list[0].notes, /原图压缩失败/, "压缩失败必须记录在 notes 里");
  assert.ok(ctx.calls.imports.length >= 1, "压缩失败不得阻断清洗与导入");
  ctx.assistant.send("这张图里有几个测点");
  await tick(20);
  assert.match(messagesHtml(ctx.doc), /重新上传/, "没有原图时必须提示重新上传");
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
console.log("ok - assistant multiturn: " + total + "/" + total + " checks passed（附件模块：" + ATTACHMENTS_PATH + "）");
