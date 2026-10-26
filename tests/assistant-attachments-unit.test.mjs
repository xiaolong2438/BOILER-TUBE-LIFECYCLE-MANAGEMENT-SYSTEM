import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/**
 * 会话附件上下文 v1 单元测试。
 * 用 node:vm 直接执行 assets/app/assistant-attachments-v1.js 的真实源码；
 * 模块本身零 DOM / 零网络 / 零 localStorage，因此不需要打桩任何浏览器依赖。
 */
const here = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(here, "../assets/app/assistant-attachments-v1.js");
const source = readFileSync(modulePath, "utf8");

/* vm 里造出来的数组与测试进程不是同一个 Array 原型，deepStrictEqual 会因原型不同而失败，
   所以比较前先转成宿主侧纯数据结构。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadModule() {
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "assistant-attachments-v1.js" });
  return sandbox.BTAssistantAttachments;
}

const rowsOf = (headers, ...data) => [headers].concat(data);

/* 标准三附件会话：a.png（图片，识别 3 行）/ b.csv（表格，1 行）/ c.pdf（PDF，0 行） */
function threeRegistry(A) {
  const reg = A.createRegistry();
  const img = reg.add({
    name: "a.png",
    rows: rowsOf(["日期", "编码"], ["2024-01-05", "A-1"], ["2024-01-06", "A-2"], ["2024-01-07", "A-3"]),
    size: 2048,
    dataUrl: "data:image/png;base64,AAA"
  });
  const tbl = reg.add({ name: "b.csv", rows: rowsOf(["日期", "编码"], ["2024-01-05", "A-1"]), size: 128 });
  const pdf = reg.add({ name: "c.pdf", rows: [], size: 512 });
  return { reg, img, tbl, pdf };
}

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

/* ---------------- 导出契约 ---------------- */

check("导出 v1 冻结契约要求的全部键", () => {
  const A = loadModule();
  assert.equal(A.version, "v1");
  assert.equal(A.MAX_ATTACHMENTS, 3);
  ["createRegistry", "resolveReference", "isImageQuestion", "describeRegistry", "contextForLlm", "buildChatMessages", "buildVisionMessages"]
    .forEach((name) => assert.equal(typeof A[name], "function", name + " 必须是函数"));
});

check("支持 module.exports（CommonJS require 可直接取到同一对象）", () => {
  const require = createRequire(import.meta.url);
  const mod = require(modulePath);
  assert.equal(mod.version, "v1");
  assert.equal(typeof mod.createRegistry, "function");
  const reg = mod.createRegistry();
  assert.equal(reg.add({ name: "a.csv", rows: [["h"], ["1"]] }).rowCount, 1);
});

/* ---------------- registry ---------------- */

check("registry 基本操作：add / list / current / size / latest / bySeq", () => {
  const A = loadModule();
  const { reg, img, tbl, pdf } = threeRegistry(A);
  assert.equal(reg.size(), 3);
  assert.deepEqual(plain(reg.list().map((r) => r.name)), ["a.png", "b.csv", "c.pdf"]);
  assert.deepEqual(plain(reg.list().map((r) => r.seq)), [1, 2, 3]);
  assert.equal(reg.current().id, pdf.id, "新增后自动成为当前项");
  assert.equal(reg.latest().id, pdf.id);
  assert.equal(reg.bySeq(1).id, img.id);
  assert.equal(reg.bySeq("2").id, tbl.id, "seq 允许字符串");
  assert.equal(reg.bySeq(4), null);
  assert.equal(reg.select(img.id).id, img.id);
  assert.equal(reg.current().id, img.id);
  const record = reg.list()[0];
  assert.equal(record.id, "att-1");
  assert.equal(typeof record.at, "string");
  assert.equal(Number.isNaN(Date.parse(record.at)), false, "at 必须是可解析的时间戳");
  assert.equal(record.importedAt, null, "未导入时 importedAt 为 null");
  assert.deepEqual(Object.keys(plain(record)).sort(), ["at", "dataUrl", "headers", "id", "importedAt", "kind", "name", "notes", "rowCount", "rows", "seq", "sheetName", "size"].sort());
});

