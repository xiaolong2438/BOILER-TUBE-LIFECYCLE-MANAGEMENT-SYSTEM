/* ============================================================
 * AI 数据助手 · 文档识别层 v1（图片 / PDF → 待清洗表格）
 *
 * 职责：把现场常见的非结构化来源（拍照记录、检验报告 PDF）转换成
 *       与 CSV/Excel 上传完全一致的 {rows, sheetName, notes} 结构，
 *       后续清洗 / 预览 / 确认导入 / 撤销全部复用既有管线。
 *
 * 依赖：图片走视觉大模型（app 层的 callVisionLLM）；
 *       PDF 走 pdf.js 文本层（CDN 预载），仅文本扫描版支持，
 *       扫描图片型 PDF 会提示改用截图/拍照走图片识别。
 * 挂载：window.BTAssistantDocs
 * ============================================================ */
(function (global) {
  'use strict';

  var IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];
  var IMAGE_MAX_EDGE = 1568;      // 视觉模型常用安全边长
  var IMAGE_JPEG_QUALITY = 0.85;
  var PDF_MAX_PAGES = 30;
  var PDF_TEXT_CHAR_LIMIT = 9000; // 交给模型兜底提取的文本量
  var PDFJS_CDN_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';

  function text(value) { return value === null || value === undefined ? '' : String(value); }

  function extensionOf(name) {
    var parts = text(name).toLowerCase().split('.');
    return parts.length > 1 ? parts[parts.length - 1] : '';
  }

  function isImageFile(name) { return IMAGE_EXTENSIONS.indexOf(extensionOf(name)) >= 0; }
  function isPdfFile(name) { return extensionOf(name) === 'pdf'; }

  /* ---------------- 通用：视觉/文本模型调用 ---------------- */

  function visionLLMAvailable() {
    return typeof global.callVisionLLM === 'function' && Boolean(
      global.__llmServerKey ||
      (function () {
        try {
          var config = JSON.parse(global.localStorage.getItem('boiler_llm_config') || '{}');
          return config.apiKey && config.model;
        } catch (err) { return false; }
      })()
    );
  }

  function llmUnavailableMessage() {
    return global.__llmServerKey
      ? '服务端模型可用但尚未选择模型，请先在总览「模型接口配置」里点击“识别可用模型”。'
      : '图片识别需要配置大模型：请在总览「模型接口配置」填写 API Key（或由管理员配置服务端密钥）并识别模型。';
  }

  function parseModelJson(raw) {
    var source = text(raw).trim();
    source = source.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    var start = source.indexOf('{');
    var end = source.lastIndexOf('}');
    if(start < 0 || end <= start) throw new Error('模型未返回可解析的 JSON 表格。');
    return JSON.parse(source.slice(start, end + 1));
  }

  function gridFromModelJson(parsed) {
    var headers = Array.isArray(parsed.headers) ? parsed.headers.map(text) : [];
    var rows = Array.isArray(parsed.rows) ? parsed.rows.map(function (row) {
      return Array.isArray(row) ? row.map(text) : [text(row)];
    }) : [];
    var hasBody = rows.some(function (row) {
      return row.some(function (cell) { return text(cell).trim() !== ''; });
    });
    if(headers.length < 2 || !hasBody) throw new Error('模型未从内容中识别出表格（至少两列一行数据）。');
    return { headers: headers, rows: rows, notes: text(parsed.notes).slice(0, 200) };
  }

  /* ---------------- 图片：压缩 → 视觉模型 → 表格 ---------------- */

  function readFileAsDataURL(file) {
    return new Promise(function (resolve, reject) {
      var reader = new global.FileReader();
      reader.onload = function (event) { resolve(event && event.target ? event.target.result : ''); };
      reader.onerror = function () { reject(new Error('读取图片失败。')); };
      reader.readAsDataURL(file);
    });
  }

  function loadImage(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new global.Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('图片解码失败，请换一张清晰的截图或照片。')); };
      img.src = dataUrl;
    });
  }

  function downscaleToJpegDataUrl(img) {
    var scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
    var width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
    var height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
    var canvas = global.document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY);
  }

  var IMAGE_PROMPT = [
    '你是电站锅炉检验数据录入专家。请从图片中提取表格或记录数据，输出严格 JSON（不要包裹 Markdown 代码块）：',
    '{"headers":["列名",...],"rows":[["值",...],...],"notes":"识别备注，含不确定内容"}',
    '要求：',
    '1. 表头尽量映射到本系统模板列：数据分类/炉号/日期/管段编码/规格/材质/厚度(mm)/硬度(HB)/事件类型/更换原因/关联新管码/详细描述/结论；无法对应时保留原文列名。',
    '2. 数据分类按内容判断填「事件」或「更换」；日期统一 YYYY-MM-DD；厚度/硬度只填数字。',
    '3. 看不清或不确定的单元格填空字符串，并在 notes 说明；严禁编造任何数值、编号或日期。',
    '4. 图片里没有表格数据时，headers 与 rows 返回空数组，并在 notes 说明原因。'
  ].join('\n');

  function imageToRows(file) {
    if(!visionLLMAvailable()) return Promise.reject(new Error(llmUnavailableMessage()));
    var compressed = readFileAsDataURL(file).then(loadImage).then(downscaleToJpegDataUrl);
    return compressed.then(function (dataUrl) {
      var messages = [
        { role: 'system', content: '你是严谨的工业数据录入助手，只输出 JSON。' },
        { role: 'user', content: [
          { type: 'text', text: IMAGE_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } }
        ] }
      ];
      return global.callVisionLLM(messages, 3200).then(function (raw) {
        var parsed = gridFromModelJson(parseModelJson(raw));
        return { rows: [parsed.headers].concat(parsed.rows), sheetName: '图片识别', notes: parsed.notes };
      });
    });
  }

  /* ---------------- PDF：pdf.js 文本层 → 行列聚类 ---------------- */

  function ensurePdfJs() {
    if(global.pdfjsLib) {
      if(!global.pdfjsLib.GlobalWorkerOptions.workerSrc) {
        global.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_CDN_BASE + 'pdf.worker.min.js';
      }
      return Promise.resolve(global.pdfjsLib);
    }
    return Promise.reject(new Error('PDF 组件未加载（pdf.js），请检查网络后刷新页面；也可以把报告截图后用图片识别。'));
  }

  function readFileAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var reader = new global.FileReader();
      reader.onload = function (event) { resolve(event && event.target ? event.target.result : null); };
      reader.onerror = function () { reject(new Error('读取 PDF 失败。')); };
      reader.readAsArrayBuffer(file);
    });
  }

  function clusterItemsToRows(items) {
    var cells = items
      .filter(function (item) { return text(item.str).trim() !== ''; })
      .map(function (item) {
        return { str: text(item.str).trim(), x: item.transform[4], y: item.transform[5], w: item.width || 0 };
      })
      .sort(function (a, b) { return b.y - a.y || a.x - b.x; });
    var rows = [];
    cells.forEach(function (cell) {
      var row = rows.length ? rows[rows.length - 1] : null;
      if(row && Math.abs(row.y - cell.y) <= 3.2) {
        row.cells.push(cell);
        row.y = (row.y + cell.y) / 2;
      } else {
        rows.push({ y: cell.y, cells: [cell] });
      }
    });
    var clustered = rows.map(function (row) {
      var sorted = row.cells.sort(function (a, b) { return a.x - b.x; });
      var out = [];
      var prev = null;
      sorted.forEach(function (cell) {
        if(prev && cell.x - (prev.x + prev.w) > 12) out.push(''); // 横向空隙判定为单元格边界
        out.push(cell.str);
        prev = cell;
      });
      return out;
    }).filter(function (row) { return row.length > 1 && row.some(function (cell) { return cell !== ''; }); });
    return dropPhantomColumns(clustered);
  }

  // 列间距过宽时聚类会切出「整列皆空」的幻影列（每个真实列之间插一个空位），统一剔除。
  function dropPhantomColumns(rows) {
    if (!rows.length) return rows;
    var width = 0;
    rows.forEach(function (row) { width = Math.max(width, row.length); });
    rows.forEach(function (row) { while (row.length < width) row.push(''); });
    var keep = [];
    for (var c = 0; c < width; c += 1) {
      var hasValue = false;
      for (var r = 0; r < rows.length; r += 1) {
        if (text(rows[r][c]).trim() !== '') { hasValue = true; break; }
      }
      if (hasValue) keep.push(c);
    }
    if (keep.length === width) return rows;
    return rows.map(function (row) { return keep.map(function (c) { return row[c]; }); });
  }

  function gridLooksTabular(grid) {
    if(grid.length < 2) return false;
    var widths = grid.map(function (row) { return row.length; });
    var max = Math.max.apply(null, widths);
    return max >= 2 && grid.filter(function (row) { return row.length >= Math.max(2, max - 1); }).length >= grid.length - 1;
  }

  function extractTableFromTextViaLLM(pdfText, fileName) {
    if(!visionLLMAvailable()) {
      return Promise.reject(new Error('这份 PDF 的文本层没有可识别的表格，且未配置大模型，无法做兜底提取。可尝试截图后用图片识别。'));
    }
    var messages = [
      { role: 'system', content: '你是严谨的工业数据录入助手，只输出 JSON。' },
      { role: 'user', content: [
        { type: 'text', text: IMAGE_PROMPT + '\n\n以下是从 PDF《' + fileName + '》提取的文本内容（可能乱序，请按语义恢复表格行列）：\n\n' + pdfText.slice(0, PDF_TEXT_CHAR_LIMIT) }
      ] }
    ];
    return global.callVisionLLM(messages, 3200).then(function (raw) {
      var parsed = gridFromModelJson(parseModelJson(raw));
      return { rows: [parsed.headers].concat(parsed.rows), sheetName: 'PDF 智能提取', notes: parsed.notes };
    });
  }

  function pdfToRows(file) {
    var name = text(file && file.name) || 'document.pdf';
    return ensurePdfJs().then(function (pdfjsLib) {
      return readFileAsArrayBuffer(file).then(function (buffer) {
        return pdfjsLib.getDocument({ data: buffer }).promise;
      });
    }).then(function (pdf) {
      var pageCount = Math.min(pdf.numPages, PDF_MAX_PAGES);
      var pagePromises = [];
      for(var i = 1; i <= pageCount; i += 1) {
        pagePromises.push(pdf.getPage(i).then(function (page) {
          return page.getTextContent().then(function (content) {
            return { grid: clusterItemsToRows(content.items || []), rawText: (content.items || []).map(function (item) { return text(item.str); }).join(' ') };
          });
        }));
      }
      return Promise.all(pagePromises).then(function (pages) {
        var grid = [];
        pages.forEach(function (page) { grid = grid.concat(page.grid); });
        if(gridLooksTabular(grid)) {
          var notes = '按 PDF 文本层提取（前 ' + pageCount + ' 页）；扫描图片型 PDF 请改用图片识别。';
          return { rows: grid, sheetName: 'PDF 提取', notes: notes };
        }
        var pdfText = pages.map(function (page) { return page.rawText; }).join('\n').trim();
        if(pdfText.length > 40) return extractTableFromTextViaLLM(pdfText, name);
        throw new Error('PDF 里没有可提取的文本（疑似扫描件），请截图后用图片识别上传。');
      });
    });
  }

  /* ---------------- 导出 ---------------- */

  global.BTAssistantDocs = {
    version: 'v1',
    isImageFile: isImageFile,
    isPdfFile: isPdfFile,
    imageToRows: imageToRows,
    pdfToRows: pdfToRows
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.BTAssistantDocs;
})(typeof window !== 'undefined' ? window : this);
