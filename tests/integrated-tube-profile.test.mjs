import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const htmlPath = "C:/Users/DLX/Desktop/\u7089\u7ba1\u5168\u751f\u547d\u5468\u671f\u7ba1\u7406\u7cfb\u7edf.html";
const html = readFileSync(htmlPath, "utf8");

const lifecycleStart = html.indexOf("function loadLifecycle(customCode) {");
const lifecycleEnd = html.indexOf("\nfunction renderMatrix()", lifecycleStart);
assert.ok(lifecycleStart > -1 && lifecycleEnd > lifecycleStart, "loadLifecycle block should be found");
const lifecycleBlock = html.slice(lifecycleStart, lifecycleEnd);

const searchStart = html.indexOf("function doSearch() {");
const searchEnd = html.indexOf("\nfunction jumpLifecycle", searchStart);
assert.ok(searchStart > -1 && searchEnd > searchStart, "doSearch block should be found");
const searchBlock = html.slice(searchStart, searchEnd);

assert.match(html, /function getTubeProfileData\s*\(/, "shared tube profile data resolver should exist");
assert.match(html, /function buildTubeProfileHTML\s*\(/, "shared tube profile renderer should exist");
assert.match(html, /function openTubeProfile\s*\(/, "search-to-profile bridge should exist");
assert.match(searchBlock, /buildTubeProfileHTML\(q,\s*\{\s*context:\s*'search'\s*\}\)/, "exact search should render the integrated profile inline");
assert.match(searchBlock, /打开一体化档案/, "search match cards should expose the integrated profile action");
assert.match(lifecycleBlock, /buildTubeProfileHTML\(code,\s*\{\s*context:\s*'lifecycle'\s*\}\)/, "lifecycle should reuse the integrated profile renderer");
assert.match(html, /进入AI趋势分析/, "integrated profile should retain the AI trend entry");
assert.match(html, /全寿命事件时间线/, "integrated profile should retain the lifecycle timeline");

console.log("ok - integrated tube profile links search, lifecycle, and AI analysis");
