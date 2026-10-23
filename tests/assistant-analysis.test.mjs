import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/**
 * 分析领域层单测：只测纯函数（解析 / 聚合 / 洞察 / 图表 SVG），不碰 DOM。
 * 契约见 docs/ai-assistant-spec.md §2.10。
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const coreSource = readFileSync(resolve(root, "assets/app/assistant-core-v1.js"), "utf8");
const analysisSource = readFileSync(resolve(root, "assets/app/assistant-analysis-v1.js"), "utf8");

const sandbox = { console };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(coreSource, sandbox);
vm.runInContext(analysisSource, sandbox);

const Core = sandbox.BTAssistantCore;
const A = sandbox.BTAssistantAnalysis;

/* ---------------- 造数据 ---------------- */

function event(overrides) {
  return Object.assign({
    ts: 1,
    code: "1-WW-FR-008-0003-000",
    boiler: "1",
    date: "2024-01-15",
    type: "测厚",
    thickness: 7.5,
    hardness: 180,
    spec: "Φ63.5×7.5",
    material: "SA-210C",
    desc: "样本"
  }, overrides || {});
}

function buildSnapshot() {
  const events = [];
  let ts = 1000;
  const systems = ["WW", "HSH", "ECO", "HRH"];
  for (let year = 2022; year <= 2025; year += 1) {
    for (let month = 1; month <= 12; month += 2) {
      for (let unit = 1; unit <= 2; unit += 1) {
        const sys = systems[(month + unit) % systems.length];
        const nominal = 7.5;
        const thickness = Number((nominal - (2025 - year) * 0.2 - (unit === 2 ? 0.1 : 0)).toFixed(2));
        events.push(event({
          ts: ts++,
          code: unit + "-" + sys + "-E-012-0005-W0" + (month % 5),
          boiler: String(unit),
          date: year + "-" + String(month).padStart(2, "0") + "-15",
          type: month % 4 === 1 ? "金相分析" : "测厚",
          thickness: thickness,
          hardness: Math.round(200 - thickness * 4),
          spec: "Φ51×" + nominal
        }));
      }
    }
  }
  return {
    events: events,
    replacements: [{ ts: 1, oldCode: "1-WW-FR-008-0003-000", newCode: "1-WW-FR-008-0003-001", boiler: "1", date: "2023-05-01", reason: "爆管" }],
    materialLibrary: [],
    matrix: [],
    retiredCodes: [],
    warnings: [{ id: "w1" }, { id: "w2" }],
    overdueRows: [{ code: "1-WW-FR-008-0003-000" }],
    now: "2026-10-23T00:00:00.000Z"
  };
}

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

/* ---------------- 契约 ---------------- */

check("对外 API 齐全且挂到 window.BTAssistantAnalysis", () => {
  ["parseAnalysis", "runAnalysis", "chartSvg", "describeSpec", "capabilities", "parseNominalWall", "pearson"].forEach((name) => {
    assert.equal(typeof A[name], "function", "缺少 " + name);
  });
  assert.ok(Array.isArray(A.KINDS) && A.KINDS.length === 8, "应当声明 8 类分析");
  assert.equal(sandbox.BTAssistantAnalysis, A);
});

check("parseNominalWall 从规格串取名义壁厚", () => {
  assert.equal(A.parseNominalWall("Φ63.5×7.5"), 7.5);
  assert.equal(A.parseNominalWall("φ51*8"), 8);
  assert.equal(A.parseNominalWall("63.5x6.2"), 6.2);
  assert.equal(A.parseNominalWall("SA-210C"), null);
  assert.equal(A.parseNominalWall(""), null);
  assert.equal(A.parseNominalWall(null), null);
});

check("parseAnalysis 把八类中文问法映射到对应分析规格", () => {
  const cases = [
    ["近两年壁厚趋势", "trend", "thickness", "month"],
    ["按年度看更换次数趋势", "trend", "replacements", "year"],
    ["壁厚分布", "distribution", "thickness", "thicknessBin"],
    ["各受热面事件数分布", "distribution", "count", "sys"],
    ["受热面事件数排行", "ranking", "count", "sys"],
    ["1 号和 2 号炉壁厚对比", "compare", "thickness", "unit"],
    ["壁厚和硬度相关性", "correlation", "hardness", "month"],
    ["壁厚异常记录", "outlier", "thickness", "month"],
    ["数据整体画像", "overview", "count", "month"]
  ];
  cases.forEach(([text, kind, metric, dimension]) => {
    const spec = A.parseAnalysis(text, {});
    assert.ok(spec, "未识别：" + text);
    assert.equal(spec.kind, kind, text + " 的 kind");
    assert.equal(spec.metric, metric, text + " 的 metric");
    assert.equal(spec.dimension, dimension, text + " 的 dimension");
    assert.ok(spec.title && spec.title.length >= 3, text + " 需要中文标题");
  });
});

