import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// v6.7 起样式与脚本拆分为外部文件，改为合并检索 HTML + JS + CSS
const readFileOrEmpty = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const html = [
  readFileOrEmpty(resolve(here, "../\u7089\u7ba1\u5168\u751f\u547d\u5468\u671f\u7ba1\u7406\u7cfb\u7edf.html")),
  readFileOrEmpty(resolve(here, "../assets/app/app-v7.9.js")),
  readFileOrEmpty(resolve(here, "../assets/app/app-v8.0.css"))
].join("\n");

const loadStart = html.indexOf("function loadComponentLifecycle(sys, label");
const loadEnd = html.indexOf("\nfunction renderMaterialLibrary", loadStart);
assert.ok(loadStart > -1 && loadEnd > loadStart, "loadComponentLifecycle block should be found");
const loadBlock = html.slice(loadStart, loadEnd);

assert.match(loadBlock, /surfaceFilter/, "component records should accept a heat-surface filter");
assert.match(loadBlock, /componentSurfaceFilter/, "component records should render heat-surface filter controls");
assert.ok(
  loadBlock.indexOf('componentBoilerFilter') < loadBlock.indexOf('componentSurfaceFilter'),
  "boiler filter should render above the heat-surface filter"
);
assert.match(loadBlock, /全部受热面/, "component records should include an all-heat-surfaces option");
assert.match(loadBlock, /水冷壁|低过|高过|低再|高再/, "component records should include named heat-surface options");
assert.match(loadBlock, /getCodeSystem\(e\.code\).*selectedSys|selectedSys.*getCodeSystem\(e\.code\)/s, "local events should be filtered by selected heat surface");
assert.match(loadBlock, /loadComponentLifecycle\('[^']*',\s*'[^']*',\s*'[^']*',/, "filter buttons should preserve boiler filter while switching heat surfaces");

console.log("ok - component repair records support heat-surface filtering");
