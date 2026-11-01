import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const js = readFileSync(resolve(here, "../assets/app/app-v7.9.js"), "utf8");
const html = readFileSync(resolve(here, "../炉管全生命周期管理系统.html"), "utf8");
const css = readFileSync(resolve(here, "../assets/app/app-v8.0.css"), "utf8");
const xlsxExport = readFileSync(resolve(here, "../assets/app/xlsx-export-v1.js"), "utf8");

// 事件记录：数据录入表格每行必须提供“编辑”入口，保存走统一校验并留痕。
assert.match(js, /function openEditEvent\(ts\)/);
assert.match(js, /function saveEventEdit\(ts\)/);
assert.match(js, /onclick="openEditEvent\(\$\{Number\(r\.ts\)\}\)"/);
assert.match(js, /mlog\('update', \{ record: target, field: key, before, after: next, source: 'manual' \}\);/);

// 管段编码可点击直达管段档案（管段分析）：事件表与更换登记表统一走 dmCodeCell。
assert.match(js, /function dmCodeCell\(code, tone\)/);
assert.match(js, /onclick="openTubeProfile\('\$\{value\}'\)/, "编码按钮调用 openTubeProfile 打开管段档案");
assert.match(js, /title="打开管段档案 \$\{value\}"/, "悬停提示打开管段档案");
assert.match(js, /\$\{dmCodeCell\(r\.code\)\}/, "事件表编码列用 dmCodeCell");
assert.match(js, /\$\{dmCodeCell\(r\.oldCode\)\}\$\{dmCodeCell\(r\.newCode, 'var\(--ok\)'\)\}/, "更换登记表旧/新编码都用 dmCodeCell");

// 批量数据管理：受热面筛选与批量范围叠加，作用于两张记录表与 CSV/XLSX 导出。
assert.match(html, /id="dm-sys-filter" onchange="setDmSysFilter\(this\.value\)"/, "受热面筛选下拉存在");
assert.match(html, /<option value="">全部受热面<\/option>/);
assert.match(js, /function getDmSysFilter\(\)/);
assert.match(js, /function setDmSysFilter\(value\)/);
assert.match(js, /localStorage\.setItem\('boiler_dm_sys_filter', value \|\| ''\)/, "受热面筛选记忆在本地");
assert.match(js, /function dmRowInScope\(boilerOf, codes, boilerFilter, sysFilter\)/);
assert.match(js, /sysSelect\.innerHTML = '<option value="">全部受热面<\/option>' \+ CODE_SYSTEMS\.map/, "选项来自受热面系统表");
assert.match(js, /\$\{escapeHTML\(item\.sys\)\} · \$\{escapeHTML\(item\.label\)\}/);
assert.match(js, /dmRowInScope\(eventBoiler\(r\), \[r\.code\], filter, sys\)/, "事件表应用受热面过滤");
assert.match(js, /dmRowInScope\(replacementBoiler\(r\), \[r\.oldCode, r\.newCode\], filter, sys\)/, "更换表应用受热面过滤（旧码或新码命中）");
assert.match(js, /dmRowInScope\(eventBoiler\(e\), \[e\.code\], filter, sys\)/, "CSV导出应用受热面过滤");
assert.match(xlsxExport, /dmRowInScope\(eventBoiler\(item\), \[item\.code\], filter, sys\)/, "XLSX导出应用受热面过滤");
assert.match(xlsxExport, /\(filter === 'all' \? '全厂' : `\$\{filter\}号机组`\) \+ \(sys \? `_\$\{sys\}` : ''\)/, "XLSX文件名带受热面范围");
assert.match(html, /导出筛选范围数据 \(CSV\)/, "导出按钮文案与筛选语义一致");
assert.match(html, /导出筛选范围 Excel/);

// 编辑校验与新增口径一致：机组/编码/日期/结论必填，编码与机组前缀联动校验。
assert.match(js, /if\(!boiler \|\| !code \|\| !date \|\| !desc\) \{ showToast\('机组、管段编码、日期和详细数据\/结论不能为空', 'warn'\); return; \}/);
assert.match(js, /if\(getBoilerFromCode\(code\) && getBoilerFromCode\(code\) !== boiler\) \{ showToast\('所选机组与管段编码开头不一致，请核对。', 'warn'\); return; \}/);
assert.match(js, /厚度必须是 0\.1 ~ 100 之间的数字（mm），或留空/);
assert.match(js, /硬度必须是 1 ~ 600 之间的数字（HB），或留空/);

// 更换记录：必须提供列表 + 单条编辑/删除；删除时联动清理自动生成的报废/投运事件。
assert.match(js, /function renderReplacementTable\(\)/);
assert.match(js, /function openEditReplacement\(ts\)/);
assert.match(js, /function saveReplacementEdit\(ts\)/);
assert.match(js, /function deleteReplacement\(ts\)/);
assert.match(js, /function isReplacementAutoEvent\(event, replacement\)/);
assert.match(js, /event\.type === '报废更换' && event\.code === replacement\.oldCode/);
assert.match(js, /event\.type === '安装投运' && event\.code === replacement\.newCode/);
assert.match(html, /id="dm-rep-table-body"/);

// 弹窗容器与筛选联动：机组筛选同时刷新事件表与更换表。
assert.match(html, /id="dataEditModal"/);
assert.match(html, /class="unit-switch" id="dm-batch-boiler"/, "批量范围用主页同款分段按钮组");
assert.match(html, /onclick="setDmBoilerFilter\('all'\)"/);
assert.match(js, /function setDmBoilerFilter\(value\)/);
assert.match(js, /localStorage\.setItem\('boiler_dm_boiler_filter', value \|\| 'all'\)/, "批量范围选择记忆在本地");
assert.match(js, /boilerHost\.querySelectorAll\('button'\)\.forEach\(btn => btn\.classList\.toggle\('active', btn\.dataset\.boiler === savedBoiler\)\)/);
assert.match(js, /function renderDataManagerTables\(\) \{[\s\S]*?renderDMTable\(\); renderReplacementTable\(\);\s*\}/);
assert.match(js, /renderDataManagerTables\(\);\s*\r?\n\s*updateLifecycleDropdown\(\);/);
assert.match(js, /function closeDataEditModal\(\)/);

// 权限口径与 AI 助手一致：viewer 只读，界面隐藏编辑/删除操作。
assert.match(js, /function canManageTubeData\(\)/);
assert.match(js, /return getAssistantRole\(\) !== 'viewer';/);
assert.match(js, /: '<span style="font-size:11px; color:var\(--text-dim\);">只读<\/span>';/);

// 弹窗样式（浅色/深色主题共用的变量化面板）。
assert.match(css, /\.data-edit-modal \{/);
assert.match(css, /\.data-edit-panel \{/);

console.log("ok - datamgr records (events + replacements) support per-row edit/delete with viewer gating and audit logging");
