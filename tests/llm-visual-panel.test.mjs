import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, "..", p), "utf8");
const html = read("炉管全生命周期管理系统.html");
const app = read("assets/app/app-v7.9.js");
const css = read("assets/app/app-v8.0.css");

// 总览深度分析面板挂载本地可视化区块，复用助手分析引擎（图 → 大模型解读同一数据）。
assert.match(html, /class="llm-viz" id="llm-viz"/, "面板应有可视化分析区块");
assert.match(html, /id="llm-viz-type" onchange="runLLMVisualAnalysis\(\)"/, "类型切换应触发分析");
assert.match(html, /id="llm-viz-view"/, "应有渲染容器");

assert.match(app, /function runLLMVisualAnalysis\(\)/, "渲染函数应存在");
assert.match(app, /window\.BTAssistantAnalysis/, "必须复用助手分析引擎而不是另写一套");
assert.match(app, /collectAssistantSnapshot\(\)/, "数据口径与助手快照一致");
assert.match(app, /lastLLMVisualInsights/, "洞察应暂存供大模型引用");
assert.match(app, /总览可视化分析结论（本地规则计算，可作为解读依据）/, "洞察应注入 buildLLMContext");
assert.match(app, /if\(typeof runLLMVisualAnalysis === 'function'\) runLLMVisualAnalysis\(\);/, "数据变更时应自动刷新");
assert.match(app, /^runLLMVisualAnalysis\(\);$/m, "初始化时应渲染一次");

// 引擎契约：分系列与预警线（由 assistant-analysis 测试覆盖细节），这里只钉面板接线。
assert.match(css, /\.llm-viz \{/, "区块样式应存在");
assert.match(css, /\.llm-viz-chart svg \{[^}]*width: 100%;[^}]*height: auto;/, "图表应等比自适应宽度");

console.log("ok - dashboard deep-analysis panel embeds the local visual analysis block");