check("parseAnalysis 对无关句子返回 null，不误判", () => {
  ["今天天气怎么样", "帮我写一封邮件", "", null, undefined].forEach((text) => {
    assert.equal(A.parseAnalysis(text, {}), null, String(text));
  });
});

check("过滤条件复用查询口径（机组 / 受热面 / 日期）", () => {
  const spec = A.parseAnalysis("1 号炉水冷壁近两年壁厚趋势", { now: "2026-10-23T00:00:00.000Z" });
  assert.equal(spec.filters.unit, "1");
  assert.equal(spec.filters.sys, "WW");
  assert.equal(spec.filters.dateFrom, "2024-10-23");
  const result = A.runAnalysis(spec, buildSnapshot());
  assert.ok(result.ok);
  assert.ok(result.sampleSize > 0);
  assert.ok(result.insights.join(" ").length > 0);
});

check("按机组对比时不能被「1 号炉」这类条件过滤成单组", () => {
  const spec = A.parseAnalysis("1 号和 2 号炉壁厚对比", {});
  assert.equal(spec.kind, "compare");
  assert.equal(spec.filters.unit, undefined, "对比维度是机组时必须放开机组过滤");
  const result = A.runAnalysis(spec, buildSnapshot());
  assert.ok(result.ok);
  assert.equal(result.metrics.length, 2, "两台机组都应出现在对比里");
});

/* ---------------- 各类分析 ---------------- */

check("runAnalysis 趋势：按月聚合、给出均值与结论", () => {
  const spec = A.parseAnalysis("壁厚趋势", {});
  const result = A.runAnalysis(spec, buildSnapshot());
  assert.ok(result.ok);
  assert.equal(result.chart.type, "line");
  assert.ok(result.chart.categories.length >= 6, "按月应当有多个时间点");
  assert.ok(result.chart.series.length >= 1);
  const insightText = result.insights.join(" ");
  assert.match(insightText, /平均壁厚/);
  assert.match(insightText, /各期均值最低/);
  assert.ok(result.metrics.some((m) => m.label === "记录数"));
});

check("runAnalysis 分布：分箱计数之和等于样本数", () => {
  const spec = A.parseAnalysis("壁厚分布", {});
  const result = A.runAnalysis(spec, buildSnapshot());
  assert.ok(result.ok);
  assert.equal(result.chart.type, "bar");
  const total = result.chart.series[0].values.reduce((a, b) => a + b, 0);
  assert.equal(total, result.sampleSize, "分箱计数之和必须等于样本数");
  assert.match(result.insights.join(" "), /最集中区间/);
});

check("runAnalysis 排行：默认降序且支持「前 3 名」截断", () => {
  const spec = A.parseAnalysis("受热面事件数排行前 3 名", {});
  assert.equal(spec.limit, 3);
  const result = A.runAnalysis(spec, buildSnapshot());
  assert.ok(result.ok);
  assert.equal(result.chart.type, "hbar");
  assert.equal(result.chart.categories.length, 3, "前 3 名只应画 3 条");
  const values = result.chart.series[0].values;
  for (let i = 1; i < values.length; i += 1) assert.ok(values[i - 1] >= values[i], "必须降序");
  assert.match(result.insights[0], /第 1 名/);
});

check("runAnalysis 排行：最薄壁厚按升序", () => {
  const spec = A.parseAnalysis("各受热面最薄壁厚排行", {});
  assert.equal(spec.order, "asc");
  assert.equal(spec.metric, "thickness");
  const result = A.runAnalysis(spec, buildSnapshot());
  const values = result.chart.series[0].values;
  for (let i = 1; i < values.length; i += 1) assert.ok(values[i - 1] <= values[i], "最薄排行必须升序");
});

