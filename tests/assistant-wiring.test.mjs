import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, p), "utf8");
const coreSource = read("../assets/app/assistant-core-v1.js");
const analysisSource = read("../assets/app/assistant-analysis-v1.js");
const uiSource = read("../assets/app/assistant-ui-v1.js");
const wiringSource = read("../assets/app/assistant-v1.js");

/* ---------------- 静态契约 ---------------- */

const checks = [];
const check = (name, fn) => checks.push([name, fn]);
const asyncChecks = [];
const checkAsync = (name, fn) => asyncChecks.push([name, fn]);
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

function boot(extra) {
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
  if (extra && typeof extra === "object") Object.assign(sandbox, extra);
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(coreSource, sandbox);
  vm.runInContext(analysisSource, sandbox);
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

check("分析意图渲染图表卡片，并挂出导出明细动作", () => {
  const events = [];
  for (let i = 0; i < 8; i += 1) {
    events.push({
      ts: i + 1,
      code: "1-HSH-E-012-0005-W01",
      boiler: "1",
      date: "2026-0" + ((i % 9) + 1) + "-10",
      type: "测厚",
      thickness: Number((7.5 - i * 0.1).toFixed(2)),
      hardness: 180 + i * 3,
      spec: "Φ51×7.5",
      desc: "接线层样例"
    });
  }
  const { sandbox, doc } = boot({
    collectAssistantSnapshot: () => ({
      events: events,
      replacements: [],
      materialLibrary: [],
      matrix: [],
      retiredCodes: [],
      warnings: [],
      overdueRows: [],
      role: "editor",
      now: "2026-10-23T00:00:00.000Z"
    })
  });
  sandbox.BTAssistant.open();
  sandbox.BTAssistant.send("近两年壁厚趋势");
  const html = lastMessagesHtml(doc);
  assert.match(html, /class="assistant-analysis"/);
  assert.match(html, /data-kind="trend"/);
  assert.match(html, /<svg/);
  assert.match(html, /assistant-insight/);
  assert.match(html, /data-action-id="export-analysis"/, "分析卡片必须能导出明细");
  assert.match(html, /壁厚/);
});

check("没有数据时分析给出可执行提示，而不是空卡片", () => {
  const { sandbox, doc } = boot();
  sandbox.BTAssistant.open();
  sandbox.BTAssistant.send("各受热面事件数排行");
  assert.match(lastMessagesHtml(doc), /没有可分析的数据/);
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

/* ---------------- 大模型参与分析（异步） ---------------- */

checkAsync("配置模型后分析卡片升级为模型解读，并过滤无依据结论", async () => {
  const events = [];
  for (let m = 1; m <= 12; m += 1) {
    events.push({
      ts: m,
      code: "1-WW-FR-008-0001-000",
      boiler: "1",
      date: "2026-" + String(m).padStart(2, "0") + "-10",
      type: "测厚",
      thickness: m <= 6 ? 7.4 : 7.0,
      hardness: 180,
      spec: "Φ63.5×7.5",
      desc: "阶梯式减薄样例"
    });
  }
  const captured = [];
  const { sandbox, doc } = boot({
    collectAssistantSnapshot: () => ({
      events: events,
      replacements: [],
      materialLibrary: [],
      matrix: [],
      retiredCodes: [],
      warnings: [],
      overdueRows: [],
      role: "editor",
      now: "2026-10-23T00:00:00.000Z"
    }),
    getLLMConfig: () => ({ baseUrl: "https://llm.example/v1", apiKey: "k", model: "m" }),
    callAssistantChatCompletions: async (messages) => {
      captured.push(messages);
      return JSON.stringify({
        title: "壁厚阶跃下降",
        insights: [
          "平均壁厚 7.2mm，前 6 个月 7.4mm、后 6 个月 7mm，呈阶跃式下降。",
          "另有 3 根管段壁厚低于 5.55mm，需要立即换管。"
        ],
        risk: "medium",
        advice: "对后 6 个月的低值段安排测点复测。",
        spec: { kind: "trend", metric: "thickness", dimension: "month", chartType: "line" }
      });
    }
  });
  sandbox.BTAssistant.open();
  sandbox.BTAssistant.send("近两年壁厚趋势");
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(captured.length, 1, "分析只应调用一次模型");
  const payloadText = captured[0][1].content;
  assert.ok(!payloadText.includes("1-WW-FR-008-0001-000"), "证据包不得外发管段编码");
  const payload = JSON.parse(payloadText);
  assert.ok(payload.series.length > 0, "必须提供聚合序列供模型判断");
  assert.ok(!payload.table && !payload.rows, "不得外发明细表");

  const html = lastMessagesHtml(doc);
  assert.match(html, /data-source="llm"/, "卡片应标记为模型分析");
  assert.match(html, /assistant-analysis-badge/, "应渲染模型解读徽标元素");
  assert.match(html, /模型解读/, "徽标文案应为「模型解读」，与页面「深度分析」区分");
  assert.match(html, /平均壁厚 7\.2mm/, "有依据的模型结论应展示");
  assert.doesNotMatch(html, /5\.55/, "编造数值必须被过滤");
  assert.match(html, /1 条结论/, "应提示被过滤条数");
  assert.match(html, /对后 6 个月的低值段安排测点复测/, "建议应展示");
});

checkAsync("只在规则置信度低时才让模型参与判意图", async () => {
  const calls = [];
  const { sandbox } = boot({
    getLLMConfig: () => ({ baseUrl: "https://llm.example/v1", apiKey: "k", model: "m" }),
    callAssistantChatCompletions: async (messages) => {
      calls.push(messages);
      return JSON.stringify({ intent: "stats", datasetType: "unknown", params: {}, reply: "", confidence: 0.9 });
    }
  });
  const lowText = "看看这些数据";
  const baseIntent = sandbox.BTAssistantCore.parseIntent(lowText, {});
  assert.ok(baseIntent.confidence < 0.6, "测试文本的规则置信度应低于阈值，实际 " + baseIntent.confidence);

  sandbox.BTAssistant.open();
  sandbox.BTAssistant.send(lowText);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.length, 1, "低置信度应请求模型判定");

  sandbox.BTAssistant.send("帮助");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.length, 1, "高置信度的明确指令不应再请求模型");
});

checkAsync("模型调用失败时保留规则结论并给出降级说明", async () => {
  const events = [];
  for (let m = 1; m <= 6; m += 1) {
    events.push({
      ts: m,
      code: "1-WW-FR-008-0001-000",
      boiler: "1",
      date: "2026-0" + m + "-10",
      type: "测厚",
      thickness: 7.4 - m * 0.05,
      hardness: 180,
      spec: "Φ63.5×7.5",
      desc: ""
    });
  }
  const { sandbox, doc } = boot({
    collectAssistantSnapshot: () => ({ events, replacements: [], materialLibrary: [], matrix: [], retiredCodes: [], warnings: [], overdueRows: [], role: "editor" }),
    getLLMConfig: () => ({ baseUrl: "https://llm.example/v1", apiKey: "k", model: "m" }),
    callAssistantChatCompletions: async () => { throw new Error("接口 502"); }
  });
  sandbox.BTAssistant.open();
  sandbox.BTAssistant.send("壁厚趋势");
  await new Promise((resolve) => setTimeout(resolve, 80));
  const html = lastMessagesHtml(doc);
  assert.match(html, /data-source="rules"/, "失败时应回落为规则卡片");
  assert.match(html, /模型分析未采用/, "必须说明降级原因");
  assert.match(html, /接口 502/);
  assert.match(html, /平均壁厚/, "规则结论必须保留");
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

checkAsync("未识别数据集上传后：对话文案不说「可导入」，卡片也不给导入按钮", async () => {
  const { sandbox, doc } = boot();
  sandbox.BTAssistant.open();
  const csv = ["供应商名称,联系人,联系电话,供货范围", "华东钢管厂,王经理,13800138000,水冷壁管", "北方耐材,李经理,13900139000,耐火浇注料"].join("\n");
  const file = { name: "无关表格-供应商清单.csv", size: csv.length, type: "text/csv" };
  /* 接线层用 FileReader 读取 CSV */
  sandbox.FileReader = class {
    readAsText() { setTimeout(() => this.onload({ target: { result: csv } }), 0); }
  };
  sandbox.BTAssistant.handleFile(file);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const html = lastMessagesHtml(doc);
  assert.match(html, /未识别数据集|未识别出数据集类型/, "必须明确提示数据集未识别");
  assert.ok(!/可导入 \d+ 行/.test(html), "未识别数据集不得出现「可导入 N 行」，实际：" + html.slice(-400));
  assert.match(html, /通用清洗后保留 \d+ 行，不导入/, "应说明保留行数且不导入");
  assert.ok(html.indexOf('data-action-id="import-confirm"') < 0, "未识别数据集不能出现确认导入按钮");
});

for (const [name, fn] of checks) {
  fn();
  console.log("ok - " + name);
}
for (const [name, fn] of asyncChecks) {
  await fn();
  console.log("ok - " + name);
}
const total = checks.length + asyncChecks.length;
console.log("ok - assistant wiring: " + total + "/" + total + " checks passed");
