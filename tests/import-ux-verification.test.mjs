import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";

/**
 * 数据导入便捷性/准确性 全面验收（含 AI 辅助清洗、识别分类、模糊定位）。
 *
 * 夹具（tests/fixtures/import-ux/，由 build_fixtures.py 生成）模拟现场真实文件：
 *   - 现场检测记录-乱序列.csv   别名表头 + 乱序列 + 日期/数值脏数据 + 笔误编码 + 重复行 + BOM
 *   - 受热面材料台账-别名表头.csv 材料库别名表头 + 重复行 + 缺材质
 *   - 无关表格-供应商清单.csv    非台账表格（必须判 unknown、不误写库）
 *   - 检测记录.xlsx              真实 Excel（openpyxl 生成，多工作表）
 *   - 检测台账.docx              真实 Word（OOXML 表格，别名表头 + 脏数据）
 *
 * 覆盖四条验收主线：
 *   A 识别和分类 —— 数据集识别（表头/文件名兜底）、事件类型别名、数据分类别名、无关表格不误判
 *   B 模糊定位（表头）—— 现场叫法 → 标准字段、歧义不映射、模型映射优先、列序归一
 *   C 模糊定位（编码）—— 笔误编码近似建议、-R1 新管码、跨系统过滤、低相似不误报
 *   D 清洗与导入准确性 —— 分流（干净行/警告行/错误行）、日期数值归一、重复去重、缺失阻断
 *   E 便捷性 —— Word/CSV 同口径、大文件性能、格式容错（BOM/全角）
 */
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Core = require(resolve(here, "../assets/app/assistant-core-v1.js"));

const checks = [];
const check = (name, fn) => checks.push([name, fn]);
const checkById = (report, id) => report.checks.find((item) => item.id === id);

/* 与页面「炉管台账」同构的矩阵（覆盖夹具里的前墙/后墙/冷灰斗/高过） */
const MATRIX = [
  { sys: "SLB", comp: "WB", pos: "F000", dirs: ["R", "L"], tMax: 192 },
  { sys: "SLB", comp: "WB", pos: "B000", dirs: ["R", "L"], tMax: 192 },
  { sys: "SLB", comp: "LHD", pos: "F000", dirs: ["L", "R"], tMax: 96 },
  { sys: "GGRQ", comp: "GQ", posLetters: ["L", "R"], pMax: 32, dirs: ["U", "D"], tMax: 12 }
];
/* 台账已有编码（模拟系统里已存在检测记录的管段） */
const KNOWN = [
  "1G-SLB-WB-F000-R003-Q001", "1G-SLB-WB-F000-R004-Q001", "1G-SLB-WB-B000-R010-Q001",
  "1G-SLB-WB-B000-R011-Q001", "1G-SLB-WB-B000-R012-Q001", "1G-SLB-WB-B000-R013-Q001"
];
const CLEAN_CONTEXT = { matrixRows: MATRIX, knownCodes: KNOWN, units: ["1", "2"] };

function fixture(name) {
  return readFileSync(resolve(here, "fixtures/import-ux", name), "utf8");
}
function parseCsvText(text) {
  const body = text.replace(/^\uFEFF/, "");
  const lines = body.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => line.split(","));
}
/* 与接线层 splitCleanRowsByWarnings 同一条规则：出现在任一警告/错误检查行号里的行 → 待人工确认 */
function splitByWarnings(cleanRows, report) {
  const flagged = {};
  (report.checks || []).forEach((item) => {
    if (item.severity === "warning" || item.severity === "error") (item.rows || []).forEach((n) => { flagged[n] = true; });
  });
  const auto = [];
  const flaggedRows = [];
  (cleanRows || []).slice(1).forEach((row, i) => {
    const rowNumber = report.rowIndexes[i];
    if (flagged[rowNumber]) flaggedRows.push(row); else auto.push(row);
  });
  return { auto, flaggedRows };
}
/* 按原始行号取清洗后网格行（cleanRows[0] 是表头） */
function rowByNumber(result, rowNumber) {
  const index = result.report.rowIndexes.indexOf(rowNumber);
  return result.cleanRows[index + 1];
}