check("seq 不因移除而重排，「第 2 个」始终指向同一份附件", () => {
  const A = loadModule();
  const { reg, img, tbl } = threeRegistry(A);
  assert.equal(reg.remove(img.id), true);
  assert.equal(reg.size(), 2);
  assert.deepEqual(plain(reg.list().map((r) => r.seq)), [2, 3]);
  assert.equal(reg.bySeq(1), null);
  assert.equal(reg.bySeq(2).id, tbl.id);
  const ref = plain(A.resolveReference("第二张", reg));
  assert.equal(ref.ok, true);
  assert.equal(ref.record.name, "b.csv");
  assert.equal(ref.index, 0, "index 是 list() 中的 0 基下标");
  assert.equal(A.resolveReference("第一个", reg).ok, false, "第 1 份已被移除");
});

check("MAX_ATTACHMENTS=3：超出后 FIFO 淘汰最旧的，seq 不回收", () => {
  const A = loadModule();
  const reg = A.createRegistry();
  reg.add({ name: "a.csv", rows: rowsOf(["h"], ["1"]), size: 10 });
  reg.add({ name: "b.csv", rows: rowsOf(["h"], ["1"]), size: 11 });
  reg.add({ name: "c.csv", rows: rowsOf(["h"], ["1"]), size: 12 });
  reg.add({ name: "d.csv", rows: rowsOf(["h"], ["1"]), size: 13 });
  assert.equal(A.MAX_ATTACHMENTS, 3);
  assert.equal(reg.size(), 3);
  assert.deepEqual(plain(reg.list().map((r) => r.name)), ["b.csv", "c.csv", "d.csv"]);
  assert.deepEqual(plain(reg.list().map((r) => r.seq)), [2, 3, 4]);
  assert.equal(reg.current().name, "d.csv");
});

check("重复 add（同名 + 同 size + 同 rowCount）替换旧记录，保留 id 与 seq", () => {
  const A = loadModule();
  const reg = A.createRegistry();
  const first = reg.add({ name: "a.csv", rows: rowsOf(["h"], ["1"]), size: 100, notes: "旧备注", importedAt: "2026-01-01T00:00:00.000Z" });
  const second = plain(reg.add({ name: "a.csv", rows: rowsOf(["h"], ["9"]), size: 100, notes: "新备注" }));
  assert.equal(reg.size(), 1, "替换而不是新增");
  assert.equal(second.id, first.id);
  assert.equal(second.seq, first.seq);
  assert.equal(second.notes, "新备注");
  assert.deepEqual(second.rows, [["h"], ["9"]]);
  assert.equal(second.importedAt, null, "重新上传视为一次新登记，清空导入时间");
  assert.equal(reg.current().id, first.id);
});

check("同名但数据行数不同视为两份附件", () => {
  const A = loadModule();
  const reg = A.createRegistry();
  reg.add({ name: "a.csv", rows: rowsOf(["h"], ["1"]), size: 100 });
  reg.add({ name: "a.csv", rows: rowsOf(["h"], ["1"], ["2"]), size: 100 });
  assert.equal(reg.size(), 2);
});

