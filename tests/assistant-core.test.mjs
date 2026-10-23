import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const corePath = resolve(here, "../assets/app/assistant-core-v1.js");
const source = readFileSync(corePath, "utf8");

// —— 加载 IIFE：验证「无 window 也能跑」与「window.BTAssistantCore / module.exports 双通道」——
const sandboxModule = { exports: {} };
const sandboxWindow = {};
new Function("window", "module", source)(sandboxWindow, sandboxModule);
const Core = sandboxModule.exports;

const require = createRequire(import.meta.url);
const requiredModule = require(corePath);
const browserOnly = {};
new Function("window", source)(browserOnly);

const EVENT_HEADER = ["数据分类", "炉号", "日期", "管段编码", "规格", "材质", "厚度(mm)", "硬度(HB)", "事件类型/更换原因", "关联新管码", "详细描述/结论"];
const MATERIAL_HEADER = ["部件名称", "系统代码", "分段/位置", "结构形式", "规格型号", "管径", "壁厚", "材质", "库存根数", "库存总长度(m)", "预留位置", "备注"];
const MATRIX = [
  { sys: "WW", zone: "FR", pMin: 1, pMax: 12, tMin: 1, tMax: 192 },
  { sys: "HSH", zone: "E", pMin: 1, pMax: 32, tMin: 1, tMax: 12 }
];
const eventRow = (over) => ["事件", "1", "2024-01-05", "1-WW-FR-008-0003-000", "Φ63.5×7.5", "SA-210C", "7.10", "185", "测厚", "", "前墙第8排第3管测厚"].map((cell, index) => (over && over[index] !== undefined ? over[index] : cell));
const cleanOf = (input) => Core.cleanRows(input);
const checkById = (report, id) => report.checks.find((item) => item.id === id);

