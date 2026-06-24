import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const htmlPath = "C:/Users/DLX/Desktop/炉管全生命周期管理系统.html";
const html = readFileSync(htmlPath, "utf8");

const hshEightSpecSummary = "Φ51×9 12Cr1MoVG、Φ51×8 SA-213T91、Φ51×8 SA-213TP304H、Φ51×11 SA-213T22、Φ54×7.5 SA-213TP347H、Φ54×9 SA-213T91、Φ54×11 SA-213T22、Φ54×9 12Cr1MoVG";
const hshMaterialRows = [...html.matchAll(/component:'高温过热器'[\s\S]*?position:'(?:24|25|26|27|28|29|30|31) [^']+'[\s\S]*?spec:'([^']+)'[\s\S]*?material:'([^']+)'/g)]
  .map(match => `${match[1]} ${match[2]}`);

assert.deepEqual(hshMaterialRows, hshEightSpecSummary.split("、"), "HSH material library should keep eight spec/material rows");
assert.match(html, new RegExp(`hsh:\\s*\\{[\\s\\S]*?spec:\\s*'${hshEightSpecSummary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`), "HSH component summary should display all eight spec/material combinations");
assert.match(html, new RegExp(`name:'高温过热器'[\\s\\S]*?sys:'HSH'[\\s\\S]*?spec:'${hshEightSpecSummary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`), "HSH full-ledger summary should display all eight spec/material combinations");
assert.match(html, new RegExp(`gg:\\s*\\{[\\s\\S]*?spec:'${hshEightSpecSummary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`), "HSH boiler schematic should display all eight spec/material combinations");
assert.doesNotMatch(html, /hsh:\s*\{[\s\S]*?spec:\s*'Φ51×8\/9\/11、Φ54×7\.5\/9\/11'/, "HSH component summary should not collapse eight combinations into six size groups");
assert.doesNotMatch(html, /gg:\s*\{[\s\S]*?spec:'Φ51\/Φ54 T91\/TP304H'/, "HSH schematic should not use the short two-diameter summary");

console.log("ok - HSH summaries display all eight high-superheater spec/material combinations");