check("rowCount / headers：空 rows、只有表头、超 12 列截断、首行非数组", () => {
  const A = loadModule();
  const reg = A.createRegistry();
  const normal = reg.add({ name: "t.csv", rows: [["h1", "h2"], ["a", "b"], ["c", "d"]] });
  assert.equal(normal.rowCount, 2);
  assert.deepEqual(plain(normal.headers), ["h1", "h2"]);
  const empty = reg.add({ name: "empty.csv", rows: [] });
  assert.equal(empty.rowCount, 0);
  assert.deepEqual(plain(empty.headers), []);
  const headerOnly = reg.add({ name: "header-only.csv", rows: [["日期", "编码"]] });
  assert.equal(headerOnly.rowCount, 0, "只有表头时数据行为 0");
  assert.deepEqual(plain(headerOnly.headers), ["日期", "编码"]);

  const reg2 = A.createRegistry();
  const noRows = reg2.add({ name: "no-rows.csv" });
  assert.equal(noRows.rowCount, 0);
  assert.deepEqual(plain(noRows.headers), []);
  const wide = reg2.add({ name: "wide.csv", rows: [Array.from({ length: 15 }, (_, i) => "列" + (i + 1)), Array.from({ length: 15 }, (_, i) => String(i + 1))] });
  assert.equal(wide.rowCount, 1);
  assert.equal(plain(wide.headers).length, 12, "headers 只保留前 12 列");
  assert.equal(plain(wide.headers)[11], "列12");
  assert.equal(plain(wide.headers).includes("列13"), false);
  const odd = reg2.add({ name: "odd.csv", rows: ["a", "b"] });
  assert.equal(odd.rowCount, 1);
  assert.deepEqual(plain(odd.headers), [], "首行不是数组时按没有表头处理");
});

check("kind 缺省按扩展名推断，显式 kind 优先", () => {
  const A = loadModule();
  const reg = A.createRegistry();
  assert.equal(reg.add({ name: "a.PNG", rows: [] }).kind, "image");
  assert.equal(reg.add({ name: "b.jpeg", rows: [] }).kind, "image");
  assert.equal(reg.add({ name: "c.webp", rows: [] }).kind, "image");
  const reg2 = A.createRegistry();
  assert.equal(reg2.add({ name: "d.pdf", rows: [] }).kind, "pdf");
  assert.equal(reg2.add({ name: "e.csv", rows: [] }).kind, "table");
  assert.equal(reg2.add({ name: "f.xlsx", rows: [] }).kind, "table");
  const reg3 = A.createRegistry();
  assert.equal(reg3.add({ name: "g.bin", kind: "image", rows: [] }).kind, "image", "显式 kind 优先于扩展名");
  assert.equal(reg3.add({ name: "h.bin", kind: "未知值", rows: [] }).kind, "table", "非法 kind 回落到扩展名推断");
  assert.equal(reg3.add({ name: "批量图片(3张).png", rows: [] }).kind, "image");
});

check("摘要回填：不传 rows 时可显式给出 rowCount，传了 rows 则以 rows 为准", () => {
  const A = loadModule();
  const reg = A.createRegistry();
  const restored = reg.add({ name: "a.png", kind: "image", rows: undefined, rowCount: 5, notes: "会话摘要回填" });
  assert.equal(restored.rowCount, 5, "回填时没有 rows，用显式 rowCount");
  assert.deepEqual(plain(restored.headers), []);
  assert.equal(reg.add({ name: "b.png", kind: "image" }).rowCount, 0, "没有 rows 也没有 rowCount 时记 0");
  assert.equal(reg.add({ name: "c.csv", rows: rowsOf(["h"], ["1"]), rowCount: 99 }).rowCount, 1, "rows 优先");
  assert.equal(reg.add({ name: "d.png", kind: "image", rowCount: -3 }).rowCount, 0, "非法 rowCount 按 0");
});

check("select / remove / clear 的边界行为", () => {
  const A = loadModule();
  const { reg, img, tbl, pdf } = threeRegistry(A);
  assert.equal(reg.select("不存在"), null, "选择不存在的 id 返回 null 且不抛错");
  assert.equal(reg.current().id, pdf.id);
  assert.equal(reg.remove("不存在"), false);
  assert.equal(reg.select(tbl.id).id, tbl.id);
  assert.equal(reg.remove(tbl.id), true);
  assert.equal(reg.current().id, pdf.id, "移除当前项后回退到最新一条");
  assert.equal(reg.remove(pdf.id), true);
  assert.equal(reg.current().id, img.id);
  assert.equal(reg.remove(pdf.id), false, "重复移除返回 false");
  assert.equal(reg.remove(img.id), true);
  assert.equal(reg.current(), null);
  assert.equal(reg.latest(), null);
  reg.add({ name: "x.csv", rows: rowsOf(["h"], ["1"]) });
  reg.clear();
  assert.equal(reg.size(), 0);
  assert.equal(reg.current(), null);
  assert.equal(reg.bySeq(1), null);
  assert.equal(reg.add({ name: "y.csv", rows: rowsOf(["h"], ["1"]) }).seq, 1, "clear 之后序号重新从 1 开始");
});

