import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/**
 * 文档识别层 v2 单元测试。
 * 用 node:vm 直接执行 assets/app/assistant-docs-v1.js 的真实源码，并打桩
 * FileReader / Image / canvas / localStorage / callVisionLLM 这些浏览器依赖
 * （模块内部一律通过 global.* 访问，因此可以整体替换）。
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../assets/app/assistant-docs-v1.js"), "utf8");

const VISION_CONFIG = JSON.stringify({ apiKey: "unit-test-key", model: "unit-test-vision" });

/* vm 里造出来的数组与测试进程不是同一个 Array 原型，deepStrictEqual 会因原型不同而失败，
   所以比较前先转成宿主侧纯数据结构。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

function createHarness(options = {}) {
  const calls = [];
  const responses = (options.responses || []).slice();
  let active = 0;
  let maxActive = 0;

  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;

  sandbox.localStorage = {
    _data: { boiler_llm_config: options.llmConfig === undefined ? VISION_CONFIG : options.llmConfig },
    getItem(key) { return Object.prototype.hasOwnProperty.call(this._data, key) ? this._data[key] : null; },
    setItem(key, value) { this._data[key] = String(value); }
  };

  sandbox.FileReader = class {
    readAsDataURL(file) {
      setTimeout(() => {
        this.onload({ target: { result: "data:image/png;base64," + Buffer.from(String(file && file.name)).toString("base64") } });
      }, 0);
    }
  };

  sandbox.Image = class {
    constructor() { this.naturalWidth = 1200; this.naturalHeight = 800; }
    set src(value) { this._src = value; setTimeout(() => { if (typeof this.onload === "function") this.onload(); }, 0); }
    get src() { return this._src; }
  };

  sandbox.document = {
    createElement() {
      return {
        width: 0,
        height: 0,
        getContext() { return { drawImage() {} }; },
        toDataURL() { return "data:image/jpeg;base64,UNIT-TEST"; }
      };
    }
  };

  sandbox.callVisionLLM = (messages, maxTokens) => {
    calls.push({ messages, maxTokens });
    active += 1;
    maxActive = Math.max(maxActive, active);
    const next = responses.length
      ? responses.shift()
      : JSON.stringify({ headers: ["日期", "管段编码"], rows: [["2024-01-05", "A-1"]] });
    return new Promise((res, rej) => {
      setTimeout(() => {
        active -= 1;
        if (next instanceof Error) rej(next); else res(next);
      }, 0);
    });
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return {
    sandbox,
    docs: sandbox.BTAssistantDocs,
    calls,
    stats: () => ({ calls: calls.length, maxActive })
  };
}

const checks = [];
const check = (name, fn) => checks.push([name, fn]);
const png = (name) => ({ name: name, size: 2048, type: "image/png" });
const gridJson = (headers, rows, extra) => JSON.stringify(Object.assign({ headers: headers, rows: rows }, extra || {}));

/* ---------------- 导出契约 ---------------- */

check("导出 v3 冻结契约要求的全部键", () => {
  const { docs } = createHarness();
  assert.equal(docs.version, "v3");
  ["imageToRows", "pdfToRows", "docxToRows", "imagesToRows", "mergeGrids", "normalizeGrid", "normalizeCell", "normalizeDate", "normalizeNumber"].forEach((name) => {
    assert.equal(typeof docs[name], "function", name + " 必须是函数");
  });
  assert.equal(typeof docs.isImageFile, "function");
  assert.equal(docs.isImageFile("a.PNG"), true);
  assert.equal(docs.isPdfFile("a.pdf"), true);
  assert.equal(typeof docs.isDocxFile, "function");
  assert.equal(docs.isDocxFile("a.DOCX"), true);
  assert.equal(docs.isDocxFile("a.doc"), false);
});

/* ---------------- normalizeCell / normalizeDate / normalizeNumber ---------------- */