check("runAnalysis 相关性：完全线性关系得到 r≈±1", () => {
  const events = [];
  for (let i = 0; i < 12; i += 1) {
    const thickness = 6 + i * 0.1;
    events.push(event({
      ts: i + 1,
      code: "1-HSH-E-012-0005-W01",
      date: "2024-" + String((i % 12) + 1).padStart(2, "0") + "-10",
      thickness: thickness,
      hardness: 260 - thickness * 10
    }));
  }
  const spec = A.parseAnalysis("壁厚和硬度相关性", {});
  const result = A.runAnalysis(spec, { events: events, replacements: [], now: "2026-01-01T00:00:00.000Z" });
  assert.ok(result.ok);
  assert.equal(result.chart.type, "scatter");
  const r = Number(result.metrics.find((m) => m.label === "相关系数 r").value);
  assert.ok(r < -0.99, "完全负相关应当接近 -1，实际 " + r);
  assert.match(result.insights.join(" "), /相关不等于因果/);
});

check("runAnalysis 异常识别：低于名义 80% 的记录必须被点名", () => {
  const events = [];
  for (let i = 0; i < 10; i += 1) {
    events.push(event({
      ts: i + 1,
      code: "1-WW-FR-008-000" + i + "-000",
      date: "2024-0" + ((i % 9) + 1) + "-10",
      thickness: i === 4 ? 5.2 : 7.4,
      spec: "Φ63.5×7.5"
    }));
  }
  const spec = A.parseAnalysis("壁厚异常记录", {});
  const result = A.runAnalysis(spec, { events: events, replacements: [], now: "2026-01-01T00:00:00.000Z" });
  assert.ok(result.ok);
  assert.equal(result.metrics.find((m) => m.label === "异常记录").value, "1");
  assert.ok(result.table.rows.length >= 1);
  assert.match(result.table.rows[0]["异常原因"], /减薄率/);
});

check("runAnalysis 单管剖面：按日期排序并画 80% 名义壁厚阈值", () => {
  const events = [
    event({ ts: 3, code: "1-WW-FR-008-0003-000", date: "2025-03-01", thickness: 6.2 }),
    event({ ts: 1, code: "1-WW-FR-008-0003-000", date: "2021-03-01", thickness: 7.3 }),
    event({ ts: 2, code: "1-WW-FR-008-0003-000", date: "2023-03-01", thickness: 6.8 })
  ];
  const spec = A.parseAnalysis("1-WW-FR-008-0003-000 壁厚变化曲线", {});
  const result = A.runAnalysis(spec, { events: events, replacements: [], now: "2026-01-01T00:00:00.000Z" });
  assert.ok(result.ok);
  assert.deepEqual(
    Array.from(result.chart.categories),
    ["2021-03-01", "2023-03-01", "2025-03-01"],
    "必须按日期升序"
  );
  assert.equal(result.chart.threshold.value, 6, "阈值应为名义壁厚 7.5 的 80%");
  assert.match(result.insights.join(" "), /年均减薄/);
});

check("runAnalysis 综合画像：给出指标、构成图与建议", () => {
  const spec = A.parseAnalysis("数据整体画像", {});
  const result = A.runAnalysis(spec, buildSnapshot());
  assert.ok(result.ok);
  assert.equal(result.chart.type, "donut");
  assert.ok(result.metrics.length >= 5);
  assert.ok(result.metrics.some((m) => m.label === "超期未检"));
  assert.match(result.insights.join(" "), /超期未检|预警/);
});

/* ---------------- 图表 SVG ---------------- */

check("chartSvg 六种图形都能产出合法 SVG 且不含 NaN/undefined", () => {
  const charts = [
    { type: "line", categories: ["1月", "2月", "3月"], series: [{ name: "壁厚", values: [7.5, 7.3, 7.1] }] },
    { type: "bar", categories: ["A", "B"], series: [{ name: "数量", values: [3, 5] }] },
    { type: "hbar", categories: ["水冷壁", "高温过热器"], series: [{ name: "记录数", values: [12, 8] }] },
    { type: "donut", categories: ["测厚", "金相"], series: [{ name: "占比", values: [30, 10] }] },
    { type: "scatter", points: [{ x: 7.1, y: 180 }, { x: 7.4, y: 170 }], xLabel: "壁厚", yLabel: "硬度" },
    { type: "histogram", categories: ["6~7", "7~8"], series: [{ name: "条", values: [2, 8] }] }
  ];
  charts.forEach((chart) => {
    const svg = A.chartSvg(chart);
    assert.ok(svg.startsWith("<svg"), chart.type + " 必须返回 svg");
    assert.ok(svg.trim().endsWith("</svg>"), chart.type + " 必须闭合");
    assert.ok(!/NaN|undefined|null/.test(svg), chart.type + " 不能出现 NaN/undefined/null");
  });
});

