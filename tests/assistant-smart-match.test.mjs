import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/**
 * 智能匹配层验收：模糊表头匹配、模型映射（headerMap）复用、列重排补位、
 * 编码智能匹配（台账/矩阵相似码建议）。
 * 对应能力：把「表格 / Word / 图片」里不规范的列名与编码自动对齐到系统字段，
 * 清洗输出按模板列序重排，保证页面按位置导入不错位。
 */
const here = dirname(fileURLToPath(import.meta.url));
const corePath = resolve(here, "../assets/app/assistant-core-v1.js");
const require = createRequire(import.meta.url);
const Core = require(corePath);

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

const EVENT_HEADER = ["数据分类", "炉号", "日期", "管段编码", "规格", "材质", "厚度(mm)", "硬度(HB)", "事件类型/更换原因", "关联新管码", "详细描述/结论"];
const MATRIX = [
  { sys: "SLB", comp: "WB", pos: "F000", dirs: ["R", "L"], tMax: 192 },
  { sys: "GGRQ", comp: "GQ", posLetters: ["L", "R"], pMax: 32, dirs: ["U", "D"], tMax: 12 }
];
const checkById = (report, id) => report.checks.find((item) => item.id === id);

/* ---------------- 1. 模糊表头匹配 ---------------- */

check("模糊匹配：括号单位与冗余修饰词被剥离后命中", () => {
  assert.equal(Core.fuzzyMatchHeader("events", "实测壁厚值(mm)").canonical, "厚度(mm)");
  assert.equal(Core.fuzzyMatchHeader("events", "测量日期").canonical, "日期");
  assert.equal(Core.fuzzyMatchHeader("events", "设备编码").canonical, "管段编码");
  assert.equal(Core.fuzzyMatchHeader("material_library", "部件名称（中文）").canonical, "部件名称");
});

check("模糊匹配：识别不了的列返回 null，绝不硬猜", () => {
  assert.equal(Core.fuzzyMatchHeader("events", "天气"), null);
  assert.equal(Core.fuzzyMatchHeader("events", "供应商电话"), null);
});

check("模糊匹配：两个标准列同分时不映射，避免歧义归并", () => {
  /* 「编码备注」同时包含「编码」（管段编码）与「备注」（详细描述/结论），得分并列 → 不映射 */
  assert.equal(Core.fuzzyMatchHeader("events", "编码备注"), null);
});

check("模糊匹配：两级候选合并取全局最高分——编辑距离更近的列胜出", () => {
  /* 「事件类别」：包含「类别」→ 数据分类 0.50；编辑距离「事件类型」→ 事件类型/更换原因 0.75。
     旧实现包含层优先，会误归到「数据分类」；现按全局最高分归到语义更近的事件类型。 */
  assert.equal(Core.fuzzyMatchHeader("events", "事件类别").canonical, "事件类型/更换原因");
  assert.equal(Core.fuzzyMatchHeader("events", "检测类别").canonical, "事件类型/更换原因");
  assert.notEqual(Core.fuzzyMatchHeader("events", "事件类别").canonical, "数据分类");
});

check("模糊匹配：全局比分后并列仍不映射（宁缺勿错），常规包含匹配不回归", () => {
  assert.equal(Core.fuzzyMatchHeader("events", "编码备注"), null);
  assert.equal(Core.fuzzyMatchHeader("events", "设备编码").canonical, "管段编码");
  assert.equal(Core.fuzzyMatchHeader("events", "钢管规格").canonical, "规格");
  assert.equal(Core.fuzzyMatchHeader("events", "实测壁厚值(mm)").canonical, "厚度(mm)");
  assert.equal(Core.fuzzyMatchHeader("events", "布氏硬度值").canonical, "硬度(HB)");
});

check("canonicalHeaderWithLevel：精确 > 模糊，override（模型映射）优先且只认合法列名", () => {
  assert.equal(Core.canonicalHeaderWithLevel("events", "管段编码").level, "exact");
  assert.equal(Core.canonicalHeaderWithLevel("events", "实测壁厚值(mm)").level, "fuzzy");
  assert.equal(Core.canonicalHeaderWithLevel("events", "天气").level, "none");
  const override = { "传感器读数": "厚度(mm)", "乱写的": "不存在的列" };
  const mapped = Core.canonicalHeaderWithLevel("events", "传感器读数", override);
  assert.equal(mapped.canonical, "厚度(mm)");
  assert.equal(mapped.level, "model");
  /* 非法目标列名被忽略，退回普通匹配 */
  assert.equal(Core.canonicalHeaderWithLevel("events", "乱写的", override).level, "none");
});