check("createRegistry 每次返回独立实例（会话隔离）", () => {
  const A = loadModule();
  const a = A.createRegistry();
  const b = A.createRegistry();
  a.add({ name: "a.csv", rows: rowsOf(["h"], ["1"]) });
  assert.equal(a.size(), 1);
  assert.equal(b.size(), 0);
  assert.equal(b.current(), null);
  assert.equal(b.latest(), null);
});

/* ---------------- resolveReference ---------------- */

check("resolveReference 正例：单数指示词 / 序号 / 最后 / 上一个 / 最新（≥10 条）", () => {
  const A = loadModule();
  const { reg, img, tbl, pdf } = threeRegistry(A); // img(seq1) tbl(seq2) pdf(seq3)，current=pdf
  reg.select(tbl.id);
  const hits = [
    ["这个表", tbl.id],
    ["该附件", tbl.id],
    ["这份文件", tbl.id],
    ["这张图", tbl.id],
    ["刚才那个文件", pdf.id],
    ["刚上传的图片", pdf.id],
    ["最新的", pdf.id],
    ["第二张", tbl.id],
    ["第 3 个", pdf.id],
    ["第三个", pdf.id],
    ["第一个", img.id],
    ["最后一张", pdf.id],
    ["最后一个", pdf.id],
    ["最后那个", pdf.id],
    ["上一个", img.id]
  ];
  assert.equal(hits.length >= 10, true);
  const records = reg.list();
  for (const [textValue, id] of hits) {
    const ref = plain(A.resolveReference(textValue, reg));
    assert.equal(ref.ok, true, textValue + " 应能解析");
    assert.equal(ref.record.id, id, textValue + " 应指向 " + id);
    assert.equal(ref.many, false, textValue + " 不是复数");
    assert.equal(ref.index, records.findIndex((r) => r.id === id), textValue + " 的 index 应为 list() 下标");
    assert.equal(typeof ref.reason, "string");
  }
});

check("resolveReference：序号按 seq 解析，越界直接判失败", () => {
  const A = loadModule();
  const { reg, img, tbl } = threeRegistry(A);
  const outOfRange = plain(A.resolveReference("第 9 个", reg));
  assert.equal(outOfRange.ok, false);
  assert.match(outOfRange.reason, /不存在/);
  assert.equal(plain(A.resolveReference("第0个", reg)).ok, false);
  reg.remove(img.id);
  const ref = plain(A.resolveReference("第二张", reg));
  assert.equal(ref.ok, true);
  assert.equal(ref.record.id, tbl.id, "seq 不重排，第二张仍是原来的第二份");
  assert.equal(plain(A.resolveReference("第一个", reg)).ok, false, "第 1 份已被移除");
});

check("resolveReference 反例：无附件词 / 无附件 / 空文本 / 无注册表", () => {
  const A = loadModule();
  const { reg } = threeRegistry(A);
  const misses = ["帮我看看数据", "请重新导入", "第一次上传的文件", "导出报表", ""];
  for (const textValue of misses) {
    const ref = plain(A.resolveReference(textValue, reg));
    assert.equal(ref.ok, false, JSON.stringify(textValue) + " 不应解析出附件");
    assert.equal(ref.record, null);
    assert.equal(ref.index, -1);
    assert.equal(ref.many, false);
    assert.equal(typeof ref.reason, "string");
  }
  assert.equal(plain(A.resolveReference(null, reg)).ok, false);
  assert.equal(plain(A.resolveReference("   ", reg)).ok, false);
  const empty = A.createRegistry();
  const noAttachment = plain(A.resolveReference("这个表", empty));
  assert.equal(noAttachment.ok, false);
  assert.match(noAttachment.reason, /还没有附件/);
  assert.equal(plain(A.resolveReference("这个表", null)).ok, false);
});