check("normalizeCell：中文 / 点分 / 斜杠 / 紧凑日期归一到 YYYY-MM-DD", () => {
  const { docs } = createHarness();
  assert.equal(docs.normalizeCell("2024年1月5日", "日期"), "2024-01-05");
  assert.equal(docs.normalizeCell("2024.1.5", "检测日期"), "2024-01-05");
  assert.equal(docs.normalizeCell("2024/1/5", "日期"), "2024-01-05");
  assert.equal(docs.normalizeCell("20240105", "日期"), "2024-01-05");
  assert.equal(docs.normalizeCell("２０２４年１月５日", "日期"), "2024-01-05");
  assert.equal(docs.normalizeDate("2024-1-5"), "2024-01-05");
  assert.equal(docs.normalizeDate("2024-01-05 10:30"), "2024-01-05");
  assert.equal(docs.normalizeDate("2024年2月29日"), "2024-02-29", "闰年 2 月 29 日合法");
  assert.equal(docs.normalizeDate(docs.normalizeDate("2024年1月5日")), "2024-01-05", "幂等");
});

check("normalizeDate：识别不了或日期不存在时保留原文（严禁臆造）", () => {
  const { docs } = createHarness();
  assert.equal(docs.normalizeDate("2024年13月45日"), "2024年13月45日");
  assert.equal(docs.normalizeDate("2023年2月29日"), "2023年2月29日", "平年 2 月 29 日不能瞎改");
  assert.equal(docs.normalizeDate("待补"), "待补");
  assert.equal(docs.normalizeDate("  待 补  "), "待 补");
  assert.equal(docs.normalizeDate(""), "");
  assert.equal(docs.normalizeDate(null), "");
  assert.equal(docs.normalizeCell("待补", "日期"), "待补");
});

check("normalizeCell：厚度 / 硬度 / 库存数值去单位、去千分位", () => {
  const { docs } = createHarness();
  assert.equal(docs.normalizeCell("6.5mm", "厚度(mm)"), "6.5");
  assert.equal(docs.normalizeCell("１８３HB", "硬度(HB)"), "183");
  assert.equal(docs.normalizeCell("6.5 mm", "壁厚"), "6.5");
  assert.equal(docs.normalizeCell("183 HB", "硬度"), "183");
  assert.equal(docs.normalizeCell("1,234", "库存"), "1234");
  assert.equal(docs.normalizeCell("12,345,678", "总长度(mm)"), "12345678");
  assert.equal(docs.normalizeNumber("１２３４．５"), "1234.5");
  assert.equal(docs.normalizeNumber("6.5（mm）"), "6.5");
});

check("normalizeNumber：无法规范化时保留原文（不丢数据）", () => {
  const { docs } = createHarness();
  assert.equal(docs.normalizeCell("6.5~7.0", "厚度(mm)"), "6.5~7.0", "区间值不能被截断成 6.5");
  assert.equal(docs.normalizeCell("见附页", "壁厚"), "见附页");
  assert.equal(docs.normalizeNumber("6,5"), "6,5", "不是千分位时不能吞掉逗号");
  assert.equal(docs.normalizeNumber("1 234"), "1 234");
  assert.equal(docs.normalizeNumber(""), "");
});

check("normalizeCell：管段编码去所有空白、全角转半角、不改大小写", () => {
  const { docs } = createHarness();
  assert.equal(docs.normalizeCell(" 1G-SLB-WB-F000-R007-Q001 ", "管段编码"), "1G-SLB-WB-F000-R007-Q001");
  assert.equal(docs.normalizeCell("1-WW FR-009", "管段编码"), "1-WWFR-009");
  assert.equal(docs.normalizeCell("ａｂＣ１２", "关联新管码"), "abC12");
  assert.equal(docs.normalizeCell("Φ63.5 × 7.5", "规格"), "Φ63.5 × 7.5", "非编码列只做基础清洗");
});

check("normalizeCell：全角 / 零宽字符 / 首尾空白基础清洗", () => {
  const { docs } = createHarness();
  assert.equal(docs.normalizeCell("ＥＶＥＮＴ，测厚\u200b", "详细描述"), "EVENT,测厚");
  assert.equal(docs.normalizeCell("　测厚　", "结论"), "测厚");
  assert.equal(docs.normalizeCell("   ", "日期"), "");
  assert.equal(docs.normalizeCell(undefined, "日期"), "");
});

/* ---------------- normalizeGrid ---------------- */