check("chartSvg 对分类文本做转义，避免注入", () => {
  const svg = A.chartSvg({
    type: "hbar",
    categories: ['<script>alert(1)</script>', '"quoted"'],
    series: [{ name: "条", values: [1, 2] }]
  });
  assert.ok(!svg.includes("<script>"), "标签必须被转义");
  assert.ok(svg.includes("&lt;script&gt;"));
  assert.ok(svg.includes("&quot;quoted&quot;"));
});

check("chartSvg 空数据给出占位文案而不是崩溃", () => {
  const svg = A.chartSvg({ type: "line", categories: [], series: [] }, { emptyText: "无可用记录" });
  assert.match(svg, /无可用记录/);
});

/* ---------------- 边界 ---------------- */

check("空快照返回 ok:false 且给出可执行提示", () => {
  const spec = A.parseAnalysis("壁厚趋势", {});
  const result = A.runAnalysis(spec, { events: [], replacements: [] });
  assert.equal(result.ok, false);
  assert.match(result.message, /没有可分析的数据/);
});

check("数据不足时（相关性）不返回误导性结论", () => {
  const spec = A.parseAnalysis("壁厚和硬度相关性", {});
  const result = A.runAnalysis(spec, { events: [event({})], replacements: [] });
  assert.equal(result.ok, false);
  assert.match(result.message, /至少需要 3 条/);
});

check("describeSpec / capabilities 提供中文说明", () => {
  const spec = A.parseAnalysis("1 号炉水冷壁壁厚趋势", {});
  const text = A.describeSpec(spec);
  assert.match(text, /趋势/);
  assert.match(text, /水冷壁/);
  const caps = A.capabilities();
  assert.equal(caps.length, 8);
  caps.forEach((item) => {
    assert.ok(item.label && item.example, "能力项必须带中文名与示例");
  });
});

check("pearson 对异常输入保持稳健", () => {
  assert.equal(A.pearson([]), null);
  assert.equal(A.pearson([[1, 2]]), null);
  assert.equal(A.pearson([[1, 2], [1, 2], [1, 2]]), null, "零方差返回 null");
  const r = A.pearson([[1, 1], [2, 2], [3, 3]]);
  assert.ok(Math.abs(r - 1) < 1e-9);
});

/* ---------------- 大模型参与分析（证据包 / 校验） ---------------- */

check("buildEvidence 只发聚合结果，不外发管码与原始行", () => {
  const spec = A.parseAnalysis("1 号炉水冷壁壁厚趋势", {});
  const result = A.runAnalysis(spec, buildSnapshot());
  const evidence = A.buildEvidence("1 号炉水冷壁壁厚趋势", spec, result);
  const payload = evidence.payload;
  const serialized = JSON.stringify(payload);
  assert.ok(!/[12]-[A-Z]{2,3}-[A-Z]{1,3}-\d{3}-\d{4}-[A-Z0-9]{3}/.test(serialized), "证据包里不能出现管段编码");
  assert.ok(!payload.table && !payload.rows, "不能把明细表发给模型");
  assert.ok(!serialized.includes("desc"), "不能包含原始行的描述字段");
  assert.ok(payload.series.length >= 1 && payload.series.length <= 3, "序列最多 3 条");
  payload.series.forEach((item) => assert.ok(item.values.length <= 24, "序列点最多 24 个"));
  assert.ok(payload.metrics.length <= 8);
  assert.deepEqual(Array.from(payload.allowed.kinds).sort(), ["compare", "correlation", "distribution", "outlier", "overview", "profile", "ranking", "trend"]);
  assert.ok(payload.sampleSize > 0);
  assert.ok(Object.keys(evidence.numbers).length > 0, "必须收集可引用的数字白名单");
});

check("buildAnalysisMessages 产出 system + user 两段，且可解析", () => {
  const spec = A.parseAnalysis("壁厚趋势", {});
  const result = A.runAnalysis(spec, buildSnapshot());
  const messages = A.buildAnalysisMessages(A.buildEvidence("壁厚趋势", spec, result));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /只输出严格 JSON/);
  assert.match(messages[0].content, /严禁编造/);
  assert.equal(messages[1].role, "user");
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.rule.kind, "trend");
  assert.ok(payload.categories.length > 0);
});

