/* ============================================================
 * AI 数据助手 · 文档识别层 v3（图片 / PDF / Word → 待清洗表格）
 *
 * v1 职责：把现场常见的非结构化来源（拍照记录、检验报告 PDF）转换成
 *          与 CSV/Excel 上传完全一致的 {rows, sheetName, notes} 结构，
 *          后续清洗 / 预览 / 确认导入 / 撤销全部复用既有管线。
 * v2 增补「提炼层」能力，提高识别结果可直接导入的比例：
 *   1. imagesToRows：多图批量识别。串行调用模型（禁止并发），单张失败
 *      不拖垮整批，全部失败才 reject；表头按首次出现顺序取并集、缺失列
 *      补空串，重复数据行只保留第一行。
 *   2. normalizeCell / normalizeGrid：字段规范化（日期 / 数值 / 编码）。
 *      只做无损清洗，识别不了的值一律保留原文，交给下游清洗层照常报
 *      invalid_date / invalid_number 警告，严禁丢数据。
 *   3. 模型输出不是合法 JSON 时，自动发起一次「修复」请求（最多一次）。
 *   4. 模型返回 uncertain（不确定单元格坐标）时置空对应单元格，并在备注里
 *      提示人工核对。
 * v3 增补 Word（.docx）支持：ZIP 手工解析 + DecompressionStream 解压 +
 *   轻量 OOXML tokenizer 提取 w:tbl 表格（零第三方依赖、浏览器/Node 一致）；
 *   多表合并走 mergeGrids；无表格时正文交给大模型兜底提取。
 *
 * 依赖：图片走视觉大模型（app 层的 callVisionLLM）；
 *       PDF 走 pdf.js 文本层（CDN 预载），仅文本扫描版支持，
 *       扫描图片型 PDF 会提示改用截图/拍照走图片识别；
 *       Word 走浏览器原生 DecompressionStream，未配置模型时无表格文档不能兜底。
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
  var BATCH_MAX_FILES = 8;        // 单次批量识别的图片数量上限
  var REPAIR_OUTPUT_LIMIT = 2000; // 修复请求回传的原始输出上限（字符）
  var NOTE_LIMIT = 200;           // 单张识别备注的长度上限
  var VISION_MAX_TOKENS = 3200;

  var ZERO_WIDTH_RE = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;
  var FULL_WIDTH_RE = /[\uff01-\uff5e]/g;
  var IDEOGRAPHIC_SPACE_RE = /\u3000/g;
  var MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  var DATE_TIME_SUFFIX_RE = /[T\s]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(z|[+-]\d{2}:?\d{2})?$/i;
  var DATE_TEXT_RE = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?$/;
  var DATE_COMPACT_RE = /^(\d{4})(\d{2})(\d{2})$/;
  var THOUSANDS_RE = /,(\d{3})(?!\d)/g;
  var NUMBER_UNIT_RE = /毫米|㎜|mm|hbw|hb|hrc|hrb|hra/gi;
  var PLAIN_NUMBER_RE = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;
  var DATE_HEADER_RE = /日期/;
  var NUMBER_HEADER_RE = /厚度|壁厚|硬度|库存|总长度/;
  var CODE_HEADER_RE = /编码|管码/;
  var UNCERTAIN_NOTE_RE = /(\d+)\s*个单元格识别不确定已置空/;

  function text(value) { return value === null || value === undefined ? '' : String(value); }

  function extensionOf(name) {
    var parts = text(name).toLowerCase().split('.');
    return parts.length > 1 ? parts[parts.length - 1] : '';
  }

  function isImageFile(name) { return IMAGE_EXTENSIONS.indexOf(extensionOf(name)) >= 0; }
  function isPdfFile(name) { return extensionOf(name) === 'pdf'; }

  /* ---------------- 基础清洗：全角 / 零宽 / 空白 ---------------- */

  /* 所有规范化入口都先过这一步：去零宽字符 → 全角转半角 → 去首尾空白。 */
  function cleanText(value) {
    return text(value)
      .replace(ZERO_WIDTH_RE, '')
      .replace(FULL_WIDTH_RE, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xfee0); })
      .replace(IDEOGRAPHIC_SPACE_RE, ' ')
      .trim();
  }

  /* ---------------- 日期归一 ---------------- */

  function pad2(value) { return (value < 10 ? '0' : '') + value; }

  function isLeapYear(year) { return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0; }

  function formatDate(year, month, day) {
    year = Number(year);
    month = Number(month);
    day = Number(day);
    if (!(year >= 1000 && year <= 2999)) return '';
    if (!(month >= 1 && month <= 12)) return '';
    var maxDay = month === 2 && isLeapYear(year) ? 29 : MONTH_DAYS[month - 1];
    if (!(day >= 1 && day <= maxDay)) return '';
    return String(year) + '-' + pad2(month) + '-' + pad2(day);
  }

  /* 日期归一：2024年1月5日 / 2024.1.5 / 2024/1/5 / 2024-1-5 / 20240105 → 2024-01-05。
     识别不了（含 2024-13-45 这类不存在的日期）时返回去空白后的原文，
     让下游清洗层照常报 invalid_date，绝不臆造日期。 */
  function normalizeDate(value) {
    var source = cleanText(value);
    if (source === '') return '';
    var candidate = source.replace(DATE_TIME_SUFFIX_RE, '').trim();
    var matched = DATE_TEXT_RE.exec(candidate) || DATE_COMPACT_RE.exec(candidate);
    if (!matched) return source;
    return formatDate(matched[1], matched[2], matched[3]) || source;
  }

  /* ---------------- 数值归一 ---------------- */

  /* 数值归一：'6.5mm'→'6.5'，'１８３HB'→'183'，'1,234'→'1234'，'6.5（mm）'→'6.5'。
     只做去单位 / 去千分位这类无损处理；'6.5~7.0'、'见附页' 等原样返回。 */
  function normalizeNumber(value) {
    var source = cleanText(value);
    if (source === '') return '';
    var candidate = source;
    var guard = 0;
    while (guard < 3) {
      var next = candidate.replace(THOUSANDS_RE, '$1');
      if (next === candidate) break;
      candidate = next;
      guard += 1;
    }
    candidate = candidate.replace(NUMBER_UNIT_RE, '')
      .replace(/^[()\s（）]+/, '')
      .replace(/[()\s（）]+$/, '');
    if (candidate !== '' && PLAIN_NUMBER_RE.test(candidate)) return candidate;
    return source;
  }

  /* 编码归一：去所有空白（cleanText 已去零宽字符），全角转半角，不改大小写。 */
  function normalizeCode(value) {
    return cleanText(value).replace(/\s+/g, '');
  }

  function normalizeCell(value, header) {
    var cleaned = cleanText(value);
    if (cleaned === '') return '';
    var head = cleanText(header);
    if (DATE_HEADER_RE.test(head)) return normalizeDate(cleaned);
    if (NUMBER_HEADER_RE.test(head)) return normalizeNumber(cleaned);
    if (CODE_HEADER_RE.test(head)) return normalizeCode(cleaned);
    return cleaned;
  }

  function cellArray(row) {
    if (Array.isArray(row)) return row;
    return row === null || row === undefined ? [] : [row];
  }

  /* 整表规范化：返回全新数组（不修改入参），表头行与数据行都处理，幂等。 */
  function normalizeGrid(rows) {
    var grid = Array.isArray(rows) ? rows : [];
    if (!grid.length) return [];
    var width = 0;
    grid.forEach(function (row) { width = Math.max(width, cellArray(row).length); });
    var headers = [];
    for (var c = 0; c < width; c += 1) headers.push(cleanText(cellArray(grid[0])[c]));
    return grid.map(function (row) {
      var cells = cellArray(row);
      var out = [];
      for (var i = 0; i < width; i += 1) out.push(normalizeCell(cells[i], headers[i]));
      return out;
    });
  }

  /* ---------------- 多图合并 ---------------- */

  function normalizeGridList(grids) {
    return (Array.isArray(grids) ? grids : []).map(function (item) {
      if (Array.isArray(item)) return item;
      return item && Array.isArray(item.rows) ? item.rows : [];
    }).filter(function (grid) { return grid.length > 0; });
  }

  function padCells(row, width) {
    var out = [];
    for (var i = 0; i < width; i += 1) out.push(text(row[i]));
    return out;
  }

  /* 多图合并：表头按首次出现顺序取并集，缺失列补空串，重复数据行只保留第一行。
     返回 { rows, notes }，rows[0] 为合并后的表头；整列皆空的幻影列会被剔除。 */
  function mergeGrids(grids) {
    var list = normalizeGridList(grids);
    if (!list.length) return { rows: [], notes: '没有可合并的识别结果。' };

    var headers = [];
    // 用无原型对象做映射：表头文本来自模型输出，可能是 constructor / __proto__ 这类键
    var headerSlots = Object.create(null);   // 表头文本 → 依次出现的并集列号（同名重复列按出现次序对齐）
    var plans = [];

    function slotFor(key, occurrence) {
      var slots = headerSlots[key];
      if (!slots) { slots = []; headerSlots[key] = slots; }
      while (slots.length <= occurrence) {
        slots.push(headers.length);
        headers.push(key);
      }
      return slots[occurrence];
    }

    list.forEach(function (grid) {
      var width = 0;
      grid.forEach(function (row) { width = Math.max(width, cellArray(row).length); });
      var head = padCells(cellArray(grid[0]), width).map(cleanText);
      var seen = Object.create(null);
      var map = head.map(function (key) {
        var occurrence = seen[key] || 0;
        seen[key] = occurrence + 1;
        return slotFor(key, occurrence);
      });
      plans.push({ grid: grid, width: width, map: map });
    });

    var dataRows = [];
    var seenRowKeys = Object.create(null);
    var duplicateCount = 0;
    var blankCount = 0;

    plans.forEach(function (plan) {
      for (var r = 1; r < plan.grid.length; r += 1) {
        var cells = padCells(cellArray(plan.grid[r]), plan.width).map(cleanText);
        var isBlank = cells.every(function (cell) { return cell === ''; });
        if (isBlank) { blankCount += 1; continue; }
        var out = [];
        for (var c = 0; c < headers.length; c += 1) out.push('');
        plan.map.forEach(function (target, source) { out[target] = cells[source]; });
        var key = out.join('\u0001');
        if (Object.prototype.hasOwnProperty.call(seenRowKeys, key)) { duplicateCount += 1; continue; }
        seenRowKeys[key] = true;
        dataRows.push(out);
      }
    });

    var keep = [];
    for (var col = 0; col < headers.length; col += 1) {
      var filled = headers[col] !== '';
      if (!filled) {
        for (var row = 0; row < dataRows.length; row += 1) {
          if (dataRows[row][col] !== '') { filled = true; break; }
        }
      }
      if (filled) keep.push(col);
    }

    var outHeaders = keep.map(function (index) { return headers[index]; });
    var outRows = dataRows.map(function (row) {
      return keep.map(function (index) { return row[index]; });
    });
    var extras = [];
    if (duplicateCount) extras.push('已去重 ' + duplicateCount + ' 行');
    if (blankCount) extras.push('已丢弃 ' + blankCount + ' 行空行');
    var notes = '合并 ' + list.length + ' 份识别结果：表头 ' + outHeaders.length + ' 列，数据 ' + outRows.length + ' 行'
      + (extras.length ? '（' + extras.join('，') + '）' : '') + '。';
    return { rows: [outHeaders].concat(outRows), notes: notes };
  }

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
    // 去掉模型可能包裹的 Markdown 代码围栏（\x60\x60\x60 即三个反引号）
    source = source.replace(/^\x60\x60\x60json\s*/i, '').replace(/^\x60\x60\x60\s*/, '').replace(/\x60\x60\x60\s*$/, '').trim();
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
    return {
      headers: headers,
      rows: rows,
      notes: text(parsed.notes).slice(0, NOTE_LIMIT),
      uncertain: Array.isArray(parsed.uncertain) ? parsed.uncertain : []
    };
  }

  function errorMessage(err) {
    return err && err.message ? err.message : String(err);
  }

  function outputSnippet(raw) {
    return text(raw).replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  /* 模型输出不是合法 JSON 时，补一轮「修复」请求（最多一次）：把原始输出与解析
     错误回传，要求只输出 JSON；仍失败则 reject，错误信息含原始输出片段。 */
  function requestGrid(messages, maxTokens) {
    return global.callVisionLLM(messages, maxTokens).then(function (raw) {
      var parsed = null;
      var parseError = '';
      try { parsed = parseModelJson(raw); }
      catch (err) { parseError = errorMessage(err); }
      if (!parseError) return gridFromModelJson(parsed);

      var repairMessages = messages.concat([
        { role: 'assistant', content: text(raw).slice(0, REPAIR_OUTPUT_LIMIT) },
        { role: 'user', content: '上面的输出不是合法 JSON（解析错误：' + parseError + '）。'
          + '请只输出一个 JSON 对象，不要解释、不要 Markdown 代码块，格式为 {"headers":["列名"],"rows":[["值"]]}；'
          + '看不清的单元格填空字符串，严禁编造任何数值、编号或日期。' }
      ]);
      return global.callVisionLLM(repairMessages, maxTokens).then(function (repaired) {
        var second = null;
        try { second = parseModelJson(repaired); }
        catch (err) {
          throw new Error('模型两次输出都不是可解析的 JSON（' + errorMessage(err) + '）。'
            + '原始输出片段：' + outputSnippet(raw) + '；修复后输出片段：' + outputSnippet(repaired));
        }
        try { return gridFromModelJson(second); }
        catch (err) {
          throw new Error(errorMessage(err) + '原始输出片段：' + outputSnippet(raw) + '；修复后输出片段：' + outputSnippet(repaired));
        }
      }, function (err) {
        throw new Error('模型输出不是可解析的 JSON（' + parseError + '），修复请求也失败：' + errorMessage(err)
          + '。原始输出片段：' + outputSnippet(raw));
      });
    });
  }

  /* ---------------- 不确定单元格 ---------------- */

  function toIndex(value) {
    if (typeof value === 'number' && isFinite(value) && value >= 0 && Math.floor(value) === value) return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
    return -1;
  }

  /* 视觉模型额外返回的 uncertain: [[数据行号, 列号], ...]（0-based、不含表头）。
     命中位置置空字符串；越界 / 非法项安全忽略；返回实际置空的单元格数。 */
  function applyUncertainCells(gridRows, uncertain) {
    if (!Array.isArray(uncertain)) return 0;
    var seen = {};
    var count = 0;
    uncertain.forEach(function (entry) {
      if (!Array.isArray(entry) || entry.length < 2) return;
      var dataRow = toIndex(entry[0]);
      var column = toIndex(entry[1]);
      if (dataRow < 0 || column < 0) return;
      var row = gridRows[dataRow + 1];
      if (!Array.isArray(row) || column >= row.length) return;
      var key = dataRow + ':' + column;
      if (seen[key]) return;
      seen[key] = true;
      row[column] = '';
      count += 1;
    });
    return count;
  }

  /* 模型结果 → 统一结构：不确定单元格置空 → 字段规范化 → 备注带上不确定提示。 */
  function buildGridResult(grid, sheetName) {
    var gridRows = [grid.headers].concat(grid.rows);
    var uncertainCount = applyUncertainCells(gridRows, grid.uncertain);
    var notes = text(grid.notes).slice(0, NOTE_LIMIT);
    if (uncertainCount > 0) {
      notes = (notes ? notes + '；' : '') + uncertainCount + ' 个单元格识别不确定已置空，请人工核对';
    }
    return { rows: normalizeGrid(gridRows), sheetName: sheetName, notes: notes };
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
    '{"headers":["列名",...],"rows":[["值",...],...],"notes":"识别备注，含不确定内容","uncertain":[[数据行号,列号],...]}',
    '要求：',
    '1. 表头尽量映射到本系统模板列：数据分类/炉号/日期/管段编码/规格/材质/厚度(mm)/硬度(HB)/事件类型/更换原因/关联新管码/详细描述/结论；无法对应时保留原文列名。',
    '2. 数据分类按内容判断填「事件」或「更换」；日期统一 YYYY-MM-DD；厚度/硬度只填数字。',
    '3. 看不清或不确定的单元格填空字符串，并在 notes 说明；严禁编造任何数值、编号或日期。',
    '4. 图片里没有表格数据时，headers 与 rows 返回空数组，并在 notes 说明原因。',
    '5. 有拿不准的单元格时，另用 uncertain 列出坐标：[[数据行号,列号],...]，从 0 开始且不含表头行；这些单元格同时填空字符串。'
  ].join('\n');

  /* 压缩后的图片 dataURL：多轮对话追问时需要重发原图，因此单独导出，复用同一条压缩管线。 */
  function imageToDataUrl(file) {
    return readFileAsDataURL(file).then(loadImage).then(downscaleToJpegDataUrl);
  }

  function imageToRows(file) {
    if(!visionLLMAvailable()) return Promise.reject(new Error(llmUnavailableMessage()));
    var compressed = imageToDataUrl(file);
    return compressed.then(function (dataUrl) {
      var messages = [
        { role: 'system', content: '你是严谨的工业数据录入助手，只输出 JSON。' },
        { role: 'user', content: [
          { type: 'text', text: IMAGE_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } }
        ] }
      ];
      return requestGrid(messages, VISION_MAX_TOKENS).then(function (grid) {
        var result = buildGridResult(grid, '图片识别');
        result.dataUrl = dataUrl; /* 供会话附件上下文在多轮追问时重发原图 */
        return result;
      });
    });
  }

  /* ---------------- 多图批量识别 ---------------- */

  function fileListToArray(files) {
    if (!files) return [];
    if (Array.isArray(files)) return files.slice();
    if (typeof files.length === 'number') {
      var out = [];
      for (var i = 0; i < files.length; i += 1) out.push(files[i]);
      return out;
    }
    return [files];
  }

  function imageNameOf(file, index) {
    return text(file && file.name) || ('图片' + (index + 1));
  }

  function callOnProgress(onProgress, index, total, name) {
    if (typeof onProgress !== 'function') return;
    try { onProgress(index, total, name); } catch (err) { /* 进度回调异常不能影响识别 */ }
  }

  function countUncertainCells(notes) {
    var matched = UNCERTAIN_NOTE_RE.exec(text(notes));
    return matched ? Number(matched[1]) : 0;
  }

  /* 多图批量识别：串行处理（禁止并发调用模型），单张失败不整体失败，
     全部失败才 reject；合并结果的数据行 = rows.length - 1 且已去重。 */
  function imagesToRows(files, options) {
    var opts = options || {};
    var list = fileListToArray(files);
    if (!list.length) return Promise.reject(new Error('没有可识别的图片文件，请先选择图片。'));
    var maxFiles = typeof opts.maxFiles === 'number' && opts.maxFiles > 0 ? Math.floor(opts.maxFiles) : BATCH_MAX_FILES;
    if (list.length > maxFiles) {
      return Promise.reject(new Error('一次最多识别 ' + maxFiles + ' 张图片，当前选择了 ' + list.length + ' 张，请分批上传。'));
    }

    var results = [];
    /* 第一张的进度回调同步发出，保证调用方立刻能看到阶段反馈 */
    callOnProgress(opts.onProgress, 0, list.length, imageNameOf(list[0], 0));

    var chain = Promise.resolve();
    list.forEach(function (file, index) {
      chain = chain.then(function () {
        var name = imageNameOf(file, index);
        if (index > 0) callOnProgress(opts.onProgress, index, list.length, name);
        return Promise.resolve().then(function () {
          return imageToRows(file);
        }).then(function (parsed) {
          results.push({
            name: name,
            ok: true,
            rows: parsed.rows,
            sheetName: parsed.sheetName,
            notes: parsed.notes,
            dataUrl: parsed.dataUrl
          });
        }, function (err) {
          results.push({ name: name, ok: false, error: errorMessage(err) });
        });
      });
    });

    return chain.then(function () {
      var okResults = results.filter(function (item) { return item.ok; });
      var failed = results.filter(function (item) { return !item.ok; });
      if (!okResults.length) {
        throw new Error('这 ' + list.length + ' 张图片全部识别失败：' + failed[0].name + '：' + failed[0].error);
      }
      var merged = mergeGrids(okResults.map(function (item) { return item.rows; }));
      var uncertainCount = okResults.reduce(function (sum, item) {
        return sum + countUncertainCells(item.notes);
      }, 0);
      var failedDetail = failed.map(function (item) { return item.name + '：' + item.error; }).join('；');
      var parts = [];
      parts.push('批量识别完成：成功 ' + okResults.length + ' 张，失败 ' + failed.length + ' 张'
        + (failed.length ? '（' + failedDetail + '）' : '') + '。');
      parts.push(merged.notes);
      if (uncertainCount > 0) parts.push(uncertainCount + ' 个单元格识别不确定已置空，请人工核对。');
      return {
        rows: merged.rows,
        sheetName: '图片识别(' + list.length + '张)',
        notes: parts.join(''),
        results: results
      };
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

  function extractTableFromTextViaLLM(pdfText, fileName, sourceLabel) {
    var label = text(sourceLabel) || 'PDF';
    if(!visionLLMAvailable()) {
      return Promise.reject(new Error('这份' + label + '的文本层没有可识别的表格，且未配置大模型，无法做兜底提取。可尝试截图后用图片识别。'));
    }
    var messages = [
      { role: 'system', content: '你是严谨的工业数据录入助手，只输出 JSON。' },
      { role: 'user', content: [
        { type: 'text', text: IMAGE_PROMPT + '\n\n以下是从' + label + '《' + fileName + '》提取的文本内容（可能乱序，请按语义恢复表格行列）：\n\n' + pdfText.slice(0, PDF_TEXT_CHAR_LIMIT) }
      ] }
    ];
    return requestGrid(messages, VISION_MAX_TOKENS).then(function (grid) {
      return buildGridResult(grid, label + ' 智能提取');
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

  /* ---------------- Word（.docx）：ZIP 解压 + OOXML 表格提取 ----------------
   * .docx 是 ZIP 容器，正文在 word/document.xml。这里不依赖任何第三方库：
   * ZIP 手工解析（EOCD → 中央目录 → 本地头），deflate 用浏览器原生的
   * DecompressionStream('deflate-raw')；XML 用轻量 tokenizer 提取 w:tbl 表格，
   * 浏览器与 Node 行为完全一致。没有表格时把正文文字交给大模型兜底提取。 */

  function isDocxFile(name) { return extensionOf(name) === 'docx'; }

  var ZIP_EOCD_SIG = 0x06054b50;
  var ZIP_CENTRAL_SIG = 0x02014b50;
  var ZIP_LOCAL_SIG = 0x04034b50;
  var ZIP_EOCD_MAX_SCAN = 65558;   /* EOCD 最长 22 字节 + 每条目注释上限 65535 */
  var DOCX_ENTRY_NAME = 'word/document.xml';

  function findEOCD(view) {
    for (var i = view.byteLength - 22; i >= Math.max(0, view.byteLength - ZIP_EOCD_MAX_SCAN); i -= 1) {
      if (view.getUint32(i, true) === ZIP_EOCD_SIG) return i;
    }
    return -1;
  }

  /* 解析 ZIP 中央目录：文件名 → { method, compressedSize, localOffset } */
  function parseZipEntries(buffer) {
    var view = new DataView(buffer);
    var eocd = findEOCD(view);
    if (eocd < 0) throw new Error('这不是有效的 DOCX 文件（找不到 ZIP 目录），请确认文件没有损坏。');
    var count = view.getUint16(eocd + 10, true);
    var offset = view.getUint32(eocd + 16, true);
    var decoder = new TextDecoder('utf-8');
    var entries = {};
    for (var i = 0; i < count; i += 1) {
      if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== ZIP_CENTRAL_SIG) {
        throw new Error('DOCX 的 ZIP 目录损坏，无法解析。');
      }
      var method = view.getUint16(offset + 10, true);
      var compressedSize = view.getUint32(offset + 20, true);
      var nameLen = view.getUint16(offset + 28, true);
      var extraLen = view.getUint16(offset + 30, true);
      var commentLen = view.getUint16(offset + 32, true);
      var localOffset = view.getUint32(offset + 42, true);
      var name = decoder.decode(new Uint8Array(buffer, offset + 46, nameLen));
      entries[name.replace(/^\/+/, '')] = { method: method, compressedSize: compressedSize, localOffset: localOffset };
      offset += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function collectStream(stream) {
    if (typeof global.Response === 'function') {
      return new global.Response(stream).arrayBuffer().then(function (buffer) {
        return new Uint8Array(buffer);
      });
    }
    var reader = stream.getReader();
    var chunks = [];
    function pump() {
      return reader.read().then(function (result) {
        if (result.done) {
          var total = 0;
          chunks.forEach(function (chunk) { total += chunk.length; });
          var out = new Uint8Array(total);
          var offset = 0;
          chunks.forEach(function (chunk) { out.set(chunk, offset); offset += chunk.length; });
          return out;
        }
        chunks.push(result.value);
        return pump();
      });
    }
    return pump();
  }

  /* deflate-raw 解压（ZIP method 8）；环境不支持时给出可操作的中文提示 */
  function inflateRaw(bytes) {
    if (typeof global.DecompressionStream !== 'function' || typeof global.ReadableStream !== 'function') {
      throw new Error('当前浏览器不支持解压 DOCX，请改用较新版本的 Chrome / Edge，或把内容另存为 CSV / 截图后用图片识别。');
    }
    var stream = new global.ReadableStream({
      start: function (controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    }).pipeThrough(new global.DecompressionStream('deflate-raw'));
    return collectStream(stream);
  }

  function readZipEntry(buffer, entries, name) {
    var entry = entries[name];
    if (!entry) return null;
    var view = new DataView(buffer);
    var p = entry.localOffset;
    if (p + 30 > view.byteLength || view.getUint32(p, true) !== ZIP_LOCAL_SIG) {
      throw new Error('DOCX 内部数据损坏（本地文件头无效）。');
    }
    var nameLen = view.getUint16(p + 26, true);
    var extraLen = view.getUint16(p + 28, true);
    var dataStart = p + 30 + nameLen + extraLen;
    if (dataStart + entry.compressedSize > view.byteLength) {
      throw new Error('DOCX 内部数据损坏（数据长度越界）。');
    }
    var raw = new Uint8Array(buffer, dataStart, entry.compressedSize);
    if (entry.method === 0) return Promise.resolve(raw);
    if (entry.method !== 8) {
      return Promise.reject(new Error('DOCX 使用了不支持的压缩方式（method ' + entry.method + '）。'));
    }
    return inflateRaw(raw);
  }

  var XML_ENTITY_RE = /&(?:lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;

  function decodeXmlText(value) {
    return String(value === null || value === undefined ? '' : value).replace(XML_ENTITY_RE, function (entity) {
      if (entity === '&lt;') return '<';
      if (entity === '&gt;') return '>';
      if (entity === '&quot;') return '"';
      if (entity === '&apos;') return "'";
      if (entity === '&amp;') return '&';
      var code = entity.charAt(2) === 'x' || entity.charAt(2) === 'X'
        ? parseInt(entity.slice(3, -1), 16)
        : parseInt(entity.slice(2, -1), 10);
      return isFinite(code) && code > 0 ? String.fromCodePoint(code) : entity;
    });
  }

  var XML_TAG_RE = /<\/?[A-Za-z][^>]*>/g;
  var XML_TAG_NAME_RE = /^<\/?([A-Za-z0-9:]+)/;

  function xmlAttr(tag, attr) {
    var matched = new RegExp(attr + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')').exec(tag);
    if (!matched) return '';
    return matched[2] !== undefined ? matched[2] : matched[3];
  }

  /* document.xml → { tables: [ [ [单元格,...], ... ], ... ], lines: [正文段落] }。
     只提取顶层的 w:tbl（嵌套表格随父单元格忽略）；w:gridSpan 补空列对齐；
     单元格内多段落合并为一段文字。不依赖 DOMParser，浏览器 / Node 行为一致。 */
  function parseDocxDocument(xmlText) {
    var tables = [];
    var lines = [];
    var tblDepth = 0;
    var table = null;
    var row = null;
    var cell = null;
    var cellSpan = 1;
    var paragraph = null;
    var inT = false;
    var tBuffer = '';
    var lastTagEnd = 0;
    var match;

    function flushT() {
      if (!inT) return;
      var piece = decodeXmlText(tBuffer);
      if (cell) cell.parts.push(piece);
      else if (paragraph) paragraph.push(piece);
      tBuffer = '';
      inT = false;
    }

    XML_TAG_RE.lastIndex = 0;
    while ((match = XML_TAG_RE.exec(xmlText)) !== null) {
      var tag = match[0];
      if (inT) tBuffer += xmlText.slice(lastTagEnd, match.index);
      lastTagEnd = XML_TAG_RE.lastIndex;
      var isClose = tag.charAt(1) === '/';
      var isSelfClose = tag.charAt(tag.length - 2) === '/';
      var nameMatch = XML_TAG_NAME_RE.exec(tag);
      var name = nameMatch ? nameMatch[1] : '';

      if (name === 'w:t') {
        if (isClose || isSelfClose) flushT();
        else { flushT(); inT = true; tBuffer = ''; }
        continue;
      }
      flushT();

      if (name === 'w:tbl') {
        if (isClose) {
          tblDepth = Math.max(0, tblDepth - 1);
          if (tblDepth === 0) { table = null; row = null; cell = null; }
        } else if (!isSelfClose) {
          tblDepth += 1;
          if (tblDepth === 1) { table = []; tables.push(table); }
        }
        continue;
      }
      if (name === 'w:tr') {
        if (tblDepth === 1 && table) {
          if (isClose) { if (row) { table.push(row); row = null; } cell = null; }
          else if (!isSelfClose) { row = []; }
        }
        continue;
      }
      if (name === 'w:tc') {
        if (tblDepth === 1 && row) {
          if (isClose) {
            var cellText = cell ? cell.parts.join('').replace(/\s+/g, ' ').trim() : '';
            row.push(cellText);
            for (var pad = 1; pad < cellSpan; pad += 1) row.push('');
            cellSpan = 1;
            cell = null;
          } else if (!isSelfClose) {
            cell = { parts: [] };
          }
        }
        continue;
      }
      if (name === 'w:gridSpan' && cell && !isClose) {
        var span = parseInt(xmlAttr(tag, 'w:val'), 10);
        if (isFinite(span) && span > 1) cellSpan = Math.min(span, 64);
        continue;
      }
      if (name === 'w:p') {
        if (isClose || isSelfClose) {
          if (cell) cell.parts.push(' ');
          else if (tblDepth === 0 && paragraph) {
            var line = paragraph.join('').replace(/\s+/g, ' ').trim();
            if (line) lines.push(line);
            paragraph = null;
          }
        } else if (!isSelfClose && tblDepth === 0 && !cell) {
          paragraph = [];
        }
        continue;
      }
    }
    flushT();
    return { tables: tables, lines: lines };
  }

  function gridWidth(grid) {
    var width = 0;
    grid.forEach(function (row) { width = Math.max(width, cellArray(row).length); });
    return width;
  }

  function docxToRows(file) {
    var name = text(file && file.name) || 'document.docx';
    return readFileAsArrayBuffer(file).then(function (buffer) {
      if (!buffer) throw new Error('读取 Word 文件失败。');
      var entries = parseZipEntries(buffer);
      var entryName = Object.keys(entries).filter(function (key) { return key === DOCX_ENTRY_NAME; })[0];
      if (!entryName) throw new Error('这不是标准的 Word 文档（缺少正文部分），请另存为 .docx 后重试。');
      return readZipEntry(buffer, entries, entryName);
    }).then(function (bytes) {
      var xml = new TextDecoder('utf-8').decode(bytes);
      var parsed = parseDocxDocument(xml);
      var usable = parsed.tables.filter(function (grid) {
        return grid.length >= 2 && gridWidth(grid) >= 2;
      });
      if (usable.length) {
        var merged = mergeGrids(usable.map(function (grid) { return normalizeGrid(grid); }));
        return {
          rows: merged.rows,
          sheetName: 'Word 表格',
          notes: '从 Word 提取 ' + usable.length + ' 个表格；' + merged.notes
        };
      }
      var bodyText = parsed.lines.join('\n').trim();
      if (bodyText.length > 40) {
        return extractTableFromTextViaLLM(bodyText, name, 'Word').then(function (result) {
          return {
            rows: result.rows,
            sheetName: 'Word 智能提取',
            notes: text(result.notes)
          };
        });
      }
      throw new Error('Word 里没有找到表格或可提取的文字内容，请检查文档内容。');
    });
  }

  /* ---------------- 导出 ---------------- */

  global.BTAssistantDocs = {
    version: 'v3',
    isImageFile: isImageFile,
    isPdfFile: isPdfFile,
    isDocxFile: isDocxFile,
    imageToRows: imageToRows,
    pdfToRows: pdfToRows,
    docxToRows: docxToRows,
    parseDocxDocument: parseDocxDocument,
    imageToDataUrl: imageToDataUrl,
    imagesToRows: imagesToRows,
    mergeGrids: mergeGrids,
    normalizeGrid: normalizeGrid,
    normalizeCell: normalizeCell,
    normalizeDate: normalizeDate,
    normalizeNumber: normalizeNumber
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.BTAssistantDocs;
})(typeof window !== 'undefined' ? window : this);
