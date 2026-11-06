import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const js = readFileSync(resolve(here, "../assets/app/app-v7.9.js"), "utf8");
const html = readFileSync(resolve(here, "../炉管全生命周期管理系统.html"), "utf8");
const css = readFileSync(resolve(here, "../assets/app/app-v8.0.css"), "utf8");
const xlsxExport = readFileSync(resolve(here, "../assets/app/xlsx-export-v1.js"), "utf8");

// 事件记录：数据录入表格每行必须提供“编辑”入口，保存走统一校验并留痕。
assert.match(js, /function openEditEvent\(ts\)/);
assert.match(js, /function saveEventEdit\(ts\)/);
assert.match(js, /onclick="openEditEvent\(\$\{ts\}\)"/);
assert.match(js, /mlog\('update', \{ record: target, field: key, before, after: next, source: 'manual' \}\);/);

// 管段编码可点击直达管段档案（管段分析）：事件表与更换登记表统一走 dmCodeCell。
assert.match(js, /function dmCodeCell\(code, tone\)/);
assert.match(js, /onclick="openTubeProfile\('\$\{value\}'\)/, "编码按钮调用 openTubeProfile 打开管段档案");
assert.match(js, /title="打开管段档案 \$\{value\}"/, "悬停提示打开管段档案");
assert.match(js, /\$\{dmCodeCell\(r\.code\)\}/, "事件表编码列用 dmCodeCell");
assert.match(js, /\$\{dmCodeCell\(r\.oldCode\)\}\$\{dmCodeCell\(r\.newCode, 'var\(--ok\)'\)\}/, "更换登记表旧/新编码都用 dmCodeCell");

// 批量数据管理：受热面多选筛选/编码查询与批量范围叠加，作用于两张记录表与 CSV/XLSX 导出。
assert.match(html, /id="dm-sys-trigger"[^>]*onclick="toggleDmSysPanel\(event\)"/, "受热面多选下拉触发器存在");
assert.match(html, /id="dm-sys-trigger-text">全部受热面</, "默认展示全部受热面");
assert.match(html, /id="dm-sys-options"/, "受热面多选选项容器存在");
assert.match(js, /function getDmSysFilter\(\)/);
assert.match(js, /#dm-sys-options input\[type="checkbox"\]:checked/, "多选值来自勾选的复选框");
assert.match(js, /function setDmSysFilter\(values\)/);
assert.match(js, /localStorage\.setItem\('boiler_dm_sys_filter', JSON\.stringify\(list\)\)/, "受热面多选以数组记忆在本地");
assert.match(js, /function readDmSysSaved\(\)/);
assert.match(js, /return \[raw\];/, "旧版单选字符串自动迁移为数组");
assert.match(js, /function dmSysSetAll\(all\)/, "提供全选/清空");
assert.match(js, /已选 \$\{selected\.length\} 项受热面/, "多选时触发器显示已选数量");
assert.match(js, /sysFilter && sysFilter\.length && !codes\.some\(c => sysFilter\.includes\(getCodeSystem\(c\)\)\)/, "任一勾选受热面命中即保留该行");
assert.match(js, /CODE_SYSTEMS\.map\(item =>\s*'<label class="dm-multi-option">/, "复选框选项来自受热面系统表");
assert.match(js, /function dmRowInScope\(boilerOf, codes, boilerFilter, sysFilter, codeQuery\)/);
assert.match(html, /id="dm-code-search"[^>]*oninput="renderDataManagerTables\(\)"/, "编码查询输入框存在并联动刷新两张记录表");
assert.match(js, /function getDmCodeQuery\(\)/);
assert.match(js, /codeQuery && !codes\.some\(c => String\(c \|\| ''\)\.toUpperCase\(\)\.includes\(codeQuery\)\)/, "编码查询按包含匹配，事件旧码/新码任一命中");
assert.match(js, /dmRowInScope\(eventBoiler\(r\), \[r\.code\], filter, sys, codeQuery\)/, "事件表应用受热面与编码查询过滤");
assert.match(js, /dmRowInScope\(replacementBoiler\(r\), \[r\.oldCode, r\.newCode\], filter, sys, codeQuery\)/, "更换表应用受热面与编码查询过滤（旧码或新码命中）");
assert.match(js, /dmRowInScope\(eventBoiler\(e\), \[e\.code\], filter, sys, codeQuery\)/, "CSV导出应用受热面与编码查询过滤");
assert.match(xlsxExport, /dmRowInScope\(eventBoiler\(item\), \[item\.code\], filter, sys, codeQuery\)/, "XLSX导出应用受热面与编码查询过滤");
assert.match(xlsxExport, /\(sys\.length \? `_\$\{sys\.join\('\+'\)\}` : ''\)/, "XLSX文件名带多选受热面范围");

// 事件类型查询：下拉选项=内置类型+台账已出现类型，与批量范围/受热面/编码查询叠加。
assert.match(html, /<label for="dm-type-search">事件类型<\/label>/, "筛选行提供事件类型查询");
assert.match(html, /id="dm-type-search"[^>]*onchange="setDmTypeFilter\(this\.value\)"/, "事件类型下拉切换即刷新表格");
assert.match(html, /<option value="">全部类型<\/option>/, "默认全部类型");
assert.match(js, /function getDmTypeFilter\(\)/);
assert.match(js, /function dmTypeOptions\(\)/);
assert.match(js, /\[\.\.\.DATA_EDIT_TYPES, \.\.\.userDB\.events\.map\(e => String\(e\.type \|\| ''\)\.trim\(\)\), saved\]/, "类型选项来自内置类型与台账已有类型");
assert.match(js, /localStorage\.setItem\('boiler_dm_type_filter', value \|\| ''\)/, "事件类型选择记忆在本地");
assert.match(js, /select\.dataset\.signature !== signature/, "类型选项变化时才重建下拉，保留当前选择");
assert.match(js, /function dmTypeInScope\(type\)/);
assert.match(js, /dmTypeInScope\(r\.type\) && dmRowInScope\(eventBoiler\(r\), \[r\.code\], filter, sys, codeQuery\)/, "事件表应用事件类型筛选");
assert.match(js, /!typeFilter && dmRowInScope\(replacementBoiler\(r\)/, "开启事件类型筛选时更换登记不参与展示");
assert.match(js, /dmTypeInScope\(e\.type\) && dmRowInScope\(eventBoiler\(e\), \[e\.code\], filter, sys, codeQuery\)/, "CSV 导出应用事件类型筛选");
assert.match(xlsxExport, /dmTypeInScope\(item\.type\) && dmRowInScope\(eventBoiler\(item\), \[item\.code\], filter, sys, codeQuery\)/, "XLSX 导出应用事件类型筛选");
assert.match(css, /\.dm-filter-row \.dm-filter-type \{/, "事件类型下拉与筛选行统一布局");
assert.match(html, /导出筛选范围数据 \(CSV\)/, "导出按钮文案与筛选语义一致");
assert.match(html, /导出筛选范围 Excel/);
assert.match(css, /\.dm-filter-row \{/, "筛选行使用统一对齐布局");
assert.match(css, /\.dm-filter-row \.form-group select,\s*\.dm-filter-row \.form-group input \{\s*height: 50px;/, "受热面下拉与编码查询输入框和分段按钮等高对齐");

// 批量选择：表头全选框 + 行复选框 + 全选/反选/批量删除（viewer 只读不可见）。
assert.match(html, /id="dm-select-all" aria-label="全选" onchange="dmToggleAll\(this\.checked\)"/);
assert.match(html, /id="dm-batch-bar"/);
assert.match(js, /function dmSetSelected\(ts, checked\)/);
assert.match(js, /function dmToggleAll\(checked\)/);
assert.match(js, /function dmInvertSelection\(\)/);
assert.match(js, /function dmClearSelection\(\)/);
assert.match(js, /function dmDeleteSelected\(\)/);
assert.match(js, /dmDeleteSelected/, "工具条挂批量删除按钮");
assert.match(js, /确定删除所选 \$\{dmSelectedTs\.size\} 条检测记录/, "批量删除需确认");
assert.match(js, /removed\.forEach\(e => mlog\('delete', \{ record: e, source: 'manual' \}\)\);/, "批量删除逐条留痕");
assert.match(js, /class="dm-row-check" data-ts="\$\{ts\}"/, "行复选框带ts标识");
assert.match(js, /allBox\.indeterminate = selectedCount > 0 && selectedCount < all\.length/, "全选框支持半选态");

// 记录列表：按炉管检查日期倒序，滚动容器内分页，每页 10/50/100/200 条。
assert.match(html, /id="dm-page-size"/, "每页条数选择器存在");
for (const size of [10, 50, 100, 200]) {
  assert.match(html, new RegExp(`<option value="${size}"${size === 50 ? ' selected' : ''}>${size} 条</option>`), `每页 ${size} 条选项`);
}
assert.match(html, /id="dm-page-prev"/, "上一页按钮存在");
assert.match(html, /id="dm-page-next"/, "下一页按钮存在");
assert.match(html, /class="table-wrap dm-table-scroll"/, "记录表使用滚动容器");
assert.match(js, /function dmCompareByInspectionDateDesc\(a, b\)/, "按检查日期倒序比较函数存在");
assert.match(js, /\.sort\(dmCompareByInspectionDateDesc\)/, "事件表使用检查日期倒序排列");
assert.match(js, /function setDmPageSize\(value\)/, "页大小切换函数存在");
assert.match(js, /function dmGoPage\(delta\)/, "翻页函数存在");
assert.match(js, /const pageRows = all\.slice\(pageStart, pageStart \+ dmPageSize\)/, "事件表按页切片渲染");
assert.match(css, /\.dm-table-scroll \{ max-height: 62vh; overflow-y: auto; \}/, "滚动容器固定高度");
const sortCtx = vm.createContext({ Date });
vm.runInContext(js.slice(js.indexOf("function dmInspectionTimestamp"), js.indexOf("function setDmPageSize")), sortCtx);
const sortedDates = JSON.parse(vm.runInContext(
  "JSON.stringify([{date:'2022-10',ts:1},{date:'2024-01-15',ts:2},{date:'2023-06',ts:3},{date:'2024-01-15',ts:4}].sort(dmCompareByInspectionDateDesc).map(r => r.date + '#' + r.ts))",
  sortCtx
));
assert.deepEqual(sortedDates, ["2024-01-15#4", "2024-01-15#2", "2023-06#3", "2022-10#1"], "检查日期倒序，同日期按录入时间倒序");

// 编辑校验与新增口径一致：编码/日期/结论必填；炉号可选（留空按编码推断），两侧都有值时校验前缀。
assert.match(js, /if\(!code \|\| !date \|\| !desc\) \{ showToast\('管段编码、日期和详细数据\/结论不能为空', 'warn'\); return; \}/);
assert.match(js, /const codeBoiler = getBoilerFromCode\(code\);\s*\r?\n\s*if\(!boiler && codeBoiler\) boiler = codeBoiler;/);
assert.match(js, /if\(boiler && codeBoiler && codeBoiler !== boiler\) \{ showToast\('所选机组与管段编码开头不一致，请核对。', 'warn'\); return; \}/);
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
const cloudBoot = js.slice(js.indexOf('async function bootstrapCloudStorage'), js.indexOf('async function loadAuthSession'));
assert.match(cloudBoot, /if\(localRaw !== remoteRaw\)\s*\{[\s\S]*?changed = true;/, '相同云端台账不标记变更');
assert.match(cloudBoot, /if\(localMatRaw !== remoteMatRaw\)\s*\{[\s\S]*?changed = true;/, '相同云端材料不标记变更');
assert.match(cloudBoot, /if\(changed\) invalidateTubeViews\(\);/, '云同步有变更时统一失效：活动页立即刷新，隐藏页返回时刷新（行为见 view-lifecycle.test.mjs）');
assert.doesNotMatch(cloudBoot, /renderDataManagerTables\(\);|updateLifecycleDropdown\(\);/, '云同步不再强制重绘隐藏页面');
const lifecycle = js.slice(js.indexOf('const viewLifecycle ='), js.indexOf('function activeViewId'));
assert.match(lifecycle, /datamgr:\s*\{\s*refresh:\s*renderDataManagerTables\s*\}/, '数据管理表接入视图刷新');
assert.match(lifecycle, /'tube-analysis':\s*\{\s*refresh:\s*refreshTubeAnalysisView\s*\}/, '管段分析接入专用刷新入口');
const tubeRefresh = js.slice(js.indexOf('function refreshTubeAnalysisView'), js.indexOf('function activeViewId'));
assert.match(tubeRefresh, /updateLifecycleDropdown\(\);\s*populateAIThicknessTargets\(\);/, '管段分析刷新更新两组下拉');
assert.match(js, /function closeDataEditModal\(\)/);

// 权限口径与 AI 助手一致：viewer 只读，界面隐藏编辑/删除操作。
assert.match(js, /function canManageTubeData\(\)/);
assert.match(js, /return getAssistantRole\(\) !== 'viewer';/);
assert.match(js, /: '<span style="font-size:11px; color:var\(--text-dim\);">只读<\/span>';/);

// 弹窗样式（浅色/深色主题共用的变量化面板）。
assert.match(css, /\.data-edit-modal \{/);
assert.match(css, /\.data-edit-panel \{/);

console.log("ok - datamgr records (events + replacements) support per-row edit/delete with viewer gating and audit logging");