check("parseModelAnalysis 过滤无数据依据的结论，保留有依据的", () => {
  const spec = A.parseAnalysis("壁厚趋势", {});
  const result = A.runAnalysis(spec, buildSnapshot());
  const evidence = A.buildEvidence("壁厚趋势", spec, result);
  const mean = result.metrics.find((m) => m.label === "均值").value;   // 形如 7.2mm
  const reply = JSON.stringify({
    title: "壁厚缓慢减薄",
    insights: [
      "平均壁厚 " + mean + "，整体呈缓慢减薄趋势。",
      "另有 3 根管段壁厚低于 5.55mm，需立即换管。"
    ],
    risk: "medium",
    advice: "对低值段安排复测。",
    spec: { kind: "trend", metric: "thickness", dimension: "month", chartType: "line" }
  });
  const parsed = A.parseModelAnalysis(reply, evidence);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.insights.length, 1, "编造数字的结论必须被过滤");
  assert.equal(parsed.dropped, 1);
  assert.match(parsed.insights[0], /平均壁厚/);
  assert.equal(parsed.risk, "medium");
  assert.equal(parsed.advice, "对低值段安排复测。");
  assert.equal(parsed.specPatch.kind, "trend");
});

check("parseModelAnalysis 兼容 ```json 围栏与无效 JSON", () => {
  const spec = A.parseAnalysis("壁厚趋势", {});
  const result = A.runAnalysis(spec, buildSnapshot());
  const evidence = A.buildEvidence("壁厚趋势", spec, result);
  const fenced = "```json\n" + JSON.stringify({ insights: ["均值 " + result.metrics[2].value + "，数据稳定。"], risk: "low" }) + "\n```";
  const parsedFenced = A.parseModelAnalysis(fenced, evidence);
  assert.equal(parsedFenced.ok, true);

  const broken = A.parseModelAnalysis("模型说这段话不是 JSON", evidence);
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /JSON/);

  const empty = A.parseModelAnalysis("", evidence);
  assert.equal(empty.ok, false);
});

check("parseModelAnalysis 拒绝非法口径，只保留白名单字段", () => {
  const spec = A.parseAnalysis("壁厚趋势", {});
  const result = A.runAnalysis(spec, buildSnapshot());
  const evidence = A.buildEvidence("壁厚趋势", spec, result);
  const parsed = A.parseModelAnalysis(JSON.stringify({
    insights: ["均值 " + result.metrics[2].value + "，可以关注。"],
    spec: { kind: "drop_table", metric: "profit", dimension: "galaxy", chartType: "pie3d" }
  }), evidence);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.specPatch, null, "全部非法时不应给出口径建议");
  const partial = A.parseModelAnalysis(JSON.stringify({
    insights: ["均值 " + result.metrics[2].value + "，可以关注。"],
    spec: { kind: "ranking", dimension: "sys", chartType: "hbar", metric: "profit" }
  }), evidence);
  assert.deepEqual(JSON.parse(JSON.stringify(partial.specPatch)), { kind: "ranking", dimension: "sys", chartType: "hbar" });
});

check("mergeAnalysisSpec 换口径时自动补默认图表并重算标题", () => {
  const spec = A.parseAnalysis("壁厚趋势", {});
  const merged = A.mergeAnalysisSpec(spec, { kind: "ranking", dimension: "sys" });
  assert.equal(merged.changed, true);
  assert.equal(merged.spec.kind, "ranking");
  assert.equal(merged.spec.chartType, "hbar", "排行默认横向条形");
  assert.ok(merged.spec.title.length > 0);
  const same = A.mergeAnalysisSpec(spec, { kind: "trend", metric: "thickness", dimension: "month" });
  assert.equal(same.changed, false, "口径没变就不应触发重算");
});

check("isGrounded 支持百分比换算，maskPii 抹掉管码与联系方式", () => {
  const numbers = { "0.054": true, "5.4": true, "7.2": true };
  assert.equal(A.isGrounded("累计下降 5.4%", numbers), true);
  assert.equal(A.isGrounded("累计下降 9.9%", numbers), false);
  const masked = A.maskPii("1-WW-FR-008-0003-000 联系电话 13800138000 邮箱 a@b.com");
  assert.ok(!masked.includes("1-WW-FR-008-0003-000"));
  assert.ok(masked.includes("[管码]"));
  assert.ok(!masked.includes("13800138000"));
  assert.ok(!masked.includes("a@b.com"));
});

