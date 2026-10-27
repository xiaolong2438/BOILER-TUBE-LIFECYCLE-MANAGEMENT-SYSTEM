import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import zlib from "node:zlib";

/**
 * Word（.docx）识别层单元测试。
 * 用 node:vm 执行 assets/app/assistant-docs-v1.js 真实源码，注入浏览器原生依赖
 * （TextDecoder / ReadableStream / DecompressionStream / Response / FileReader），
 * ZIP 字节在测试里手工构造（deflate-raw 与真实 Word 输出一致）。
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../assets/app/assistant-docs-v1.js"), "utf8");

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

function createHarness() {
  const sandbox = { console, setTimeout, clearTimeout, TextDecoder, TextEncoder, ReadableStream, DecompressionStream, Response };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "assistant-docs-v1.js" });
  const docs = sandbox.BTAssistantDocs;
  assert.ok(docs && docs.version === "v3", "docs 模块必须加载且版本为 v3");
  return { sandbox, docs };
}

/* 手工构造 DOCX（ZIP 容器）：method 0 = stored，method 8 = deflate-raw */
function buildDocx(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data, method] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>';
const XML_FOOTER = "</w:body></w:document>";

function docxBuffer(xml) {
  return buildDocx([
    ["[Content_Types].xml", Buffer.from("<Types/>"), 0],
    ["_rels/.rels", Buffer.from("<Relationships/>"), 0],
    ["word/document.xml", Buffer.from(xml, "utf8"), 8]
  ]);
}

function makeFile({ sandbox, docs }, buffer, name = "检测记录.docx") {
  const view = new Uint8Array(buffer);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  const arrayBuffer = copy.buffer;
  sandbox.FileReader = class {
    readAsArrayBuffer(file) {
      setTimeout(() => this.onload({ target: { result: arrayBuffer } }), 0);
    }
  };
  return { name, size: buffer.length };
}

/* ---------------- 1. 判定与契约 ---------------- */

check("isDocxFile：只认 .docx 扩展名（大小写不敏感）", () => {
  const { docs } = createHarness();
  assert.equal(docs.isDocxFile("测厚记录.DOCX"), true);
  assert.equal(docs.isDocxFile("a.docx"), true);
  assert.equal(docs.isDocxFile("a.doc"), false);
  assert.equal(docs.isDocxFile("a.pdf"), false);
  assert.equal(docs.isDocxFile("docx"), false);
});

/* ---------------- 2. 表格提取 ---------------- */

check("提取 w:tbl 表格：表头 + 数据行，单元格文本完整", () => {
  const { docs } = createHarness();
  const xml = XML_HEADER
    + "<w:tbl><w:tr>"
    + "<w:tc><w:p><w:r><w:t>日期</w:t></w:r></w:p></w:tc>"
    + "<w:tc><w:p><w:r><w:t>管段编码</w:t></w:r></w:p></w:tc>"
    + "</w:tr><w:tr>"
    + "<w:tc><w:p><w:r><w:t>2024年3月5日</w:t></w:r></w:p></w:tc>"
    + "<w:tc><w:p><w:r><w:t>1G-SLB-WB-F000-R003-Q001</w:t></w:r></w:p></w:tc>"
    + "</w:tr></w:tbl>"
    + XML_FOOTER;
  const parsed = docs.parseDocxDocument(xml);
  assert.equal(parsed.tables.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.tables[0])), [
    ["日期", "管段编码"],
    ["2024年3月5日", "1G-SLB-WB-F000-R003-Q001"]
  ]);
});

check("XML 实体与跨 run 文本：&amp; 解码、同单元格多 run 拼接", () => {
  const { docs } = createHarness();
  const xml = XML_HEADER
    + "<w:tbl><w:tr>"
    + "<w:tc><w:p><w:r><w:t>A&amp;B</w:t><w:t> 厂</w:t></w:r></w:p></w:tc>"
    + "<w:tc><w:p><w:r><w:t>&lt;结论&gt;</w:t></w:r></w:p></w:tc>"
    + "</w:tr><w:tr>"
    + "<w:tc><w:p><w:r><w:t>x</w:t></w:r></w:p></w:tc>"
    + "<w:tc><w:p><w:r><w:t>y</w:t></w:r></w:p></w:tc>"
    + "</w:tr></w:tbl>"
    + XML_FOOTER;
  const grid = docs.parseDocxDocument(xml).tables[0];
  assert.equal(grid[0][0], "A&B 厂");
  assert.equal(grid[0][1], "<结论>");
});

