import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');
const html = read('炉管全生命周期管理系统.html');
const app = read('assets/app/app-v7.9.js');
const css = read('assets/app/app-v8.0.css');
const moduleCode = read('assets/app/report-pro-v1.js');

/* ---------------- 1. 页面接线：按钮与脚本 ---------------- */
assert.match(html, /onclick="addLLMVizToReport\(\)">加入报告/, '可视化面板应有「加入报告」按钮');
assert.match(html, /id="llm-edit-tab" onclick="toggleLLMReportEdit\(\)">编辑/, '应有报告编辑按钮');
assert.match(html, /id="llm-save-btn" onclick="saveLLMReportPro\(\)">保存/, '应有报告保存按钮');
assert.match(html, /onclick="exportLLMReportDOCX\(\)">导出Word/, '应有导出 Word 按钮');
assert.match(html, /assets\/app\/report-pro-v1\.js" defer/, '应引入 report-pro 模块');
assert.match(html, /onclick="exportLLMReportPDF\(\)">导出PDF/, '原有导出 PDF 保留');

/* ---------------- 2. 宿主接线：守卫、钩子与打印配色 ---------------- */
assert.match(app, /window\.BTReportPro\.guardExport\('PDF'\)/, '导出 PDF 必须经过保存守卫');
assert.match(app, /onReportReplaced === 'function'\) window\.BTReportPro\.onReportReplaced\(false\)/, '新报告渲染后应标记未保存');
assert.match(app, /window\.BTReportPro\.onReportReplaced\(true\)/, '清空结果应重置保存状态');
assert.match(app, /window\.BTDocx \? window\.BTDocx\.printVarsCss\(\)/, '打印窗口应注入白底配色 CSS 变量');

/* ---------------- 3. 编辑态样式 ---------------- */
assert.match(css, /\.llm-report-view\[contenteditable="true"\]/, '编辑态应有可视轮廓');
assert.match(css, /#llm-save-btn\.is-dirty/, '未保存状态应在保存按钮上标识');

/* ---------------- 4. 模块在无 DOM 环境可加载，且能产出合法 docx ---------------- */
const sandbox = { window: {}, atob, TextEncoder, TextDecoder, console };
vm.createContext(sandbox);
vm.runInContext(moduleCode, sandbox, { filename: 'report-pro-v1.js' });
const BTDocx = sandbox.window.BTDocx;
assert.equal(typeof BTDocx, 'object', '应暴露 window.BTDocx');
assert.equal(typeof BTDocx.buildDocx, 'function', 'buildDocx 应为函数');

assert.equal(BTDocx.xmlEsc('<a>&"\''), '&lt;a&gt;&amp;&quot;&apos;', 'XML 转义必须覆盖五个字符');
assert.equal(BTDocx.crc32(new TextEncoder().encode('123456789')), 0xCBF43926, 'CRC32 标准校验向量');

/* 1x1 透明 PNG */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const model = {
  title: '锅炉炉管 · 专业分析报告',
  metaLines: ['系统：锅炉炉管全生命周期管理系统', '导出时间：2026-10-25 10:00:00'],
  blocks: [
    { t: 'h2', text: '关键结论 <风险&总览>' },
    { t: 'p', text: '水冷壁区域减薄速率偏高。' },
    { t: 'bullets', items: ['2WW-X 区域优先复测', '纳入下次 A 级检修'] },
    { t: 'table', headers: ['对象', '风险等级'], rows: [['2WW-01', '高'], ['2SH-05', '中']] },
    { t: 'image', pngBase64: PNG_BASE64, widthPx: 620, heightPx: 310 },
    { t: 'meta', text: '数值校验：通过。' }
  ]
};
const bytes = BTDocx.buildDocx(model);
assert.ok(bytes && typeof bytes.length === 'number' && bytes.length > 0, 'buildDocx 应返回字节数组');
assert.equal(bytes.constructor?.name, 'Uint8Array', 'buildDocx 应返回 Uint8Array');
assert.deepStrictEqual([...bytes.slice(0, 4)], [0x50, 0x4B, 0x03, 0x04], 'ZIP 本地文件头签名');
assert.deepStrictEqual([...bytes.slice(-22, -18)], [0x50, 0x4B, 0x05, 0x06], 'EOCD 签名应位于末尾');

/* 解析 ZIP（stored）并逐项校验 CRC 与内容 */
function parseZip(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const decoder = new TextDecoder();
  const entries = {};
  let pos = 0;
  while (view.getUint32(pos, true) === 0x04034b50) {
    const crc = view.getUint32(pos + 14, true);
    const size = view.getUint32(pos + 18, true);
    const nameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);
    const name = decoder.decode(buf.subarray(pos + 30, pos + 30 + nameLen));
    const dataStart = pos + 30 + nameLen + extraLen;
    const data = buf.subarray(dataStart, dataStart + size);
    entries[name] = { crc, data };
    pos = dataStart + size;
  }
  return entries;
}
const entries = parseZip(bytes);
const names = Object.keys(entries);
for (const [name, entry] of Object.entries(entries)) {
  assert.equal(BTDocx.crc32(entry.data), entry.crc, `条目 ${name} 的 CRC32 应与中央目录一致`);
}
for (const required of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/media/image1.png']) {
  assert.ok(names.includes(required), `docx 应包含 ${required}`);
}
const decoder = new TextDecoder();
const docXml = decoder.decode(entries['word/document.xml'].data);
assert.match(docXml, /锅炉炉管 · 专业分析报告/, '标题应写入 document.xml');
assert.match(docXml, /关键结论 &lt;风险&amp;总览&gt;/, '标题文本必须做 XML 转义');
assert.match(docXml, /• 2WW-X 区域优先复测/, '列表应以项目符号输出');
assert.match(docXml, /<w:tbl>/, '表格应输出 w:tbl');
assert.match(docXml, /<w:tblHeader\/>/, '表头行应跨页重复');
assert.match(docXml, /r:embed="rId10"/, '图片应引用 rId10 关系');
assert.match(docXml, /<w:sectPr>/, '应有 A4 页面设置');
const relsXml = decoder.decode(entries['word/_rels/document.xml.rels'].data);
assert.match(relsXml, /Id="rId10"[^>]*Type="[^"]*\/image" Target="media\/image1\.png"/, '图片关系应注册在 document rels');
assert.match(decoder.decode(entries['[Content_Types].xml'].data), /Extension="png"/, 'png 内容类型应声明');
assert.deepStrictEqual([...entries['word/media/image1.png'].data.slice(0, 4)], [0x89, 0x50, 0x4E, 0x47], '媒体条目应为 PNG 二进制');

/* ---------------- 5. 导出守卫语义（源码级断言） ---------------- */
assert.match(moduleCode, /function guardExport\(kind\)/, '守卫函数应存在');
assert.match(moduleCode, /请先点「保存」/, '脏状态导出应给出保存提示');
assert.match(moduleCode, /blcms-pro-report-v1/, '报告应持久化到 localStorage');
assert.match(moduleCode, /contenteditable/, '编辑模式应使用 contenteditable');
assert.match(moduleCode, /rasterizeSvg/, 'SVG 应栅格化为 PNG 嵌入 docx');
assert.match(moduleCode, /data-viz-title/, '重复加入同名可视化应替换而不是堆积');
assert.match(moduleCode, /PLACEHOLDER_HINT\)\)\s*\n\s*\.forEach\(node => node\.remove/, '首次加入可视化应清掉占位提示行，避免保存被误判为空报告');

console.log('ok - 专业分析报告：可视化入报告、可编辑、保存后导出 PDF/Word 全部就绪');