check("数据集检测仍只认精确别名，模糊匹配不会把无关表格误判成台账", () => {
  const headers = ["检测日期", "设备编号", "实测壁厚值(mm)", "备注"];
  assert.equal(Core.detectDatasetType(headers, ""), "unknown");
  assert.equal(Core.detectDatasetType(["日期", "管段编码"], ""), "events");
});

/* ---------------- 2. 清洗：列重排 + 映射报告 + headerMap ---------------- */

check("乱序表头清洗后按模板列序重排，缺失模板列补空列占位", () => {
  const rows = [
    ["管段编码", "检测日期", "实测壁厚值(mm)", "数据分类", "备注"],
    ["1G-SLB-WB-F000-R003-Q001", "2024年3月5日", "6.5", "事件", "前墙第8排"],
    ["1G-SLB-WB-F000-R004-Q001", "2024/4/8", "7.1", "事件", ""]
  ];
  const result = Core.cleanRows({ rows, matrixRows: MATRIX, units: ["1", "2"] });
  assert.equal(result.report.datasetType, "events");
  assert.deepEqual(result.cleanRows[0], EVENT_HEADER);
  const first = result.cleanRows[1];
  assert.equal(first[0], "事件");           // 数据分类回到第 0 列
  assert.equal(first[2], "2024-03-05");     // 日期归一
  assert.equal(first[3], "1G-SLB-WB-F000-R003-Q001");
  assert.equal(first[6], "6.5");            // 厚度列
  assert.equal(first[10], "前墙第8排");      // 备注 → 详细描述/结论
  assert.equal(first[1], "");               // 缺失的炉号列补空
});

check("字段智能映射进入清洗报告（info 检查项），含原始列名与目标列名", () => {
  const rows = [
    ["数据分类", "日期", "管段编码", "实测壁厚值(mm)"],
    ["事件", "2024-03-05", "1G-SLB-WB-F000-R003-Q001", "6.5"]
  ];
  const report = Core.cleanRows({ rows, matrixRows: MATRIX, units: ["1", "2"] }).report;
  const checkItem = checkById(report, "header_mapping");
  assert.ok(checkItem, "必须输出 header_mapping 检查项");
  assert.ok(checkItem.detail.includes("实测壁厚值(mm)"), "detail 必须包含原始列名");
  assert.ok(checkItem.detail.includes("厚度(mm)"), "detail 必须包含目标列名");
  const fuzzyEntry = report.headerMapping.find((item) => item.raw === "实测壁厚值(mm)");
  assert.equal(fuzzyEntry.level, "fuzzy");
});

check("headerMap（模型映射）参与清洗：未识别列被映射后可对位，映射写入报告", () => {
  const rows = [
    ["数据分类", "日期", "管段编码", "传感器读数", "仪器编号"],
    ["事件", "2024-03-05", "1G-SLB-WB-F000-R003-Q001", "6.6", "A-100"]
  ];
  const report = Core.cleanRows({
    rows,
    matrixRows: MATRIX,
    units: ["1", "2"],
    headerMap: { "传感器读数": "厚度(mm)" }
  }).report;
  assert.equal(report.headerMapping.find((item) => item.raw === "传感器读数").canonical, "厚度(mm)");
  assert.equal(report.headerMapping.find((item) => item.raw === "传感器读数").level, "model");
  const checkItem = checkById(report, "header_mapping");
  assert.ok(checkItem.detail.includes("模型匹配"), "模型来源必须在检查项里注明");
  /* 仪器编号未被映射 → 保留为附加列，附在模板列之后 */
  assert.equal(report.headers[EVENT_HEADER.length], "仪器编号");
});

/* ---------------- 3. 智能编码匹配 ---------------- */

check("expandMatrixCodes：矩阵展开为基础编码（机组×排×管，字母尾Q）", () => {
  const codes = Core.expandMatrixCodes([{ sys: "GGRQ", comp: "GQ", posLetters: ["L"], pMax: 2, dirs: ["U"], tMax: 2 }], ["1", "2"]);
  assert.deepEqual(codes, [
    "1G-GGRQ-GQ-L001-U001-Q",
    "1G-GGRQ-GQ-L001-U002-Q",
    "1G-GGRQ-GQ-L002-U001-Q",
    "1G-GGRQ-GQ-L002-U002-Q",
    "2G-GGRQ-GQ-L001-U001-Q",
    "2G-GGRQ-GQ-L001-U002-Q",
    "2G-GGRQ-GQ-L002-U001-Q",
    "2G-GGRQ-GQ-L002-U002-Q"
  ]);
});

