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
assert.match(docs, /严禁编造任何数值、编号或日期/, "vision prompt must forbid fabricating data");
assert.match(docs, /type: 'image_url'/, "vision message format should be used");
assert.match(docs, /downscaleToJpegDataUrl/, "images should be downscaled before sending");
assert.match(docs, /function dropPhantomColumns\(rows\)/, "phantom empty columns from over-segmentation should be dropped");
assert.match(docs, /return dropPhantomColumns\(clustered\)/, "clustered rows must pass through phantom-column cleanup");

// 接线层：图片/PDF 进入与 CSV 相同的清洗-导入管线；服务端密钥模式可用。
assert.match(wiring, /var docKind = docs && docs\.isImageFile\(name\) \? 'image' : docs && docs\.isPdfFile\(name\) \? 'pdf' : ''/, "handleFile should route image/pdf");
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
assert.match(ui, /accept="\.csv,\.xlsx,\.xls,\.png,\.jpg,\.jpeg,\.webp,\.pdf"/, "file input should accept images and pdf");
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

console.log("ok - assistant ingests images/PDF via vision+pdf.js with drag-and-drop, then reuses the cleaning pipeline");
