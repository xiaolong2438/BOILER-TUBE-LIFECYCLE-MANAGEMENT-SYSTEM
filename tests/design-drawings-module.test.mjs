import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, "../炉管全生命周期管理系统.html"), "utf8");
const js = readFileSync(resolve(here, "../assets/app/app-v7.9.js"), "utf8");

// 导航与视图
assert.match(html, /data-view="drawings"/, "设计图纸导航入口应存在");
assert.match(html, /id="view-drawings"/, "设计图纸视图应存在");
assert.match(html, /id="drawingFileInput"[^>]*accept="image\/png,image\/jpeg,image\/webp,application\/pdf"/, "上传控件应接受图片与PDF");
assert.match(html, /id="drawingsGrid"/, "图纸卡片网格应存在");
assert.match(html, /id="drawingSysFilter"/, "受热面筛选应存在");

// 模块函数与存储
assert.match(js, /const DESIGN_DRAWINGS_KEY = 'boiler_design_drawings';/);
assert.match(js, /queueCloudStorageSave\(DESIGN_DRAWINGS_KEY, designDrawings\)/, "图纸元数据应随KV云端同步");
assert.match(js, /const DRAWING_MAX_BYTES = 4 \* 1024 \* 1024;/, "单文件4MB上限");
assert.match(js, /function handleDrawingUpload\(event\)/);
assert.match(js, /function renderDesignDrawings\(\)/);
assert.match(js, /function openDrawingViewer\(id\)/);
assert.match(js, /function closeDrawingViewer\(\)/);
assert.match(js, /function deleteDesignDrawing\(id\)/);
assert.match(js, /function renameDesignDrawing\(id\)/);
assert.match(js, /function openDrawingsForSys\(sys\)/);
assert.match(js, /function designDrawingsForSys\(sys\)/);
assert.match(js, /function canManageTubeData\(\)/, "上传/删除前有权限校验的函数可用");
assert.match(js, /renderDesignDrawings\(\);/, "INIT 应渲染图纸模块");

// 只读权限拦截
const uploadFn = js.slice(js.indexOf("function handleDrawingUpload"), js.indexOf("function deleteDesignDrawing"));
assert.match(uploadFn, /if \(!canManageTubeData\(\)\) \{ showToast\('当前权限为只读，不能上传图纸。', 'warn'\); event\.target\.value = ''; return; \}/);
const deleteFn = js.slice(js.indexOf("function deleteDesignDrawing"), js.indexOf("function drawingSurfaceLabel"));
assert.match(deleteFn, /当前权限为只读，不能删除图纸。/);
assert.match(deleteFn, /if \(!confirm\(/, "删除图纸需确认");

// 查看器：图片/PDF 分支与 Blob 释放
const viewerFn = js.slice(js.indexOf("function openDrawingViewer"), js.indexOf("function closeDrawingViewer"));
assert.match(viewerFn, /drawing\.fileType === 'pdf' \? 'application\/pdf' : mime/);
assert.match(viewerFn, /<iframe src="' \+ drawingViewerUrl/, "PDF 用内嵌框架查看");
assert.match(viewerFn, /URL\.revokeObjectURL\(drawingViewerUrl\)/, "关闭时释放 Blob URL");

// 数据页/生成器联动
assert.match(html, /onclick="openDrawingsForSys\(document\.getElementById\('f-system'\)\?\.value \|\| ''\)"/, "编码生成器应有一键打开对应受热面图纸");
assert.match(html, /onclick="openDrawingsForSys\(''\)"/, "数据录入页应有一键打开图纸");

// 标题注册
assert.match(js, /drawings: '受热面设计图纸'/);

// 行为验证：按受热面过滤（通用图纸始终显示）
const ctx = vm.createContext({});
vm.runInContext("var designDrawings = [{id:'a', sys:'GGRQ'},{id:'b', sys:''},{id:'c', sys:'GZRQ'}];", ctx);
vm.runInContext(js.slice(js.indexOf("function designDrawingsForSys"), js.indexOf("function fmtDrawingSize")), ctx);
assert.deepEqual(
  Array.from(vm.runInContext("designDrawingsForSys('GGRQ').map(d => d.id)", ctx)),
  ["a", "b"],
  "指定受热面过滤应包含通用图纸"
);
assert.equal(vm.runInContext("designDrawingsForSys('').length", ctx), 3, "全部视图显示所有图纸");

console.log("ok - design drawings module: nav/view/upload/viewer/delete/linkage with permission gating and KV sync");