check("normalizeGrid：返回新数组、不改入参、表头与数据行都处理、幂等", () => {
  const { docs } = createHarness();
  const input = [
    ["日期", "管段编码", "厚度(mm)", "规格"],
    ["2024年1月5日", " 1G-SLB-WB-F000-R007 ", "6.5mm", "Φ63.5×7.5"],
    ["2024.2.6", "1G-SLB-WB-F000-R008", "见附页", "Φ51×8"]
  ];
  const snapshot = JSON.parse(JSON.stringify(input));
  const first = docs.normalizeGrid(input);

  assert.deepEqual(input, snapshot, "normalizeGrid 不能修改入参");
  assert.notEqual(first, input);
  assert.notEqual(first[0], input[0]);
  assert.notEqual(first[1], input[1]);
  assert.deepEqual(plain(first[0]), ["日期", "管段编码", "厚度(mm)", "规格"], "表头行也要清洗但不能被破坏");
  assert.deepEqual(plain(first[1]), ["2024-01-05", "1G-SLB-WB-F000-R007", "6.5", "Φ63.5×7.5"]);
  assert.deepEqual(plain(first[2]), ["2024-02-06", "1G-SLB-WB-F000-R008", "见附页", "Φ51×8"]);
  assert.deepEqual(plain(docs.normalizeGrid(first)), plain(first), "normalizeGrid 必须幂等");
  assert.deepEqual(plain(docs.normalizeGrid([])), []);
  assert.deepEqual(plain(docs.normalizeGrid(null)), []);
});

/* ---------------- mergeGrids ---------------- */

check("mergeGrids：表头并集保序、缺失列补空串、重复数据行去重", () => {
  const { docs } = createHarness();
  const merged = docs.mergeGrids([
    [["炉号", "日期"], ["1", "2024-01-05"], ["2", "2024-01-06"]],
    [["日期", "管段编码"], ["2024-01-06", "A-1"], ["2024-01-07", "A-2"], ["2024-01-07", "A-2"]]
  ]);
  assert.deepEqual(plain(merged.rows[0]), ["炉号", "日期", "管段编码"], "表头按首次出现顺序取并集");
  assert.deepEqual(plain(merged.rows[1]), ["1", "2024-01-05", ""], "缺失列补空串");
  assert.deepEqual(plain(merged.rows[2]), ["2", "2024-01-06", ""]);
  assert.deepEqual(plain(merged.rows[3]), ["", "2024-01-06", "A-1"]);
  assert.deepEqual(plain(merged.rows[4]), ["", "2024-01-07", "A-2"]);
  assert.equal(merged.rows.length - 1, 4, "重复数据行必须去重");
  assert.match(merged.notes, /表头 3 列/);
  assert.match(merged.notes, /去重 1 行/);

  const empty = docs.mergeGrids([]);
  assert.deepEqual(plain(empty.rows), []);
  assert.match(empty.notes, /没有可合并/);
});

/* ---------------- imagesToRows ---------------- */

check("imagesToRows：两张串行识别合并、表头对齐去重、进度回调完整", async () => {
  const responses = [
    gridJson(["日期", "管段编码", "结论"], [["2024年1月5日", " 1G-SLB-WB-F000-R007 ", "合格"]], { uncertain: [[0, 2]] }),
    gridJson(["管段编码", "日期", "结论"], [["1G-SLB-WB-F000-R007", "2024/1/5", ""], ["1G-SLB-WB-F000-R009", "2024/2/7", "待复检"]])
  ];
  const h = createHarness({ responses });
  const seen = [];
  const result = await h.docs.imagesToRows([png("a.png"), png("b.png")], {
    onProgress: (index, total, name) => seen.push([index, total, name])
  });

  assert.equal(result.sheetName, "图片识别(2张)");
  assert.deepEqual(plain(result.rows[0]), ["日期", "管段编码", "结论"]);
  assert.deepEqual(plain(result.rows[1]), ["2024-01-05", "1G-SLB-WB-F000-R007", ""], "uncertain 命中的单元格置空");
  assert.deepEqual(plain(result.rows[2]), ["2024-02-07", "1G-SLB-WB-F000-R009", "待复检"]);
  assert.equal(result.rows.length - 1, 2, "跨图重复数据行必须去重");
  assert.match(result.notes, /成功 2 张/);
  assert.match(result.notes, /失败 0 张/);
  assert.match(result.notes, /1 个单元格识别不确定已置空，请人工核对/);

  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].name, "a.png");
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].sheetName, "图片识别");
  assert.equal(result.results[1].ok, true);
  assert.match(result.results[0].notes, /1 个单元格识别不确定已置空/);

  assert.deepEqual(seen, [[0, 2, "a.png"], [1, 2, "b.png"]], "onProgress 必须每张各回调一次且顺序正确");
  assert.equal(h.stats().maxActive, 1, "禁止并发调用模型");
  assert.equal(h.calls.length, 2);
  const imageParts = h.calls[0].messages[1].content.concat(h.calls[1].messages[1].content).filter((part) => part.type === "image_url");
  assert.equal(imageParts.length, 2, "每张图片都要带上压缩后的 data URL");
});