check("resolveReference 复数指代返回 many:true", () => {
  const A = loadModule();
  const { reg } = threeRegistry(A);
  for (const textValue of ["这些附件", "它们", "所有附件", "全部附件", "这些都导入"]) {
    const ref = plain(A.resolveReference(textValue, reg));
    assert.equal(ref.ok, true, textValue);
    assert.equal(ref.many, true, textValue);
    assert.equal(ref.record.seq, 3, textValue + " 落在当前项上");
  }
});

/* ---------------- isImageQuestion ---------------- */

check("isImageQuestion 正例：图片指代词 + 疑问/请求特征（≥6 条）", () => {
  const A = loadModule();
  const positives = [
    "这张图里有几个测点",
    "图片里有几行数据",
    "图上的编号是什么",
    "帮我看看这张图片",
    "照片里的日期是多少",
    "截图中是否有盖章",
    "图中有几个阀门?",
    "这张图念一下",
    "图中所示的规格是什么"
  ];
  assert.equal(positives.length >= 6, true);
  for (const textValue of positives) assert.equal(A.isImageQuestion(textValue), true, textValue);
});

check("isImageQuestion 反例：表格/导入/OCR 不误判为图片追问（≥6 条）", () => {
  const A = loadModule();
  const negatives = [
    "导入这个表",
    "这张表有几行",
    "图片识别",
    "请做图片识别",
    "确认导入",
    "这个文件有几行",
    "第一张图",
    "意图是什么",
    "帮我导入第二张图",
    "这个图表有多少行",
    "",
    null
  ];
  assert.equal(negatives.length >= 6, true);
  for (const textValue of negatives) assert.equal(A.isImageQuestion(textValue), false, String(textValue));
});

/* ---------------- 摘要 ---------------- */

check("describeRegistry 中文摘要（含序号、类型、行数与当前项）", () => {
  const A = loadModule();
  const { reg, tbl } = threeRegistry(A);
  const summary = A.describeRegistry(reg);
  assert.equal(summary, "会话附件：1) a.png（图片，识别 3 行）；2) b.csv（表格，1 行）；3) c.pdf（PDF，未提取出数据行） · 当前");
  reg.select(tbl.id);
  assert.match(A.describeRegistry(reg), /· 当前$/);
  reg.remove(reg.bySeq(1).id);
  assert.match(A.describeRegistry(reg), /^会话附件：2\) b\.csv/);
  assert.equal(A.describeRegistry(A.createRegistry()), "会话附件：暂无附件。");
  assert.equal(A.describeRegistry(null), "会话附件：暂无附件。");
});

check("contextForLlm：只含元信息，不含 rows 与 dataUrl", () => {
  const A = loadModule();
  const { reg } = threeRegistry(A);
  const ctx = plain(A.contextForLlm(reg));
  assert.deepEqual(Object.keys(ctx).sort(), ["attachments", "current"]);
  assert.equal(ctx.current, 3);
  assert.equal(ctx.attachments.length, 3);
  assert.deepEqual(Object.keys(ctx.attachments[0]).sort(), ["headers", "kind", "name", "rowCount", "seq"]);
  assert.deepEqual(ctx.attachments[0], { seq: 1, name: "a.png", kind: "image", rowCount: 3, headers: ["日期", "编码"] });
  const text = JSON.stringify(ctx);
  assert.equal(text.includes("dataUrl"), false, "不得带 dataUrl");
  assert.equal(text.includes("2024-01-05"), false, "不得带 rows 明细");
  assert.deepEqual(plain(A.contextForLlm(A.createRegistry())), { attachments: [], current: null });
  assert.deepEqual(plain(A.contextForLlm(null)), { attachments: [], current: null });
  const moved = plain(A.contextForLlm(reg));
  assert.equal(moved.attachments[0].seq, 1);
});

/* ---------------- buildChatMessages ---------------- */

