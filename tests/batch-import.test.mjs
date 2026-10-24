import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const js = readFileSync(resolve(here, "../assets/app/app-v7.9.js"), "utf8");
const html = readFileSync(resolve(here, "../炉管全生命周期管理系统.html"), "utf8");

// CSV 与 Excel 必须共用同一条 importLifecycleRows 入库管线（防重复、机组校验行为一致）。
assert.match(js, /function importLifecycleRows\(rawRows, options = \{\}\)/);
assert.match(js, /const result = importLifecycleRows\(grid, \{ batchFilter: getBatchBoilerFilter\(\), fileName: file\.name \}\);/);
assert.match(js, /function importXLSX\(event\)/);
assert.match(js, /XLSX\.read\(new Uint8Array\(e\.target\.result\), \{ type: 'array', cellDates: true \}\)/);
assert.match(js, /function normalizeImportDate\(value\)/);
assert.match(js, /function downloadXLSXTemplate\(\)/);

// 表头必须包含 数据分类/管段编码/日期 才继续，防止整表误导入。
assert.match(js, /未识别到表头：缺少/);

// 页面提供 Excel 模板下载与导入入口。
assert.match(html, /downloadXLSXTemplate\(\)/);
assert.match(html, /onchange="importXLSX\(event\)"/);
assert.match(html, /accept="\.xlsx,\.xls"/);

console.log("ok - batch import shares one pipeline for CSV and Excel with header validation");