check("imagesToRows：单张失败被容忍，notes 说明失败张数与原因", async () => {
  const h = createHarness({
    responses: [gridJson(["日期", "管段编码"], [["2024-01-05", "A-1"]]), new Error("图片解码失败，请换一张清晰的截图或照片。")]
  });
  const result = await h.docs.imagesToRows([png("good.png"), png("bad.png")]);

  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].ok, false);
  assert.equal(result.results[1].error, "图片解码失败，请换一张清晰的截图或照片。");
  assert.equal(result.results[1].rows, undefined);
  assert.deepEqual(plain(result.rows), [["日期", "管段编码"], ["2024-01-05", "A-1"]]);
  assert.equal(result.rows.length - 1, 1);
  assert.equal(result.sheetName, "图片识别(2张)");
  assert.match(result.notes, /成功 1 张/);
  assert.match(result.notes, /失败 1 张/);
  assert.match(result.notes, /bad\.png/);
  assert.match(result.notes, /图片解码失败/);
});

check("imagesToRows：全部失败才 reject，且带首条失败原因", async () => {
  const h = createHarness({ responses: [new Error("第一张认不出表格"), new Error("第二张也认不出")] });
  await assert.rejects(
    () => h.docs.imagesToRows([png("a.png"), png("b.png")]),
    (error) => {
      assert.match(error.message, /全部识别失败/);
      assert.match(error.message, /a\.png/);
      assert.match(error.message, /第一张认不出表格/);
      return true;
    }
  );
});

check("imagesToRows：空列表 / 超上限直接 reject（中文提示，不调用模型）", async () => {
  const h = createHarness({});
  await assert.rejects(() => h.docs.imagesToRows([]), /没有可识别的图片文件/);
  const nine = new Array(9).fill(null).map((_, index) => png("p" + index + ".png"));
  await assert.rejects(() => h.docs.imagesToRows(nine), /一次最多识别 8 张图片/);
  await assert.rejects(() => h.docs.imagesToRows([png("a.png"), png("b.png")], { maxFiles: 1 }), /一次最多识别 1 张图片/);
  assert.equal(h.calls.length, 0, "参数校验失败时不能调用模型");
});

check("imagesToRows：onProgress 抛错被吞掉，首张同步回调", async () => {
  const ok = gridJson(["日期", "管段编码"], [["2024-01-05", "A-1"]]);
  const h = createHarness({ responses: [ok, ok] });
  const seen = [];
  const pending = h.docs.imagesToRows([png("a.png"), png("b.png")], {
    onProgress: (index, total, name) => { seen.push([index, total, name]); throw new Error("进度回调异常"); }
  });
  assert.deepEqual(seen, [[0, 2, "a.png"]], "第一张的进度回调必须同步发生");
  const result = await pending;
  assert.equal(result.results.filter((item) => item.ok).length, 2, "进度回调抛错不能影响识别");
  assert.deepEqual(seen.map((item) => item[0]), [0, 1]);
});

check("imagesToRows：兼容 FileList 形态（length + 数字下标）", async () => {
  const ok = gridJson(["日期", "管段编码"], [["2024-01-05", "A-1"]]);
  const h = createHarness({ responses: [ok, ok] });
  const result = await h.docs.imagesToRows({ 0: png("a.png"), 1: png("b.png"), length: 2 });
  assert.equal(result.results.length, 2);
  assert.equal(result.sheetName, "图片识别(2张)");
  assert.equal(result.results.every((item) => item.ok), true);
});