/* ================= A. 识别和分类 ================= */

check("识别：别名表头 + 乱序列的事件台账，靠文件名兜底分类为「寿命事件/检测记录」", () => {
  const rows = parseCsvText(fixture("现场检测记录-乱序列.csv"));
  assert.equal(rows[0][0], "设备编码"); // 表头不是标准模板
  assert.equal(Core.detectDatasetType(rows[0], "现场检测记录-乱序列.csv"), "events");
  assert.equal(Core.datasetLabel("events"), "寿命事件/检测记录");
});

check("识别：表头模糊列无法分类时必须返回 unknown（设备编码只是模糊命中，不参与分类）", () => {
  const rows = parseCsvText(fixture("现场检测记录-乱序列.csv"));
  assert.equal(Core.detectDatasetType(rows[0], ""), "unknown");
});

check("识别：材料库别名表头靠文件名分类为「受热面材料库」", () => {
  const rows = parseCsvText(fixture("受热面材料台账-别名表头.csv"));
  assert.equal(Core.detectDatasetType(rows[0], "受热面材料台账-别名表头.csv"), "material_library");
});

check("识别：无关表格（供应商清单）判为 unknown，绝不误判成台账", () => {
  const rows = parseCsvText(fixture("无关表格-供应商清单.csv"));
  assert.equal(Core.detectDatasetType(rows[0], "无关表格-供应商清单.csv"), "unknown");
  assert.equal(Core.detectDatasetType(rows[0], ""), "unknown");
});

check("识别：标准表头直接命中——材料库三要素 + 事件「日期+管段编码」", () => {
  assert.equal(Core.detectDatasetType(["部件名称", "规格型号", "材质", "库存根数"], ""), "material_library");
  assert.equal(Core.detectDatasetType(["日期", "管段编码"], ""), "events");
  /* 两者同时命中时材料库优先（表头更特异） */
  assert.equal(Core.detectDatasetType(["日期", "管段编码", "部件名称", "规格型号", "材质"], ""), "material_library");
});

check("分类：事件类型现场叫法归一——探伤→无损检测、金相→金相分析、爆管更换→报废更换", () => {
  const expectations = [
    ["测厚", "测厚"], ["壁厚测量", "测厚"], ["探伤", "无损检测"], ["无损探伤", "无损检测"],
    ["金相", "金相分析"], ["割管", "割管取样"], ["报废", "报废更换"], ["爆管更换", "报废更换"], ["投运", "安装投运"]
  ];
  for (const [raw, type] of expectations) {
    assert.equal(Core.normalizeEventType(raw).type, type, raw + " 应归一为 " + type);
    assert.equal(Core.normalizeEventType(raw).known, true, raw + " 应被识别为已知类型");
  }
});

check("分类：数据分类列只认「事件/更换」（含英文与大小写），其余值跳过并提示", () => {
  const rows = [
    ["数据分类", "炉号", "日期", "管段编码", "事件类型/更换原因"],
    ["event", "1", "2024-03-05", "1G-SLB-WB-F000-R003-Q001", "测厚"],
    ["Replacement", "1", "2024-03-06", "1G-SLB-WB-F000-R004-Q001", "爆管更换"],
    ["巡检", "1", "2024-03-07", "1G-SLB-WB-B000-R010-Q001", "测厚"]
  ];
  const report = Core.cleanRows({ rows, ...CLEAN_CONTEXT }).report;
  assert.equal(checkById(report, "unknown_type").rows.join(","), "3");
  assert.deepEqual(report.rowIndexes, [1, 2]);
});

/* ================= B. 模糊定位：表头 ================= */