check("buildChatMessages：system 在首、历史正序且只取最近 maxTurns 条", () => {
  const A = loadModule();
  const { reg } = threeRegistry(A);
  const history = [
    { role: "user", text: "第 1 轮问题" },
    { role: "assistant", text: "第 1 轮回答" },
    { role: "user", text: "第 2 轮问题" },
    { role: "assistant", text: "第 2 轮回答" },
    { role: "user", text: "第 3 轮问题" },
    { role: "assistant", text: "第 3 轮回答" },
    { role: "user", text: "第 4 轮问题" },
    { role: "assistant", text: "第 4 轮回答" }
  ];
  const messages = plain(A.buildChatMessages({ history, message: "这个表有多少行", registry: reg }));
  assert.equal(messages.length, 1 + 6 + 1);
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /严禁编造任何数值、编号或日期/);
  assert.match(messages[0].content, /a\.png/);
  assert.match(messages[0].content, /b\.csv/);
  assert.deepEqual(messages.slice(1, 7).map((m) => m.content), ["第 2 轮问题", "第 2 轮回答", "第 3 轮问题", "第 3 轮回答", "第 4 轮问题", "第 4 轮回答"]);
  assert.deepEqual(messages.slice(1, 7).map((m) => m.role), ["user", "assistant", "user", "assistant", "user", "assistant"]);
  assert.deepEqual(messages[7], { role: "user", content: "这个表有多少行" });
  const short = plain(A.buildChatMessages({ history, message: "x", registry: reg, maxTurns: 2 }));
  assert.equal(short.length, 1 + 2 + 1);
  assert.deepEqual(short.slice(1, 3).map((m) => m.content), ["第 4 轮问题", "第 4 轮回答"]);
  const none = plain(A.buildChatMessages({ history, message: "x", registry: reg, maxTurns: 0 }));
  assert.equal(none.length, 2, "maxTurns=0 时只保留 system 与当前问题");
  assert.equal(none[0].role, "system");
  assert.equal(none[1].content, "x");
});

check("buildChatMessages：单条截断 maxCharsPerTurn、跳过空文本", () => {
  const A = loadModule();
  const { reg } = threeRegistry(A);
  const long = "A".repeat(30) + "尾";
  const messages = plain(A.buildChatMessages({ history: [{ role: "user", text: long }], message: "x", registry: reg, maxCharsPerTurn: 10 }));
  assert.equal(messages[1].content, "A".repeat(10));
  assert.equal(messages[1].content.length, 10);
  const skipped = plain(A.buildChatMessages({
    history: [{ role: "user", text: "" }, { role: "assistant", text: "   " }, { role: "user", text: null }, { role: "assistant", text: "保留我" }],
    message: "x",
    registry: reg
  }));
  assert.deepEqual(skipped.slice(1, -1), [{ role: "assistant", content: "保留我" }]);
  const emptyHistory = plain(A.buildChatMessages({ message: "只有问题", registry: reg }));
  assert.equal(emptyHistory.length, 2);
  assert.deepEqual(emptyHistory[1], { role: "user", content: "只有问题" });
  assert.equal(plain(A.buildChatMessages({ history: "不是数组", message: "x", registry: reg })).length, 2);
});

/* ---------------- buildVisionMessages ---------------- */

check("buildVisionMessages：非图片 / 无 dataUrl / 空注册表返回 null", () => {
  const A = loadModule();
  const { reg, img, tbl } = threeRegistry(A);
  assert.equal(A.buildVisionMessages({ message: "x", registry: reg }), null, "当前是 pdf");
  reg.select(tbl.id);
  assert.equal(A.buildVisionMessages({ message: "x", registry: reg }), null, "当前是表格");
  reg.select(img.id);
  assert.notEqual(A.buildVisionMessages({ message: "x", registry: reg }), null, "当前是带原图的图片");
  const noUrl = A.createRegistry();
  noUrl.add({ name: "no-dataurl.png", rows: [] });
  assert.equal(A.buildVisionMessages({ message: "x", registry: noUrl }), null, "图片没有压缩原图");
  const emptyUrl = A.createRegistry();
  emptyUrl.add({ name: "empty-dataurl.png", rows: [], dataUrl: "" });
  assert.equal(A.buildVisionMessages({ message: "x", registry: emptyUrl }), null);
  assert.equal(A.buildVisionMessages({ message: "x", registry: A.createRegistry() }), null);
  assert.equal(A.buildVisionMessages({ message: "x", registry: null }), null);
  assert.equal(A.buildVisionMessages({}), null);
});

