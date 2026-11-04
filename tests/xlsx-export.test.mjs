import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '../炉管全生命周期管理系统.html'), 'utf8');
const js = readFileSync(resolve(here, '../assets/app/xlsx-export-v1.js'), 'utf8');
const lazy = readFileSync(resolve(here, '../assets/app/lazy-v1.js'), 'utf8');

/* SheetJS 不再随首屏加载：CDN 地址在懒加载清单里，页面里不允许再出现静态引用 */
assert.match(lazy, /xlsx-0\.20\.3\/package\/dist\/xlsx\.full\.min\.js/);
assert.doesNotMatch(html, /xlsx-0\.20\.3\/package\/dist\/xlsx\.full\.min\.js/, 'SheetJS 不应随首屏加载');
assert.match(js, /BTLazy\.ensure\('xlsx'\)/, '首次导出必须按需加载 SheetJS');
assert.match(html, /assets\/app\/xlsx-export-v1\.js/);
assert.match(html, /exportMaterialLibraryToXLSX\(\)/);
assert.match(html, /exportLifecycleDataToXLSX\(\)/);
assert.match(html, /exportInventoryToXLSX\('all'\)/);
assert.match(html, /exportMaintenanceOverdueXLSX\(\)/);
assert.match(html, /exportMaintenancePlanToXLSX\(\)/);
assert.match(html, /exportLLMReportXLSX\(\)/);

assert.match(js, /getMaterialLibrary\(\)/);
assert.match(js, /getGeneratedTubeLedgerRows\(normalized\)/);
assert.match(js, /buildMaintenanceOverdueRows\(year, boiler\)/);
assert.match(js, /buildMaintenanceOutagePlan\(year, boiler\)/);
assert.match(js, /XLSX\.writeFile\(workbook/);
assert.match(js, /\^\[=\+\\-@\]/, 'spreadsheet formula injection guard must be present');

console.log('ok - XLSX exports are wired to real project data and guarded');
