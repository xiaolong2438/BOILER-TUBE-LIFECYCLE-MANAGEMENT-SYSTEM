import { readFileSync, readdirSync } from "node:fs";
import { strict as assert } from "node:assert";

const desktopPath = "C:/Users/DLX/Desktop";
const htmlPath = readdirSync(desktopPath)
  .filter((name) => name.endsWith(".html"))
  .map((name) => `${desktopPath}/${name}`)
  .find((path) => readFileSync(path, "utf8").includes("BOILER-TUBE LIFECYCLE SYSTEM"));

assert.ok(htmlPath, "Could not find the boiler lifecycle HTML file on the desktop");
const html = readFileSync(htmlPath, "utf8");

const checks = [
  ["dashboard contains standard LLM interface panel", () => {
    assert.match(html, /id="llm-provider"/);
    assert.match(html, /id="llm-api-key"/);
    assert.match(html, /<select id="llm-model"/);
    assert.match(html, /id="llm-prompt"/);
    assert.match(html, /id="llm-result"/);
  }],
  ["LLM config is persisted to browser localStorage", () => {
    assert.match(html, /const LLM_CONFIG_KEY\s*=\s*['"]boiler_llm_config['"]/);
    assert.match(html, /localStorage\.setItem\(LLM_CONFIG_KEY/);
    assert.match(html, /localStorage\.getItem\(LLM_CONFIG_KEY/);
  }],
  ["OpenAI-compatible chat completions request is built", () => {
    assert.match(html, /function buildLLMMessages\s*\(/);
    assert.match(html, /\/chat\/completions/);
    assert.match(html, /Authorization['"]?\s*:\s*`Bearer \$\{config\.apiKey\}`/);
    assert.match(html, /messages:\s*buildLLMMessages/);
  }],
  ["analysis execution and error rendering are wired", () => {
    assert.match(html, /async function runLLMAnalysis\s*\(/);
    assert.match(html, /async function testLLMConnection\s*\(/);
    assert.match(html, /function renderLLMResult\s*\(/);
    assert.match(html, /function setLLMStatus\s*\(/);
    assert.match(html, /response\.ok/);
  }],
  ["homepage initializes saved model configuration", () => {
    const initBlock = html.slice(html.indexOf("// ========== INIT =========="));
    assert.match(initBlock, /loadLLMConfigToForm\(\)/);
  }],
  ["models are discovered from API URL and key", () => {
    assert.match(html, /async function discoverLLMModels\s*\(/);
    assert.match(html, /\/models/);
    assert.match(html, /function renderLLMModelOptions\s*\(/);
    assert.match(html, /识别可用模型/);
  }],
  ["network errors render actionable diagnostics for model discovery and chat", () => {
    assert.match(html, /function formatLLMError\s*\(/);
    assert.match(html, /Failed to fetch|NetworkError|Load failed/);
    assert.match(html, /CORS|跨域/);
  }],
  ["LLM analysis renders a structured report with raw fallback", () => {
    assert.match(html, /id="llm-report-view"/);
    assert.match(html, /id="llm-raw-view"/);
    assert.match(html, /function renderLLMReport\s*\(/);
    assert.match(html, /function parseLLMReport\s*\(/);
    assert.match(html, /function setLLMViewMode\s*\(/);
    assert.match(html, /风险排序|关键结论|检修建议|依据与不确定性/);
  }],
  ["dashboard warnings are actual data-driven warnings", () => {
    assert.match(html, /id="dashboard-warning-list"/);
    assert.match(html, /function collectDashboardWarnings\s*\(/);
    assert.match(html, /function renderDashboardWarnings\s*\(/);
    assert.match(html, /userDB\.events/);
    assert.doesNotMatch(html, /样例警报/);
  }],
  ["warning trend analysis calls the LLM instead of the mock AI page", () => {
    assert.match(html, /function runWarningTrendAnalysis\s*\(/);
    assert.match(html, /runLLMAnalysis\s*\(/);
    assert.match(html, /预警趋势分析/);
    assert.doesNotMatch(html, /查看模拟AI趋势分析/);
  }],
  ["retired or replaced tubes are excluded from current dashboard warnings", () => {
    assert.match(html, /function collectRetiredTubeCodes\s*\(/);
    assert.match(html, /function isRetiredTubeCode\s*\(/);
    assert.match(html, /oldCode/);
    assert.match(html, /报废更换|更换为/);
    assert.match(html, /!isRetiredTubeCode\(code, retiredCodes\)/);
    assert.match(html, /!isRetiredTubeCode\(event\.code, retiredCodes\)/);
  }],
];

for (const [name, check] of checks) {
  check();
  console.log(`ok - ${name}`);
}
