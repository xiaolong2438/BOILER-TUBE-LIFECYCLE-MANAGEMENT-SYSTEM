import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const htmlPath = "C:/Users/DLX/Desktop/\u7089\u7ba1\u5168\u751f\u547d\u5468\u671f\u7ba1\u7406\u7cfb\u7edf.html";
const html = readFileSync(htmlPath, "utf8");

assert.match(html, /data-view="tube-analysis"/, "unified tube analysis nav should exist");
assert.match(html, /id="view-tube-analysis"/, "unified tube analysis section should exist");
assert.doesNotMatch(html, /data-view="search"/, "old precision search nav/view should be removed");
assert.doesNotMatch(html, /data-view="lifecycle"/, "old lifecycle nav/view should be removed");
assert.doesNotMatch(html, /data-view="ai"/, "old AI analysis nav/view should be removed");
assert.match(html, /id="lcSelect"/, "unified module should retain lifecycle selector");
assert.match(html, /id="lcCustomCode"/, "unified module should use lifecycle custom-code input as the only manual tube query");
assert.doesNotMatch(html, /id="searchInput"/, "duplicate precision-search input should be removed");
assert.doesNotMatch(html, />🔍 全局查询</, "duplicate global query button should be removed");
assert.doesNotMatch(html, /<div class="card">\s*<div class="card-title">管码\/部件查询<\/div>/, "duplicate tube query card should be removed");
assert.match(html, /id="ai-custom-target"/, "unified module should retain AI target input");
assert.match(html, /id="ai-llm-report"/, "unified module should retain AI LLM report");
assert.match(html, /querySelector\('\[data-view="tube-analysis"\]'\)/, "bridges should route to the unified module");

console.log("ok - precision search, lifecycle tracking, and AI analysis are one module");