check("模糊定位：现场叫法逐一映射到标准字段（含括号单位剥离）", () => {
  const expectations = [
    ["设备编码", "管段编码"], ["机组号", "炉号"], ["检测日期", "日期"], ["钢管规格", "规格"],
    ["材质牌号", "材质"], ["实测壁厚值(mm)", "厚度(mm)"], ["布氏硬度值", "硬度(HB)"],
    ["检测类型", "事件类型/更换原因"], ["结论备注", "详细描述/结论"], ["新管段编码", "关联新管码"]
  ];
  for (const [raw, canonical] of expectations) {
    const mapped = Core.canonicalHeaderWithLevel("events", raw);
    assert.equal(mapped.canonical, canonical, raw + " 应映射为 " + canonical + "（实际 " + mapped.canonical + "）");
    assert.ok(["exact", "fuzzy"].indexOf(mapped.level) >= 0);
  }
});

check("模糊定位：识别不了的列返回 none，绝不硬猜（天气、供应商电话）", () => {
  assert.equal(Core.canonicalHeaderWithLevel("events", "天气").level, "none");
  assert.equal(Core.canonicalHeaderWithLevel("events", "供应商电话").level, "none");
  assert.equal(Core.canonicalHeaderWithLevel("events", "天气").canonical, "天气");
});

check("模糊定位：两个标准列同分时不映射，宁缺勿错（编码备注歧义）", () => {
  assert.equal(Core.fuzzyMatchHeader("events", "编码备注"), null);
});

check("模糊定位：模型映射（headerMap）优先级最高，且只认合法目标列", () => {
  const override = { "传感器读数": "厚度(mm)", "乱写的": "不存在的列" };
  assert.equal(Core.canonicalHeaderWithLevel("events", "传感器读数", override).level, "model");
  assert.equal(Core.canonicalHeaderWithLevel("events", "传感器读数", override).canonical, "厚度(mm)");
  assert.equal(Core.canonicalHeaderWithLevel("events", "乱写的", override).level, "none");
});

check("模糊定位：清洗报告输出「字段智能匹配」卡片，列出每个模糊映射的原始列名", () => {
  const rows = parseCsvText(fixture("现场检测记录-乱序列.csv"));
  const report = Core.cleanRows({ rows, fileName: "现场检测记录-乱序列.csv", ...CLEAN_CONTEXT }).report;
  const item = checkById(report, "header_mapping");
  assert.ok(item, "必须输出 header_mapping 检查项");
  assert.equal(item.severity, "info");
  for (const raw of ["设备编码", "钢管规格", "材质牌号", "实测壁厚值(mm)", "布氏硬度值", "结论备注"]) {
    assert.ok(item.detail.includes(raw), "映射明细必须包含原始列名 " + raw);
  }
  const fuzzy = report.headerMapping.filter((entry) => entry.level === "fuzzy");
  assert.equal(fuzzy.length, 6, "本夹具应有 6 个模糊映射列");
});

check("列序归一：乱序文件清洗后按模板列序重排，数值逐列对位（导入准确性的根基）", () => {
  const rows = parseCsvText(fixture("现场检测记录-乱序列.csv"));
  const result = Core.cleanRows({ rows, fileName: "现场检测记录-乱序列.csv", ...CLEAN_CONTEXT });
  assert.deepEqual(result.cleanRows[0], [
    "数据分类", "炉号", "日期", "管段编码", "规格", "材质", "厚度(mm)", "硬度(HB)",
    "事件类型/更换原因", "关联新管码", "详细描述/结论"
  ]);
  /* 第 1 行原始：设备编码,机组号,检测日期,分类,钢管规格,材质牌号,实测壁厚值,布氏硬度值,检测类型,结论备注,新管段编码 */
  assert.deepEqual(result.cleanRows[1], [
    "事件", "1", "2024-03-05", "1G-SLB-WB-F000-R003-Q001", "Φ63.5×7.5", "SA-210C",
    "6.8", "182", "测厚", "", "前墙第3根"
  ]);
});

/* ================= C. 模糊定位：编码 ================= */

check("编码定位：矩阵内合法编码（含未有过记录的新管）不误报", () => {
  const rows = [
    ["数据分类", "炉号", "日期", "管段编码", "事件类型/更换原因"],
    ["事件", "1", "2024-03-05", "1G-SLB-WB-F000-R005-Q001", "测厚"]
  ];
  const report = Core.cleanRows({ rows, ...CLEAN_CONTEXT }).report;
  assert.equal(checkById(report, "unknown_code"), undefined);
  assert.equal(checkById(report, "out_of_range"), undefined);
});

