import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const js = readFileSync(resolve(here, "../assets/app/app-v7.9.js"), "utf8");
const html = readFileSync(resolve(here, "../炉管全生命周期管理系统.html"), "utf8");
const css = readFileSync(resolve(here, "../assets/app/app-v8.0.css"), "utf8");

// 事件记录：数据录入表格每行必须提供“编辑”入口，保存走统一校验并留痕。
assert.match(js, /function openEditEvent\(ts\)/);
assert.match(js, /function saveEventEdit\(ts\)/);
assert.match(js, /onclick="openEditEvent\(\$\{Number\(r\.ts\)\}\)"/);
assert.match(js, /mlog\('update', \{ record: target, field: key, before, after: next, source: 'manual' \}\);/);

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
assert.match(html, /onchange="renderDataManagerTables\(\)"/);
assert.match(js, /function renderDataManagerTables\(\) \{ renderDMTable\(\); renderReplacementTable\(\); \}/);
assert.match(js, /renderDMTable\(\); renderReplacementTable\(\); updateLifecycleDropdown\(\);/);
assert.match(js, /function closeDataEditModal\(\)/);

// 权限口径与 AI 助手一致：viewer 只读，界面隐藏编辑/删除操作。
assert.match(js, /function canManageTubeData\(\)/);
assert.match(js, /return getAssistantRole\(\) !== 'viewer';/);
assert.match(js, /: '<span style="font-size:11px; color:var\(--text-dim\);">只读<\/span>';/);

// 弹窗样式（浅色/深色主题共用的变量化面板）。
assert.match(css, /\.data-edit-modal \{/);
assert.match(css, /\.data-edit-panel \{/);

console.log("ok - datamgr records (events + replacements) support per-row edit/delete with viewer gating and audit logging");
