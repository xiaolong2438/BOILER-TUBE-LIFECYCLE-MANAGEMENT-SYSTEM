import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const htmlPath = "C:/Users/DLX/Desktop/\u7089\u7ba1\u5168\u751f\u547d\u5468\u671f\u7ba1\u7406\u7cfb\u7edf.html";
const html = readFileSync(htmlPath, "utf8");

assert.match(html, /function collectAICompositeSignals\s*\(/, "composite evidence collector should exist");
assert.match(html, /function buildCompositeAIReport\s*\(/, "composite report builder should exist");
assert.match(html, /hardnessHistory|硬度历史/, "AI logic should include hardness evidence");
assert.match(html, /metallography|金相/, "AI logic should include metallography evidence");
assert.match(html, /compositeRisk|综合风险/, "AI logic should produce a composite risk judgment");
assert.match(html, /综合判断|综合分析|证据/, "AI report should surface a composite judgment section");
assert.match(html, /硬度|金相|组织|裂纹|蠕变|脱碳/, "report or prompt should mention microstructure-related evidence");
assert.match(html, /await runDeepAIAnalysisFromTrend\(data\)/, "AI analysis should call the configured LLM after local evidence assembly");
assert.match(html, /大模型|LLM|深度分析/, "AI workflow should make the large-model step visible");
assert.match(html, /id="ai-llm-report"/, "AI page should have its own LLM result panel");
assert.match(html, /callLLMChatCompletions\(buildTrendAnalysisPrompt\(data\)/, "AI analysis should call the configured model directly from the AI module");
assert.match(html, /总览.*模型配置|模型接口配置|复用/, "AI LLM panel should explain it reuses the overview model configuration");

console.log("ok - composite AI analysis wiring exists");
