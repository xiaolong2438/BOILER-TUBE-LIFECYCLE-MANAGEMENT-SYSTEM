import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const htmlPath = "C:/Users/DLX/Desktop/\u7089\u7ba1\u5168\u751f\u547d\u5468\u671f\u7ba1\u7406\u7cfb\u7edf.html";
const html = readFileSync(htmlPath, "utf8");

const componentStart = html.indexOf("function loadComponentLifecycle(");
const componentEnd = html.indexOf("\ndocument.querySelectorAll('.comp-tab')", componentStart);
assert.ok(componentStart > -1 && componentEnd > componentStart, "component lifecycle block should be found");
const componentBlock = html.slice(componentStart, componentEnd);

assert.match(componentBlock, /const rule = materialRuleForRow\(item\)/, "component material rows should reuse material-library warning rules");
assert.match(componentBlock, /item\.categoryNo/, "component material rows should use material-library category numbers");
assert.match(componentBlock, /item\.sampleName \|\| item\.position/, "component material rows should use material-library sample names");
assert.match(componentBlock, /item\.diameter/, "component material rows should use material-library diameter");
assert.match(componentBlock, /item\.wallThickness/, "component material rows should use material-library wall thickness");
assert.match(componentBlock, /rule\.straight/, "component material rows should show straight warning value");
assert.match(componentBlock, /rule\.bend/, "component material rows should show bend outside warning value");
assert.doesNotMatch(componentBlock, /materialRows\.slice\(0,\s*6\)/, "component material table should not truncate material-library rows");
assert.match(componentBlock, /<th>受热面<\/th><th>序号<\/th><th>名称<\/th><th>外径\(mm\)<\/th><th>取用壁厚\(mm\)<\/th><th>材料<\/th>/, "component material table should include heat surface and mirror material-library leading columns");
assert.match(componentBlock, /<th>直管理论计算厚度\(mm\)<\/th><th>弯管外侧理论计算厚度\(mm\)<\/th>/, "component material table should split straight and bend warning columns");
assert.doesNotMatch(componentBlock, /<th>管壁预警值\(mm\)<\/th>/, "component material table should not use stale merged warning column");
assert.doesNotMatch(componentBlock, /formatWallThicknessWarning\(item\)/, "component material rows should not use merged warning formatter");

console.log("ok - component lifecycle material table mirrors material library fields and warning rules");