check("gridSpan 补空列对齐，vMerge 续行单元格为空", () => {
  const { docs } = createHarness();
  const xml = XML_HEADER
    + "<w:tbl><w:tr>"
    + "<w:tc><w:tcPr><w:gridSpan w:val=\"3\"/></w:tcPr><w:p><w:r><w:t>测厚记录</w:t></w:r></w:p></w:tc>"
    + "</w:tr><w:tr>"
    + "<w:tc><w:p><w:r><w:t>日期</w:t></w:r></w:p></w:tc>"
    + "<w:tc><w:p><w:r><w:t>编码</w:t></w:r></w:p></w:tc>"
    + "<w:tc><w:p><w:r><w:t>厚度</w:t></w:r></w:p></w:tc>"
    + "</w:tr><w:tr>"
    + "<w:tc><w:tcPr><w:vMerge w:val=\"restart\"/></w:tcPr><w:p><w:r><w:t>合并组</w:t></w:r></w:p></w:tc>"
    + "<w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc>"
    + "<w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc>"
    + "</w:tr><w:tr>"
    + "<w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p></w:p></w:tc>"
    + "<w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc>"
    + "<w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc>"
    + "</w:tr></w:tbl>"
    + XML_FOOTER;
  const grid = docs.parseDocxDocument(xml).tables[0];
  assert.deepEqual(JSON.parse(JSON.stringify(grid)), [
    ["测厚记录", "", ""],
    ["日期", "编码", "厚度"],
    ["合并组", "a", "1"],
    ["", "b", "2"]
  ]);
});

check("嵌套表格随父单元格忽略，只提取顶层表", () => {
  const { docs } = createHarness();
  const xml = XML_HEADER
    + "<w:tbl><w:tr>"
    + "<w:tc><w:p><w:r><w:t>外层</w:t></w:r></w:p>"
    + "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>内层</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"
    + "</w:tc>"
    + "<w:tc><w:p><w:r><w:t>说明</w:t></w:r></w:p></w:tc>"
    + "</w:tr><w:tr>"
    + "<w:tc><w:p><w:r><w:t>数据1</w:t></w:r></w:p></w:tc>"
    + "<w:tc><w:p><w:r><w:t>数据2</w:t></w:r></w:p></w:tc>"
    + "</w:tr></w:tbl>"
    + XML_FOOTER;
  const parsed = docs.parseDocxDocument(xml);
  assert.equal(parsed.tables.length, 1, "嵌套表不能算成独立表格");
  /* 嵌套表的文字按 DOM 语义并入父单元格文本（flatten），但不再单独成表 */
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.tables[0])), [
    ["外层 内层", "说明"],
    ["数据1", "数据2"]
  ]);
});

check("正文段落单独收集，表格外的文字不混进表格", () => {
  const { docs } = createHarness();
  const xml = XML_HEADER
    + "<w:p><w:r><w:t>检测记录汇总（2024）</w:t></w:r></w:p>"
    + "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"
    + "<w:p><w:r><w:t>备注：现场记录。</w:t></w:r></w:p>"
    + XML_FOOTER;
  const parsed = docs.parseDocxDocument(xml);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.lines)), ["检测记录汇总（2024）", "备注：现场记录。"]);
});

/* ---------------- 3. docxToRows 全链路 ---------------- */

check("docxToRows：deflate 文档 → 表格 → 字段规范化（日期/数值/编码）+ 多表合并", async () => {
  const h = createHarness();
  const xml = XML_HEADER
    + "<w:tbl><w:tr>"
    + "<w:tc><w:p><w:r><w:t>日期</w:t></w:r></w:p></w:tc>"
    + "<w:tc><w:p><w:r><w:t>管段编码</w:t></w:r></w:p></w:tc>"
    + "<w:tc><w:p><w:r><w:t>实测壁厚值(mm)</w:t></w:r></w:p></w:tc>"
    + "</w:tr><w:tr>"
    + "<w:tc><w:p><w:r><w:t>2024年3月5日</w:t></w:r></w:p></w:tc>"
    + "<w:tc><w:p><w:r><w:t>1G-SLB-WB-F000-R003-Q001</w:t></w:r></w:p></w:tc>"
    + "<w:tc><w:p><w:r><w:t>6.5mm</w:t></w:r></w:p></w:tc>"
    + "</w:tr><w:tr>"
    + "<w:tc><w:p><w:r><w:t>2024/4/8</w:t></w:r></w:p></w:tc>"
    + "<w:tc><w:p><w:r><w:t>2G-GGRQ-GQ-L012-U005-Q001</w:t></w:r></w:p></w:tc>"
    + "<w:tc><w:p><w:r><w:t>1,234</w:t></w:r></w:p></w:tc>"
    + "</w:tr></w:tbl>"
    + XML_FOOTER;
  const file = makeFile(h, docxBuffer(xml));
  const result = await h.docs.docxToRows(file);
  assert.equal(result.sheetName, "Word 表格");
  assert.ok(result.notes.includes("1 个表格"), "备注必须报告表格数量");
  const plain = JSON.parse(JSON.stringify(result.rows));
  assert.deepEqual(plain[0], ["日期", "管段编码", "实测壁厚值(mm)"]);
  assert.deepEqual(plain[1], ["2024-03-05", "1G-SLB-WB-F000-R003-Q001", "6.5"]);
  assert.deepEqual(plain[2], ["2024-04-08", "2G-GGRQ-GQ-L012-U005-Q001", "1234"]);
});

