import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const htmlPath = "C:/Users/DLX/Desktop/炉管全生命周期管理系统.html";
const html = readFileSync(htmlPath, "utf8");

const expectedBySys = new Map([
  ["ECO", "Φ51×6 SA-210C、Φ60×9 SA-210C、Φ159×18 20G"],
  ["WW", "Φ63.5×7.5 SA-210C、Φ159×18 20G"],
  ["RSH", "Φ159×18 20G、Φ48.5×6 15CrMoG"],
  ["WSH", "Φ51×6 12Cr1MoVG、Φ51×7 12Cr1MoVG、Φ63.5×12 12Cr1MoVG"],
  ["LSH", "Φ57×6 15CrMoG、Φ60×8.5 15CrMoG、Φ57×6 12Cr1MoVG、Φ57×8 12Cr1MoVG"],
  ["PSH", "Φ51×7 12Cr1MoVG、Φ51×7 SA-213T91"],
  ["ISH", "Φ54×9 SA-213TP347H、Φ54×8.5 SA-213T91、Φ54×8.5 12Cr1MoVG、Φ54×8.5 SA-213TP347H、Φ60×8 SA-213T91、Φ60×9 SA-213TP347H、Φ60×8 12Cr1MoVG"],
  ["HSH", "Φ51×9 12Cr1MoVG、Φ51×8 SA-213T91、Φ51×8 SA-213TP304H、Φ51×11 SA-213T22、Φ54×7.5 SA-213TP347H、Φ54×9 SA-213T91、Φ54×11 SA-213T22、Φ54×9 12Cr1MoVG"],
  ["HRH", "Φ60×4 12Cr1MoVG、Φ51×4 12Cr1MoVG、Φ60×4 SA-213T91、Φ60×4 SA-213TP304H、Φ60×6 SA-213T91、Φ60×5 SA-213T22、Φ51×5 SA-213T22、Φ60×5 12Cr1MoVG"],
  ["LRH", "Φ63.5×4 SA-210C、Φ63.5×4 15CrMoG、Φ63.5×4 12Cr1MoVG、Φ63.5×6 SA-210C、Φ63.5×6 15CrMoG"],
]);

for (const [sys, summary] of expectedBySys) {
  const escaped = summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(html, new RegExp(`sys: '${sys}'[\\s\\S]*?spec: '${escaped}'[\\s\\S]*?mat: '按材料库分项'`), `${sys} component summary should align to material library`);
  assert.match(html, new RegExp(`sys:'${sys}'[\\s\\S]*?spec:'${escaped}'[\\s\\S]*?mat:'按材料库分项'`), `${sys} matrix summary should align to material library`);
}

for (const [sys, summary] of [...expectedBySys].filter(([sys]) => ["PSH", "ISH", "HSH", "HRH", "LSH", "LRH", "ECO"].includes(sys))) {
  const escaped = summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(html, new RegExp(`sys:'${sys}', spec:'${escaped}'`), `${sys} schematic summary should align to material library`);
}

console.log("ok - handwritten material summaries align to material library spec/material rows");
