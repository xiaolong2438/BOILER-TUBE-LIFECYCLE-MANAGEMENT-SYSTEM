import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, "..", p), "utf8");
const docs = read("assets/app/assistant-docs-v1.js");
const wiring = read("assets/app/assistant-v1.js");
const ui = read("assets/app/assistant-ui-v1.js");
const app = read("assets/app/app-v7.9.js");
const chat = read("functions/api/llm/chat.js");
const html = read("炉管全生命周期管理系统.html");
const css = read("assets/app/assistant-v1.css");

// 文档识别模块：图片走视觉模型、PDF 走 pdf.js，输出与 CSV/Excel 一致的网格。
assert.match(docs, /global\.BTAssistantDocs/, "docs module should attach window.BTAssistantDocs");
assert.match(docs, /imageToRows: imageToRows/, "image extraction entry should be exported");
assert.match(docs, /pdfToRows: pdfToRows/, "pdf extraction entry should be exported");
assert.match(docs, /docxToRows: docxToRows/, "word extraction entry should be exported");
assert.match(docs, /严禁编造任何数值、编号或日期/, "vision prompt must forbid fabricating data");
assert.match(docs, /type: 'image_url'/, "vision message format should be used");
assert.match(docs, /downscaleToJpegDataUrl/, "images should be downscaled before sending");
assert.match(docs, /function dropPhantomColumns\(rows\)/, "phantom empty columns from over-segmentation should be dropped");
assert.match(docs, /return dropPhantomColumns\(clustered\)/, "clustered rows must pass through phantom-column cleanup");