check("docxToRows：多个表格按并集合并、重复行去重", async () => {
  const h = createHarness();
  const xml = XML_HEADER
    + "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>日期</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>编码</w:t></w:r></w:p></w:tc></w:tr>"
    + "<w:tr><w:tc><w:p><w:r><w:t>2024-03-05</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1G-SLB-WB-F000-R003-Q001</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"
    + "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>日期</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>编码</w:t></w:r></w:p></w:tc></w:tr>"
    + "<w:tr><w:tc><w:p><w:r><w:t>2024-03-05</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1G-SLB-WB-F000-R003-Q001</w:t></w:r></w:p></w:tc></w:tr>"
    + "<w:tr><w:tc><w:p><w:r><w:t>2024-03-06</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1G-SLB-WB-F000-R004-Q001</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"
    + XML_FOOTER;
  const file = makeFile(h, docxBuffer(xml));
  const result = await h.docs.docxToRows(file);
  const plain = JSON.parse(JSON.stringify(result.rows));
  assert.equal(plain.length, 3, "重复行只保留一行（表头 + 2 条数据）");
  assert.ok(result.notes.includes("去重 1 行"), "备注必须报告去重行数");
});

check("docxToRows：没有表格且正文太短 → 中文报错，不进清洗", async () => {
  const h = createHarness();
  const xml = XML_HEADER + "<w:p><w:r><w:t>短</w:t></w:r></w:p>" + XML_FOOTER;
  const file = makeFile(h, docxBuffer(xml));
  await assert.rejects(h.docs.docxToRows(file), (err) => err.message.includes("没有找到表格"), "必须给出中文错误说明");
});

check("docxToRows：缺 document.xml（不是标准 Word）→ 中文报错", async () => {
  const h = createHarness();
  const buffer = buildDocx([["readme.txt", Buffer.from("hello"), 0]]);
  const file = makeFile(h, buffer);
  await assert.rejects(h.docs.docxToRows(file), (err) => err.message.includes("另存为"), "必须提示另存为 .docx");
});

check("docxToRows：损坏的字节流（非 ZIP）→ 中文报错", async () => {
  const h = createHarness();
  const file = makeFile(h, Buffer.from("这不是一个 zip 文件"));
  await assert.rejects(h.docs.docxToRows(file), (err) => err.message.includes("ZIP"), "必须说明 ZIP 目录问题");
});

check("docxToRows：无表格但正文较长且未配置模型 → 兜底提取给配置提示", async () => {
  const h = createHarness();
  const paragraph = "这是一段很长的检测说明文字，用来确保超过四十个字符的阈值，" +
    "因此会尝试把正文交给大模型做表格提取，但当前环境没有配置任何模型密钥，" +
    "所以应当得到明确的中文配置提示而不是静默失败。";
  const xml = XML_HEADER + "<w:p><w:r><w:t>" + paragraph + "</w:t></w:r></w:p>" + XML_FOOTER;
  const file = makeFile(h, docxBuffer(xml));
  await assert.rejects(h.docs.docxToRows(file), (err) => err.message.includes("未配置大模型"), "必须提示先配置模型");
});

/* ---------------- 输出 ---------------- */

let failed = 0;
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
console.log((failed ? "FAIL" : "ok") + " - assistant docx unit: " + (checks.length - failed) + "/" + checks.length + " checks passed");
process.exit(failed ? 1 : 0);