check("suggestSimilarCode：同机组同系统内找最近编码，跨系统候选被过滤", () => {
  const ledger = ["1G-SLB-WB-F000-R003-Q001", "2G-GGRQ-GQ-L012-U005-Q001"];
  const hit = Core.suggestSimilarCode("1G-SLB-WB-F000-R030-Q001", ledger);
  assert.equal(hit.code, "1G-SLB-WB-F000-R003-Q001");
  assert.ok(hit.similarity >= 0.82, "屏号笔误的相似度必须达到阈值");
  /* 目标编码本身在候选里 → 相似码没有意义，返回 null（调用方按存在处理） */
  assert.equal(Core.suggestSimilarCode("1G-SLB-WB-F000-R003-Q001", ledger), null);
  /* 相似度太低（不是笔误，可能是合法新码）不给出建议 */
  assert.equal(Core.suggestSimilarCode("1G-DZRQ-GQ-1KJ-L001-U001-Q001", ledger), null);
});

check("台账里不存在但高度相似的编码：报 unknown_code 警告并给出建议", () => {
  const rows = [
    ["数据分类", "炉号", "日期", "管段编码", "事件类型/更换原因"],
    ["事件", "1", "2024-03-05", "1G-SLB-WB-F000-R030-Q001", "测厚"],
    ["事件", "1", "2024-03-06", "1G-SLB-WB-F000-R003-Q001", "测厚"]
  ];
  const report = Core.cleanRows({
    rows,
    knownCodes: ["1G-SLB-WB-F000-R003-Q001"],
    matrixRows: [],
    units: ["1", "2"]
  }).report;
  const checkItem = checkById(report, "unknown_code");
  assert.ok(checkItem, "疑似笔误编码必须报 unknown_code");
  assert.equal(checkItem.severity, "warning");
  assert.ok(checkItem.rows.includes(1), "第 1 行（笔误行）必须被标记");
  assert.ok(!checkItem.rows.includes(2), "第 2 行（正确编码）不能被标记");
  assert.ok(checkItem.sample[0].includes("1G-SLB-WB-F000-R003-Q001"), "样例必须给出最相似的真实编码");
});

check("更换产生的新管码（-R1 后缀）剥掉后缀后比对基础码，不误报", () => {
  const rows = [
    ["数据分类", "炉号", "日期", "管段编码", "事件类型/更换原因", "关联新管码"],
    ["更换", "1", "2024-03-05", "1G-SLB-WB-F000-R003-Q001", "爆管更换", "1G-SLB-WB-F000-R003-Q002"]
  ];
  const report = Core.cleanRows({
    rows,
    knownCodes: ["1G-SLB-WB-F000-R003-Q001"],
    matrixRows: [],
    units: ["1", "2"]
  }).report;
  assert.equal(checkById(report, "unknown_code"), undefined, "-R1 新管码不能被当成疑似笔误");
});

check("矩阵内合法编码不触发 unknown_code（新管首个事件不算笔误）", () => {
  const rows = [
    ["数据分类", "炉号", "日期", "管段编码", "事件类型/更换原因"],
    ["事件", "1", "2024-03-05", "1G-SLB-WB-F000-R005-Q001", "测厚"]
  ];
  const report = Core.cleanRows({ rows, knownCodes: [], matrixRows: MATRIX, units: ["1", "2"] }).report;
  assert.equal(checkById(report, "unknown_code"), undefined);
  assert.equal(checkById(report, "out_of_range"), undefined);
});

check("矩阵外的编码若与真实编码高度相似，out_of_range 样例里附带相似码建议", () => {
  const rows = [
    ["数据分类", "炉号", "日期", "管段编码", "事件类型/更换原因"],
    ["事件", "1", "2024-03-05", "1G-GGRQ-GQ-L040-U001-Q001", "测厚"]
  ];
  const report = Core.cleanRows({ rows, knownCodes: [], matrixRows: MATRIX, units: ["1", "2"] }).report;
  const outOfRange = checkById(report, "out_of_range");
  assert.ok(outOfRange, "矩阵外编码必须报 out_of_range");
  assert.ok(outOfRange.sample[0].includes("（近似："), "样例应给出近似编码建议");
  assert.ok(outOfRange.sample[0].includes("相似度"), "近似建议必须带相似度");
  assert.ok(outOfRange.sample[0].startsWith("1G-GGRQ-GQ-L040-U001-Q001"), "样例以原始编码开头");
});

/* ---------------- 输出 ---------------- */

let failed = 0;
for (const [name, fn] of checks) {
  try {
    fn();
    console.log("ok - " + name);
  } catch (err) {
    failed += 1;
    console.log("not ok - " + name);
    console.log(String(err && err.stack ? err.stack : err).split("\n").slice(0, 6).join("\n"));
  }
}
console.log((failed ? "FAIL" : "ok") + " - assistant smart match: " + (checks.length - failed) + "/" + checks.length + " checks passed");
process.exit(failed ? 1 : 0);