/* ---------------- 报告数值审计（页面 AI 报告用） ---------------- */

check("auditNumericClaims 标出本地证据里没有的数值", () => {
  const evidence = "当前壁厚 7.12mm，年化减薄 0.15mm/年，基准触阈 2029 年，置信度 82%";
  const report = "该管段当前壁厚 7.12mm，年减薄 0.15mm，预计 2029 年触阈；另有 2 根相邻管壁厚 5.55mm。";
  const audit = A.auditNumericClaims(report, evidence);
  assert.equal(audit.ok, false);
  assert.equal(audit.skipped, false);
  assert.equal(audit.count, 1, "只应标出带单位的 5.55mm");
  assert.deepEqual(Array.from(audit.examples), ["5.55"]);
});

check("auditNumericClaims 忽略建议里的纯数量，但抓住带单位的数值", () => {
  const evidence = "当前壁厚 7.12mm，年化减薄 0.15mm/年，置信度 82%";
  const report = "建议扩大排查至相邻 12 根管，其中硬度 168HB 的管段优先复测。";
  const audit = A.auditNumericClaims(report, evidence);
  assert.equal(audit.count, 1, "168HB 应被标出，12 根不应算数据主张");
  assert.deepEqual(Array.from(audit.examples), ["168"]);
});

check("auditNumericClaims 对全部可追溯的报告放行", () => {
  const evidence = "当前壁厚 7.12mm，年化减薄 0.15mm/年，基准触阈 2029 年，置信度 82%";
  const report = "该管段当前壁厚 7.12mm，年化减薄 0.15mm，预计 2029 年触阈，置信度 82%。";
  const audit = A.auditNumericClaims(report, evidence);
  assert.equal(audit.ok, true);
  assert.equal(audit.count, 0);
});

check("auditNumericClaims 支持百分比换算，证据过少时跳过", () => {
  const audit = A.auditNumericClaims("置信度 8.2%", "0.082");
  assert.equal(audit.skipped, true, "证据里数字太少时不应误报");

  const percent = A.auditNumericClaims("置信度 8.2%", "置信度 0.082，样本 12 条，跨度 3 年");
  assert.equal(percent.skipped, false);
  assert.equal(percent.ok, true, "0.082 与 8.2% 应视为同一数值");
});

check("auditNumericClaims 不把年份当成编造", () => {
  const audit = A.auditNumericClaims("2024 年至 2026 年壁厚由 7.4 降至 7.0", "壁厚 7.4mm 与 7.0mm，样本 8 条");
  assert.equal(audit.count, 0, "年份不应被标记");
});

/* ---------------- 与 core 的意图联动 ---------------- */

check("core.parseIntent 把分析问法路由到 data.analyze", () => {
  ["近两年壁厚趋势", "各受热面事件数排行", "壁厚分布", "壁厚和硬度相关性", "壁厚异常记录", "数据整体画像"].forEach((text) => {
    const intent = Core.parseIntent(text, { role: "viewer" });
    assert.equal(intent.intent, "analyze", text);
    assert.equal(intent.tool, "data.analyze", text);
    assert.equal(intent.needsConfirm, false, "分析是只读操作，不需要二次确认");
    assert.equal(intent.needsFile, false, "分析不需要附件");
  });
  assert.equal(Core.requiredRole("data.analyze"), "viewer", "只读角色也应能看分析");
});

check("core.parseIntent 既有口径不回归", () => {
  assert.equal(Core.parseIntent("现在数据质量怎么样", {}).intent, "stats");
  assert.equal(Core.parseIntent("一共有多少条事件", {}).intent, "stats");
  assert.equal(Core.parseIntent("导出壁厚趋势分析", {}).intent, "export", "明确说导出时仍应走导出");
  assert.equal(Core.parseIntent("查询 1 号炉高过的测厚记录", {}).intent, "query");
  assert.equal(Core.parseIntent("把数据导入系统", {}).intent, "import");
  assert.equal(Core.parseIntent("撤销上次导入", {}).intent, "undo");
  assert.equal(Core.parseIntent("把 1-WW-FR-008-0003-000 的厚度改成 6.8", {}).intent, "edit");
});

/* ---------------- run ---------------- */

for (const [name, fn] of checks) {
  fn();
  console.log("ok - " + name);
}
console.log("ok - assistant analysis: " + checks.length + "/" + checks.length + " checks passed");