const checks = [
  ["core module is exposed on window and module.exports", () => {
    assert.equal(typeof Core, "object");
    assert.equal(sandboxWindow.BTAssistantCore, Core, "window.BTAssistantCore 必须指向同一个 api");
    assert.equal(typeof browserOnly.BTAssistantCore.cleanRows, "function", "只有 window 时也要挂载");
    assert.equal(typeof requiredModule.cleanRows, "function", "CommonJS 里 module.exports 必须可用");
    assert.deepEqual(Object.keys(requiredModule).sort(), Object.keys(Core).sort(), "两种加载方式导出的 API 必须一致");
    const apiNames = [
      "datasetCatalog", "getDataset", "toolCatalog", "toolsForRole", "requiredRole", "toolRank", "roleLabel",
      "parseIntent", "cleanRows", "parseQuery", "parseEdit", "buildStats",
      "normalizeText", "normalizeDateText", "normalizeEventType", "normalizeCode", "validateTubeCode",
      "formatNumber", "escapeHtml"
    ];
    apiNames.forEach((name) => assert.equal(typeof Core[name], "function", name + " 必须导出为函数"));
  }],
  ["core stays a pure domain layer (no DOM / storage / network)", () => {
    assert.doesNotMatch(source, /\bdocument\./);
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/);
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest/);
    assert.doesNotMatch(source, /^\s*(import|export)\s/m);
  }],

  ["dataset registry covers events and material_library with header aliases", () => {
    const catalog = Core.datasetCatalog();
    assert.deepEqual(catalog.map((item) => item.type), ["events", "material_library"]);
    const events = Core.getDataset("events");
    assert.deepEqual(events.requiredHeaders, ["日期", "管段编码"]);
    assert.deepEqual(events.dateColumns, ["日期"]);
    assert.equal(events.typeColumn, "数据分类");
    assert.deepEqual(events.headers, EVENT_HEADER);
    const material = Core.getDataset("material_library");
    assert.deepEqual(material.requiredHeaders, ["部件名称", "规格型号", "材质"]);
    assert.deepEqual(material.businessKey, ["部件名称", "分段/位置", "规格型号", "材质"]);
    assert.equal(Core.getDataset("unknown"), null);
    assert.equal(Core.datasetLabel("events"), "寿命事件/检测记录");
    assert.equal(Core.datasetLabel("nope"), "数据");
  }],
  ["header aliases normalize case, full-width characters and spaces", () => {
    assert.equal(Core.canonicalHeader("events", " 日期 "), "日期");
    assert.equal(Core.canonicalHeader("events", "检测日期"), "日期");
    assert.equal(Core.canonicalHeader("events", "ＣＯＤＥ"), "管段编码");
    assert.equal(Core.canonicalHeader("events", "壁厚"), "厚度(mm)");
    assert.equal(Core.canonicalHeader("events", "hardness"), "硬度(HB)");
    assert.equal(Core.canonicalHeader("material_library", "规格"), "规格型号");
    assert.equal(Core.canonicalHeader("material_library", "材料"), "材质");
    assert.equal(Core.canonicalHeader("events", "未知列"), "未知列");
  }],
  ["dataset detection uses headers first and falls back to file name", () => {
    assert.equal(Core.resolveDatasetType(EVENT_HEADER), "events");
    assert.equal(Core.resolveDatasetType(MATERIAL_HEADER), "material_library");
    assert.equal(Core.resolveDatasetType(["随便", "几列"]), "unknown");
    assert.equal(Core.resolveDatasetType([], "寿命数据_录入模板.csv"), "events");
    assert.equal(Core.resolveDatasetType([], "受热面材料库_维护模板.csv"), "material_library");
    assert.equal(Core.resolveDatasetType([], "unknown.csv"), "unknown");
    assert.equal(Core.detectDatasetType(["日期", "管段编码"]), "events");
  }],

  ["tool catalog matches the contract table", () => {
    const catalog = Core.toolCatalog();
    const expected = {
      "assistant.clean": ["viewer", false, false],
      "data.import": ["editor", true, false],
      "data.export": ["viewer", false, true],
      "data.query": ["viewer", false, true],
      "data.edit": ["editor", true, true],
      "data.stats": ["viewer", false, true],
      "data.analyze": ["viewer", false, true],
      "data.undo": ["editor", true, true],
      "assistant.help": ["viewer", false, true]
    };
    assert.deepEqual(catalog.map((item) => item.name), Object.keys(expected));
    catalog.forEach((item) => {
      assert.deepEqual([item.minRole, item.requiresConfirm, item.runnableWithoutFile], expected[item.name], item.name);
    });
    catalog[0].minRole = "admin";
    assert.equal(Core.toolCatalog()[0].minRole, "viewer", "toolCatalog 必须返回副本，避免调用方改坏注册表");
  }],
  ["toolsForRole / requiredRole / toolRank / roleLabel follow the role ladder", () => {
    assert.deepEqual(Core.toolsForRole("viewer").map((item) => item.name), ["assistant.clean", "data.export", "data.query", "data.stats", "data.analyze", "assistant.help"]);
    assert.deepEqual(Core.toolsForRole("editor").map((item) => item.name), ["assistant.clean", "data.import", "data.export", "data.query", "data.edit", "data.stats", "data.analyze", "data.undo", "assistant.help"]);
    assert.equal(Core.toolsForRole("admin").length, 9);
    assert.equal(Core.toolsForRole("nobody").length, 6, "未知角色按 viewer 处理");
    assert.equal(Core.requiredRole("assistant.clean"), "viewer");
    assert.equal(Core.requiredRole("data.import"), "editor");
    assert.equal(Core.requiredRole("data.edit", "events"), "editor");
    assert.equal(Core.requiredRole("data.undo"), "editor");
    assert.equal(Core.requiredRole("data.analyze"), "viewer", "分析是只读能力");
    assert.deepEqual([Core.toolRank("viewer"), Core.toolRank("editor"), Core.toolRank("admin"), Core.toolRank("x")], [1, 2, 3, 0]);
    assert.deepEqual([Core.roleLabel("viewer"), Core.roleLabel("editor"), Core.roleLabel("admin")], ["只读", "编辑", "管理员"]);
  }],

  ["normalizeText strips spaces, lowercases and folds full-width characters", () => {
    assert.equal(Core.normalizeText(" ＡＢＣ　D e F "), "abcdef");
    assert.equal(Core.normalizeText("管 段\t编码"), "管段编码");
    assert.equal(Core.normalizeText(null), "");
    assert.equal(Core.normalizeText(undefined), "");
  }],
  ["normalizeDateText normalizes to YYYY-MM-DD and rejects impossible dates", () => {
    assert.equal(Core.normalizeDateText("2024/1/5"), "2024-01-05");
    assert.equal(Core.normalizeDateText("2024-01-05"), "2024-01-05");
    assert.equal(Core.normalizeDateText("2024.1.5"), "2024-01-05");
    assert.equal(Core.normalizeDateText("2024年1月5日"), "2024-01-05");
    assert.equal(Core.normalizeDateText("2024-02-30"), null);
    assert.equal(Core.normalizeDateText("2024-13-01"), null);
    assert.equal(Core.normalizeDateText("not a date"), null);
    assert.equal(Core.normalizeDateText(""), null);
    assert.equal(Core.normalizeDateText(null), null);
    assert.equal(Core.normalizeDateText(45296), "2024-01-05", "Excel 日期序列号也要能识别");
  }],
  ["normalizeEventType maps aliases and reports unknown values", () => {
    assert.deepEqual(Core.normalizeEventType("测厚"), { type: "测厚", known: true });
    assert.deepEqual(Core.normalizeEventType("金相"), { type: "金相分析", known: true });
    assert.deepEqual(Core.normalizeEventType("无损探伤"), { type: "无损检测", known: true });
    assert.deepEqual(Core.normalizeEventType("爆管更换"), { type: "报废更换", known: true });
    assert.deepEqual(Core.normalizeEventType("随便写写"), { type: "随便写写", known: false });
    assert.deepEqual(Core.normalizeEventType(""), { type: "", known: false });
  }],
  ["normalizeCode trims, strips BOM and uppercases", () => {
    assert.equal(Core.normalizeCode("\uFEFF 1-ww-fr-008-0003-000 "), "1-WW-FR-008-0003-000");
    assert.equal(Core.normalizeCode(null), "");
    assert.equal(Core.normalizeCode(undefined), "");
  }],
  ["validateTubeCode handles format, matrix matching and suffixes", () => {
    const ok = Core.validateTubeCode("1-WW-FR-008-0003-000");
    assert.equal(ok.valid, true);
    assert.equal(ok.code, "1-WW-FR-008-0003-000");
    assert.equal(ok.parts.sys, "WW");
    assert.equal(ok.parts.zone, "FR");
    assert.equal(ok.parts.panel, 8);
    assert.equal(ok.parts.tube, 3);
    assert.equal(ok.matched, null, "未提供矩阵时不判 matched");
    assert.equal(Core.validateTubeCode("1-WW-FR-008-0003-000-R1").valid, true, "更换后的 -R 后缀也合法");
    assert.equal(Core.validateTubeCode("1-HSH-E-012-0005-W02").valid, true);
    assert.equal(Core.validateTubeCode("bad-code").valid, false);
    assert.match(Core.validateTubeCode("bad-code").reason, /格式/);
    assert.equal(Core.validateTubeCode("").valid, false);
    assert.equal(Core.validateTubeCode(null).valid, false);
    const matched = Core.validateTubeCode("1-WW-FR-008-0003-000", MATRIX);
    assert.equal(matched.valid, true);
    assert.ok(matched.matched, "落入矩阵范围时应返回 matched 行");
    assert.equal(matched.matched.sys, "WW");
    const outside = Core.validateTubeCode("1-WW-FR-200-0003-000", MATRIX);
    assert.equal(outside.valid, true);
    assert.equal(outside.matched, null);
    assert.match(outside.reason, /台账矩阵/);
  }],
  ["formatNumber adds thousands separators and escapes html", () => {
    assert.equal(Core.formatNumber(1234567), "1,234,567");
    assert.equal(Core.formatNumber(1234.5), "1,234.50");
    assert.equal(Core.formatNumber(-1000), "-1,000");
    assert.equal(Core.formatNumber("abc"), "abc");
    assert.equal(Core.formatNumber(null), "-");
    assert.equal(Core.escapeHtml("<b a=\"1\">&'</b>"), "&lt;b a=&quot;1&quot;&gt;&amp;&#39;&lt;/b&gt;");
    assert.equal(Core.escapeHtml(null), "");
  }],

  ["parseIntent: help / stats / unknown stay distinct", () => {
    assert.equal(Core.parseIntent("帮助", {}).intent, "help");
    assert.equal(Core.parseIntent("你能做什么", {}).intent, "help");
    assert.equal(Core.parseIntent("现在数据质量怎么样", {}).intent, "stats");
    assert.equal(Core.parseIntent("一共有多少条事件", {}).intent, "stats");
    const unknown = Core.parseIntent("今天天气怎么样", {});
    assert.equal(unknown.intent, "unknown");
    assert.equal(unknown.tool, "assistant.help");
    assert.match(unknown.reply, /1\./);
    assert.match(unknown.reply, /2\./);
    assert.match(unknown.reply, /3\./, "unknown 时必须给出 3 条示例");
    assert.ok(unknown.reply.includes("检查这批寿命数据能不能导入"));
    assert.equal(Core.parseIntent("", {}).intent, "unknown");
    assert.equal(Core.parseIntent(null, {}).intent, "unknown");
    assert.equal(Core.parseIntent(undefined, undefined).intent, "unknown");
  }],
  ["parseIntent: download template is help, not export", () => {
    const template = Core.parseIntent("下载模板", {});
    assert.notEqual(template.intent, "export");
    assert.equal(template.intent, "help");
    assert.equal(template.params.note, "template");
    assert.match(template.reply, /模板/);
    assert.match(template.reply, /数据录入/);
    const templateAgain = Core.parseIntent("怎么下载 CSV 模板", {});
    assert.notEqual(templateAgain.intent, "export");
    const exportIntent = Core.parseIntent("导出当前数据", {});
    assert.equal(exportIntent.intent, "export");
    assert.equal(exportIntent.params.exportScope, "current_filter");
    assert.equal(exportIntent.params.format, "csv");
    const exportAll = Core.parseIntent("把全部数据导出成 Excel", {});
    assert.equal(exportAll.params.exportScope, "all");
    assert.equal(exportAll.params.format, "xlsx");
  }],
  ["parseIntent: wording for import / clean / edit / query", () => {
    const importer = Core.parseIntent("把这些数据导入系统", { role: "editor" });
    assert.equal(importer.intent, "import");
    assert.equal(importer.tool, "data.import");
    assert.equal(importer.needsConfirm, true, "写操作必须二次确认");
    assert.equal(importer.needsFile, true, "没有待处理文件时需要附件");
    const cleanIntent = Core.parseIntent("这批数据能不能导入", { role: "viewer" });
    assert.equal(cleanIntent.intent, "clean");
    assert.equal(cleanIntent.tool, "assistant.clean");
    const dedupe = Core.parseIntent("帮我洗一下数据并去重", { role: "viewer" });
    assert.equal(dedupe.intent, "clean");
    const editIntent = Core.parseIntent("把 1-WW-FR-008-0003-000 的最新测厚记录厚度改成 6.8", { role: "editor" });
    assert.equal(editIntent.intent, "edit");
    assert.equal(editIntent.tool, "data.edit");
    assert.equal(editIntent.needsConfirm, true);
    const queryIntent = Core.parseIntent("查询 1 号炉高过的测厚记录", { role: "viewer" });
    assert.equal(queryIntent.intent, "query");
    assert.equal(queryIntent.params.queryDataset, "events");
  }],
  ["parseIntent: same score resolves toward the riskier intent", () => {
    assert.equal(Core.parseIntent("撤销刚才的导入", {}).intent, "undo");
    assert.equal(Core.parseIntent("导入前先清洗并去重", {}).intent, "clean");
    assert.equal(Core.parseIntent("先导出再导入", {}).intent, "export");
    assert.equal(Core.parseIntent("修改后查询 1-WW-FR-008-0003-000", {}).intent, "query");
    assert.equal(Core.parseIntent("数据统计和帮助", {}).intent, "stats");
  }],
  ["parseIntent: role shortage still returns the intent but explains permission", () => {
    const denied = Core.parseIntent("把数据导入系统", { role: "viewer" });
    assert.equal(denied.intent, "import");
    assert.equal(denied.tool, "data.import");
    assert.match(denied.reply, /需要编辑权限/);
    assert.match(denied.reply, /请联系管理员/);
    const allowed = Core.parseIntent("把数据导入系统", { role: "editor" });
    assert.doesNotMatch(allowed.reply, /需要编辑权限/);
    const adminUndo = Core.parseIntent("撤销上次导入", { role: "admin" });
    assert.equal(adminUndo.intent, "undo");
    assert.doesNotMatch(adminUndo.reply, /需要编辑权限/);
    const offlineDefault = Core.parseIntent("把数据导入系统", {});
    assert.equal(offlineDefault.intent, "import");
    assert.doesNotMatch(offlineDefault.reply, /需要编辑权限/, "本地离线模式视为 editor");
  }],
  ["parseIntent: dataset detection from text, headers and active view", () => {
    assert.equal(Core.parseIntent("材料库数据检查一下", {}).datasetType, "material_library");
    assert.equal(Core.parseIntent("检查寿命事件数据", {}).datasetType, "events");
    assert.equal(Core.parseIntent("导入", { role: "editor", headers: MATERIAL_HEADER }).datasetType, "material_library");
    assert.equal(Core.parseIntent("导入", { role: "editor", activeDatasetType: "events" }).datasetType, "events");
    const pending = Core.parseIntent("清洗数据", { role: "editor", hasPendingRows: true });
    assert.equal(pending.needsFile, false, "已有待处理数据时不再要求文件");
  }],
  ["parseIntent: unknown dataset is never importable state and params stay sparse", () => {
    const intent = Core.parseIntent("今天天气怎么样", {});
    assert.equal(intent.datasetType, "unknown");
    assert.deepEqual(Object.keys(intent.params), []);
    assert.equal(intent.source, "rules");
    assert.ok(intent.confidence >= 0 && intent.confidence <= 1);
    const exportIntent = Core.parseIntent("导出", {});
    assert.deepEqual(Object.keys(exportIntent.params).sort(), ["exportScope", "format"]);
    assert.equal(exportIntent.datasetType, "unknown");
  }],
  ["parseIntent never throws on hostile input", () => {
    const hostile = [undefined, null, 0, "", "   ", {}, [], Symbol("x"), () => 1, { toString() { throw new Error("boom"); } }];
    hostile.forEach((value) => {
      const intent = Core.parseIntent(value, value);
      assert.equal(typeof intent.intent, "string");
      assert.equal(typeof intent.reply, "string");
    });
  }],

  ["cleanRows: happy path is importable with 1-based row indexes", () => {
    const result = cleanOf({
      rows: [EVENT_HEADER, eventRow(), eventRow({ 1: "2", 3: "2-HSH-E-012-0005-W02", 9: "2-HSH-E-012-0005-W02-R1", 8: "更换", 10: "爆管更换" })],
      fileName: "寿命数据_录入模板.csv"
    });
    assert.equal(result.report.datasetType, "events");
    assert.equal(result.report.summary.totalRows, 2);
    assert.equal(result.report.summary.cleanRows, 2);
    assert.equal(result.report.summary.errorCount, 0);
    assert.equal(result.report.summary.warningCount, 0);
    assert.equal(result.report.summary.issueCount, 0);
    assert.equal(result.report.summary.importable, true);
    assert.deepEqual(result.report.rowIndexes, [1, 2]);
    assert.equal(result.cleanRows.length, 3, "cleanRows 含表头 + 2 条数据行");
    assert.deepEqual(result.cleanRows[0], EVENT_HEADER);
    assert.equal(result.preview.length, 2, "preview 不含表头");
    assert.equal(result.report.fileName, "寿命数据_录入模板.csv");
  }],
  ["cleanRows: row numbers are 1-based after the header and count blank rows", () => {
    const result = cleanOf({
      rows: [EVENT_HEADER, eventRow(), [""], ["", "", ""], eventRow({ 10: "第二条" })]
    });
    assert.equal(result.report.summary.totalRows, 4, "空行也计入 totalRows");
    assert.deepEqual(result.report.rowIndexes, [1, 4]);
    assert.equal(result.report.normalizations.filter((item) => /空行/.test(item)).length, 2);
  }],
  ["cleanRows: duplicate rows keep the first row only", () => {
    const result = cleanOf({
      rows: [EVENT_HEADER, eventRow(), eventRow(), eventRow({ 10: "另一条描述" }), eventRow()]
    });
    const duplicate = checkById(result.report, "duplicate_rows");
    assert.ok(duplicate, "必须输出 duplicate_rows");
    assert.deepEqual(duplicate.rows, [1, 2, 4], "报告行号包含被保留首行与该组重复行");
    assert.deepEqual(duplicate.droppedRows, [2, 4]);
    assert.deepEqual(duplicate.keptRows, [1]);
    assert.equal(result.report.summary.duplicateRows, 2, "duplicateRows = 被丢弃的重复行数");
    assert.equal(result.report.summary.cleanRows, 2, "首行 + 描述不同那一行");
    assert.deepEqual(result.report.rowIndexes, [1, 3]);
  }],
  ["cleanRows: replacement duplicates use boiler + old/new code + date + reason", () => {
    const replacement = (reason) => ["更换", "1", "2024-03-01", "1-WW-FR-008-0003-000", "", "", "", "", reason, "1-WW-FR-008-0003-000-R1", "泄漏"];
    const result = cleanOf({ rows: [EVENT_HEADER, replacement("爆管更换"), replacement("爆管更换"), replacement("检修更换")] });
    assert.equal(result.report.summary.cleanRows, 2);
    assert.equal(result.report.summary.duplicateRows, 1);
    assert.deepEqual(checkById(result.report, "duplicate_rows").droppedRows, [2]);
  }],
  ["cleanRows: rows missing required fields are dropped and reported", () => {
    const result = cleanOf({
      rows: [EVENT_HEADER,
        eventRow({ 2: "" }),
        eventRow({ 3: "" }),
        ["更换", "1", "2024-03-01", "1-WW-FR-008-0003-000", "", "", "", "", "爆管更换", "", "泄漏"]]
    });
    const missing = checkById(result.report, "missing_required");
    assert.ok(missing);
    assert.equal(missing.severity, "error");
    assert.deepEqual(missing.rows, [1, 2, 3]);
    assert.equal(result.report.summary.errorCount, 3);
    assert.equal(result.report.summary.cleanRows, 0);
    assert.equal(result.report.summary.importable, false);
  }],
  ["cleanRows: boiler_mismatch rows are errors and never enter cleanRows", () => {
    const result = cleanOf({
      rows: [EVENT_HEADER,
        eventRow({ 1: "2" }),
        eventRow({ 3: "1-WW-FR-008-0004-000" }),
        eventRow({ 3: "1-WW-FR-008-0005-000" })]
    });
    const mismatch = checkById(result.report, "boiler_mismatch");
    assert.ok(mismatch, "炉号与编码不一致必须报 boiler_mismatch");
    assert.equal(mismatch.severity, "error");
    assert.deepEqual(mismatch.rows, [1]);
    assert.equal(result.report.summary.errorCount, 1);
    assert.deepEqual(result.report.rowIndexes, [2, 3]);
    assert.equal(result.report.summary.cleanRows, 2);
    assert.equal(result.report.summary.importable, false, "有 error 就不可导入");
  }],
  ["cleanRows: unknown 数据分类 is skipped like importCSV does", () => {
    const result = cleanOf({ rows: [EVENT_HEADER, eventRow({ 0: "检测" }), eventRow({ 3: "1-WW-FR-008-0004-000" })] });
    const unknownType = checkById(result.report, "unknown_type");
    assert.ok(unknownType);
    assert.deepEqual(unknownType.rows, [1]);
    assert.equal(result.report.summary.cleanRows, 1);
    assert.equal(result.report.rowIndexes.length, 1);
    assert.equal(checkById(result.report, "unknown_type").sample[0], "检测");
  }],
  ["cleanRows: dates are normalized to YYYY-MM-DD and failures stay as warnings", () => {
    const result = cleanOf({
      rows: [EVENT_HEADER, eventRow({ 2: "2024/1/5" }), eventRow({ 2: "2024年1月6日", 3: "1-WW-FR-008-0004-000" }), eventRow({ 2: "不知道", 3: "1-WW-FR-008-0005-000" })]
    });
    assert.equal(result.cleanRows[1][2], "2024-01-05");
    assert.equal(result.cleanRows[2][2], "2024-01-06");
    assert.equal(result.cleanRows[3][2], "不知道", "无法解析时保留原文");
    const invalidDate = checkById(result.report, "invalid_date");
    assert.ok(invalidDate);
    assert.equal(invalidDate.severity, "warning");
    assert.deepEqual(invalidDate.rows, [3]);
    assert.equal(result.report.summary.warningCount, 1);
    assert.equal(result.report.summary.errorCount, 0);
    assert.equal(result.report.summary.importable, true, "warning 不阻断导入");
    assert.ok(result.report.normalizations.some((item) => item.includes("已归一为")));
  }],
  ["cleanRows: thickness/hardness values are checked as numbers", () => {
    const result = cleanOf({
      rows: [EVENT_HEADER, eventRow({ 6: "很厚" }), eventRow({ 7: "硬", 3: "1-WW-FR-008-0004-000" })]
    });
    const invalidNumber = checkById(result.report, "invalid_number");
    assert.ok(invalidNumber);
    assert.equal(invalidNumber.severity, "warning");
    assert.deepEqual(invalidNumber.rows, [1, 2]);
    assert.equal(result.report.summary.cleanRows, 2, "数值异常只提示，行仍保留");
    assert.equal(result.report.summary.importable, true);
  }],
  ["cleanRows: unmatched, retired and out-of-range codes are warnings", () => {
    const result = cleanOf({
      rows: [EVENT_HEADER,
        eventRow({ 3: "1-ABCDE-FR-008-0003-000" }),
        eventRow({ 3: "1-WW-FR-200-0003-000" }),
        eventRow({ 3: "1-WW-FR-008-0004-000" })],
      matrixRows: MATRIX,
      retiredCodes: ["1-WW-FR-008-0004-000"]
    });
    assert.deepEqual(checkById(result.report, "unmatched_code").rows, [1]);
    assert.deepEqual(checkById(result.report, "out_of_range").rows, [2]);
    assert.deepEqual(checkById(result.report, "retired_code").rows, [3]);
    assert.equal(result.report.summary.errorCount, 0);
    assert.equal(result.report.summary.warningCount, 3);
    assert.equal(result.report.summary.cleanRows, 3, "编码类问题不阻断导入");
    assert.equal(checkById(result.report, "retired_code").sample[0], "1-WW-FR-008-0004-000");
  }],
  ["cleanRows: extra trailing columns are info and rows keep the file width", () => {
    const wideHeader = EVENT_HEADER.concat(["", ""]);
    const result = cleanOf({ rows: [wideHeader, eventRow().concat(["", ""])] });
    const extra = checkById(result.report, "extra_columns");
    assert.ok(extra);
    assert.equal(extra.severity, "info");
    assert.equal(result.report.summary.issueCount, 0, "info 不计入 issueCount");
    assert.equal(result.cleanRows[1].length, wideHeader.length, "数据行补齐到原表头宽度");
    const shortRow = cleanOf({ rows: [EVENT_HEADER, eventRow().slice(0, 5)] });
    assert.equal(shortRow.cleanRows[1].length, EVENT_HEADER.length, "短行补齐到表头宽度");
    assert.equal(shortRow.cleanRows[1][8], "", "缺失的格补空字符串");
    const tooShort = cleanOf({ rows: [EVENT_HEADER, [eventRow()[0]]] });
    assert.equal(tooShort.report.summary.cleanRows, 0, "少于 5 列的行与 importCSV 一样跳过");
    assert.deepEqual(checkById(tooShort.report, "missing_required").rows, [1]);
  }],
  ["cleanRows: header-level missing columns block import", () => {
    const result = cleanOf({ rows: [["数据分类", "日期", "规格"], ["事件", "2024-01-05", "x"]], datasetType: "events" });
    const missing = checkById(result.report, "missing_required");
    assert.ok(missing);
    assert.equal(missing.severity, "error");
    assert.match(missing.detail, /管段编码/);
    assert.equal(result.report.summary.importable, false);
    assert.equal(result.report.summary.cleanRows, 0);
  }],
  ["cleanRows: unknown dataset only runs generic cleaning and is never importable", () => {
    const result = cleanOf({ rows: [["甲", "乙", "丙"], ["a", "b", "c"], ["a", "b", "c"], ["  d  ", " e ", " f "]] });
    assert.equal(result.report.datasetType, "unknown");
    assert.equal(result.report.summary.importable, false);
    assert.equal(result.report.summary.cleanRows, 2, "完全重复的行被丢弃");
    assert.equal(result.report.summary.duplicateRows, 1);
    assert.deepEqual(result.cleanRows[2], ["d", "e", "f"], "trim 生效");
    const unknownCheck = result.report.checks.filter((item) => item.id === "unknown_type");
    assert.equal(unknownCheck.length, 1);
    assert.equal(unknownCheck[0].severity, "warning");
    assert.equal(unknownCheck[0].title, "未识别数据集");
  }],
  ["cleanRows: material_library uses component/spec/material as row key", () => {
    const result = cleanOf({
      rows: [MATERIAL_HEADER,
        ["省煤器", "ECO", "1 蛇形管", "蛇形管", "Φ51×6", "51", "6", "SA-210C", "", "", "", "第47页"],
        ["省煤器", "ECO", "1 蛇形管", "蛇形管", "Φ51×6", "51", "6", "SA-210C", "", "", "", "重复"],
        ["省煤器", "ECO", "2 吊挂管", "吊挂管", "", "60", "9", "SA-210C", "", "", "", "缺规格"]]
    });
    assert.equal(result.report.datasetType, "material_library");
    assert.equal(result.report.summary.totalRows, 3);
    assert.equal(result.report.summary.cleanRows, 1);
    assert.equal(result.report.summary.duplicateRows, 1);
    const missing = checkById(result.report, "missing_required");
    assert.deepEqual(missing.rows, [3]);
    assert.equal(result.report.summary.importable, false);
    assert.equal(result.preview[0][0], "省煤器");
  }],
  ["cleanRows: preview holds at most five data rows without header", () => {
    const rows = [EVENT_HEADER];
    for (let index = 0; index < 7; index += 1) {
      rows.push(eventRow({ 2: `2024-01-${10 + index}`, 3: `1-WW-FR-008-000${index}` }));
    }
    const result = cleanOf({ rows });
    assert.equal(result.preview.length, 5);
    assert.equal(result.cleanRows.length, 8);
    assert.equal(result.report.rowIndexes.length, 7);
    assert.notDeepEqual(result.preview[0], EVENT_HEADER);
  }],
  ["cleanRows never throws on hostile input", () => {
    const hostile = [undefined, null, 0, "", [], {}, { rows: "x" }, { rows: [null] }, { rows: [[null, undefined]] }, { rows: [{}] }, { rows: [[1, 2], ["x", 2]] }];
    hostile.forEach((value) => {
      const result = cleanOf(value);
      assert.equal(typeof result.report.summary.importable, "boolean");
      assert.ok(Array.isArray(result.cleanRows));
      assert.ok(Array.isArray(result.preview));
    });
  }],

  ["parseQuery: unit / system / type / risk filters", () => {
    const parsed = Core.parseQuery("查询 1 号炉高过的高风险测厚记录", { now: "2026-10-23" });
    assert.equal(parsed.dataset, "events");
    assert.equal(parsed.filters.unit, "1");
    assert.equal(parsed.filters.sys, "HSH");
    assert.equal(parsed.filters.type, "测厚");
    assert.equal(parsed.filters.riskLevel, "HIGH");
    assert.match(parsed.description, /1 号机组/);
    assert.match(parsed.description, /高温过热器/);
    assert.equal(Core.parseQuery("2号炉水冷壁前墙的事件", {}).filters.zone, "FR");
    const wide = Core.parseQuery("1 号炉所有过热器的事件", {});
    assert.deepEqual(wide.filters.sys, ["RSH", "WSH", "LSH", "PSH", "ISH", "HSH"]);
    assert.match(wide.description, /顶棚过热器/);
    assert.equal(Core.parseQuery("全厂的事故", {}).filters.unit, undefined, "全厂不设 unit");
  }],
  ["parseQuery: code / keyword / thickness / date filters", () => {
    const byCode = Core.parseQuery("查 1-WW-FR-008-0003-000 的全部记录", { now: "2026-10-23" });
    assert.equal(byCode.filters.code, "1-WW-FR-008-0003-000");
    const thickness = Core.parseQuery("壁厚小于6.5的测厚记录", { now: "2026-10-23" });
    assert.equal(thickness.filters.maxThickness, 6.5);
    assert.equal(thickness.filters.type, "测厚");
    assert.equal(Core.parseQuery("厚度大于 8 的记录", {}).filters.minThickness, 8);
    const year = Core.parseQuery("2024 年的事件", { now: "2026-10-23" });
    assert.equal(year.filters.dateFrom, "2024-01-01");
    assert.equal(year.filters.dateTo, "2024-12-31");
    const range = Core.parseQuery("2022-2024 年的更换记录", { now: "2026-10-23" });
    assert.equal(range.dataset, "replacements");
    assert.equal(range.filters.dateFrom, "2022-01-01");
    assert.equal(range.filters.dateTo, "2024-12-31");
    const recent = Core.parseQuery("最近3个月新增了什么", { now: "2026-10-23" });
    assert.equal(recent.filters.dateFrom, "2026-07-23");
    assert.equal(recent.filters.dateTo, "2026-10-23");
    const keyword = Core.parseQuery('查「HSH」的记录', {});
    assert.equal(keyword.filters.sys, "HSH");
  }],
  ["parseQuery: maintenance / material / ledger datasets", () => {
    const overdue = Core.parseQuery("超过10年没检查的管段", { now: "2026-10-23" });
    assert.equal(overdue.dataset, "maintenance");
    assert.equal(overdue.filters.overdueYears, 10);
    const never = Core.parseQuery("从未检查过的管段", {});
    assert.equal(never.dataset, "maintenance");
    assert.equal(never.filters.neverInspected, true);
    assert.equal(Core.parseQuery("材料库有哪些库存", {}).dataset, "material_library");
    assert.equal(Core.parseQuery("炉管台账里有多少管段", {}).dataset, "tube_ledger");
    assert.equal(Core.parseQuery("有哪些预警", {}).dataset, "warnings");
    assert.equal(Core.parseQuery("", {}).dataset, "unknown");
    assert.deepEqual(Core.parseQuery("", {}).filters, {});
    assert.equal(Core.parseQuery("今天天气怎么样", {}).dataset, "unknown");
    assert.equal(Core.parseQuery("今天天气怎么样", {}).description, "");
    assert.equal(Core.parseQuery(null, null).dataset, "unknown");
  }],

  ["parseEdit: latest record single field edit", () => {
    const parsed = Core.parseEdit("把 1-WW-FR-008-0003-000 的最新测厚记录厚度改成 6.8");
    assert.ok(parsed);
    assert.equal(parsed.targetCode, "1-WW-FR-008-0003-000");
    assert.equal(parsed.recordHint, "latest");
    assert.equal(parsed.field, "thickness");
    assert.equal(parsed.value, "6.8");
    assert.match(parsed.reply, /确认/);
    const hardness = Core.parseEdit("2-HSH-E-012-0005-W02 的硬度改为 190");
    assert.equal(hardness.field, "hardness");
    assert.equal(hardness.value, "190");
    const date = Core.parseEdit("把 1-WW-FR-008-0003-000 的日期改成 2024/3/5");
    assert.equal(date.field, "date");
    assert.equal(date.value, "2024-03-05");
    assert.equal(date.recordHint, "date");
    assert.equal(date.targetDate, "2024-03-05");
    assert.equal(Core.parseEdit("把 1-WW-FR-008-0003-000 的管码改成 1-WW-FR-008-0004-000").field, "code");
    assert.equal(Core.parseEdit("把 1-WW-FR-008-0003-000 的类型改成金相").value, "金相分析");
    assert.equal(Core.parseEdit("把 1-WW-FR-008-0003-000 的最早记录厚度改成 7.0").recordHint, "oldest");
  }],
  ["parseEdit: invalid values and missing anchors return null", () => {
    assert.equal(Core.parseEdit("把 1-WW-FR-008-0003-000 的厚度改成 abc"), null);
    assert.equal(Core.parseEdit("把 1-WW-FR-008-0003-000 的厚度改成 -3"), null);
    assert.equal(Core.parseEdit("把 1-WW-FR-008-0003-000 的厚度改成 500"), null, "厚度上限 100mm");
    assert.equal(Core.parseEdit("把 1-WW-FR-008-0003-000 的硬度改成 900"), null, "硬度上限 600HB");
    assert.equal(Core.parseEdit("把 1-WW-FR-008-0003-000 的日期改成 不是日期"), null);
    assert.equal(Core.parseEdit("把厚度改成 6.8"), null, "缺少管段编码");
    assert.equal(Core.parseEdit("把 1-WW-FR-008-0003-000 改一改"), null, "缺少字段词");
    assert.equal(Core.parseEdit("你好"), null);
    assert.equal(Core.parseEdit(""), null);
    assert.equal(Core.parseEdit(null), null);
  }],

  ["buildStats: metrics cover the five required indicators", () => {
    const now = new Date("2026-10-23T00:00:00Z");
    const stats = Core.buildStats({
      events: [
        { code: "1-WW-FR-008-0003-000", type: "测厚", date: "2026-10-01", thickness: "6.8", hardness: "185", desc: "a", ts: Date.now() },
        { code: "1-WW-FR-008-0003-000", type: "测厚", date: "2024-01-01", thickness: "7.1", hardness: "190", desc: "b", ts: 1 }
      ],
      replacements: [{ oldCode: "1-WW-FR-008-0004-000", newCode: "1-WW-FR-008-0004-000-R1", date: "2024-02-01", ts: 2 }],
      materialLibrary: [{ component: "省煤器", spec: "Φ51×6", material: "SA-210C", stockQty: "10" }],
      matrix: MATRIX,
      retiredCodes: ["1-WW-FR-008-0009-000"],
      now
    });
    assert.equal(typeof stats.intro, "string");
    assert.match(stats.intro, /寿命事件/);
    assert.ok(stats.metrics.length >= 4 && stats.metrics.length <= 8, "指标数量 4~8");
    const labels = stats.metrics.map((item) => item.label);
    ["寿命事件", "涉及管段", "更换记录", "材料库记录", "近 30 天新增"].forEach((label) => {
      assert.ok(labels.includes(label), "缺少指标：" + label);
    });
    stats.metrics.forEach((item) => {
      assert.equal(typeof item.label, "string");
      assert.equal(typeof item.value, "string");
    });
    assert.equal(stats.metrics.find((item) => item.label === "涉及管段").value, "1");
    assert.equal(stats.metrics.find((item) => item.label === "近 30 天新增").value, "1");
  }],
  ["buildStats: reports the six data-quality issues", () => {
    const now = new Date("2026-10-23T00:00:00Z");
    const stats = Core.buildStats({
      events: [
        { code: "1-WW-FR-008-0003-000", type: "测厚", date: "2024-01-01", thickness: "", hardness: "", desc: "缺厚度", ts: 1 },
        { code: "1-WW-FR-008-0003-000", type: "测厚", date: "2024-01-01", thickness: "", hardness: "", desc: "缺厚度", ts: 2 },
        { code: "9-WW-FR-999-0003-000", type: "金相分析", date: "2024-01-01", thickness: "6", hardness: "180", desc: "矩阵外", ts: 3 },
        { code: "1-WW-FR-008-0009-000", type: "测厚", date: "2024-01-01", thickness: "6", hardness: "180", desc: "报废", ts: 4 }
      ],
      replacements: [],
      materialLibrary: [{ component: "省煤器", spec: "Φ51×6", material: "SA-210C" }],
      matrix: MATRIX,
      retiredCodes: ["1-WW-FR-008-0009-000"],
      now
    });
    const titles = stats.issues.map((item) => item.title);
    assert.ok(titles.includes("检测事件缺少厚度/硬度"));
    assert.ok(titles.includes("业务键重复事件"));
    assert.ok(titles.includes("编码不在台账矩阵"));
    assert.ok(titles.includes("已报废管码仍有新事件"));
    assert.ok(titles.includes("材料库缺少库存信息"));
    assert.ok(titles.includes("材料库理论厚度未匹配"));
    const duplicate = stats.issues.find((item) => item.title === "业务键重复事件");
    assert.deepEqual(duplicate.rows, [2], "rows 为 1 基记录序号");
  }],
  ["buildStats never throws and returns a stable shape", () => {
    [undefined, null, 0, "", {}, [], { events: "x", matrix: 5 }].forEach((value) => {
      const stats = Core.buildStats(value);
      assert.equal(typeof stats.intro, "string");
      assert.ok(Array.isArray(stats.metrics));
      assert.ok(Array.isArray(stats.issues));
    });
    const empty = Core.buildStats({});
    assert.equal(empty.metrics.length, 5);
    assert.deepEqual(empty.issues, []);
    assert.match(empty.intro, /0 条寿命事件/);
  }]
];

let passed = 0;
for (const [name, check] of checks) {
  try {
    check();
  } catch (error) {
    console.error("FAIL - " + name);
    throw error;
  }
  passed += 1;
  console.log("ok - " + name);
}
console.log(`ok - assistant core: ${passed}/${checks.length} checks passed`);
