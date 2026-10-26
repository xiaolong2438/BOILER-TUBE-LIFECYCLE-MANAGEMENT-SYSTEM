/* ============================================================
 * AI 数据助手 · 会话附件上下文 v1（纯逻辑底座）
 *
 * 职责（零 DOM、零网络、零 localStorage，可在 node:vm 里整体加载打桩）：
 *   1. registry：会话内记住上传过的图片 / PDF / 表格，最多 3 个（FIFO 淘汰），
 *      序号 seq 从 1 开始递增、移除后不重排，保证「第 2 个」这类指代稳定；
 *      同名 + 同大小 + 同数据行数再次登记时替换旧记录（保留 id 与 seq）。
 *   2. resolveReference：把「这个表 / 这张图 / 第二张 / 最后一个 / 这些附件」
 *      这类自然语言指代解析成具体记录。
 *   3. isImageQuestion：判断用户是不是在「追问图片内容」（与导入/识别动作分开）。
 *   4. describeRegistry / contextForLlm：给人看的摘要、给模型看的紧凑上下文
 *      （后者不含 rows 与 dataUrl，避免把大表格和图片塞进请求）。
 *   5. buildChatMessages / buildVisionMessages：组装多轮对话消息。
 *
 * 约定：
 *   - index 一律指「在 list() 里的 0 基下标」（会随移除变化）；
 *     需要在多轮之间稳定的编号请用 record.seq。
 *   - 指代词去空白后再匹配，因此「第 3 个」「第3个」等价。
 *   - 本轮不修正用户输入里的错别字，识别不到就返回 ok:false，由调用方决定怎么问。
 *   - 传了 rows 时 rowCount 一律由 rows 推导；只做会话摘要回填（没有 rows）时
 *     可以显式给出 rowCount，避免同名附件在回填时被误判成「重复上传」而合并。
 *
 * 挂载：window.BTAssistantAttachments
 * ============================================================ */