// 接线层：图片/PDF 进入与 CSV 相同的清洗-导入管线；服务端密钥模式可用。
assert.match(wiring, /docs && docs\.isPdfFile\(name\) \? 'pdf' : isWord \? 'word' : ''/, "handleFile should route image/pdf/word");
assert.match(wiring, /runCleaning\(rows, name, parsed\.sheetName/, "extracted grid should feed the shared cleaning pipeline");
assert.match(wiring, /return Boolean\(global\.__llmServerKey\)/, "server-key mode should unlock assistant LLM features");
assert.match(wiring, /function exportConversation\(\)/, "conversation export should exist");
assert.match(wiring, /event\.kind === 'export-chat'/, "export-chat event should be dispatched");

// 分流导入契约：干净行直接入库、警告行留待人工确认，两条路径共用 runImportGrid。
assert.match(wiring, /function splitCleanRowsByWarnings\(cleanRows, report\)/, "clean/warned row split should exist");
assert.match(wiring, /function runImportGrid\(rows, report\)/, "shared import executor should exist");
assert.match(wiring, /runImportGrid\(\[split\.header\]\.concat\(split\.autoRows\), report\)/, "clean rows should be imported directly");
assert.match(wiring, /state\.pendingCleaning = \{ report: flaggedReport, cleanRows: \[split\.header\]\.concat\(split\.flaggedRows\) \}/, "warned rows should stay pending for confirmation");
assert.match(wiring, /var manualMode = currentRole\(\) === 'viewer' \|\| report\.datasetType === 'unknown'/, "viewer/unknown-dataset must keep the manual whole-set flow");
assert.match(wiring, /行干净数据已直接导入/, "assistant must report the auto-imported row count");

// UI：文件选择与拖拽双入口。
assert.match(ui, /accept="\.csv,\.xlsx,\.xls,\.docx,\.doc,\.png,\.jpg,\.jpeg,\.webp,\.pdf"/, "file input should accept word, images and pdf");
assert.match(ui, /data-assistant="export-chat"/, "export chat button should exist");
assert.match(ui, /addEventListener\('dragenter', onPanelDragEnter\)/, "panel should accept drag-enter");
assert.match(ui, /addEventListener\('drop', onPanelDrop\)/, "panel should accept drop");

// 视觉调用走长超时；服务端代理放行视觉分段并收紧图像来源。
assert.match(app, /async function callVisionLLM\(/, "vision LLM wrapper should exist");
assert.match(app, /window\.__llmServerKey = Boolean\(llmServerStatus\?\.serverKey\)/, "server-key flag should be exposed");
assert.match(chat, /part\.type === 'image_url'/, "server proxy should accept image_url parts");
assert.ok(chat.indexOf("/^data:image\\/(png|jpe?g|webp);base64,/i") >= 0, "server proxy should only accept inline data images");
assert.match(chat, /6 \* 1024 \* 1024/, "vision requests need a larger body cap");

// 页面接线与拖拽视觉反馈。
assert.match(html, /assistant-docs-v1\.js/, "docs module should be loaded");
assert.match(html, /pdf\.js\/3\.11\.174\/pdf\.min\.js/, "pdf.js should be loaded from CDN");
assert.match(css, /\.assistant-panel\.is-dragover/, "drag-over highlight should be styled");

/* ---------------- v3 契约：Word 识别 + 智能字段/编码匹配 ---------------- */

// 文档识别层：Word 走零依赖 ZIP + OOXML 表格提取，无表格时文本交模型兜底。
assert.match(docs, /function parseDocxDocument\(xmlText\)/, "docx XML should be parsed by a self-contained tokenizer");
assert.match(docs, /DecompressionStream\('deflate-raw'\)/, "deflate entries should use the native DecompressionStream");
assert.match(docs, /word\/document\.xml/, "docx pipeline must read the main document part");
assert.match(docs, /'Word 智能提取'/, "docx text fallback should be labeled separately from PDF");
assert.match(docs, /w:gridSpan/, "gridSpan columns should be padded to keep alignment");

// 接线层：模型兜底的字段映射 + 按文件名缓存，重清洗不重复调用模型。
assert.match(wiring, /function llmMapHeaders\(/, "LLM header mapping should exist");
assert.match(wiring, /state\.headerMaps\[key\] = mapped\.map/, "model mapping must be cached per file");
assert.match(wiring, /headerMap: state\.headerMaps\[key\] \|\| null/, "cleaning must consume cached header mapping");
assert.match(wiring, /datasetType: state\.headerDatasetTypes\[key\] \|\| undefined/, "declared dataset type must be replayable");
assert.match(wiring, /旧版 \.doc 是二进制格式/, "legacy .doc should get a conversion hint");

// 领域层：模糊表头匹配 + 列重排 + 编码相似建议。
assert.match(wiring, /runCleaning\(rows, name, parsed\.sheetName/, "extracted grid should feed the shared cleaning pipeline");

// 文档识别层对外契约：v2 版本号与新增能力必须可被调用方依赖。
assert.match(docs, /version: 'v3'/, "docs module should report v3");
["imagesToRows", "mergeGrids", "normalizeGrid", "normalizeCell"].forEach((name) => {
  assert.ok(docs.indexOf(name + ": " + name) >= 0, "v2 API should export " + name);
});
assert.match(docs, /"uncertain":\[\[数据行号,列号\],\.\.\.\]/, "vision prompt should request uncertain cell coordinates");
assert.match(docs, /请只输出一个 JSON 对象/, "unparsable model output should trigger a JSON repair request");
assert.match(docs, /return \{ rows: normalizeGrid\(gridRows\), sheetName: sheetName, notes: notes \}/, "extracted grids must pass through field normalization");
assert.match(docs, /严禁编造任何数值、编号或日期/, "repair prompt must keep the anti-fabrication rule");

// 接入层：多文件入口与批量接线，识别结果必须回到既有清洗链路。
assert.match(wiring, /var MAX_BATCH_IMAGES = 8;/, "batch image cap should be declared");
assert.match(wiring, /if \(event\.kind === 'files'\) \{ handleFiles\(event\.files\); return; \}/, "dispatch should route batch file events");
assert.match(wiring, /return docs\.imagesToRows\(files, \{/, "batch path should call docs.imagesToRows");
assert.match(wiring, /handleFiles: handleFiles,/, "wiring facade should expose handleFiles");
assert.match(wiring, /runCleaning\(rows, batchName, sheetName\)/, "merged batch grid must reuse the shared cleaning pipeline");

// UI：多选入口与单/多文件分流。
assert.match(ui, /multiple accept="\.csv,\.xlsx,\.xls,\.docx,\.doc,\.png,\.jpg,\.jpeg,\.webp,\.pdf"/, "file input should allow multi-select including Word");
assert.match(ui, /emit\(\{ kind: 'files', files: files \}\)/, "multiple files should be dispatched as one batch event");

console.log("ok - assistant ingests images/PDF via vision+pdf.js, batches multi-image extraction through normalization, then reuses the cleaning pipeline");
