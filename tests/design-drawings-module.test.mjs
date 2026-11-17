import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, "../炉管全生命周期管理系统.html"), "utf8");
const js = readFileSync(resolve(here, "../assets/app/app-v7.9.js"), "utf8");
const css = readFileSync(resolve(here, "../assets/app/app-v8.0.css"), "utf8");

// 导航与视图
assert.match(html, /data-view="drawings"/, "设计图纸导航入口应存在");
assert.match(html, /id="view-drawings"/, "设计图纸视图应存在");
assert.match(html, /id="drawingFileInput"[^>]*accept="image\/png,image\/jpeg,image\/webp,application\/pdf"/, "上传控件应接受图片与PDF");
assert.match(html, /id="drawingsGrid"/, "图纸卡片网格应存在");
assert.match(html, /id="drawingSysFilter"/, "受热面筛选应存在");

// 模块函数与存储（元数据/内容分离）
assert.match(js, /const DESIGN_DRAWINGS_META_KEY = 'boiler_design_drawings_meta';/);
assert.match(js, /const DESIGN_DRAWINGS_KEY = 'boiler_design_drawings';/);
assert.match(js, /const DRAWING_CONTENT_PREFIX = 'boiler_drawing_content:'/);
assert.match(js, /const DRAWING_MAX_BYTES = 4 \* 1024 \* 1024;/, "单文件4MB上限");
assert.match(js, /function normalizeDrawingMeta\(/);
assert.match(js, /async function ensureDrawingContent\(/);
assert.match(js, /cloudStorageRequest\(drawingContentKey\(id\)\)/, "图纸内容按需从云端读取");
assert.match(js, /function handleDrawingUpload\(event\)/);
assert.match(js, /function renderDesignDrawings\(\)/);
assert.match(js, /function openDrawingViewer\(id, options = \{\}\)/);
assert.match(js, /function closeDrawingViewer\(\)/);
assert.match(js, /function deleteDesignDrawing\(id\)/);
assert.match(js, /function renameDesignDrawing\(id\)/);
assert.match(js, /function openDrawingsForSys\(sys\)/);
assert.match(js, /function designDrawingsForSys\(sys\)/);
assert.match(js, /function canManageTubeData\(\)/, "上传/删除前有权限校验的函数可用");
assert.match(js, /renderDesignDrawings\(\);/, "INIT 应渲染图纸模块");

// 只读权限拦截
const uploadFn = js.slice(js.indexOf("async function handleDrawingUpload"), js.indexOf("async function deleteDesignDrawing"));
assert.match(uploadFn, /canManageTubeData\(\)/);
assert.match(uploadFn, /当前权限为只读，不能上传图纸/);
assert.match(uploadFn, /cloudStorageWrite\(drawingContentKey\(id\), data\)/, "先写内容键");
assert.match(uploadFn, /const persisted = await persistDrawingMeta\(\)/, "再等待元数据云端确认");
assert.match(uploadFn, /if \(!persisted\.ok\)[\s\S]*?云端保存未确认/, "元数据未确认不得报告上传成功");
const deleteFn = js.slice(js.indexOf("async function deleteDesignDrawing"), js.indexOf("function drawingSurfaceLabel"));
assert.match(deleteFn, /当前权限为只读，不能删除图纸。/);
assert.match(deleteFn, /if \(!confirm\(/, "删除图纸需确认");
assert.match(deleteFn, /releaseDrawingContent\(id\)/, "删除时释放内容缓存");

// 查看器：按需加载内容、校验 data URL、无内联事件
assert.match(js, /async function openDrawingViewer\(id, options = \{\}\)/);
assert.match(js, /const entry = await ensureDrawingContent\(id, options\)/, "查看器按需拉取内容");
assert.match(js, /if \(!entry\)/, "内容不可信/缺失时显示错误而不是渲染");
assert.match(js, /<iframe src="' \+ entry\.url/, "PDF 用内嵌框架查看");
assert.doesNotMatch(js, /onclick="openDrawingViewer\(/, "不得使用内联事件拼接图纸 id");
assert.doesNotMatch(js, /'<img src="' \+ d\.data/, "列表不得直接拼接 base64 内容");
assert.match(js, /data-drawing-thumb=/, "图片缩略图按需加载");
assert.match(js, /data-drawing-action="view"/, "卡片使用事件委托属性");

// 查看器：放大/缩小、适应窗口、拖动平移与全屏
assert.match(js, /function setDrawingViewerScale\(/, "查看器应支持按比例缩放");
assert.match(js, /function fitDrawingViewer\(/, "查看器应支持适应窗口");
assert.match(js, /function toggleDrawingFullscreen\(/, "查看器应支持全屏切换");
assert.match(js, /requestFullscreen/, "全屏优先使用浏览器 Fullscreen API");
assert.match(js, /is-maximized/, "Fullscreen API 不可用时退化为铺满视口");
assert.match(js, /data-drawing-zoom="in"/, "查看器应有放大按钮");
assert.match(js, /data-drawing-zoom="fit"/, "查看器应有适应窗口按钮");
assert.match(js, /data-drawing-fullscreen/, "查看器应有全屏按钮");
assert.match(js, /addEventListener\('wheel'/, "滚轮可缩放");
assert.match(js, /pointerdown[\s\S]{0,400}scrollLeft/, "拖动可平移");
assert.match(js, /function releaseDrawingViewer\(/, "关闭弹窗应释放查看器对象 URL");
assert.match(css, /\.drawing-viewer-panel:fullscreen/, "全屏样式应铺满视口");

// 内容载入兜底：旧格式缓存 + 类型以内容为准
assert.doesNotMatch(js, /data\.slice\(0, 22\)\.toLowerCase\(\)/, "PDF 前缀判定不得截断后再与短字符串比较");
assert.ok(js.includes("const fileType = /^data:application\\/pdf;/i.test(data)"), "PDF 按 data URL 前缀判定类型");
assert.match(js, /function legacyDrawingData\(id\)/, "云端内容缺失时应回退本机旧格式缓存");
assert.match(js, /async function remoteLegacyDrawingData\(id\)/, "本机无缓存时应可按需回退云端旧格式数组");
assert.match(js, /options\.remoteLegacy/, "云端旧格式数组体积大，必须由用户显式触发恢复");
assert.ok(js.includes("仅元数据缺失时才在启动阶段解析旧数组"), "启动阶段不得每次都解析数 MB 旧数组");
assert.match(js, /reuploadLegacyDrawingContent\(id, data\)/, "旧缓存命中后应后台补传云端");
assert.match(js, /meta\.fileType = isPdf \? 'pdf' : 'image'/, "元数据文件类型与内容不一致时应按内容修正");
assert.match(js, /已尝试云端内容与本机旧格式缓存/, "错误提示应说明已尝试的兜底来源");
assert.match(css, /\.drawing-viewer-stage\s*\{[\s\S]*?overflow:\s*auto/, "缩放后舞台可滚动查看");

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
assert.match(js, /const PSGRQ_LOOP_BASELINE = \[/, "屏式过热器13回路分段基准应存在");
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
assert.match(html, /id="gzrqLoopBaseline"/, "高再分段基准表容器应存在");
assert.match(html, /高温再热器材质分段基准（7回路）/, "高再分段基准卡片标题应存在");
assert.match(js, /const GZRQ_LOOP_BASELINE = \[/, "高再7回路分段基准应存在");
assert.match(js, /function renderGZRQLoopBaseline\(\)/, "高再分段基准渲染函数应存在");
assert.match(js, /function renderDZRQLoopBaseline\(\)/, "低再分段基准渲染函数应存在");
assert.match(html, /id="smqLoopBaseline"/, "省煤器分段基准表容器应存在");
assert.match(html, /省煤器材质分段基准（每排三管圈）/, "省煤器分段基准卡片标题应存在");
assert.match(js, /const SMQ_LOOP_BASELINE = \[/, "省煤器分段基准应存在");
assert.match(js, /function renderSMQLoopBaseline\(\)/, "省煤器分段基准渲染函数应存在");
assert.match(html, /SMQ-SG-L001~056-F001\/F002-Q/, "吊挂管编码模式应明确：F001=前排、F002=后排（B不用），L001~056为炉左往右56个位置");
assert.match(js, /name:'省煤器蛇形管', sys:'SMQ', comp:'SG', posLetters:\['L','R'\], pMax:124, dirs:\['U','D'\], tMax:3, dualDir:true/, "蛇形管矩阵行应按新口径：U=上组/D=下组，圈号001~003，双向展开不互镜像");
assert.match(js, /name:'省煤器吊挂管', sys:'SMQ', comp:'SG', label:'省煤器直管', posLetters:\['L','R'\], pMax:56, dirs:\['F'\], tMax:2/, "吊挂管为直管，矩阵行应存在：L001~056 × F001/F002");
assert.doesNotMatch(js, /name:'省煤器进口集箱', sys:'SMQ'/, "集箱不属回路管段，编码矩阵不再有进口集箱行");
assert.doesNotMatch(js, /name:'省煤器出口集箱', sys:'SMQ'/, "集箱不属回路管段，编码矩阵不再有出口集箱行");

// 行为验证：回路号即入口段F00k/出口段B00k编号（JSON 序列化取出，避免跨 realm 原型差异）
const baselineCtx = vm.createContext({});
vm.runInContext(js.slice(js.indexOf("const GGRQ_LOOP_BASELINE"), js.indexOf("function renderGGRQLoopBaseline")), baselineCtx);
const baseline = JSON.parse(vm.runInContext("JSON.stringify(GGRQ_LOOP_BASELINE)", baselineCtx));
assert.equal(baseline.length, 12, "应包含全部12个回路");
for (const l of baseline) {
  assert.equal(l.loop, baseline.indexOf(l) + 1, "回路号连续1..12");
  assert.ok(l.frontSegs.length >= 2 && l.rearSegs.length >= 2, "入口直管和底弯分别保留，出口段至少2段");
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
const gzrqBaseline = JSON.parse(vm.runInContext("JSON.stringify(GZRQ_LOOP_BASELINE)", baselineCtx));
assert.equal(gzrqBaseline.length, 7, "高再应包含7个回路");
for (const l of gzrqBaseline) {
  assert.equal(l.loop, gzrqBaseline.indexOf(l) + 1, "高再回路号连续1..7");
  assert.ok(l.frontSegs.length >= 3 && l.rearSegs.length >= 2, "每回路含入口段/底弯/出口段");
  assert.deepEqual(l.rearSegs[l.rearSegs.length - 1], ['Φ60×5', 'SA-213T22'], `回路${l.loop} 顶棚外出口段T22`);
}
assert.deepEqual(gzrqBaseline[0].frontSegs, [
  ['Φ60×5', '12Cr1MoVG'],
  ['Φ60×4', '12Cr1MoVG'],
  ['Φ60×4', 'SA-213T91'],
  ['Φ60×4', 'SA-213TP304H']
], 'F001 外圈底弯TP304H');
assert.deepEqual(gzrqBaseline[0].rearSegs, [['Φ60×5', 'SA-213T91'], ['Φ60×5', 'SA-213T22']], 'F001 出口段');
assert.deepEqual(gzrqBaseline[1].frontSegs, [
  ['Φ51×5', '12Cr1MoVG'],
  ['Φ51×4', '12Cr1MoVG'],
  ['Φ60×4', '12Cr1MoVG'],
  ['Φ60×4', 'SA-213T91']
], 'F002 底弯T91');
assert.deepEqual(gzrqBaseline[4].frontSegs, [
  ['Φ51×5', '12Cr1MoVG'],
  ['Φ51×4', '12Cr1MoVG'],
  ['Φ60×4', '12Cr1MoVG'],
  ['Φ60×4', '12Cr1MoVG']
], 'F005 入口直管与底弯同材质仍分别保留');
for (const loop of gzrqBaseline.slice(4)) {
  assert.deepEqual(loop.frontSegs.slice(-2), [['Φ60×4', '12Cr1MoVG'], ['Φ60×4', '12Cr1MoVG']], 'F005–F007 独立入口与底弯');
}
assert.deepEqual(gzrqBaseline[5].rearSegs, [
  ['Φ60×4', 'SA-213T91'],
  ['Φ60×5', 'SA-213T91'],
  ['Φ60×5', 'SA-213T22']
], 'F006 出口段');
assert.deepEqual(gzrqBaseline[6].rearSegs, [
  ['Φ60×6', 'SA-213T91'],
  ['Φ60×4', 'SA-213T91'],
  ['Φ60×5', 'SA-213T91'],
  ['Φ60×5', 'SA-213T22']
], 'F007 出口三段T91');

// 省煤器：每排三管圈＝回路1~3 逐回路一行（写法对齐低过/低再），沿水流程3段，全部碳钢（148M3-0 + 用户确认2026-11-08）
const smqBaseline = JSON.parse(vm.runInContext("JSON.stringify(SMQ_LOOP_BASELINE)", baselineCtx));
assert.equal(smqBaseline.length, 3, "省煤器每排三管圈＝回路1~3，逐回路一行");
assert.deepEqual(smqBaseline.map(l => l.tube), ['U001=上组、D001=下组', 'U002=上组、D002=下组', 'U003=上组、D003=下组'], "蛇形管方向字母即组别（U=上组/D=下组），数字位001~003=圈号");
for (const l of smqBaseline) {
  assert.equal(l.loop, smqBaseline.indexOf(l) + 1, "回路号连续1..3");
  assert.deepEqual(l.segs.map(s => s[0]), ['下级水平段（下组）', '上级水平段（上组）', '吊挂管直段'], "分段顺序沿水流程：下级→上级→吊挂管，无级间过渡段");
  assert.deepEqual(l.segs.map(s => s[1] + ' ' + s[2]), ['Φ51×6 SA-210C', 'Φ51×6 SA-210C', 'Φ60×9 SA-210C'], "蛇形管两段同规格材质，吊挂管直段Φ60×9 SA-210C");
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
vm.runInContext(js.slice(js.indexOf("function canonicalizeSystemAliases"), js.indexOf("/* 方向感知归一")), baselineCtx);
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
assert.ok(summaryOf('1G-GZRQ-GQ-L001-F001-W', []).startsWith('回路1 底弯段 Φ60×4 SA-213TP304H'), '高再底弯使用确认基准');
assert.ok(summaryOf('1G-GZRQ-GQ-L001-B001-Q', []).startsWith('回路1 出口段 B001（底弯→顶出口）：Φ60×5 SA-213T91'), '高再出口腿单独显示材质链');
assert.ok(summaryOf('1G-GZRQ-GQ-L001-F005-Q', []).includes('Φ60×4 12Cr1MoVG【底弯前】'), '入口与底弯同材质不能省略入口直管');
assert.ok(summaryOf('1G-PSGRQ-GQ-L001-F007-Q', []).includes('Φ54×8.5 12Cr1MoVG'), '屏过同材质入口直管规格完整显示');
baselineCtx.escapeHTML = value => String(value);
const gzrqTable = vm.runInContext("platenLoopBaselineTable(GZRQ_LOOP_BASELINE, '高再')", baselineCtx);
assert.ok(gzrqTable.includes('F001↓ + B001↑') && gzrqTable.includes('F007↓ + B007↑'), '高再表格统一F入口/B出口');
assert.equal((gzrqTable.match(/【底弯】/g) || []).length, 7, '每回路独立标注底弯');
const f005Row = gzrqTable.slice(gzrqTable.indexOf('>回路5<'), gzrqTable.indexOf('>回路6<'));
assert.equal((f005Row.match(/Φ60×4 12Cr1MoVG/g) || []).length, 2, '表格保留同规格材质入口和底弯两个位置');
const hpTable = vm.runInContext("platenLoopBaselineTable(PSGRQ_LOOP_BASELINE, '后屏')", baselineCtx);
const hp7Row = hpTable.slice(hpTable.indexOf('>回路7<'), hpTable.indexOf('>回路8<'));
assert.equal((hp7Row.match(/Φ54×8.5 12Cr1MoVG/g) || []).length, 3, '同材质入口、底弯、出口分别显示且不重复补段');

// 三类受热面同规格材质的入口/底弯必须在数据、表格、Q/W摘要中各自保留。
for (const [sys, name, first, last, spec, material] of [
  ['GGRQ', 'GGRQ_LOOP_BASELINE', 8, 11, 'Φ51×9', '12Cr1MoVG'],
  ['PSGRQ', 'PSGRQ_LOOP_BASELINE', 7, 12, 'Φ54×8.5', '12Cr1MoVG'],
  ['DPGRQ', 'DPGRQ_LOOP_BASELINE', 4, 13, 'Φ51×7', '12Cr1MoVG']
]) {
  const loops = JSON.parse(vm.runInContext(`JSON.stringify(${name})`, baselineCtx));
  const table = vm.runInContext(`platenLoopBaselineTable(${name}, '${sys}')`, baselineCtx);
  for (let no = first; no <= last; no++) {
    const loop = loops.find(item => item.loop === no);
    assert.deepEqual(loop.frontSegs, [[spec, material], [spec, material]], `${sys}回路${no}分别存储入口直管与底弯`);
    const row = table.split('<tr>').find(part => part.includes(`>回路${no}<`));
    const label = `${spec} ${material}`;
    assert.equal(row.split(label).length - 1, 2 + loop.rearSegs.filter(seg => seg.join(' ') === label).length, `${sys}回路${no}不能额外补出重复段`);
    assert.equal(row.split('【底弯】').length - 1, 1, '每回路只标一次底弯');
    const code = `1G-${sys}-GQ-L001-${sys === 'DPGRQ' ? 'F001-' : ''}F${String(no).padStart(3, '0')}`;
    assert.ok(summaryOf(code + '-Q', []).includes(label + '【底弯前】'), `${sys}回路${no}入口档案显示完整直管材质`);
    assert.ok(summaryOf(code + '-W', []).includes(`${label} → ${label}【底弯】`), `${sys}回路${no}底弯档案全回路保留入口`);
  }
}

// 云端启动同步：元数据/内容分离后只拉元数据；旧格式内容逐张迁移
assert.match(js, /cloudStorageRequest\(DESIGN_DRAWINGS_META_KEY\)/, "bootstrap 应先拉取图纸元数据键");
assert.match(js, /await syncDesignDrawingsFromCloud\(remoteDrawingMeta, remoteLegacyDrawings\)/, "bootstrap 应等待元数据同步");
assert.match(js, /remoteDrawingMeta\?\.found === false[\s\S]*?cloudStorageRequest\(DESIGN_DRAWINGS_KEY\)/, "仅元数据缺失时才读取旧键");
assert.match(js, /图纸元数据已排队同步云端/, "本机配额不足时只提示元数据排队，不再假称内容已存云端");

const normalizeFn = js.slice(js.indexOf("function normalizeDrawingMeta"), js.indexOf("function drawingContentKey"));
const contentKeyFn = js.slice(js.indexOf("function drawingContentKey"), js.indexOf("async function ensureDrawingContent"));
const syncFn = js.slice(js.indexOf("async function syncDesignDrawingsFromCloud"), js.indexOf("async function loadAuthSession"));

function makeSyncContext(localDrawings = [], legacy = null) {
  const calls = { content: [], meta: [], saved: [], removed: [], toasts: [] };
  const ctx = vm.createContext({
    console,
    DESIGN_DRAWINGS_KEY: 'boiler_design_drawings',
    DESIGN_DRAWINGS_META_KEY: 'boiler_design_drawings_meta',
    DRAWING_CONTENT_PREFIX: 'boiler_drawing_content:',
    DRAWING_ID_RE: /^[A-Za-z0-9_-]{1,64}$/,
    DRAWING_DATA_RE: /^data:(image\/(?:png|jpeg|jpg|webp)|application\/pdf);base64,[A-Za-z0-9+/=\s]+$/,
    var_designDrawings: null,
    cloudStorageWrite: async (key, value) => { calls.content.push({ key, length: String(value).length }); return { ok: true }; },
    persistDrawingMeta: async options => {
      calls.meta.push({ options });
      calls.saved.push({ k: 'boiler_design_drawings_meta', v: JSON.stringify(vm.runInContext('designDrawings', ctx)) });
      return { ok: true };
    },
    localStorage: {
      setItem: (k, v) => calls.saved.push({ k, v }),
      removeItem: k => calls.removed.push(k)
    },
    renderDesignDrawings: () => {},
    showToast: msg => calls.toasts.push(String(msg))
  });
  vm.runInContext(`var designDrawings = ${JSON.stringify(localDrawings)}; var legacyLocalDrawings = ${JSON.stringify(legacy)};`, ctx);
  vm.runInContext(normalizeFn + '\n' + contentKeyFn + '\n' + syncFn, ctx);
  const run = (remoteMeta, remoteLegacy) => vm.runInContext(
    `syncDesignDrawingsFromCloud(${JSON.stringify(remoteMeta)}, ${JSON.stringify(remoteLegacy)})`, ctx);
  const drawings = () => JSON.parse(vm.runInContext('JSON.stringify(designDrawings)', ctx));
  return { ctx, calls, run, drawings };
}
const remoteA = { id: 'a', name: '云端A', sys: 'GGRQ', fileType: 'image', size: 10, data: 'data:image/png;base64,QUFB' };
const remoteB = { id: 'b', name: '云端B', sys: '', fileType: 'pdf', size: 20 };
const localA = { id: 'a', name: '本机改名A', sys: 'GGRQ', fileType: 'image', size: 10 };
const localX = { id: 'x', name: '仅本机', sys: 'DGRQ', fileType: 'image', size: 5 };

await (async () => {
  // 本机为空：载入云端元数据，纯载入不回推
  const emptyLocal = makeSyncContext([]);
  await emptyLocal.run({ found: true, value: [remoteA, remoteB], updatedAt: '2026-11-16T00:00:00Z' }, null);
  assert.deepEqual(emptyLocal.drawings().map(d => d.id), ['a', 'b']);
  assert.equal(emptyLocal.calls.meta.length, 0, '纯载入不应回推云端');
  assert.equal(emptyLocal.calls.saved.length, 1, '应写入本机元数据');
  assert.match(emptyLocal.calls.toasts[0], /云端新增 2 张/);
  assert.equal(emptyLocal.drawings().find(d => d.id === 'a').data, undefined, '元数据不得包含 base64 内容');

  // 两端各有新增：并集合并并回推
  const bothSides = makeSyncContext([localX]);
  await bothSides.run({ found: true, value: [remoteA, remoteB] }, null);
  assert.deepEqual(bothSides.drawings().map(d => d.id), ['x', 'a', 'b']);
  assert.equal(bothSides.calls.meta.length, 1, '本机独有图纸应回推元数据');
  assert.match(bothSides.calls.toasts[0], /云端新增 2 张.*本机 1 张已补推/);

  // 同 id 以本机为准
  const renamed = makeSyncContext([localA]);
  await renamed.run({ found: true, value: [remoteA, remoteB] }, null);
  assert.equal(renamed.drawings().find(d => d.id === 'a').name, '本机改名A');
  assert.equal(renamed.drawings().length, 2);

  // 云端缺元数据：把本机存量推上去
  const cloudMissing = makeSyncContext([localX]);
  await cloudMissing.run({ found: false }, null);
  assert.equal(cloudMissing.calls.meta.length, 1, '云端缺键应推送本机元数据');

  // 网络失败：保持本机现状
  const offline = makeSyncContext([localX]);
  await offline.run(null, null);
  assert.equal(offline.calls.meta.length, 0);
  assert.equal(offline.calls.toasts.length, 0);
  assert.equal(offline.drawings().length, 1);

  // 旧格式迁移：内容先上传，再写元数据，成功后清理本机旧键
  const migration = makeSyncContext([], null);
  await migration.run({ found: false }, { found: true, value: [{ id: 'old1', name: '旧图', fileType: 'image', size: 9, data: 'data:image/png;base64,QUJD' }] });
  assert.equal(migration.calls.content.length, 1);
  assert.equal(migration.calls.content[0].key, 'boiler_drawing_content:old1');
  assert.deepEqual(migration.drawings().map(d => d.id), ['old1']);
  assert.equal(migration.calls.meta.length, 1);
  assert.ok(migration.calls.removed.includes('boiler_design_drawings'), '迁移成功后清理本机旧键');
  assert.match(migration.calls.toasts[0], /旧格式迁移 1 张/);

  // 旧格式中的非法 id / 非图片内容必须被拒绝，不得写入内容键
  const malicious = makeSyncContext([], null);
  await malicious.run({ found: false }, { found: true, value: [
    { id: '<img src=x onerror=alert(1)>', name: '恶意', fileType: 'image', data: 'data:image/png;base64,QUJD' },
    { id: 'bad2', name: 'HTML', fileType: 'image', data: 'data:text/html;base64,PHNjcmlwdD4=' }
  ] });
  assert.equal(malicious.calls.content.length, 0);
  assert.equal(malicious.drawings().length, 0);
})();

// 元数据校验与 data URL 白名单
const metaCtx = vm.createContext({
  DRAWING_ID_RE: /^[A-Za-z0-9_-]{1,64}$/,
  DRAWING_DATA_RE: /^data:(image\/(?:png|jpeg|jpg|webp)|application\/pdf);base64,[A-Za-z0-9+/=\s]+$/
});
vm.runInContext(normalizeFn, metaCtx);
const normalize = value => vm.runInContext(`normalizeDrawingMeta(${JSON.stringify(value)})`, metaCtx);
assert.equal(normalize({ id: '<img src=x>', fileType: 'image' }), null, '非法 id 必须拒绝');
assert.equal(normalize({ id: 'ok', fileType: 'text' }), null, '非法类型必须拒绝');
assert.equal(
  JSON.stringify(normalize({ id: 'ok', name: '图'.repeat(300), fileType: 'image', size: '12', data: 'data:image/png;base64,QUJD' })),
  JSON.stringify({ id: 'ok', name: '图'.repeat(200), drawingNo: '', sys: '', fileName: '', fileType: 'image', size: 12, uploadedAt: '' }),
  '元数据必须剥离 data 并截断字符串'
);
assert.equal(vm.runInContext("DRAWING_DATA_RE.test('data:text/html;base64,PHNjcmlwdD4=')", metaCtx), false);
assert.equal(vm.runInContext("DRAWING_DATA_RE.test('data:image/png;base64,QUJD')", metaCtx), true);
assert.equal(vm.runInContext("DRAWING_DATA_RE.test('data:application/pdf;base64,QUJD')", metaCtx), true);
console.log("ok - design drawings module: nav/view/upload/viewer/delete/linkage + lazy cloud content + metadata migration + loop segment baselines and inlet/bend preservation");