check("编码定位：台账外编码超矩阵范围时报警告，并给出最相似真实编码（模糊定位核心）", () => {
  const rows = [
    ["数据分类", "炉号", "日期", "管段编码", "事件类型/更换原因"],
    ["事件", "1", "2024-05-06", "1G-GGRQ-GQ-L080-U001-Q001", "测厚"]
  ];
  const report = Core.cleanRows({ rows, ...CLEAN_CONTEXT }).report;
  const item = checkById(report, "out_of_range");
  assert.ok(item, "必须报 out_of_range");
  assert.equal(item.severity, "warning");
  const sample = item.sample[0];
  assert.ok(sample.startsWith("1G-GGRQ-GQ-L080-U001-Q001"), "样例以原始编码开头");
  assert.ok(sample.includes("近似：1G-GGRQ-"), "样例必须给出近似编码建议");
  assert.ok(sample.includes("相似度"), "近似建议必须带相似度");
  const similarity = Number(sample.match(/相似度 (\d+)%/)[1]);
  assert.ok(similarity >= 82, "相似度必须达到 82% 阈值，实际 " + similarity + "%");
});

check("编码定位：建议只看同机组同系统，跨系统候选被过滤", () => {
  const ledger = ["1G-SLB-WB-F000-R003-Q001", "2G-GGRQ-GQ-L012-U005-Q001"];
  const hit = Core.suggestSimilarCode("1G-SLB-WB-F000-R005-Q001", ledger);
  assert.ok(hit && hit.code.startsWith("1G-SLB-"), "1 号机组 SLB 系统的笔误只能建议 SLB 候选");
  assert.equal(Core.suggestSimilarCode("1G-SLB-WB-F000-R003-Q001", ledger), null, "编码本身在台账 → 无需建议");
  assert.equal(Core.suggestSimilarCode("1G-SMQ-EXIN-L001-U001-Q001", ledger), null, "跨系统候选被过滤，不误报");
});

check("编码定位：更换产生的新管码剥掉 -R 后缀再比对，不误报疑似笔误", () => {
  const rows = [
    ["数据分类", "炉号", "日期", "管段编码", "事件类型/更换原因", "关联新管码"],
    ["更换", "1", "2026-05-22", "1G-SLB-WB-F000-R003-Q001", "爆管更换", "1G-SLB-WB-F000-R003-Q002"]
  ];
  const report = Core.cleanRows({ rows, knownCodes: KNOWN, matrixRows: [], units: ["1", "2"] }).report;
  assert.equal(checkById(report, "unknown_code"), undefined);
  assert.equal(checkById(report, "out_of_range"), undefined);
});

check("编码定位：夹具第 4 行（080 屏笔误）被标记待核对，其余矩阵内编码不受牵连", () => {
  const rows = parseCsvText(fixture("现场检测记录-乱序列.csv"));
  const report = Core.cleanRows({ rows, fileName: "现场检测记录-乱序列.csv", ...CLEAN_CONTEXT }).report;
  const item = checkById(report, "out_of_range");
  assert.deepEqual(item.rows, [4]);
});

/* ================= D. 清洗与导入准确性 ================= */

check("夹具全量清洗：识别为事件台账，11 行中 7 行存活、2 行错误阻断、1 行重复丢弃", () => {
  const rows = parseCsvText(fixture("现场检测记录-乱序列.csv"));
  const result = Core.cleanRows({ rows, fileName: "现场检测记录-乱序列.csv", ...CLEAN_CONTEXT });
  const summary = result.report.summary;
  assert.equal(result.report.datasetType, "events");
  assert.equal(summary.totalRows, 11);
  assert.equal(summary.cleanRows, 7);
  assert.equal(summary.errorCount, 2);
  assert.equal(summary.duplicateRows, 1);
  /* 行级分流（接线层同规则）：干净行自动入库 = 3 行，警告行待确认 = 4 行（含重复组保留首行） */
  const split = splitByWarnings(result.cleanRows, result.report);
  assert.deepEqual(split.auto.length, 3);
  assert.deepEqual(split.flaggedRows.length, 4);
});

