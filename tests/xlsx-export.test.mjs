import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '../炉管全生命周期管理系统.html'), 'utf8');
const js = readFileSync(resolve(here, '../assets/app/xlsx-export-v1.js'), 'utf8');

assert.match(html, /xlsx-0\.20\.3\/package\/dist\/xlsx\.full\.min\.js/);
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
