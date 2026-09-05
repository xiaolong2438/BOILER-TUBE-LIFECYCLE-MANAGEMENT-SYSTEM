import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const js = readFileSync(resolve(here, "../assets/app/app-v7.9.js"), "utf8");
const html = readFileSync(resolve(here, "../炉管全生命周期管理系统.html"), "utf8");

assert.doesNotMatch(js, /临时保护阈值\s*1mm/);
assert.match(js, /threshold:\s*null/);
assert.match(js, /matched:Boolean\(selected && valid\)/);
assert.match(js, /if\(!thresholdInfo\.rule \|\| !Number\.isFinite\(threshold\)\)/);
assert.match(js, /rul:\s*null[\s\S]*rulText:/);
assert.match(js, /renderAIChart\(data\);\s*renderHardnessChart\(data\);/);
assert.match(js, /function renderHardnessChart\(data\)/);
assert.match(js, /hardnessHistory\.length >= 3/);
assert.match(js, /hardnessForecast/);
assert.match(js, /robustRate \* 0\.5 \+ recentRate \* 0\.3 \+ averageRate \* 0\.2/);
assert.match(js, /acceleratedRate = Math\.max\(conservativeRate \* 1\.35/);
assert.match(js, /assessPredictionQuality\(sorted, outliers\.length\)/);
assert.match(html, /id="hardnessChart"/);
assert.match(html, /id="hardnessTrendLabel"/);
assert.match(html, /id="hardnessOneYear"/);
assert.match(html, /id="hardnessThreeYear"/);
assert.match(html, /id="hardnessConfidence"/);

console.log("ok - prediction safety, scenarios, hardness trend, and dual-chart wiring");
