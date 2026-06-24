import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const htmlPath = "C:/Users/DLX/Desktop/炉管全生命周期管理系统.html";
const html = readFileSync(htmlPath, "utf8");
const materialRenderStart = html.indexOf("function renderMaterialLibrary(key) {");
const materialRenderEnd = html.indexOf("\nfunction renderComponent", materialRenderStart);
assert.ok(materialRenderStart > -1 && materialRenderEnd > materialRenderStart, "material render block should be found");
const materialRenderBlock = html.slice(materialRenderStart, materialRenderEnd);

const checks = [
  ["component library is renamed to heat-surface material library", () => {
    assert.match(html, />▣ 受热面材料库</);
    assert.match(html, /<h2>受热面材料库<\/h2>/);
    assert.match(html, /MATERIAL DATABASE/);
  }],
  ["material library data model includes stock-maintenance fields", () => {
    assert.match(html, /const MATERIAL_LIBRARY_KEY\s*=\s*['"]boiler_material_library['"]/);
    assert.match(html, /const MATERIAL_LIBRARY\s*=/);
    assert.match(html, /inUseQty/);
    assert.match(html, /stockQty/);
    assert.match(html, /reserveLocation/);
    assert.match(html, /totalLengthM/);
    assert.match(html, /diameter/);
    assert.match(html, /wallThickness/);
    assert.match(html, /shape/);
  }],
  ["default material records include supplied heat-surface specs", () => {
    assert.match(html, /component:'省煤器'[\s\S]*position:'1 省煤器蛇形管'[\s\S]*spec:'Φ51×6'[\s\S]*material:'SA-210C'/);
    assert.match(html, /component:'顶棚过热器'[\s\S]*position:'7 顶棚管'[\s\S]*spec:'Φ48\.5×6'[\s\S]*material:'15CrMoG'/);
    assert.match(html, /component:'低温过热器'[\s\S]*position:'12 低过管子（二）'[\s\S]*spec:'Φ60×8\.5'[\s\S]*material:'15CrMoG'/);
    assert.match(html, /component:'高温过热器'[\s\S]*position:'31 高过管子（八）'[\s\S]*spec:'Φ54×9'[\s\S]*material:'12Cr1MoVG'/);
    assert.match(html, /component:'高温再热器'[\s\S]*position:'33 高温再热器管（二）'[\s\S]*spec:'Φ51×4'[\s\S]*material:'12Cr1MoVG'/);
  }],
  ["all-screen superheater stock row supports spare quantity and total meters", () => {
    assert.match(html, /component:'全大屏过热器'[\s\S]*position:'15 全大屏管子（一）'[\s\S]*spec:\s*'Φ51×7'[\s\S]*material:\s*'12Cr1MoVG'[\s\S]*inUseQty:\s*''[\s\S]*stockQty:\s*''[\s\S]*totalLengthM:\s*''/);
    assert.match(html, /component:'全大屏过热器'[\s\S]*position:'16 全大屏管子（二）'[\s\S]*spec:\s*'Φ51×7'[\s\S]*material:\s*'SA-213T91'[\s\S]*inUseQty:\s*''[\s\S]*stockQty:\s*''[\s\S]*totalLengthM:\s*''/);
    assert.doesNotMatch(html, /全大屏过热器[\s\S]*inUseQty:\s*'6大屏×4小屏×14根'/);
    assert.doesNotMatch(html, /全大屏过热器[\s\S]*inUseQty:\s*'336根'/);
    assert.match(html, /库存根数/);
    assert.match(html, /总长度\(m\)/);
  }],
  ["material CSV maintenance functions are wired", () => {
    assert.match(html, /function downloadMaterialCSVTemplate\s*\(/);
    assert.match(html, /function exportMaterialCSV\s*\(/);
    assert.match(html, /function importMaterialCSV\s*\(/);
    assert.match(html, /function parseCSVLine\s*\(/);
    assert.match(html, /onchange="importMaterialCSV\(event\)"/);
    assert.match(html, /下载材料库 CSV 模板/);
    assert.match(html, /导出材料库/);
    assert.match(html, /导入材料库 CSV/);
  }],
  ["material library renders table columns expected by maintenance users", () => {
    assert.match(html, /function renderMaterialLibrary\s*\(/);
    assert.match(html, /MATERIAL_COLUMNS\s*=\s*\['部件名称','系统代码','分段\/位置','结构形式','规格型号','管径','壁厚','材质','库存根数','库存总长度\(m\)','预留位置','备注'\]/);
    assert.match(html, /<th>序号<\/th><th>名称<\/th><th>外径\(mm\)<\/th><th>取用壁厚\(mm\)<\/th><th>材料<\/th><th>设计压力\(MPa\)<\/th><th>设计温度\(℃\)<\/th><th>直管理论计算厚度\(mm\)<\/th><th>弯管半径\(mm\)<\/th><th>弯管外侧理论计算厚度\(mm\)<\/th><th>规格型号<\/th><th>库存根数<\/th><th>库存总长度\(m\)<\/th><th>备注<\/th>/);
  }],
  ["wall warning values are exact straight and bend values, not ranges", () => {
    assert.match(html, /const rule = materialRuleForRow\(item\)/);
    assert.match(html, /<td>\$\{escapeHTML\(materialCell\(rule\.straight\)\)\}<\/td>\s*<td>\$\{escapeHTML\(materialCell\(rule\.bendRadius\)\)\}<\/td>\s*<td>\$\{escapeHTML\(materialCell\(rule\.bend\)\)\}<\/td>/);
    assert.match(html, /<th>直管理论计算厚度\(mm\)<\/th><th>弯管半径\(mm\)<\/th><th>弯管外侧理论计算厚度\(mm\)<\/th>/);
    assert.doesNotMatch(materialRenderBlock, /<th>管壁预警值\(mm\)<\/th>/);
    assert.doesNotMatch(materialRenderBlock, /\$\{escapeHTML\(formatWallThicknessWarning\(item\)\)\}/);
    assert.doesNotMatch(materialRenderBlock, /values\.length === 1 \? values\[0\] : `\$\{values\[0\]\}~\$\{values\[values\.length - 1\]\}`/);
  }],
];

for (const [name, check] of checks) {
  check();
  console.log(`ok - ${name}`);
}
