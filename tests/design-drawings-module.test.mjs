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

// 高过12回路材质分段基准：展示容器 + JS数据 + 查询函数
assert.match(html, /id="ggrqLoopBaseline"/, "分段基准表容器应存在");
assert.match(html, /高温过热器材质分段基准（12回路）/, "分段基准卡片标题应存在");
assert.match(js, /const GGRQ_LOOP_BASELINE = \[/);
assert.match(js, /const HPGRQ_LOOP_BASELINE = \[/, "屏式过热器13回路分段基准应存在");
assert.match(js, /function ggrqLoopForTube\(/);
assert.match(js, /function ggrqBottomBendAttrs\(/);
assert.match(js, /function renderGGRQLoopBaseline\(\)/);
assert.match(js, /const DPGRQ_LOOP_BASELINE = \[/, "全大屏14回路分段基准应存在");
assert.match(html, /id="dzrqLoopBaseline"/, "低再分段基准表容器应存在");
assert.match(html, /低温再热器材质分段基准（6回路）/, "低再分段基准卡片标题应存在");
assert.match(js, /const DZRQ_LOOP_BASELINE = \[/, "低再6回路分段基准应存在");
assert.match(js, /function renderDZRQLoopBaseline\(\)/, "低再分段基准渲染函数应存在");
assert.match(html, /id="dgrqLoopBaseline"/, "低过分段基准表容器应存在");
assert.match(html, /低温过热器材质分段基准（5回路）/, "低过分段基准卡片标题应存在");
assert.match(js, /const DGRQ_LOOP_BASELINE = \[/, "低过5回路分段基准应存在");
assert.match(js, /function renderDGRQLoopBaseline\(\)/, "低过分段基准渲染函数应存在");
assert.match(js, /function renderDZRQLoopBaseline\(\)/, "低再分段基准渲染函数应存在");

// 行为验证：回路号即入口段F00k/出口段B00k编号（JSON 序列化取出，避免跨 realm 原型差异）
const baselineCtx = vm.createContext({});
vm.runInContext(js.slice(js.indexOf("const GGRQ_LOOP_BASELINE"), js.indexOf("function renderGGRQLoopBaseline")), baselineCtx);
const baseline = JSON.parse(vm.runInContext("JSON.stringify(GGRQ_LOOP_BASELINE)", baselineCtx));
assert.equal(baseline.length, 12, "应包含全部12个回路");
for (const l of baseline) {
  assert.equal(l.loop, baseline.indexOf(l) + 1, "回路号连续1..12");
  assert.ok(l.frontSegs.length >= 1 && l.rearSegs.length >= 2, "每条腿至少1段，出口段至少2段");
}
assert.deepEqual(
  JSON.parse(vm.runInContext("JSON.stringify([ggrqBottomBendAttrs(5), ggrqBottomBendAttrs(8), ggrqBottomBendAttrs(12), ggrqBottomBendAttrs(1)])", baselineCtx)),
  [["Φ51×8", "SA-213T91"], ["Φ51×9", "12Cr1MoVG"], ["Φ51×8", "SA-213T91"], ["Φ54×7.5", "SA-213TP347H"]],
  "底弯件=入口段末段：回路5-7/12=Φ51×8 T91、8-11=Φ51×9 12Cr1MoVG、回路1=Φ54×7.5 TP347H"
);
const dzrqBaseline = JSON.parse(vm.runInContext("JSON.stringify(DZRQ_LOOP_BASELINE)", baselineCtx));
assert.equal(dzrqBaseline.length, 6, "低再应包含6个回路");
assert.deepEqual(dzrqBaseline.map(l => l.tube), ['D001', 'D002', 'D003', 'D004', 'D005', 'D006'], "管组按自下而上连续编号");
for (const l of dzrqBaseline) {
  assert.equal(l.loop, dzrqBaseline.indexOf(l) + 1, "低再回路号连续1..6");
  assert.deepEqual(l.segs.map(s => s[0]), ['1~3组', '4组', '5组', '垂直段'], "分段顺序沿蒸汽流程");
  assert.deepEqual(l.segs[3], ['垂直段', 'Φ63.5×4', '12Cr1MoVG'], "垂直段统一Φ63.5×4 12Cr1MoVG");
}
for (const l of [dzrqBaseline[0], dzrqBaseline[5]]) {
  assert.equal(l.outer, true, `${l.tube} 应为外圈/支撑耳板管`);
  assert.deepEqual(l.segs.map(s => s[1]), ['Φ63.5×6', 'Φ63.5×6', 'Φ63.5×6', 'Φ63.5×4'], "外圈水平段Φ63.5×6、垂直段Φ63.5×4");
  assert.deepEqual(l.segs.map(s => s[2]), ['SA-210C', 'SA-210C/15CrMoG', '15CrMoG', '12Cr1MoVG'], "外圈材质分段");
}
for (const l of dzrqBaseline.slice(1, 5)) {
  assert.equal(l.outer, false, `${l.tube} 应为内圈管`);
  assert.deepEqual(l.segs.map(s => s[1]), ['Φ63.5×4', 'Φ63.5×4', 'Φ63.5×4', 'Φ63.5×4'], "内圈全段Φ63.5×4");
}
const dgrqBaseline = JSON.parse(vm.runInContext("JSON.stringify(DGRQ_LOOP_BASELINE)", baselineCtx));
assert.equal(dgrqBaseline.length, 5, "低过应包含5个回路");
assert.deepEqual(dgrqBaseline.map(l => l.tube), ['D001', 'D002', 'D003', 'D004', 'D005'], "低过管组按自下而上连续编号");
for (const l of dgrqBaseline) {
  assert.equal(l.loop, dgrqBaseline.indexOf(l) + 1, "低过回路号连续1..5");
  assert.deepEqual(l.segs, [
    ['入口段', 'Φ60×8.5 15CrMoG/Φ57×6 15CrMoG'],
    ['1~3组', 'Φ57×6 15CrMoG'],
    ['4组', 'Φ57×6 12Cr1MoVG'],
    ['垂直段', 'Φ57×8 12Cr1MoVG']
  ], `${l.tube} 分段链`);
}

// 与清洗脚本的 GGRQ_LOOP_SEGMENTS 逐回路逐段一致（单一事实源，双端同步）
const py = readFileSync(resolve(here, "../scripts/clean_boiler_film_records.py"), "utf8");
const parseSegs = blob => [...blob.matchAll(/\("([^"]+)", "([^"]+)"\)/g)].map(m => [m[1], m[2]]);
// 共享段常量（_LOOP2_4 = [...]）先解析，再在回路定义中按名引用
const pyConsts = {};
for (const m of py.matchAll(/^_([A-Z0-9_]+) = \[([^\]]+)\]/gm)) pyConsts["_" + m[1]] = parseSegs(m[2]);
const segsOf = blob => (blob.startsWith("_") ? pyConsts[blob] : parseSegs(blob));
const pyLoops = [...py.matchAll(/"loop": (\d+), "front": \((\d+),\), "rear": \((\d+),\),\s*"front_segs": (\[[^\]]+\]|_[A-Z0-9_]+),\s*"rear_segs": (\[[^\]]+\]|_[A-Z0-9_]+)/g)];
assert.equal(pyLoops.length, 12, "清洗脚本应含12个回路定义");
for (const m of pyLoops) {
  const jsLoop = baseline.find(l => l.loop === Number(m[1]));
  assert.ok(jsLoop, `回路${m[1]} 在JS基准中存在`);
  assert.deepEqual(jsLoop.frontSegs, segsOf(m[4]), `回路${m[1]} 入口段分段两端一致`);
  assert.deepEqual(jsLoop.rearSegs, segsOf(m[5]), `回路${m[1]} 出口段分段两端一致`);
}

// 档案页「规格材质」取值：tubeSpecMaterialSummary（与基线同上下文，parseTubeCode 需先注入）
vm.runInContext(js.slice(js.indexOf("function parseTubeCode"), js.indexOf("function isValidTubeCodeStructure")), baselineCtx);
assert.match(js, /const specSummary = tubeSpecMaterialSummary\(code, localEvents\);/, "档案页本地录入分支应接入规格材质摘要");
const summaryOf = (code, events) => vm.runInContext(
  `tubeSpecMaterialSummary(${JSON.stringify(code)}, ${JSON.stringify(events)})`, baselineCtx);
const f002Summary = summaryOf('1G-GGRQ-GQ-L002-F002-W', [{ spec: 'Φ51×8', material: 'SA-213TP304H' }]);
assert.ok(f002Summary.startsWith('回路2 底弯段 Φ51×8 SA-213TP304H'), 'W记录按回路基准显示确定值');
assert.ok(f002Summary.includes('全回路') && f002Summary.includes('【底弯】'), '附整个回路分段链便于核对');
assert.ok(!f002Summary.includes('检测记录'), '记录值与基准一致时不重复列出');
const f005Summary = summaryOf('1G-GGRQ-GQ-L005-F005-W', [{ spec: 'Φ51×9', material: 'SA-213T91' }]);
assert.ok(f005Summary.startsWith('回路5 底弯段 Φ51×8 SA-213T91；检测记录：Φ51×9 SA-213T91'), '记录与基准不一致时并列展示待核');
const qFrontSummary = summaryOf('1G-GGRQ-GQ-L002-F002-Q', [{ spec: 'Φ51×9', material: 'SA-213T91' }]);
assert.ok(qFrontSummary.startsWith('回路2 入口段 F002（顶入口→底弯）：Φ51×9 12Cr1MoVG → Φ51×9 SA-213T91【底弯前】'), 'Q记录按回路基准显示所在腿沿流程分段链（底弯前邻段=T91）');
assert.ok(!qFrontSummary.includes('检测记录'), '记录值命中分段链时不重复列出');
assert.ok(summaryOf('1G-GGRQ-GQ-L002-F002-Q', []).startsWith('回路2 入口段 F002'), 'Q记录无检测值也返回基准链，调用方无需退回材料库');
const qRearSummary = summaryOf('1G-GGRQ-GQ-L025-B002-Q', []);
assert.ok(qRearSummary.startsWith('回路2 出口段 B002（底弯→顶出口）：Φ51×11 SA-213T91【底弯后】 → Φ51×11 SA-213T22'), '出口段Q（B向规范地址）列出底弯后多种规格（按顺序全部列出）');
assert.ok(summaryOf('1G-GGRQ-GQ-L002-F002-Q', [{ spec: 'Φ51×11', material: 'SA-213T22' }]).includes('；检测记录：Φ51×11 SA-213T22'), '记录值不在入口段直管链时附检测记录待核');
assert.ok(summaryOf('1G-GGRQ-GQ-L001-B001-W', []).startsWith('回路1 底弯段 Φ54×7.5 SA-213TP347H'), '弯头B写法归一入口段位后取回路基准');
assert.ok(summaryOf('1G-DPGRQ-GQ-L001-F002-F001-Q', []).startsWith('回路1 入口段 F001（顶入口→底弯）：Φ51×7 12Cr1MoVG → Φ51×7 SA-213T91【底弯前】'), '大屏外圈入口段链（12Cr1MoVG→T91，绑定在小屏内）');
assert.equal(summaryOf('1G-GZRQ-GQ-L001-F001-W', [{ spec: 'Φ60×4', material: 'SA-213TP304H' }]), 'Φ60×4 SA-213TP304H', '高再无回路基准，用检测记录值');

console.log("ok - design drawings module: nav/view/upload/viewer/delete/linkage with permission gating and KV sync + 12-loop segment baseline");