check("buildVisionMessages：system 强调只依据图片，末条为 text + image_url 数组", () => {
  const A = loadModule();
  const { reg, img } = threeRegistry(A);
  reg.select(img.id);
  const messages = plain(A.buildVisionMessages({ message: "这张图里有几个测点", registry: reg }));
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /只依据图片回答，看不清就说看不清，严禁编造任何数值、编号或日期/);
  assert.match(messages[0].content, /a\.png/);
  const last = messages[messages.length - 1];
  assert.equal(last.role, "user");
  assert.equal(Array.isArray(last.content), true);
  assert.equal(last.content.length, 2);
  assert.deepEqual(last.content[0], { type: "text", text: "这张图里有几个测点" });
  assert.deepEqual(last.content[1], { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } });
});

check("buildVisionMessages：历史同样受限 maxTurns，原图原样传递", () => {
  const A = loadModule();
  const { reg, img } = threeRegistry(A);
  reg.select(img.id);
  const five = [1, 2, 3, 4, 5].map((i) => ({ role: "user", text: "第" + i + "条" }));
  const messages = plain(A.buildVisionMessages({ history: five, message: "x", registry: reg }));
  assert.equal(messages.length, 1 + 4 + 1, "默认 maxTurns=4");
  assert.deepEqual(messages.slice(1, 5).map((m) => m.content), ["第2条", "第3条", "第4条", "第5条"]);
  const longUrl = "data:image/png;base64," + "Q".repeat(500);
  const reg2 = A.createRegistry();
  reg2.add({ name: "big.png", rows: [], dataUrl: longUrl });
  const built = plain(A.buildVisionMessages({ message: "看图", registry: reg2 }));
  assert.equal(built[built.length - 1].content[1].image_url.url, longUrl, "原图 dataUrl 必须原样传递");
  const limited = plain(A.buildVisionMessages({ history: five, message: "x", registry: reg, maxTurns: 0 }));
  assert.equal(limited.length, 2);
});

/* ---------------- 源码约束 ---------------- */

check("模块源码零 DOM / 零网络 / 零 localStorage，且为 ES5 IIFE", () => {
  const banned = [
    [/\bdocument\s*\./, "document"],
    [/localStorage\s*[.[]/, "localStorage"],
    [/sessionStorage\s*[.[]/, "sessionStorage"],
    [/\bfetch\s*\(/, "fetch"],
    [/XMLHttpRequest/, "XMLHttpRequest"],
    [/navigator\s*\./, "navigator"]
  ];
  for (const [re, label] of banned) assert.equal(re.test(source), false, "源码不得使用 " + label);
  assert.match(source, /^\(function \(global\) \{/m);
  assert.match(source, /'use strict';/);
  assert.match(source, /if \(typeof module !== 'undefined' && module\.exports\) module\.exports = global\.BTAssistantAttachments;/);
  assert.match(source, /global\.BTAssistantAttachments = \{/);
});

/* ---------------- 运行 ---------------- */

let failed = 0;
for (const [name, fn] of checks) {
  try {
    await fn();
    console.log("ok - " + name);
  } catch (error) {
    failed += 1;
    console.error("not ok - " + name);
    console.error(String((error && error.stack) || error));
  }
}
if (failed) {
  console.error("assistant attachments unit: " + (checks.length - failed) + "/" + checks.length + " checks passed");
  process.exitCode = 1;
} else {
  console.log("ok - assistant attachments unit: " + checks.length + "/" + checks.length + " checks passed");
}