check("准确性：日期五格式全部归一为 YYYY-MM-DD（年月日/斜杠/点/连字符/无效保留）", () => {
  assert.equal(Core.normalizeDateText("2024年3月5日"), "2024-03-05");
  assert.equal(Core.normalizeDateText("2024/4/8"), "2024-04-08");
  assert.equal(Core.normalizeDateText("2024.4.15"), "2024-04-15");
  assert.equal(Core.normalizeDateText("20240415"), "2024-04-15");
  assert.equal(Core.normalizeDateText("2024-06-01"), "2024-06-01");
  assert.equal(Core.normalizeDateText("2025-02-30"), null, "不存在的日期不臆造");
  assert.equal(Core.normalizeDateText("2024年13月45日"), null, "非法月日不臆造");
});

check("准确性：夹具中每行日期/数值的清洗结果逐行核对", () => {
  const rows = parseCsvText(fixture("现场检测记录-乱序列.csv"));
  const result = Core.cleanRows({ rows, fileName: "现场检测记录-乱序列.csv", ...CLEAN_CONTEXT });
  const report = result.report;
  /* 日期归一备注逐行出现 */
  for (const line of ["第 1 行日期「2024年3月5日」已归一为 2024-03-05",
    "第 2 行日期「2024/4/8」已归一为 2024-04-08",
    "第 3 行日期「2024.4.15」已归一为 2024-04-15"]) {
    assert.ok(report.normalizations.indexOf(line) >= 0, "缺少归一备注：" + line);
  }
  /* 无效日期保留原文并告警，不臆造 */
  assert.deepEqual(checkById(report, "invalid_date").rows, [8]);
  assert.ok(checkById(report, "invalid_date").sample[0].includes("2024年13月45日"));
  /* 非数值厚度保留原文并告警（6.5~7.0 是区间值，交给人工） */
  assert.deepEqual(checkById(report, "invalid_number").rows, [9]);
  assert.ok(checkById(report, "invalid_number").sample[0].includes("6.5~7.0"));
  /* 缺管码行错误阻断 */
  assert.deepEqual(checkById(report, "missing_required").rows, [6]);
  /* 炉号 2 + 1 号机组编码 → 冲突阻断 */
  assert.deepEqual(checkById(report, "boiler_mismatch").rows, [7]);
  assert.ok(checkById(report, "boiler_mismatch").sample[0].includes("1G-SLB-WB-B000-R013-Q001"));
  /* 重复行：业务键相同只保留首行 */
  const dup = checkById(report, "duplicate_rows");
  assert.deepEqual(dup.droppedRows, [5]);
  assert.deepEqual(dup.keptRows, [1]);
});

check("准确性：清洗不丢内容——存活行的厚度/硬度/备注与原文件逐列一致", () => {
  const rows = parseCsvText(fixture("现场检测记录-乱序列.csv"));
  const result = Core.cleanRows({ rows, fileName: "现场检测记录-乱序列.csv", ...CLEAN_CONTEXT });
  /* 第 10 行：更换行，关联新管码保留 -R1 后缀 */
  const row10 = rowByNumber(result, 10);
  assert.equal(row10[0], "更换");
  assert.equal(row10[3], "1G-SLB-LHD-F000-L005-Q001");
  assert.equal(row10[9], "1G-SLB-LHD-F000-L005-Q002");
  assert.equal(row10[8], "爆管更换");
  /* 第 9 行：区间值厚度原文保留 */
  const row9 = rowByNumber(result, 9);
  assert.equal(row9[6], "6.5~7.0");
  /* 第 8 行：无效日期原文保留在日期列 */
  const row8 = rowByNumber(result, 8);
  assert.equal(row8[2], "2024年13月45日");
});

