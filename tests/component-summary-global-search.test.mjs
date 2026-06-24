import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const htmlPath = "C:/Users/DLX/Desktop/\u7089\u7ba1\u5168\u751f\u547d\u5468\u671f\u7ba1\u7406\u7cfb\u7edf.html";
const html = readFileSync(htmlPath, "utf8");

const openStart = html.indexOf("function openComponentLifecycle(sys, label)");
const openEnd = html.indexOf("\nfunction loadComponentLifecycle", openStart);
assert.ok(openStart > -1 && openEnd > openStart, "openComponentLifecycle block should be found");
const openBlock = html.slice(openStart, openEnd);

const loadStart = html.indexOf("function loadComponentLifecycle(sys, label");
const loadEnd = html.indexOf("\nfunction renderMaterialLibrary", loadStart);
assert.ok(loadStart > -1 && loadEnd > loadStart, "loadComponentLifecycle block should be found");
const loadBlock = html.slice(loadStart, loadEnd);

assert.match(openBlock, /lcCustomCode'\)\.value\s*=\s*''/, "opening a component summary should reset the retained lifecycle query input");
assert.match(openBlock, /searchResult'\)\.innerHTML[\s\S]*全部受热面/, "opening a component summary should tell users global search still covers all heat surfaces");
assert.match(loadBlock, /componentGlobalSearchInput/, "component summary should include an in-context global tube search input");
assert.match(loadBlock, /openTubeProfile\(document\.getElementById\('componentGlobalSearchInput'\)\.value/, "component summary global search should open the unified tube profile");
assert.match(loadBlock, /全受热面管段查询|全部受热面/, "component summary should label the search as global across heat surfaces");

console.log("ok - component summary keeps global tube search available");
