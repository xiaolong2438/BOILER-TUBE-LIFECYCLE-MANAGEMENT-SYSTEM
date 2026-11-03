import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/**
 * 图表可读性回归：悬停提示、数值标注、异常高亮、数据表与图形同源。
 * 只测纯字符串输出，不碰 DOM。
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const sandbox = { console };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
["assistant-core-v1.js", "assistant-analysis-v1.js"].forEach((file) => {
  vm.runInContext(readFileSync(resolve(root, "assets/app", file), "utf8"), sandbox);
});
const A = sandbox.BTAssistantAnalysis;

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log("ok - " + name);
}

check("导出 chartTable 与 chartTableMarkup", () => {
  assert.equal(typeof A.chartTable, "function");
  assert.equal(typeof A.chartTableMarkup, "function");
});

const lineChart = {
  type: "line",
  categories: ["2023", "2024", "2025"],
  series: [{ name: "平均壁厚", values: [7.4, 7.1, 6.85] }],
  yLabel: "mm"
};

check("折线图：单系列铺面积渐变并标注末点数值", () => {
  const svg = A.chartSvg(lineChart);
  assert.ok(svg.includes("<linearGradient"), "缺少面积渐变定义");
  assert.ok(svg.includes("stop-opacity=\"0.26\""), "渐变起点透明度缺失");
  assert.ok(svg.includes(">6.85</text>"), "末点数值未标注");
});

check("折线图：每个数据点都有类别+数值的悬停提示", () => {
  const svg = A.chartSvg(lineChart);
  assert.ok(svg.includes("<title>2024 · 平均壁厚 · 7.1 mm</title>"), svg.slice(0, 400));
});

check("折线图：多系列不铺面积，避免互相遮盖", () => {
  const svg = A.chartSvg({
    type: "line",
    categories: ["2024", "2025"],
    series: [
      { name: "管A", values: [7.1, 6.9] },
      { name: "管B", values: [7.3, 7.0] }
    ]
  });
  assert.ok(!svg.includes("<linearGradient"), "多系列不应铺面积");
  assert.ok(svg.includes("<title>2025 · 管B · 7"), "多系列仍要有悬停提示");
});

check("渐变定义 id 逐图唯一，同页多图不会串定义", () => {
  const first = A.chartSvg(lineChart);
  const second = A.chartSvg(lineChart);
  const idOf = (svg) => (svg.match(/<linearGradient id="([^"]+)"/) || [])[1];
  assert.ok(idOf(first) && idOf(second));
  assert.notEqual(idOf(first), idOf(second));
});

check("柱状图：柱顶标数值且柱体带悬停提示", () => {
  const svg = A.chartSvg({
    type: "bar",
    categories: ["水冷壁", "高过"],
    series: [{ name: "事件数", values: [12, 5] }],
    yLabel: "条"
  });
  assert.ok(svg.includes(">12</text>"), "柱顶数值缺失");
  assert.ok(svg.includes("<title>水冷壁 · 事件数 · 12 条</title>"));
});

check("横条排行：提示带占比", () => {
  const svg = A.chartSvg({
    type: "hbar",
    categories: ["水冷壁", "高过"],
    series: [{ name: "事件数", values: [15, 5] }]
  });
  assert.ok(svg.includes("占 75%"), svg);
});

check("环图：扇区带占比提示，合计行闭合", () => {
  const chart = { type: "donut", categories: ["测厚", "金相"], series: [{ name: "事件", values: [30, 10] }] };
  const svg = A.chartSvg(chart);
  assert.ok(svg.includes("<title>测厚 · 30 · 占 75%</title>"), svg);
  const table = A.chartTable(chart);
  assert.deepEqual(Array.from(table.rows[table.rows.length - 1]), ["合计", "40", "100.0%"]);
});

check("环图：类别超容量时聚合为「其余 N 类」而不是静默丢弃", () => {
  const chart = {
    type: "donut",
    categories: Array.from({ length: 30 }, (_, i) => "类别" + (i + 1)),
    series: [{ name: "事件", values: Array.from({ length: 30 }, () => 2) }]
  };
  const svg = A.chartSvg(chart, { height: 120 });
  assert.ok(svg.includes("其余 "), "缺少聚合行");
  const legendLines = svg.split("\n").filter((line) => line.includes("<text"));
  assert.ok(!legendLines.some((line) => line.includes("类别30 · ")), "图例不应逐个列出全部类别");
  assert.ok(legendLines.length <= 8, "图例行数超出容量");
});

check("散点图：标签进提示，低于阈值的点高亮并配危险色带", () => {
  const svg = A.chartSvg({
    type: "scatter",
    points: [
      { x: 1, y: 7.2, label: "1G-SLB-WB-F000-R001-Q" },
      { x: 2, y: 4.1, label: "1G-GGRQ-GQ-L002-F004-W", flagged: true, flagNote: "减薄率 25.0%" }
    ],
    xLabel: "记录序号",
    yLabel: "壁厚(mm)",
    threshold: { value: 5, label: "IQR 下界 5.00" }
  });
  assert.ok(svg.includes("1G-SLB-WB-F000-R001-Q"), "正常点缺少管段标签");
  assert.ok(svg.includes("减薄率 25.0%"), "异常原因未进提示");
  assert.ok(svg.includes("r=\"4.6\""), "异常点未放大");
  assert.ok(svg.includes("opacity=\"0.06\""), "阈值危险色带缺失");
});

check("X 轴长标签截断并保留完整名称于提示", () => {
  const long = "1G-DPGRQ-GQ-L001-L002-F007-Q";
  const svg = A.chartSvg({
    type: "bar",
    categories: Array.from({ length: 8 }, () => long),
    series: [{ name: "事件数", values: [3, 4, 5, 6, 7, 8, 9, 10] }]
  });
  assert.ok(svg.includes("…<title>"), "长标签未截断");
  assert.ok(svg.includes("<title>" + long + "</title>"), "完整名称未保留在提示里");
});

check("chartTable 折线多系列：列头跟随系列名，缺失值给占位", () => {
  const table = A.chartTable({
    type: "line",
    categories: ["2024", "2025"],
    series: [
      { name: "管A", values: [7.1, null] },
      { name: "管B", values: [7.3, 7.0] }
    ]
  });
  assert.deepEqual(Array.from(table.columns), ["类别", "管A", "管B"]);
  assert.deepEqual(Array.from(table.rows[1]), ["2025", "—", "7"]);
});

check("chartTable 散点：判定列区分异常原因", () => {
  const table = A.chartTable({
    type: "scatter",
    points: [{ x: 1, y: 4.2, label: "管A", flagged: true, flagNote: "低于整体下界 5.00mm" }],
    xLabel: "序号",
    yLabel: "壁厚(mm)"
  });
  assert.deepEqual(Array.from(table.columns), ["标签", "序号", "壁厚(mm)", "判定"]);
  assert.equal(table.rows[0][3], "低于整体下界 5.00mm");
});

check("chartTableMarkup：折叠结构、行数与 HTML 转义", () => {
  const markup = A.chartTableMarkup({
    type: "bar",
    categories: ["<b>水冷壁</b>", "高过", "省煤器"],
    series: [{ name: "事件数", values: [1, 2, 3] }]
  }, { maxRows: 2 });
  assert.ok(markup.startsWith("<details class=\"chart-data\">"));
  assert.ok(markup.includes("3 行"), "未显示总行数");
  assert.ok(markup.includes("&lt;b&gt;水冷壁&lt;/b&gt;"), "类别未转义");
  assert.ok(!markup.includes("<b>水冷壁</b>"));
  assert.ok(markup.includes("仅列前 2 行"), "缺少截断说明");
});

check("chartTableMarkup：无数据时不输出空折叠块", () => {
  assert.equal(A.chartTableMarkup({ type: "bar", categories: [], series: [] }), "");
  assert.equal(A.chartTableMarkup(null), "");
});

check("异常识别：散点带管段编码与异常原因，数据表同源", () => {
  const events = [
    { code: "1G-SLB-WB-F000-R001-Q", boiler: "1", date: "2024-01-10", type: "测厚", thickness: 7.4, spec: "Φ63.5×7.5" },
    { code: "1G-SLB-WB-F000-R002-Q", boiler: "1", date: "2024-01-11", type: "测厚", thickness: 7.3, spec: "Φ63.5×7.5" },
    { code: "1G-SLB-WB-F000-R003-Q", boiler: "1", date: "2024-01-12", type: "测厚", thickness: 7.35, spec: "Φ63.5×7.5" },
    { code: "1G-GGRQ-GQ-L002-F004-W", boiler: "1", date: "2024-01-13", type: "测厚", thickness: 3.2, spec: "Φ63.5×7.5" }
  ];
  const spec = A.parseAnalysis("壁厚异常记录", {});
  const result = A.runAnalysis(spec, { events, replacements: [] });
  assert.ok(result.ok, "异常识别未产出结果");
  const flagged = result.chart.points.filter((p) => p.flagged);
  assert.ok(flagged.length >= 1, "未标出异常点");
  assert.ok(flagged[0].label.includes("1G-GGRQ-GQ-L002-F004-W"), "异常点缺管段编码");
  assert.ok(flagged[0].flagNote.length > 0, "异常点缺原因");
  const table = A.chartTable(result.chart);
  assert.equal(table.rows.length, result.chart.points.length, "数据表与图形点数不一致");
});

console.log("\n" + passed + " 项图表可读性检查通过");
