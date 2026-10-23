import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, p), "utf8");
const coreSource = read("../assets/app/assistant-core-v1.js");
const uiSource = read("../assets/app/assistant-ui-v1.js");
const wiringSource = read("../assets/app/assistant-v1.js");

/* ---------------- 静态契约 ---------------- */

const checks = [];
const check = (name, fn) => checks.push([name, fn]);
const has = (source, needle, label) => assert.ok(source.indexOf(needle) >= 0, label || ("缺少 " + needle));

check("接线层挂载门面并复用领域层与界面层", () => {
  has(wiringSource, "global.BTAssistant = api");
  has(wiringSource, "global.BTAssistantCore");
  has(wiringSource, "global.BTAssistantUI");
  ["mount", "open", "close", "toggle", "isOpen", "send", "handleFile", "refresh"].forEach((name) => {
    assert.ok(new RegExp("\\b" + name + "\\s*[:(]").test(wiringSource), "门面缺少 " + name);
  });
  has(wiringSource, "DOMContentLoaded", "必须在页面加载后自动挂载");
});

check("接线层落实二次确认、撤销与降级", () => {
  has(wiringSource, "confirmDialog");
  has(wiringSource, "undo-last-import");
  has(wiringSource, "undo-last-edit");
  has(wiringSource, "已降级");
  assert.ok(/setTimeout/.test(wiringSource), "模型调用必须有超时保护");
  has(wiringSource, "boiler_assistant_history");
  has(wiringSource, "boiler_assistant_last_import");
  has(wiringSource, "boiler_assistant_last_edit");
  has(wiringSource, "boiler_llm_config");
});

/* ---------------- 运行时：最小浏览器环境 ---------------- */

function createElement(doc) {
  return {
    style: {}, children: [], parentNode: null, hidden: false, className: "", id: "",
    value: "", disabled: false, _html: "", _attrs: {}, _handlers: {},
    set innerHTML(value) {
      this._html = String(value);
      if (doc && doc._writes) doc._writes.push({ id: this.id, html: this._html });
    },
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
        el.id = id;
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
    focus() {}, click() {}, scrollIntoView() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }
  };
}

function boot() {
  const downloads = [];
  const storage = {};
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
    downloadBlob: (name, content, type) => { downloads.push({ name, content, type }); },
    confirm: () => true,
    fetch: () => { throw new Error("未配置模型时不应发起网络请求"); }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(coreSource, sandbox);
  vm.runInContext(uiSource, sandbox);
  vm.runInContext(wiringSource, sandbox);
  return { sandbox, doc, downloads, storage };
}

const lastMessagesHtml = (doc) => {
  const hits = doc._writes.filter((item) => item.id === "assistantMessages");
  return hits.length ? hits[hits.length - 1].html : "";
};

check("接线层加载后面板自动挂载并可开关", () => {
  const { sandbox } = boot();
  const assistant = sandbox.BTAssistant;
  assert.ok(assistant, "必须挂载 window.BTAssistant");
  assistant.open();
  assert.equal(assistant.isOpen(), true);
  assistant.close();
  assert.equal(assistant.isOpen(), false);
  assistant.toggle();
  assert.equal(assistant.isOpen(), true);
});

check("帮助与统计对话走规则引擎并渲染到消息区", () => {
  const { sandbox, doc } = boot();
  sandbox.BTAssistant.open();
  sandbox.BTAssistant.send("帮助");
  assert.match(lastMessagesHtml(doc), /锅炉炉管数据助手/);

  sandbox.BTAssistant.send("现在数据质量怎么样");
  const html = lastMessagesHtml(doc);
  assert.match(html, /数据质量概览/);
  assert.match(html, /寿命事件/);
});

check("未配置模型时不联网，未知说法给出引导", () => {
  const { sandbox, doc } = boot();
  sandbox.BTAssistant.open();
  assert.doesNotThrow(() => sandbox.BTAssistant.send("今天天气怎么样"));
  assert.match(lastMessagesHtml(doc), /检查这批寿命数据能不能导入/);
});

check("导入意图在没有文件时提示上传", () => {
  const { sandbox, doc } = boot();
  sandbox.BTAssistant.open();
  sandbox.BTAssistant.send("把这些数据导入系统");
  const html = lastMessagesHtml(doc);
  assert.ok(/文件|上传/.test(html), "应提示先上传文件");
});

check("导出意图在无下载组件时报错而不是崩溃", () => {
  const { sandbox, doc, downloads } = boot();
  sandbox.BTAssistant.open();
  sandbox.BTAssistant.send("导出全部数据");
  assert.equal(downloads.length, 1, "应触发一次下载");
  assert.match(downloads[0].name, /\.csv$/);
  assert.match(lastMessagesHtml(doc), /已导出/);
});

check("会话历史持久化到本地存储", () => {
  const { sandbox, storage } = boot();
  sandbox.BTAssistant.open();
  sandbox.BTAssistant.send("帮助");
  const raw = storage["boiler_assistant_history"];
  assert.ok(raw, "必须写入会话历史");
  const list = JSON.parse(raw);
  assert.ok(Array.isArray(list) && list.length >= 1);
  assert.ok(Array.isArray(list[0].messages) && list[0].messages.length >= 2);
});

/* ---------------- 样例文件与领域层联动 ---------------- */

check("事件样例文件能被清洗并给出问题明细", () => {
  const { sandbox } = boot();
  const csv = read("fixtures/assistant-events-sample.csv").trim().split(/\r?\n/);
  const rows = csv.map((line) => line.split(","));
  const result = sandbox.BTAssistantCore.cleanRows({ rows: rows, fileName: "assistant-events-sample.csv" });
  assert.equal(result.report.datasetType, "events");
  assert.equal(result.report.summary.totalRows, 10);
  assert.ok(result.report.summary.errorCount >= 2, "缺管码与炉号冲突应判为错误");
  assert.ok(result.report.summary.duplicateRows >= 1, "完全重复行应被丢弃");
  assert.equal(result.report.summary.importable, false);
  assert.ok(result.report.checks.some((item) => item.id === "invalid_date"));
});

check("材料库样例文件能被识别为材料库数据集", () => {
  const { sandbox } = boot();
  const csv = read("fixtures/assistant-material-sample.csv").trim().split(/\r?\n/);
  const rows = csv.map((line) => line.split(","));
  const result = sandbox.BTAssistantCore.cleanRows({ rows: rows, fileName: "assistant-material-sample.csv" });
  assert.equal(result.report.datasetType, "material_library");
  assert.equal(result.report.summary.totalRows, 3);
  assert.ok(result.report.summary.cleanRows >= 2);
});

for (const [name, fn] of checks) {
  fn();
  console.log("ok - " + name);
}
console.log("ok - assistant wiring: " + checks.length + "/" + checks.length + " checks passed");