check("准确性：材料库夹具——别名表头对齐，缺材质行阻断、重复行去重", () => {
  const rows = parseCsvText(fixture("受热面材料台账-别名表头.csv"));
  const result = Core.cleanRows({ rows, fileName: "受热面材料台账-别名表头.csv", matrixRows: [], knownCodes: [], units: ["1", "2"] });
  const report = result.report;
  assert.equal(report.datasetType, "material_library");
  assert.equal(report.summary.totalRows, 4);
  assert.equal(report.summary.cleanRows, 2);
  assert.deepEqual(checkById(report, "missing_required").rows, [4]);
  const dup = checkById(report, "duplicate_rows");
  assert.deepEqual(dup.droppedRows, [3]);
  /* 重排后逐列对位：部件名称/规格型号/材质/库存根数；未识别列（管径(mm)/壁厚(mm)）原样保留在末尾、不入库字段 */
  assert.deepEqual(result.cleanRows[1].slice(0, 12), [
    "省煤器", "ECO", "入口第1排", "蛇形管", "Φ51×6", "", "", "SA-210C", "10", "60", "A区", "第47页"
  ]);
  assert.deepEqual(result.cleanRows[0].slice(12), ["管径(mm)", "壁厚(mm)"]);
  assert.deepEqual(result.cleanRows[1].slice(12), ["51", "6"]);
});

check("安全：未知表格只做通用清洗（去空行/去重/trim），标记不导入", () => {
  const rows = parseCsvText(fixture("无关表格-供应商清单.csv"));
  const result = Core.cleanRows({ rows, fileName: "无关表格-供应商清单.csv", matrixRows: [], knownCodes: [], units: ["1", "2"] });
  assert.equal(result.report.datasetType, "unknown");
  assert.equal(result.report.summary.importable, false);
  const item = checkById(result.report, "unknown_type");
  assert.ok(item.detail.includes("未识别数据集") || item.title.includes("未识别数据集"));
  assert.ok(result.cleanRows[0].join(",").includes("供应商名称"), "通用清洗保留原始表头");
});

check("容错：BOM 表头自动去除并提示，全角机组号正确判炉", () => {
  const rows = [["\uFEFF数据分类", "炉号", "日期", "管段编码", "事件类型/更换原因"],
    ["事件", "１", "2024-03-05", "1G-SLB-WB-F000-R003-Q001", "测厚"]];
  const result = Core.cleanRows({ rows, ...CLEAN_CONTEXT });
  assert.ok(result.report.normalizations.some((line) => line.includes("BOM")));
  assert.equal(result.cleanRows[1][1], "１"); // 原文保留，但炉号判定成功
  assert.equal(checkById(result.report, "boiler_mismatch"), undefined);
});

/* ================= E. 便捷性：Word 链路 + 性能 + 一致性 ================= */

async function loadDocs() {
  const source = readFileSync(resolve(here, "../assets/app/assistant-docs-v1.js"), "utf8");
  const sandbox = { console, setTimeout, clearTimeout, TextDecoder, TextEncoder, ReadableStream, DecompressionStream, Response };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "assistant-docs-v1.js" });
  /* docs 层经 FileReader 读取文件（与浏览器同路径）；返回注入器 */
  sandbox.FileReader = class {
    constructor() {}
    readAsArrayBuffer(file) {
      const bytes = file.__bytes;
      const view = new Uint8Array(bytes);
      const copy = new Uint8Array(view.length);
      copy.set(view);
      setTimeout(() => this.onload({ target: { result: copy.buffer } }), 0);
    }
  };
  return { docs: sandbox.BTAssistantDocs, sandbox };
}

const docsReady = loadDocs();

check("Word 识别：真实 .docx 表格零依赖提取——表头 + 数据行完整、合并去重留痕", async () => {
  const { docs } = await docsReady;
  const bytes = readFileSync(resolve(here, "fixtures/import-ux/检测台账.docx"));
  const parsed = await docs.docxToRows({ name: "检测台账.docx", size: bytes.length, __bytes: bytes });
  assert.equal(parsed.sheetName, "Word 表格");
  assert.ok(parsed.notes.includes("去重 1 行"), "合并层去重必须留痕：" + parsed.notes);
  assert.equal(parsed.rows.length, 4); // 表头 + 3 行（4 行数据去重 1 行）
  assert.equal(parsed.rows[0][0], "管段编号");
});