(function (global) {
  'use strict';

  var VERSION = 'v1';
  var MAX_ATTACHMENTS = 3;        // 会话内同时保留的附件上限（FIFO 淘汰最旧的）
  var HEADER_LIMIT = 12;          // record.headers 最多保留的列数
  var CHAT_MAX_TURNS = 6;         // buildChatMessages 默认带入的历史条数
  var VISION_MAX_TURNS = 4;       // buildVisionMessages 默认带入的历史条数
  var TURN_CHAR_LIMIT = 200;      // 单条历史文本的截断长度

  var IMAGE_EXT_RE = /^(png|jpe?g|webp|gif|bmp)$/;

  /* ---------------- 指代解析用的正则 ---------------- */

  /* 复数指代：返回 many:true，由调用方决定是「全部处理」还是「逐个处理」 */
  var PLURAL_RE = /这些|那些|它们|这几个|这几张|这几种|所有(?:的)?附件|全部(?:的)?附件|全部|所有/;
  /* 「最后一张 / 最后那个 / 最后一个 / 最后」→ 最新一条 */
  var LAST_RE = /最后(?:一)?(?:个|份|张|条|项|幅|只|页)?/;
  /* 「第 2 个 / 第二张 / 第十一张」；量词必须存在，避免把「第一次」误判成指代 */
  var ORDINAL_RE = /第\s*([0-9]{1,3}|[一二三四五六七八九十百]+)\s*(?:个|份|张|条|项|幅|只|页)/;
  /* 「上一个 / 上一张 / 上一条」→ 当前项的上一项 */
  var PREV_RE = /上一个|上一[份张条]|上一条/;
  /* 「刚才的 / 刚上传的 / 最新的」→ 最近登记的一条（与「当前项」区分开） */
  var LATEST_RE = /刚才(?:的|那个|那张|这个)?|刚上传的?|最新(?:的|上传的)?/;
  /* 单数指示词：这个表 / 这张图 / 该文件 / 这份附件 → 当前项 */
  var DEICTIC_RE = /这个|这张|这份|这条|本次|该(?=表|文件|附件|图|图片|照片|pdf)|本(?=表|文件|附件|图|图片|照片|pdf)/i;

  var CN_DIGITS = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };

  /* ---------------- isImageQuestion 用的正则 ---------------- */

  /* 这些词说明用户在说「图表 / OCR / 意图」等，不是在追问图片内容 */
  var IMAGE_NOISE_RE = /图片识别|识别图片|图表|图例|图书|版图|意图|试图|ocr/gi;
  var IMAGE_WORD_RE = /图|图片|照片|截图/;
  /* 明确的动作指令（导入 / 清洗）交给规则路由，不当作图片追问 */
  var IMAGE_ACTION_RE = /导入|入库|录入|清洗/;
  var QUESTION_RE = /几个|多少|是什么|什么|有没有|是否|请|帮我|看看|看一下|念一下|读一下|怎么|怎样|哪些|哪[个张份条一]|几[个行条点张处种]|\?|？/;

  var KIND_LABELS = { image: '图片', pdf: 'PDF', table: '表格' };

  function toText(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function extensionOf(name) {
    var parts = toText(name).toLowerCase().split('.');
    return parts.length > 1 ? parts[parts.length - 1] : '';
  }

  /* kind 缺省时按扩展名推断：图片 / pdf / 其余一律按表格 */
  function kindOf(kind, name) {
    var value = toText(kind).toLowerCase();
    if (value === 'image' || value === 'pdf' || value === 'table') return value;
    var ext = extensionOf(name);
    if (IMAGE_EXT_RE.test(ext)) return 'image';
    if (ext === 'pdf') return 'pdf';
    return 'table';
  }

  function kindLabel(kind) {
    return KIND_LABELS[kind] || '附件';
  }

  /* 有表头时数据行 = rows.length - 1；空表 / 无 rows 记 0 */
  function rowCountOf(rows) {
    return rows && rows.length ? rows.length - 1 : 0;
  }

  /* 会话摘要回填时只有元信息、没有 rows，允许显式给出数据行数；非法值按 0 */
  function explicitRowCount(value) {
    var n = typeof value === 'number' ? value : parseInt(toText(value), 10);
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
  }

  /* headers 取首行前 12 列；首行不是数组时按「没有表头」处理 */
  function headersOf(rows) {
    if (!rows || !rows.length || !Array.isArray(rows[0])) return [];
    return rows[0].slice(0, HEADER_LIMIT).map(toText);
  }

  function sizeKeyOf(size) {
    return size === null || size === undefined ? '' : toText(size);
  }

  function toInt(value, fallback, min) {
    var n = typeof value === 'number' ? value : parseInt(toText(value), 10);
    if (typeof n !== 'number' || !isFinite(n) || n < min) return fallback;
    return Math.floor(n);
  }

  /* 中文数字一~十（含十一 / 二十 / 一百 这类拼法）转阿拉伯数字，失败返回 NaN */
  function cnToNumber(value) {
    var source = toText(value);
    if (/^[0-9]+$/.test(source)) return parseInt(source, 10);
    var section = 0;
    for (var i = 0; i < source.length; i++) {
      var ch = source.charAt(i);
      if (ch === '十') section = (section === 0 ? 1 : section) * 10;
      else if (ch === '百') section = (section === 0 ? 1 : section) * 100;
      else if (CN_DIGITS[ch] !== undefined) section += CN_DIGITS[ch];
      else return NaN;
    }
    return section;
  }

  /* ---------------- registry ---------------- */

  function createRegistry() {
    var records = [];      // 旧 → 新
    var nextSeq = 1;       // 会话内递增，移除后不回收，保证「第 N 个」稳定
    var currentId = null;

    function indexOf(id) {
      var key = toText(id);
      for (var i = 0; i < records.length; i++) {
        if (toText(records[i].id) === key) return i;
      }
      return -1;
    }

    function recordOf(id) {
      var index = indexOf(id);
      return index >= 0 ? records[index] : null;
    }

    /* current 失效（被移除 / 被 FIFO 淘汰）时回退到最新一条 */
    function syncCurrent() {
      if (currentId !== null && indexOf(currentId) >= 0) return;
      currentId = records.length ? records[records.length - 1].id : null;
    }

    function add(attachment) {
      var input = attachment || {};
      var name = toText(input.name);
      var rows = Array.isArray(input.rows) ? input.rows : null;
      var rowCount = rows ? rowCountOf(rows) : explicitRowCount(input.rowCount);
      var sizeKey = sizeKeyOf(input.size);
      var at = nowIso();
      var i;

      /* 同名 + 同大小 + 同数据行数 → 同一份附件重新上传：替换，不新增 */
      for (i = 0; i < records.length; i++) {
        if (records[i].name === name && sizeKeyOf(records[i].size) === sizeKey && records[i].rowCount === rowCount) {
          var old = records[i];
          old.kind = kindOf(input.kind, name);
          if (rows) {
            old.rows = rows;
            old.rowCount = rowCount;
            old.headers = headersOf(rows);
          }
          old.sheetName = input.sheetName === undefined ? old.sheetName : toText(input.sheetName);
          old.notes = input.notes === undefined ? old.notes : toText(input.notes);
          old.size = input.size === undefined ? old.size : input.size;
          old.dataUrl = input.dataUrl === undefined ? old.dataUrl : (input.dataUrl || null);
          old.at = at;
          /* 重新上传视为一次新登记：没有显式传入导入时间时清空，重新走「导入」判定 */
          old.importedAt = input.importedAt === undefined ? null : input.importedAt;
          currentId = old.id;
          return old;
        }
      }

      var seq = nextSeq++;
      var record = {
        id: 'att-' + seq,
        seq: seq,
        name: name,
        kind: kindOf(input.kind, name),
        rows: rows || [],
        sheetName: toText(input.sheetName),
        notes: toText(input.notes),
        size: input.size === undefined ? null : input.size,
        dataUrl: input.dataUrl === undefined ? null : (input.dataUrl || null),
        at: at,
        rowCount: rowCount,
        headers: headersOf(rows),
        importedAt: input.importedAt === undefined ? null : input.importedAt
      };
      records.push(record);
      currentId = record.id;   // 新登记自动成为当前
      while (records.length > MAX_ATTACHMENTS) records.shift();   // FIFO 淘汰最旧的
      return record;
    }

    function select(id) {
      var record = recordOf(id);
      if (!record) return null;   // 不存在不抛错，由调用方提示
      currentId = record.id;
      return record;
    }

    function remove(id) {
      var index = indexOf(id);
      if (index < 0) return false;
      records.splice(index, 1);
      syncCurrent();
      return true;
    }

    function clear() {
      records.length = 0;
      nextSeq = 1;      // 清空即新会话，序号重新从 1 开始
      currentId = null;
    }

    function bySeq(seq) {
      var n = Number(seq);
      if (!isFinite(n)) return null;
      for (var i = 0; i < records.length; i++) {
        if (records[i].seq === n) return records[i];
      }
      return null;
    }

    return {
      add: add,
      list: function () { return records.slice(0); },
      current: function () { return recordOf(currentId); },
      select: select,
      remove: remove,
      clear: clear,
      bySeq: bySeq,
      latest: function () { return records.length ? records[records.length - 1] : null; },
      size: function () { return records.length; }
    };
  }

  /* ---------------- 只读访问 registry 的小工具 ----------------
     纯函数只走 registry 的公开方法，任何实现了契约的对象都能用。 */

  function listOf(registry) {
    if (!registry || typeof registry.list !== 'function') return [];
    var records = registry.list();
    return Array.isArray(records) ? records : [];
  }

  function currentOf(registry) {
    if (!registry || typeof registry.current !== 'function') return null;
    return registry.current() || null;
  }

  function indexOfRecord(records, record) {
    for (var i = 0; i < records.length; i++) {
      if (records[i] === record) return i;
    }
    return -1;
  }

  /* ---------------- resolveReference ---------------- */

  function missReference(reason) {
    return { ok: false, index: -1, record: null, many: false, reason: reason };
  }

  function hitReference(records, record, many, reason) {
    return { ok: true, index: indexOfRecord(records, record), record: record, many: many, reason: reason };
  }

  function resolveReference(input, registry) {
    var raw = toText(input);
    var textValue = raw.replace(/\s+/g, '');   // 「第 3 个」与「第3个」等价
    if (!textValue) return missReference('没有可解析的文本');
    if (!registry || typeof registry.list !== 'function') return missReference('会话附件上下文不可用');

    var records = listOf(registry);
    if (!records.length) return missReference('当前会话还没有附件，请先上传图片或文件');

    /* 1) 复数指代 */
    if (PLURAL_RE.test(textValue)) {
      var current = currentOf(registry) || records[records.length - 1];
      return hitReference(records, current, true, '指代全部 ' + records.length + ' 个附件');
    }

    /* 2) 最后一张 / 最后那个 */
    if (LAST_RE.test(textValue)) {
      var last = records[records.length - 1];
      return hitReference(records, last, false, '指代最后一个附件');
    }

    /* 3) 第 N 个（按 seq，移除后编号仍然稳定；越界直接判失败，不猜） */
    var ordinal = ORDINAL_RE.exec(textValue);
    if (ordinal) {
      var number = cnToNumber(ordinal[1]);
      if (!isFinite(number) || number < 1) return missReference('附件序号从 1 开始');
      var bySeq = typeof registry.bySeq === 'function' ? registry.bySeq(number) : null;
      if (!bySeq) {
        return missReference('第 ' + number + ' 个附件不存在（当前会话共 ' + records.length + ' 个）');
      }
      return hitReference(records, bySeq, false, '指代第 ' + number + ' 个附件');
    }

    /* 4) 刚才的 / 刚上传的 / 最新的 → 最近登记的一条 */
    if (LATEST_RE.test(textValue)) {
      var latest = records[records.length - 1];
      return hitReference(records, latest, false, '指代最近登记的附件');
    }

    /* 5) 上一个 → 当前项的上一项（没有上一项时退回当前项） */
    if (PREV_RE.test(textValue)) {
      var cur = currentOf(registry) || records[records.length - 1];
      var curIndex = indexOfRecord(records, cur);
      var prev = curIndex > 0 ? records[curIndex - 1] : cur;
      return hitReference(records, prev, false, '指代上一个附件');
    }

    /* 6) 单数指示词 → 当前项（正常情况下 add 后 current 就是最新一条） */
    if (DEICTIC_RE.test(textValue)) {
      var target = currentOf(registry) || records[records.length - 1];
      return hitReference(records, target, false, '指代当前附件');
    }

    return missReference('没有识别到附件指代，请说明是哪一个（如「这个表」「第二张图」「最后一张」）');
  }

  /* ---------------- isImageQuestion ---------------- */

  function isImageQuestion(input) {
    var raw = toText(input);
    if (!raw) return false;
    if (IMAGE_ACTION_RE.test(raw)) return false;                 // 导入 / 清洗走规则路由
    var cleaned = raw.replace(IMAGE_NOISE_RE, '');               // 去掉「图片识别 / 图表 / 意图」这类词
    if (!IMAGE_WORD_RE.test(cleaned)) return false;              // 没有图片指代词
    return QUESTION_RE.test(raw);                                // 必须是疑问或请求
  }

  /* ---------------- 摘要 ---------------- */

  function recordDetail(record) {
    var rows = record.rowCount || 0;
    if (record.kind === 'image') return rows > 0 ? '识别 ' + rows + ' 行' : '未识别出数据行';
    if (record.kind === 'pdf') return rows > 0 ? '提取 ' + rows + ' 行' : '未提取出数据行';
    return rows + ' 行';
  }

  function describeRegistry(registry) {
    var records = listOf(registry);
    if (!records.length) return '会话附件：暂无附件。';
    var parts = [];
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      parts.push(record.seq + ') ' + record.name + '（' + kindLabel(record.kind) + '，' + recordDetail(record) + '）');
    }
    var summary = '会话附件：' + parts.join('；');
    if (currentOf(registry)) summary += ' · 当前';
    return summary;
  }

  /* 给规则 / 模型用的紧凑上下文：只有元信息，不含 rows 与 dataUrl */
  function contextForLlm(registry) {
    var records = listOf(registry);
    var current = currentOf(registry);
    var attachments = [];
    var currentSeq = null;
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      attachments.push({
        seq: record.seq,
        name: record.name,
        kind: record.kind,
        rowCount: record.rowCount,
        headers: (record.headers || []).slice(0)
      });
      if (current && record === current) currentSeq = record.seq;
    }
    return { attachments: attachments, current: currentSeq };
  }

  /* ---------------- 消息组装 ---------------- */

  function normalizeRole(role) {
    var value = toText(role).toLowerCase();
    if (value === 'assistant' || value === 'system' || value === 'user') return value;
    return 'user';
  }

  /* 只保留 role/text（兼容 content），跳过空文本，取最近 maxTurns 条并逐条截断 */
  function appendHistory(messages, history, maxTurns, maxChars) {
    if (!Array.isArray(history) || maxTurns <= 0) return;
    var kept = [];
    var i;
    for (i = 0; i < history.length; i++) {
      var item = history[i] || {};
      var content = item.text;
      if (content === undefined || content === null || content === '') content = item.content;
      content = toText(content);
      if (!content.replace(/\s+/g, '')) continue;   // 跳过空文本
      kept.push({ role: normalizeRole(item.role), content: content });
    }
    if (kept.length > maxTurns) kept = kept.slice(kept.length - maxTurns);
    for (i = 0; i < kept.length; i++) {
      var value = kept[i].content;
      if (value.length > maxChars) value = value.slice(0, maxChars);
      messages.push({ role: kept[i].role, content: value });
    }
  }

  function attachmentLines(registry) {
    var context = contextForLlm(registry);
    var lines = [];
    if (!context.attachments.length) {
      lines.push('  （当前会话没有附件）');
      return lines;
    }
    for (var i = 0; i < context.attachments.length; i++) {
      var item = context.attachments[i];
      var detail = kindLabel(item.kind) + (item.rowCount > 0 ? '，' + item.rowCount + ' 行' : '');
      var columns = item.headers.length ? '，列：' + item.headers.join('/') : '';
      var marker = item.seq === context.current ? ' ← 当前查看' : '';
      lines.push('  ' + item.seq + ') ' + item.name + '（' + detail + columns + '）' + marker);
    }
    return lines;
  }

  function chatSystemPrompt(registry) {
    return '你是严谨的工业数据录入助手，服务于锅炉管全生命周期管理系统。\n' +
      '当前会话可用附件：\n' + attachmentLines(registry).join('\n') + '\n' +
      '回答要求：1) 只依据上面列出的附件信息与对话历史回答，附件里没有的内容必须直接说明「附件中没有该信息」；' +
      '2) 严禁编造任何数值、编号或日期；3) 用简体中文、分点简短回答；' +
      '4) 需要附件明细时，提示用户上传文件或改用图片识别后再导入。';
  }

  function visionSystemPrompt(record) {
    var detail = record.rowCount > 0 ? '，已识别 ' + record.rowCount + ' 行' : '';
    return '你是严谨的工业数据录入助手，正在通过图片回答用户的追问。' +
      '只依据图片回答，看不清就说看不清，严禁编造任何数值、编号或日期。\n' +
      '当前图片：' + record.name + '（图片' + detail + '）。用简体中文简短回答。';
  }

  function buildChatMessages(options) {
    var opts = options || {};
    var maxTurns = toInt(opts.maxTurns, CHAT_MAX_TURNS, 0);
    var maxChars = toInt(opts.maxCharsPerTurn, TURN_CHAR_LIMIT, 1);
    var messages = [{ role: 'system', content: chatSystemPrompt(opts.registry) }];
    appendHistory(messages, opts.history, maxTurns, maxChars);
    messages.push({ role: 'user', content: toText(opts.message) });
    return messages;
  }

  function buildVisionMessages(options) {
    var opts = options || {};
    var record = currentOf(opts.registry);
    if (!record || record.kind !== 'image') return null;                        // 当前附件不是图片
    if (typeof record.dataUrl !== 'string' || !record.dataUrl) return null;     // 没有原图可用
    var maxTurns = toInt(opts.maxTurns, VISION_MAX_TURNS, 0);
    var maxChars = toInt(opts.maxCharsPerTurn, TURN_CHAR_LIMIT, 1);
    var messages = [{ role: 'system', content: visionSystemPrompt(record) }];
    appendHistory(messages, opts.history, maxTurns, maxChars);
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: toText(opts.message) },
        { type: 'image_url', image_url: { url: record.dataUrl } }
      ]
    });
    return messages;
  }

  /* ---------------- 导出 ---------------- */

  global.BTAssistantAttachments = {
    version: VERSION,
    MAX_ATTACHMENTS: MAX_ATTACHMENTS,
    createRegistry: createRegistry,
    resolveReference: resolveReference,
    isImageQuestion: isImageQuestion,
    describeRegistry: describeRegistry,
    contextForLlm: contextForLlm,
    buildChatMessages: buildChatMessages,
    buildVisionMessages: buildVisionMessages
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.BTAssistantAttachments;
})(typeof window !== 'undefined' ? window : this);