/* ---------------- 模型输出 JSON 修复重试 ---------------- */

check("模型输出不是合法 JSON 时自动发起一次修复请求", async () => {
  const repaired = gridJson(["日期", "管段编码"], [["2024年1月5日", "A-1"]]);
  const h = createHarness({ responses: ["抱歉，这是识别结果：<html>504 Gateway Timeout</html>", repaired] });
  const result = await h.docs.imageToRows(png("a.png"));

  assert.equal(h.calls.length, 2, "只允许重试一次");
  assert.deepEqual(plain(result.rows), [["日期", "管段编码"], ["2024-01-05", "A-1"]], "修复后的 JSON 仍要经过字段规范化");
  const repairMessages = h.calls[1].messages;
  assert.equal(repairMessages[repairMessages.length - 2].role, "assistant");
  assert.match(repairMessages[repairMessages.length - 2].content, /504/, "修复请求要回传原始输出");
  assert.match(repairMessages[repairMessages.length - 1].content, /只输出/);
  assert.equal(repairMessages[1].content.filter((part) => part.type === "image_url").length, 1, "修复请求仍带原图");
  assert.equal(h.stats().maxActive, 1);
});

check("修复后仍是坏 JSON 时 reject，错误信息含原始输出片段", async () => {
  const h = createHarness({ responses: ["第一段垃圾输出 {", "第二段还是垃圾输出 {"] });
  await assert.rejects(
    () => h.docs.imageToRows(png("a.png")),
    (error) => {
      assert.equal(h.calls.length, 2, "修复只允许一次");
      assert.match(error.message, /原始输出片段/);
      assert.match(error.message, /第一段垃圾输出/);
      return true;
    }
  );
});

check("合法 JSON 但没有表格时直接报错，不触发修复请求", async () => {
  const h = createHarness({ responses: [gridJson([], [])] });
  await assert.rejects(() => h.docs.imageToRows(png("a.png")), /识别出表格/);
  assert.equal(h.calls.length, 1);
});

/* ---------------- uncertain 标注 ---------------- */

check("uncertain：命中单元格置空并计数，非法坐标安全忽略", async () => {
  const payload = gridJson(["日期", "管段编码", "厚度(mm)"], [["2024-01-05", "A-1", "6.5"], ["2024-01-06", "A-2", "6.6"]], {
    uncertain: [[0, 2], [1, 1], [0, 2], "坏数据", [9, 9], [-1, 0], [0], null, [1, 99]]
  });
  const h = createHarness({ responses: [payload] });
  const result = await h.docs.imageToRows(png("a.png"));

  assert.deepEqual(plain(result.rows[1]), ["2024-01-05", "A-1", ""]);
  assert.deepEqual(plain(result.rows[2]), ["2024-01-06", "", "6.6"]);
  assert.match(result.notes, /2 个单元格识别不确定已置空，请人工核对/, "重复坐标只计一次，越界项忽略");
});

check("uncertain 缺失时行为与 v1 一致（不置空、不提示）", async () => {
  const h = createHarness({ responses: [gridJson(["日期", "管段编码"], [["2024-01-05", "A-1"]])] });
  const result = await h.docs.imageToRows(png("a.png"));
  assert.deepEqual(plain(result.rows), [["日期", "管段编码"], ["2024-01-05", "A-1"]]);
  assert.equal(/不确定/.test(result.notes), false);
  assert.equal(result.sheetName, "图片识别");
});

/* ---------------- 模型未配置 ---------------- */

check("未配置模型时给出中文配置提示且不调用模型", async () => {
  const h = createHarness({ llmConfig: "{}" });
  await assert.rejects(() => h.docs.imageToRows(png("a.png")), /模型接口配置/);
  assert.equal(h.calls.length, 0);
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
  console.error("assistant docs unit: " + (checks.length - failed) + "/" + checks.length + " checks passed");
  process.exitCode = 1;
} else {
  console.log("ok - assistant docs unit: " + checks.length + "/" + checks.length + " checks passed");
}