check("Word → 清洗 → 导入网格：与 CSV 同口径（识别/归一/重排/分流一致）", async () => {
  const { docs } = await docsReady;
  const bytes = readFileSync(resolve(here, "fixtures/import-ux/检测台账.docx"));
  const parsed = await docs.docxToRows({ name: "检测台账.docx", size: bytes.length, __bytes: bytes });
  const result = Core.cleanRows({ rows: parsed.rows, fileName: "检测台账.docx", ...CLEAN_CONTEXT });
  const report = result.report;
  assert.equal(report.datasetType, "events", "Word 表格必须识别为事件台账");
  assert.equal(report.summary.cleanRows, 3);
  /* 别名表头模糊命中：壁厚值→厚度(mm)、硬度值→硬度(HB)、管段编号→管段编码 */
  const mapping = checkById(report, "header_mapping");
  assert.ok(mapping.detail.includes("壁厚值"), "Word 别名列必须出现在映射卡片");
  /* 重排后列对位：日期归一、厚度落位第 6 列 */
  assert.equal(result.cleanRows[1][2], "2024-03-05");
  assert.equal(result.cleanRows[1][6], "6.8");
  assert.equal(result.cleanRows[1][3], "1G-SLB-WB-F000-R003-Q001");
  /* 无效日期（2025-02-30）警告保留 */
  assert.deepEqual(checkById(report, "invalid_date").rows, [3]);
});

check("Excel 夹具：真实 XLSX 结构有效（ZIP 容器 + 工作表 XML），可被页面 SheetJS 路径读取", () => {
  const bytes = readFileSync(resolve(here, "fixtures/import-ux/检测记录.xlsx"));
  assert.ok(bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b, "必须是 ZIP（PK）容器");
  const text = bytes.toString("latin1");
  assert.ok(text.includes("xl/worksheets/sheet1.xml"), "必须包含工作表条目");
  assert.ok(text.includes("xl/sharedStrings.xml") || text.includes("sheet1"), "必须包含字符串表或工作表");
});

check("便捷性：2000 行脏数据清洗毫秒级完成（AI 助手不卡顿）", () => {
  const rows = parseCsvText(fixture("现场检测记录-乱序列.csv"));
  const big = [rows[0]];
  for (let i = 0; i < 2000; i += 1) big.push(rows[1 + (i % 10)].slice());
  const started = Date.now();
  const result = Core.cleanRows({ rows: big, fileName: "性能测试.csv", ...CLEAN_CONTEXT });
  const elapsed = Date.now() - started;
  assert.equal(result.report.summary.totalRows, 2000);
  assert.ok(elapsed < 3000, "2000 行清洗应在 3 秒内完成，实际 " + elapsed + "ms");
});

check("便捷性：助手与页面原导入共用同一清洗口径（合同常量在位）", () => {
  const wiring = readFileSync(resolve(here, "../assets/app/assistant-v1.js"), "utf8");
  assert.ok(wiring.includes("importLifecycleRows(rows, { batchFilter: 'all' })"), "助手导入必须复用页面 importLifecycleRows");
  assert.ok(wiring.includes("MAX_IMPORT_ROWS = 5000"), "单文件 5000 行上限（超出引导拆分）");
  const app = readFileSync(resolve(here, "../assets/app/app-v7.9.js"), "utf8");
  assert.ok(/function importLifecycleRows\(/.test(app), "页面导入函数必须在位");
});

/* ================= 输出 ================= */

let failed = 0;
(async () => {
  for (const [name, fn] of checks) {
    try {
      await fn();
      console.log("ok - " + name);
    } catch (err) {
      failed += 1;
      console.log("not ok - " + name);
      console.log(String(err && err.stack ? err.stack : err).split("\n").slice(0, 6).join("\n"));
    }
  }
  console.log((failed ? "FAIL" : "ok") + " - import ux verification: " + (checks.length - failed) + "/" + checks.length + " checks passed");
  process.exit(failed ? 1 : 0);
})();
