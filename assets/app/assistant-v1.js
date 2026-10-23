/* ============================================================
 * AI 数据助手 · 接线层 v1
 * 契约：docs/ai-assistant-spec.md §5 / §7
 *
 * 职责：把「领域层 BTAssistantCore」「UI 层 BTAssistantUI」接到既有应用上：
 *   - 读取页面全局数据（userDB / 材料库 / 台账矩阵 / 预警 / 超期清单）
 *   - 复用既有导入、导出、落盘与模型配置
 *   - 维护待处理文件、会话历史、撤销快照
 * 约束：不重复实现清洗/解析规则（全部交给领域层），不改变既有函数的对外行为。
 * ============================================================ */
(function (global) {
  'use strict';

  var VERSION = 'v1';
  var HISTORY_KEY = 'boiler_assistant_history';
  var LAST_IMPORT_KEY = 'boiler_assistant_last_import';
  var LAST_EDIT_KEY = 'boiler_assistant_last_edit';
  var MAX_CONVERSATIONS = 20;
  var MAX_MESSAGES = 60;
  var MAX_QUERY_ROWS = 12;
  var MAX_IMPORT_ROWS = 5000;
  var LLM_MAX_TOKENS = 420;

  var state = {
    messages: [],
    busy: false,
    conversations: [],
    activeConversationId: null,
    historyOpen: false,
    pendingFile: null,
    pendingCleaning: null,
    lastImport: null,
    lastEdit: null,
    mounted: false
  };
  var controller = null;
  var mountRoot = null;
  var seq = 0;

  /* ---------------- 基础工具 ---------------- */

  function core() {
    return global.BTAssistantCore || null;
  }

  function ui() {
    return global.BTAssistantUI || null;
  }

  function nextId(prefix) {
    seq += 1;
    return prefix + '-' + Date.now().toString(36) + '-' + seq;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function readJSON(key, fallback) {
    try {
      var raw = global.localStorage ? global.localStorage.getItem(key) : null;
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (err) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      if (global.localStorage) global.localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      /* 隐私模式或配额不足时静默降级为仅本次会话 */
    }
  }

  function removeKey(key) {
    try {
      if (global.localStorage) global.localStorage.removeItem(key);
    } catch (err) {
      /* 忽略 */
    }
  }

  function toast(message, tone) {
    if (typeof global.showToast === 'function') {
      try {
        global.showToast(message, tone || 'info');
        return;
      } catch (err) {
        /* 继续走控制台 */
      }
    }
    if (global.console && typeof global.console.log === 'function') global.console.log('[AI 助手] ' + message);
  }

  function readUserDB() {
    try {
      /* app-v7.9.js 用 let 声明 userDB（全局词法绑定，不是 window 属性） */
      return typeof userDB !== 'undefined' ? userDB : null;
    } catch (err) {
      return null;
    }
  }

  function callApp(name) {
    var fn = global[name];
    if (typeof fn !== 'function') return null;
    var args = Array.prototype.slice.call(arguments, 1);
    try {
      return fn.apply(global, args);
    } catch (err) {
      if (global.console && typeof global.console.error === 'function') global.console.error('[AI 助手] 调用 ' + name + ' 失败', err);
      return null;
    }
  }

  function currentRole() {
    var role = callApp('getAssistantRole');
    var module = core();
    if (module && typeof module.normalizeRole === 'function') return module.normalizeRole(role);
    return role === 'admin' || role === 'viewer' ? role : 'editor';
  }

  function llmConfig() {
    var config = callApp('getLLMConfig');
    if (!config || typeof config !== 'object') {
      // 既有应用未加载时直接读同一份配置（键名与 app-v7.9.js 的 LLM_CONFIG_KEY 一致）
      config = readJSON('boiler_llm_config', null);
    }
    if (!config || typeof config !== 'object') return null;
    return config;
  }

  function llmConfigured() {
    var config = llmConfig();
    return Boolean(config && config.baseUrl && config.apiKey && config.model);
  }

  function snapshot(options) {
    var collected = callApp('collectAssistantSnapshot', options || {});
    if (collected && typeof collected === 'object') return collected;
    var db = readUserDB() || { events: [], replacements: [] };
    return {
      events: Array.isArray(db.events) ? db.events : [],
      replacements: Array.isArray(db.replacements) ? db.replacements : [],
      materialLibrary: [],
      matrix: [],
      retiredCodes: [],
      warnings: [],
      overdueRows: [],
      ledgerRows: [],
      role: currentRole(),
      now: nowIso()
    };
  }

  function splitLines(source) {
    var raw = text(source);
    var lines = [];
    var current = '';
    for (var i = 0; i < raw.length; i += 1) {
      var ch = raw.charAt(i);
      if (ch === String.fromCharCode(13)) continue;
      if (ch === String.fromCharCode(10)) {
        lines.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    lines.push(current);
    return lines;
  }

  function parseCsvRows(content) {
    var lines = splitLines(content);
    var rows = [];
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      if (!line.trim()) {
        rows.push(['']);
        continue;
      }
      if (typeof global.parseCSVLine === 'function') rows.push(global.parseCSVLine(line));
      else rows.push(line.split(','));
    }
    return rows;
  }

  function parseXlsxRows(buffer) {
    var sheetjs = global.XLSX;
    if (!sheetjs || typeof sheetjs.read !== 'function') throw new Error('Excel 解析组件未加载，请改用 CSV 文件。');
    var workbook = sheetjs.read(new Uint8Array(buffer), { type: 'array' });
    var sheetName = workbook.SheetNames && workbook.SheetNames[0] ? workbook.SheetNames[0] : '';
    var sheet = workbook.Sheets ? workbook.Sheets[sheetName] : null;
    if (!sheet) throw new Error('Excel 中没有可读取的工作表。');
    var rows = sheetjs.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    var normalized = [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      normalized.push(Array.isArray(row) ? row.map(function (cell) { return text(cell); }) : ['']);
    }
    return { rows: normalized, sheetName: sheetName };
  }

  function fileExtension(name) {
    var parts = text(name).toLowerCase().split('.');
    return parts.length > 1 ? parts[parts.length - 1] : '';
  }

  function readFileAsText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new global.FileReader();
      reader.onload = function (event) {
        resolve(text(event && event.target ? event.target.result : ''));
      };
      reader.onerror = function () {
        reject(new Error('读取文件失败，请重试。'));
      };
      reader.readAsText(file, 'UTF-8');
    });
  }

  function readFileAsBuffer(file) {
    return new Promise(function (resolve, reject) {
      var reader = new global.FileReader();
      reader.onload = function (event) {
        resolve(event && event.target ? event.target.result : null);
      };
      reader.onerror = function () {
        reject(new Error('读取文件失败，请重试。'));
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /* ---------------- 会话历史 ---------------- */

  function loadHistory() {
    var stored = readJSON(HISTORY_KEY, []);
    var list = Array.isArray(stored) ? stored : [];
    state.conversations = list
      .filter(function (item) { return item && typeof item === 'object' && item.id; })
      .map(function (item) {
        return {
          id: text(item.id),
          title: text(item.title) || '未命名会话',
          updatedAt: text(item.updatedAt) || nowIso(),
          messages: Array.isArray(item.messages) ? item.messages.filter(function (msg) {
            return msg && (msg.role === 'user' || msg.role === 'assistant') && text(msg.text);
          }).slice(-MAX_MESSAGES).map(function (msg) {
            return {
              id: text(msg.id) || nextId('h'),
              role: msg.role === 'user' ? 'user' : 'assistant',
              text: text(msg.text),
              createdAt: text(msg.createdAt) || nowIso()
            };
          }) : []
        };
      })
      .sort(function (a, b) { return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(); })
      .slice(0, MAX_CONVERSATIONS);
  }

  function saveHistory() {
    var persisted = state.conversations.slice(0, MAX_CONVERSATIONS).map(function (conv) {
      return {
        id: conv.id,
        title: conv.title,
        updatedAt: conv.updatedAt,
        messages: conv.messages.slice(-MAX_MESSAGES).map(function (msg) {
          return { id: msg.id, role: msg.role, text: msg.text, createdAt: msg.createdAt };
        })
      };
    });
    writeJSON(HISTORY_KEY, persisted);
  }

  function syncConversation() {
    var conv = null;
    for (var i = 0; i < state.conversations.length; i += 1) {
      if (state.conversations[i].id === state.activeConversationId) { conv = state.conversations[i]; break; }
    }
    if (!conv) {
      conv = { id: nextId('conv'), title: '新会话', updatedAt: nowIso(), messages: [] };
      state.activeConversationId = conv.id;
      state.conversations.unshift(conv);
    }
    conv.messages = state.messages.slice(-MAX_MESSAGES).map(function (msg) {
      return { id: msg.id, role: msg.role, text: msg.text, createdAt: msg.createdAt };
    });
    conv.updatedAt = nowIso();
    if (conv.title === '新会话' || !conv.title) {
      var firstUser = null;
      for (var j = 0; j < conv.messages.length; j += 1) {
        if (conv.messages[j].role === 'user' && conv.messages[j].text) { firstUser = conv.messages[j]; break; }
      }
      if (firstUser) conv.title = firstUser.text.slice(0, 24);
    }
    state.conversations = state.conversations.filter(function (item) { return item.id !== conv.id; });
    state.conversations.unshift(conv);
    state.conversations = state.conversations.slice(0, MAX_CONVERSATIONS);
    saveHistory();
  }

  function startNewConversation() {
    state.activeConversationId = null;
    state.messages = [];
    state.historyOpen = false;
    state.pendingFile = null;
    state.pendingCleaning = null;
    syncConversation();
    render();
  }

  function openConversation(id) {
    var conv = null;
    for (var i = 0; i < state.conversations.length; i += 1) {
      if (state.conversations[i].id === id) { conv = state.conversations[i]; break; }
    }
    if (!conv) return;
    state.activeConversationId = conv.id;
    state.messages = conv.messages.map(function (msg) {
      return { id: msg.id, role: msg.role, text: msg.text, createdAt: msg.createdAt };
    });
    state.historyOpen = false;
    state.pendingFile = null;
    state.pendingCleaning = null;
    render();
  }

  function deleteConversation(id) {
    state.conversations = state.conversations.filter(function (item) { return item.id !== id; });
    if (state.activeConversationId === id) {
      state.activeConversationId = null;
      state.messages = [];
    }
    saveHistory();
    render();
  }

  /* ---------------- 消息 ---------------- */

  function pushMessage(message) {
    state.messages.push(message);
    if (state.messages.length > MAX_MESSAGES * 2) state.messages = state.messages.slice(-MAX_MESSAGES * 2);
    syncConversation();
    return message;
  }

  function pushAssistant(payload) {
    var message = {
      id: nextId('msg'),
      role: 'assistant',
      text: text(payload && payload.text),
      createdAt: nowIso()
    };
    if (payload && payload.attachment) message.attachment = payload.attachment;
    if (payload && payload.cleaning) message.cleaning = payload.cleaning;
    if (payload && payload.operation) message.operation = payload.operation;
    if (payload && payload.source) message.source = payload.source;
    return pushMessage(message);
  }

  function pushUser(payload) {
    return pushMessage({
      id: nextId('msg'),
      role: 'user',
      text: text(payload && payload.text),
      createdAt: nowIso(),
      attachment: payload && payload.attachment ? payload.attachment : undefined
    });
  }

  function updateMessage(id, patch) {
    for (var i = 0; i < state.messages.length; i += 1) {
      if (state.messages[i].id === id) {
        var target = state.messages[i];
        Object.keys(patch || {}).forEach(function (key) { target[key] = patch[key]; });
        return target;
      }
    }
    return null;
  }

  /* ---------------- 渲染 ---------------- */

  function quickPrompts() {
    var module = core();
    if (!module || typeof module.toolsForRole !== 'function') {
      return ['现在数据质量怎么样', '查询 1 号炉 HSH 的测厚记录', '帮助'];
    }
    var tools = module.toolsForRole(currentRole());
    var prompts = [];
    for (var i = 0; i < tools.length && prompts.length < 6; i += 1) {
      var examples = Array.isArray(tools[i].examples) ? tools[i].examples : [];
      if (examples.length) prompts.push(examples[0]);
    }
    return prompts.length ? prompts : ['现在数据质量怎么样', '帮助'];
  }

  function viewState() {
    return {
      messages: state.messages,
      busy: state.busy,
      quickPrompts: quickPrompts(),
      conversations: state.conversations,
      activeConversationId: state.activeConversationId,
      historyOpen: state.historyOpen,
      configured: llmConfigured(),
      role: currentRole(),
      unread: false
    };
  }

  function render() {
    if (controller && typeof controller.render === 'function') controller.render();
  }

  function setBusy(busy) {
    state.busy = !!busy;
    if (controller && typeof controller.setBusy === 'function') controller.setBusy(state.busy);
  }

  function reply(message, extra) {
    var payload = { text: message };
    if (extra && typeof extra === 'object') {
      Object.keys(extra).forEach(function (key) { payload[key] = extra[key]; });
    }
    pushAssistant(payload);
    render();
  }

  /* ---------------- 清洗与导入 ---------------- */

  function cleaningContext(snap) {
    var codes = [];
    var seen = {};
    for (var i = 0; i < snap.events.length; i += 1) {
      var code = text(snap.events[i].code).toUpperCase();
      if (code && !seen[code]) { seen[code] = true; codes.push(code); }
    }
    return {
      knownCodes: codes,
      retiredCodes: Array.isArray(snap.retiredCodes) ? snap.retiredCodes : [],
      matrixRows: Array.isArray(snap.matrix) ? snap.matrix : [],
      units: global.BTAssistantCore && global.BTAssistantCore.DEFAULT_UNITS ? global.BTAssistantCore.DEFAULT_UNITS.slice() : ['1', '2']
    };
  }

  function cleanRowsFor(rows, fileName, sheetName) {
    var module = core();
    if (!module || typeof module.cleanRows !== 'function') return null;
    var snap = snapshot();
    var context = cleaningContext(snap);
    return module.cleanRows({
      rows: rows,
      fileName: fileName,
      sheetName: sheetName,
      knownCodes: context.knownCodes,
      retiredCodes: context.retiredCodes,
      matrixRows: context.matrixRows,
      units: context.units
    });
  }

  function attachCleaningActions(report) {
    var copy = {};
    Object.keys(report || {}).forEach(function (key) { copy[key] = report[key]; });
    var actions = [];
    if (copy.summary && copy.summary.importable) {
      actions.push({ id: 'import-confirm', label: '确认导入', tone: 'primary' });
    }
    actions.push({ id: 'export-cleaned', label: '导出清洗后数据', tone: 'ghost' });
    if (copy.summary && (copy.summary.issueCount || 0) > 0) {
      actions.push({ id: 'export-issues', label: '导出问题明细', tone: 'ghost' });
    }
    actions.push({ id: 'clean-cancel', label: '取消', tone: 'ghost' });
    copy.actions = actions;
    return copy;
  }

  function describeCleaning(report) {
    var summary = report && report.summary ? report.summary : {};
    var parts = [];
    parts.push('已检查 ' + (summary.totalRows || 0) + ' 行数据（可导入 ' + (summary.cleanRows || 0) + ' 行）');
    if (summary.errorCount) parts.push(summary.errorCount + ' 行有错误');
    if (summary.warningCount) parts.push(summary.warningCount + ' 行有警告');
    if (summary.duplicateRows) parts.push('丢弃重复 ' + summary.duplicateRows + ' 行');
    var head = parts.join('，') + '。';
    if (summary.importable) return head + '可以点「确认导入」写入台账。';
    if (report && report.datasetType === 'unknown') return head + '未识别出数据集类型，请确认表头是否来自本系统导出的模板。';
    return head + '存在错误行，请按提示修正后再导入，或直接导出问题明细核对。';
  }

  function runCleaning(rows, fileName, sheetName) {
    var result = cleanRowsFor(rows, fileName, sheetName);
    if (!result) {
      reply('清洗组件没有加载成功，请刷新页面后重试。');
      return null;
    }
    state.pendingCleaning = {
      report: result.report,
      cleanRows: Array.isArray(result.cleanRows) ? result.cleanRows : []
    };
    pushAssistant({
      text: describeCleaning(result.report),
      cleaning: attachCleaningActions(result.report)
    });
    render();
    return result;
  }

  function handleFile(file) {
    if (!file) return;
    var name = text(file.name) || '未命名文件';
    var extension = fileExtension(name);
    if (extension !== 'csv' && extension !== 'xlsx' && extension !== 'xls') {
      reply('只支持 CSV / Excel（.csv/.xlsx/.xls）文件。可以先在「数据录入」页下载 CSV 模板再填写。');
      return;
    }
    setBusy(true);
    render();
    var reading = extension === 'csv'
      ? readFileAsText(file).then(function (content) { return { rows: parseCsvRows(content), sheetName: '' }; })
      : readFileAsBuffer(file).then(function (buffer) { return parseXlsxRows(buffer); });
    reading.then(function (parsed) {
      var rows = parsed.rows || [];
      var dataRows = 0;
      for (var i = 1; i < rows.length; i += 1) {
        var row = rows[i] || [];
        var hasContent = false;
        for (var j = 0; j < row.length; j += 1) {
          if (text(row[j]).trim()) { hasContent = true; break; }
        }
        if (hasContent) dataRows += 1;
        if (dataRows > MAX_IMPORT_ROWS) break;
      }
      if (rows.length < 2) {
        setBusy(false);
        reply('文件里没有数据行（至少需要一行表头和一行数据）。');
        return;
      }
      if (dataRows > MAX_IMPORT_ROWS) {
        setBusy(false);
        reply('文件有超过 ' + MAX_IMPORT_ROWS + ' 行数据，助手只处理较小批次；请拆分后重试，或到「数据录入」页用原入口导入。');
        return;
      }
      state.pendingFile = { name: name, size: file.size || 0, rows: rows, sheetName: parsed.sheetName || '' };
      pushUser({
        text: '上传文件：' + name,
        attachment: { name: name, size: file.size || 0 }
      });
      setBusy(false);
      runCleaning(rows, name, parsed.sheetName || '');
    }).catch(function (err) {
      setBusy(false);
      render();
      reply('读取文件失败：' + (err && err.message ? err.message : String(err)));
    });
  }

  function pendingCleaningImportable() {
    var pending = state.pendingCleaning;
    return Boolean(pending && pending.report && pending.report.summary && pending.report.summary.importable &&
      Array.isArray(pending.cleanRows) && pending.cleanRows.length > 1);
  }

  function executeImport() {
    if (!pendingCleaningImportable()) {
      reply('现在没有可导入的清洗结果，请先上传文件或重新清洗。');
      return;
    }
    var report = state.pendingCleaning.report;
    var rows = state.pendingCleaning.cleanRows;
    var datasetType = report.datasetType;
    var result = null;
    if (datasetType === 'material_library') {
      var beforeLibrary = snapshot().materialLibrary;
      if (typeof global.importMaterialRows !== 'function') { reply('材料库导入失败：写入组件没有就绪，请刷新页面。'); return; }
      result = global.importMaterialRows(rows);
      if (!result) { reply('材料库导入失败：写入组件没有就绪，请刷新页面。'); return; }
      state.lastImport = {
        kind: 'material_library',
        createdAt: nowIso(),
        fileName: report.fileName || '',
        before: beforeLibrary,
        imported: result.imported || 0
      };
      writeJSON(LAST_IMPORT_KEY, state.lastImport);
      state.pendingCleaning = null;
      state.pendingFile = null;
      reply('材料库导入完成：更新/新增 ' + (result.imported || 0) + ' 条记录。', {
        operation: {
          tool: 'data.import',
          datasetType: datasetType,
          title: '材料库导入完成',
          detail: '已写入本浏览器并排队同步云端（若已登录）。',
          metrics: [{ label: '写入记录', value: String(result.imported || 0) }],
          warnings: [],
          status: 'done',
          resultTone: 'success',
          secondaryActions: [{ id: 'undo-last-import', label: '撤销这次导入', tone: 'ghost' }]
        }
      });
      return;
    }
    if (typeof global.importLifecycleRows !== 'function') { reply('导入失败：写入组件没有就绪，请刷新页面。'); return; }
    result = global.importLifecycleRows(rows, { batchFilter: 'all' });
    if (!result) { reply('导入失败：写入组件没有就绪，请刷新页面。'); return; }
    state.lastImport = {
      kind: 'events',
      createdAt: nowIso(),
      fileName: report.fileName || '',
      addedEventTs: Array.isArray(result.addedEventTs) ? result.addedEventTs.slice() : [],
      addedReplacementTs: Array.isArray(result.addedReplacementTs) ? result.addedReplacementTs.slice() : [],
      importedEvents: result.importedEvents || 0,
      importedReplacements: result.importedReplacements || 0,
      skippedDuplicates: result.skippedDuplicates || 0
    };
    writeJSON(LAST_IMPORT_KEY, state.lastImport);
    state.pendingCleaning = null;
    state.pendingFile = null;
    var summary = '导入完成：新增事件 ' + state.lastImport.importedEvents + ' 条、更换 ' + state.lastImport.importedReplacements + ' 条';
    if (state.lastImport.skippedDuplicates) summary += '，跳过重复 ' + state.lastImport.skippedDuplicates + ' 条';
    if (result.skippedMismatch) summary += '，机组不匹配 ' + result.skippedMismatch + ' 条';
    reply(summary + '。', {
      operation: {
        tool: 'data.import',
        datasetType: datasetType,
        title: '导入完成',
        detail: '已写入本浏览器并排队同步云端（若已登录）。数据可在「数据录入」页核对。',
        metrics: [
          { label: '新增事件', value: String(state.lastImport.importedEvents), tone: 'ok' },
          { label: '新增更换', value: String(state.lastImport.importedReplacements), tone: 'ok' },
          { label: '跳过重复', value: String(state.lastImport.skippedDuplicates), tone: 'warn' }
        ],
        warnings: result.skippedMismatch ? ['机组不匹配跳过 ' + result.skippedMismatch + ' 行'] : [],
        status: 'done',
        resultTone: 'success',
        secondaryActions: [{ id: 'undo-last-import', label: '撤销这次导入', tone: 'ghost' }]
      }
    });
  }

  function undoLastImport() {
    var last = state.lastImport;
    if (!last) { reply('没有可撤销的导入记录（只记录助手最近一次导入）。'); return; }
    if (last.kind === 'material_library') {
      if (typeof global.saveMaterialLibrary === 'function' && Array.isArray(last.before)) {
        global.saveMaterialLibrary(last.before);
        state.lastImport = null;
        removeKey(LAST_IMPORT_KEY);
        reply('已撤销最近一次材料库导入，记录恢复到导入前的状态。');
        return;
      }
      reply('撤销失败：材料库写入组件未就绪。');
      return;
    }
    var db = readUserDB();
    if (!db) { reply('撤销失败：读不到本地数据库。'); return; }
    var eventTs = {};
    var replacementTs = {};
    (last.addedEventTs || []).forEach(function (ts) { eventTs[String(ts)] = true; });
    (last.addedReplacementTs || []).forEach(function (ts) { replacementTs[String(ts)] = true; });
    var removedEvents = 0;
    var removedReplacements = 0;
    db.events = (db.events || []).filter(function (record) {
      if (eventTs[String(record.ts)]) { removedEvents += 1; return false; }
      return true;
    });
    db.replacements = (db.replacements || []).filter(function (record) {
      if (replacementTs[String(record.ts)]) { removedReplacements += 1; return false; }
      return true;
    });
    callApp('saveDB');
    state.lastImport = null;
    removeKey(LAST_IMPORT_KEY);
    reply('已撤销最近一次导入：移除事件 ' + removedEvents + ' 条、更换 ' + removedReplacements + ' 条。', {
      operation: {
        tool: 'data.undo',
        datasetType: 'events',
        title: '撤销导入完成',
        detail: '只回滚助手自己最近一次导入，页面原有导入不受影响。',
        metrics: [{ label: '移除事件', value: String(removedEvents) }, { label: '移除更换', value: String(removedReplacements) }],
        warnings: [],
        status: 'done',
        resultTone: 'success',
        secondaryActions: []
      }
    });
  }
  /* ---------------- 导出 ---------------- */

  function csvCell(value) {
    var raw = value === null || value === undefined ? '' : String(value);
    if (raw.indexOf(',') >= 0 || raw.indexOf('"') >= 0 || raw.indexOf(String.fromCharCode(10)) >= 0 || raw.indexOf(String.fromCharCode(13)) >= 0) {
      return '"' + raw.replace(/"/g, '""') + '"';
    }
    return raw;
  }

  function downloadCsv(columns, rows, fileName) {
    var lines = [columns.map(csvCell).join(',')];
    rows.forEach(function (row) {
      lines.push(columns.map(function (column) { return csvCell(row[column]); }).join(','));
    });
    var content = '\uFEFF' + lines.join(String.fromCharCode(13) + String.fromCharCode(10));
    if (typeof global.downloadBlob === 'function') {
      global.downloadBlob(fileName, content, 'text/csv;charset=utf-8;');
      return true;
    }
    toast('导出组件未就绪，请刷新页面后重试。', 'error');
    return false;
  }

  function downloadXlsx(sheetName, columns, rows, fileName) {
    var sheetjs = global.XLSX;
    if (!sheetjs || !sheetjs.utils) return false;
    try {
      var objectRows = rows.map(function (row) {
        var item = {};
        columns.forEach(function (column) { item[column] = row[column]; });
        return item;
      });
      var sheet = sheetjs.utils.json_to_sheet(objectRows, { header: columns });
      sheet['!cols'] = columns.map(function () { return { wch: 18 }; });
      var workbook = sheetjs.utils.book_new();
      sheetjs.utils.book_append_sheet(workbook, sheet, text(sheetName).slice(0, 31) || 'Sheet1');
      sheetjs.writeFile(workbook, fileName);
      return true;
    } catch (err) {
      return false;
    }
  }

  function currentFilterScope() {
    var doc = global.document;
    var select = doc && typeof doc.getElementById === 'function' ? doc.getElementById('dm-batch-boiler') : null;
    var value = select && select.value ? String(select.value) : 'all';
    return value === '1' || value === '2' ? value : 'all';
  }

  function eventInScope(event, scope) {
    if (!scope || scope === 'all') return true;
    var code = text(event && event.code).toUpperCase();
    var boiler = text(event && event.boiler);
    return boiler === scope || code.indexOf(scope + '-') === 0;
  }

  function executeExport(params) {
    var scope = params && params.exportScope === 'all' ? 'all' : currentFilterScope();
    var format = params && params.format === 'xlsx' ? 'xlsx' : 'csv';
    var datasetType = params && params.datasetType === 'material_library' ? 'material_library' : 'events';
    var snap = snapshot();
    var today = new Date().toISOString().slice(0, 10);
    var columns;
    var rows;
    var sheetName;
    var fileName;
    if (datasetType === 'material_library') {
      columns = ['部件名称', '系统代码', '分段/位置', '规格型号', '管径', '壁厚', '材质', '库存根数', '库存总长度(m)', '预留位置', '备注'];
      rows = (snap.materialLibrary || []).map(function (item) {
        return {
          '部件名称': text(item.component),
          '系统代码': text(item.sys),
          '分段/位置': text(item.position),
          '规格型号': text(item.spec),
          '管径': text(item.diameter),
          '壁厚': text(item.wallThickness),
          '材质': text(item.material),
          '库存根数': text(item.stockQty),
          '库存总长度(m)': text(item.totalLengthM),
          '预留位置': text(item.reserveLocation),
          '备注': text(item.remark)
        };
      });
      sheetName = '受热面材料库';
      fileName = '受热面材料库_AI助手_' + today;
    } else {
      columns = ['炉号', '日期', '管段编码', '规格', '材质', '厚度(mm)', '硬度(HB)', '事件类型', '详细描述/结论'];
      rows = (snap.events || []).filter(function (event) { return eventInScope(event, scope); }).map(function (event) {
        return {
          '炉号': text(event.boiler) || text(event.code).charAt(0),
          '日期': text(event.date),
          '管段编码': text(event.code),
          '规格': text(event.spec),
          '材质': text(event.material),
          '厚度(mm)': text(event.thickness),
          '硬度(HB)': text(event.hardness),
          '事件类型': text(event.type),
          '详细描述/结论': text(event.desc)
        };
      });
      sheetName = '寿命事件';
      fileName = '锅炉寿命数据_' + (scope === 'all' ? '全厂' : scope + '号机组') + '_AI助手_' + today;
    }
    var ok = false;
    if (format === 'xlsx') {
      ok = downloadXlsx(sheetName, columns, rows, fileName + '.xlsx');
      if (!ok) {
        format = 'csv';
        ok = downloadCsv(columns, rows, fileName + '.csv');
        reply('Excel 组件不可用，已改为导出 CSV（' + rows.length + ' 条）。');
      }
    } else {
      ok = downloadCsv(columns, rows, fileName + '.csv');
    }
    if (!ok) {
      reply('导出失败：浏览器下载组件未就绪，请刷新页面后重试。');
      return;
    }
    var scopeLabel = datasetType === 'material_library' ? '全部材料记录' : (scope === 'all' ? '全厂' : scope + '号机组');
    reply('已导出 ' + rows.length + ' 条记录（' + scopeLabel + '，' + (format === 'xlsx' ? 'Excel' : 'CSV') + '）。', {
      operation: {
        tool: 'data.export',
        datasetType: datasetType,
        title: '导出完成',
        detail: '文件已由浏览器下载：' + fileName + '.' + format,
        metrics: [{ label: '导出记录', value: String(rows.length), tone: 'ok' }],
        warnings: [],
        status: 'done',
        resultTone: 'success',
        secondaryActions: []
      }
    });
  }

  /* ---------------- 查询 ---------------- */

  function normCode(value) {
    var module = core();
    if (module && typeof module.normalizeCode === 'function') return module.normalizeCode(value);
    return text(value).trim().toUpperCase();
  }

  function matchEventFilters(event, filters) {
    var code = normCode(event.code);
    if (filters.code && code.indexOf(filters.code) < 0) return false;
    if (filters.unit && code.indexOf(filters.unit + '-') !== 0) return false;
    if (filters.sys) {
      var sysList = Array.isArray(filters.sys) ? filters.sys : [filters.sys];
      var eventSys = code.split('-')[1] || '';
      if (sysList.indexOf(eventSys) < 0) return false;
    }
    if (filters.zone) {
      var eventZone = code.split('-')[2] || '';
      if (eventZone !== filters.zone) return false;
    }
    if (filters.type && text(event.type).indexOf(filters.type) < 0) return false;
    if (filters.keyword) {
      var haystack = [event.desc, event.spec, event.material, event.type, event.code].map(text).join(' ').toLowerCase();
      if (haystack.indexOf(text(filters.keyword).toLowerCase()) < 0) return false;
    }
    if (filters.dateFrom && text(event.date) && text(event.date) < filters.dateFrom) return false;
    if (filters.dateTo && text(event.date) && text(event.date) > filters.dateTo) return false;
    var thickness = Number(event.thickness);
    if (filters.maxThickness !== undefined && isFinite(thickness) && thickness >= filters.maxThickness) return false;
    if (filters.minThickness !== undefined && isFinite(thickness) && thickness <= filters.minThickness) return false;
    return true;
  }

  function queryDatasetRows(query) {
    var dataset = query && query.dataset ? query.dataset : 'unknown';
    var filters = query && query.filters ? query.filters : {};
    var snap = snapshot(dataset === 'tube_ledger' ? { withLedger: true } : {});
    if (dataset === 'events') {
      var eventRows = (snap.events || []).filter(function (event) { return matchEventFilters(event, filters); });
      return {
        dataset: dataset,
        columns: ['炉号', '日期', '管段编码', '事件类型', '厚度(mm)', '硬度(HB)', '详细描述/结论'],
        rows: eventRows.map(function (event) {
          return {
            '炉号': text(event.boiler) || text(event.code).charAt(0),
            '日期': text(event.date),
            '管段编码': text(event.code),
            '事件类型': text(event.type),
            '厚度(mm)': text(event.thickness),
            '硬度(HB)': text(event.hardness),
            '详细描述/结论': text(event.desc)
          };
        })
      };
    }
    if (dataset === 'replacements') {
      var replacementRows = (snap.replacements || []).filter(function (record) {
        if (filters.code && normCode(record.oldCode).indexOf(filters.code) < 0 && normCode(record.newCode).indexOf(filters.code) < 0) return false;
        if (filters.unit && normCode(record.oldCode).indexOf(filters.unit + '-') !== 0) return false;
        if (filters.dateFrom && text(record.date) && text(record.date) < filters.dateFrom) return false;
        if (filters.dateTo && text(record.date) && text(record.date) > filters.dateTo) return false;
        if (filters.keyword) {
          var hay = [record.reason, record.oldCode, record.newCode].map(text).join(' ').toLowerCase();
          if (hay.indexOf(text(filters.keyword).toLowerCase()) < 0) return false;
        }
        return true;
      });
      return {
        dataset: dataset,
        columns: ['炉号', '更换日期', '旧管段编码', '新管段编码', '更换原因'],
        rows: replacementRows.map(function (record) {
          return {
            '炉号': text(record.boiler) || normCode(record.oldCode).charAt(0),
            '更换日期': text(record.date),
            '旧管段编码': text(record.oldCode),
            '新管段编码': text(record.newCode),
            '更换原因': text(record.reason)
          };
        })
      };
    }
    if (dataset === 'material_library') {
      var materialRows = (snap.materialLibrary || []).filter(function (item) {
        if (!filters.keyword) return true;
        var hay = [item.component, item.spec, item.material, item.position, item.remark].map(text).join(' ').toLowerCase();
        return hay.indexOf(text(filters.keyword).toLowerCase()) >= 0;
      });
      return {
        dataset: dataset,
        columns: ['部件名称', '系统代码', '分段/位置', '规格型号', '材质', '库存根数'],
        rows: materialRows.map(function (item) {
          return {
            '部件名称': text(item.component),
            '系统代码': text(item.sys),
            '分段/位置': text(item.position),
            '规格型号': text(item.spec),
            '材质': text(item.material),
            '库存根数': text(item.stockQty)
          };
        })
      };
    }
    if (dataset === 'tube_ledger') {
      var ledgerRows = (snap.ledgerRows || []).filter(function (row) {
        if (filters.unit && text(row.boiler) !== filters.unit) return false;
        if (filters.sys) {
          var sysList = Array.isArray(filters.sys) ? filters.sys : [filters.sys];
          if (sysList.indexOf(text(row.sys)) < 0) return false;
        }
        if (filters.code && text(row.code).indexOf(filters.code) < 0) return false;
        return true;
      });
      return {
        dataset: dataset,
        columns: ['炉号', '管段编码', '受热面', '区域位置', '规格', '材质'],
        rows: ledgerRows.map(function (row) {
          return {
            '炉号': text(row.boiler),
            '管段编码': text(row.code),
            '受热面': text(row.label),
            '区域位置': text(row.location),
            '规格': text(row.spec),
            '材质': text(row.material)
          };
        })
      };
    }
    if (dataset === 'warnings') {
      var warningRows = (snap.warnings || []).filter(function (item) {
        if (filters.code && text(item.code).indexOf(filters.code) < 0) return false;
        if (filters.unit && text(item.code).indexOf(filters.unit + '-') !== 0) return false;
        if (filters.riskLevel && item.level !== filters.riskLevel) return false;
        return true;
      });
      return {
        dataset: dataset,
        columns: ['管段编码', '风险等级', '来源', '说明'],
        rows: warningRows.map(function (item) {
          return {
            '管段编码': text(item.code),
            '风险等级': text(item.level),
            '来源': text(item.source),
            '说明': text(item.text)
          };
        })
      };
    }
    if (dataset === 'maintenance') {
      var overdueRows = (snap.overdueRows || []).filter(function (row) {
        if (filters.overdueYears && Number(row.years) < filters.overdueYears) return false;
        if (filters.neverInspected && row.lastDate) return false;
        if (filters.unit && text(row.boiler) !== filters.unit) return false;
        if (filters.sys) {
          var list = Array.isArray(filters.sys) ? filters.sys : [filters.sys];
          if (list.indexOf(text(row.sys)) < 0) return false;
        }
        return true;
      });
      return {
        dataset: dataset,
        columns: ['优先级', '炉号', '管段编码', '受热面', '上次检查', '距今(年)', '建议动作'],
        rows: overdueRows.map(function (row) {
          return {
            '优先级': text(row.priority),
            '炉号': text(row.boiler),
            '管段编码': text(row.code),
            '受热面': text(row.label),
            '上次检查': text(row.lastDate) || '无记录',
            '距今(年)': row.years === null || row.years === undefined ? '-' : String(row.years),
            '建议动作': text(row.action)
          };
        })
      };
    }
    return { dataset: 'unknown', columns: [], rows: [] };
  }

  function executeQuery(intent) {
    var query = null;
    var module = core();
    if (module && typeof module.parseQuery === 'function') {
      query = module.parseQuery(intent && intent.params && intent.params.note ? intent.params.note : (state.lastMessage || ''), { role: currentRole() });
    }
    if (!query || query.dataset === 'unknown') {
      reply('没解析出查询条件。可以说明机组、受热面、类型或管段编码，例如：「查询 1 号炉高过的测厚记录」。');
      return;
    }
    var result = queryDatasetRows(query);
    var total = result.rows.length;
    state.pendingQuery = {
      dataset: result.dataset,
      columns: result.columns,
      rows: result.rows,
      description: query.description
    };
    if (!total) {
      reply('没有查到符合条件的记录（' + query.description + '）。可以放宽条件再试。');
      return;
    }
    var previewRows = result.rows.slice(0, MAX_QUERY_ROWS);
    var previewText = previewRows.map(function (row) {
      return result.columns.map(function (column) { return text(row[column]); }).join(' | ');
    }).join(String.fromCharCode(10));
    var metrics = [{ label: '命中记录', value: String(total), tone: 'ok' }];
    if (total > previewRows.length) metrics.push({ label: '预览', value: '前 ' + previewRows.length + ' 条' });
    var card = {
      tool: 'data.query',
      datasetType: result.dataset,
      title: query.description,
      detail: total > previewRows.length
        ? '共 ' + total + ' 条，下面只显示前 ' + previewRows.length + ' 条；导出可得完整结果。'
        : '共 ' + total + ' 条。',
      metrics: metrics,
      warnings: [],
      status: 'done',
      resultTone: 'success',
      summaryText: result.columns.join(' | ') + String.fromCharCode(10) + previewText,
      secondaryActions: [{ id: 'export-query', label: '导出查询结果', tone: 'ghost' }]
    };
    pushAssistant({ text: '', operation: card });
    render();
  }

  function exportQueryResult() {
    var pending = state.pendingQuery;
    if (!pending || !pending.rows || !pending.rows.length) {
      reply('没有可导出的查询结果，请先查询。');
      return;
    }
    var today = new Date().toISOString().slice(0, 10);
    var fileName = 'AI助手_查询结果_' + today;
    var ok = downloadCsv(pending.columns, pending.rows, fileName + '.csv');
    if (!ok) {
      reply('导出失败：浏览器下载组件未就绪。');
      return;
    }
    reply('已导出查询结果 ' + pending.rows.length + ' 条（CSV）。');
  }

  /* ---------------- 单条修改 ---------------- */

  function fieldLabel(field) {
    var labels = { date: '日期', code: '管段编码', type: '事件类型', desc: '描述', thickness: '厚度', hardness: '硬度', spec: '规格', material: '材质' };
    return labels[field] || field;
  }

  function normalizeDateValue(value) {
    var module = core();
    if (module && typeof module.normalizeDateText === 'function') return module.normalizeDateText(value);
    return text(value);
  }

  function findTargetEvent(plan) {
    var snap = snapshot();
    var code = normCode(plan.targetCode);
    var candidates = (snap.events || []).filter(function (event) {
      return normCode(event.code) === code;
    });
    if (!candidates.length) return null;
    candidates.sort(function (a, b) {
      var byDate = String(a.date || '').localeCompare(String(b.date || ''));
      if (byDate !== 0) return byDate;
      return (Number(a.ts) || 0) - (Number(b.ts) || 0);
    });
    if (plan.recordHint === 'oldest') return candidates[0];
    if (plan.recordHint === 'date' && plan.targetDate) {
      for (var i = 0; i < candidates.length; i += 1) {
        if (normalizeDateValue(candidates[i].date) === plan.targetDate) return candidates[i];
      }
      return null;
    }
    return candidates[candidates.length - 1];
  }

  function executeEdit(plan) {
    var record = findTargetEvent(plan);
    if (!record) {
      reply('没有找到 ' + plan.targetCode + ' 的对应记录。请先确认管段编码或记录日期。');
      return;
    }
    var before = text(record[plan.field]);
    state.pendingEdit = { ts: record.ts, field: plan.field, value: plan.value, before: before, code: normCode(record.code) };
    pushAssistant({
      text: '',
      operation: {
        tool: 'data.edit',
        datasetType: 'events',
        title: '修改预览',
        detail: plan.targetCode + ' 的' + fieldLabel(plan.field) + '：' + (before || '（空）') + ' → ' + plan.value,
        metrics: [
          { label: '原值', value: before || '（空）' },
          { label: '新值', value: plan.value, tone: 'accent' }
        ],
        warnings: ['确认后写入本浏览器并排队同步云端（若已登录）；写入后可在卡片上撤销。'],
        status: 'ready',
        primaryAction: { id: 'edit-confirm', label: '确认修改' },
        secondaryActions: [{ id: 'edit-cancel', label: '取消', tone: 'ghost' }]
      }
    });
    render();
  }

  function confirmEdit() {
    var pending = state.pendingEdit;
    if (!pending) { reply('没有待确认的修改，请重新说明要改哪条记录的哪个字段。'); return; }
    var result = callApp('updateEventRecord', pending.ts, pending.field, pending.value);
    state.pendingEdit = null;
    if (!result || !result.ok) {
      reply('修改失败：' + ((result && result.error) || '写入组件未就绪，请刷新页面。'));
      return;
    }
    state.lastEdit = {
      ts: pending.ts,
      field: pending.field,
      before: result.before,
      after: result.after,
      code: pending.code,
      createdAt: nowIso()
    };
    writeJSON(LAST_EDIT_KEY, state.lastEdit);
    reply('已修改 ' + pending.code + ' 的' + fieldLabel(pending.field) + '：' + (result.before || '（空）') + ' → ' + result.after + '。', {
      operation: {
        tool: 'data.edit',
        datasetType: 'events',
        title: '修改完成',
        detail: '已写入本浏览器并排队同步云端（若已登录）。',
        metrics: [{ label: '字段', value: fieldLabel(pending.field) }, { label: '新值', value: text(result.after), tone: 'ok' }],
        warnings: [],
        status: 'done',
        resultTone: 'success',
        secondaryActions: [{ id: 'undo-last-edit', label: '撤销这次修改', tone: 'ghost' }]
      }
    });
  }

  function undoLastEdit() {
    var last = state.lastEdit;
    if (!last) { reply('没有可撤销的修改（只记录助手最近一次修改）。'); return; }
    var result = callApp('updateEventRecord', last.ts, last.field, last.before);
    if (!result || !result.ok) {
      reply('撤销失败：' + ((result && result.error) || '写入组件未就绪。'));
      return;
    }
    state.lastEdit = null;
    removeKey(LAST_EDIT_KEY);
    reply('已撤销修改：' + last.code + ' 的' + fieldLabel(last.field) + ' 恢复为「' + (last.before || '（空）') + '」。');
  }

  /* ---------------- 统计与帮助 ---------------- */

  function executeStats() {
    var module = core();
    var snap = snapshot();
    var stats = module && typeof module.buildStats === 'function'
      ? module.buildStats(snap)
      : { intro: '', metrics: [], issues: [] };
    var metrics = (stats.metrics || []).slice();
    metrics.push({ label: '预警条数', value: String((snap.warnings || []).length), tone: 'warn' });
    metrics.push({ label: '超期未检', value: String((snap.overdueRows || []).length), tone: 'danger' });
    var issueText = stats.issues && stats.issues.length
      ? stats.issues.map(function (issue) { return '· ' + issue.title + '：' + issue.detail; }).join(String.fromCharCode(10))
      : '暂未发现明显数据问题。';
    pushAssistant({
      text: stats.intro || '',
      operation: {
        tool: 'data.stats',
        datasetType: 'unknown',
        title: '数据质量概览',
        detail: issueText,
        metrics: metrics,
        warnings: [],
        status: 'done',
        resultTone: stats.issues && stats.issues.length ? 'warning' : 'success',
        secondaryActions: []
      }
    });
    render();
  }

  function executeHelp() {
    var module = core();
    var role = currentRole();
    var roleName = module && typeof module.roleLabel === 'function' ? module.roleLabel(role) : role;
    var lines = [
      '我是锅炉炉管数据助手，当前权限：' + roleName + '。',
      '我能做的事：',
      '· 清洗检查：上传 CSV/Excel，我先跑一遍导入前检查（重复行、日期格式、编码范围等）。',
      '· 导入数据：清洗通过后二次确认再写入，导入后可一键撤销。',
      '· 导出数据：按当前机组筛选或全部，导出 CSV / Excel。',
      '· 查询数据：按机组、受热面、类型、管段编码、日期、壁厚等条件查记录。',
      '· 统计概览：数据质量、预警条数、超期未检。',
      '· 修改记录：改单条记录的单个字段，改完可撤销。',
      '示例：「检查这批寿命数据能不能导入」「查询 1 号炉高过的测厚记录」「现在数据质量怎么样」「把 1-WW-FR-008-0003-000 的最新测厚记录厚度改成 6.8」'
    ];
    reply(lines.join(String.fromCharCode(10)));
  }

  /* ---------------- 可选：大模型意图增强 ---------------- */

  function maskSensitive(value) {
    return text(value)
      .replace(/[0-9]{18}/g, '[证件号]')
      .replace(/[0-9]{11}/g, '[手机号]')
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}/g, '[邮箱]');
  }

  function buildIntentLlmMessages(message, ctx) {
    var module = core();
    var catalog = module && typeof module.toolCatalog === 'function' ? module.toolCatalog() : [];
    var tools = catalog.map(function (spec) { return { name: spec.name, minRole: spec.minRole }; });
    var system = [
      '你是锅炉炉管全生命周期管理系统的数据助手意图解析器。',
      '只返回严格 JSON，不要 Markdown 代码块，不要任何解释。',
      'JSON 字段：intent、datasetType、params、reply、confidence。',
      'intent 只能是 clean/import/export/query/edit/stats/undo/help/unknown。',
      'datasetType 只能是 events/material_library/unknown。',
      '可用工具：' + JSON.stringify(tools) + '。'
    ].join('');
    var context = {
      role: ctx.role,
      currentView: ctx.currentView || '',
      headers: Array.isArray(ctx.headers) ? ctx.headers.slice(0, 20) : [],
      counts: ctx.counts || {}
    };
    return [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({ message: maskSensitive(message), context: context }) }
    ];
  }

  function parseIntentWithLlm(message, ctx) {
    return new Promise(function (resolve) {
      if (!llmConfigured() || typeof global.callAssistantChatCompletions !== 'function') {
        resolve({ ok: false, reason: '未配置模型' });
        return;
      }
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) { settled = true; resolve({ ok: false, reason: '超时（9 秒）' }); }
      }, 9000);
      global.callAssistantChatCompletions(buildIntentLlmMessages(message, ctx), LLM_MAX_TOKENS).then(function (raw) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        var parsed = null;
        try {
          var jsonText = text(raw).replace(/^\x60\x60\x60json/i, '').replace(/^\x60\x60\x60/, '').replace(/\x60\x60\x60$/, '').trim();
          parsed = JSON.parse(jsonText);
        } catch (err) {
          parsed = null;
        }
        if (!parsed) resolve({ ok: false, reason: '模型返回内容不是有效 JSON' });
        else resolve({ ok: true, parsed: parsed });
      }).catch(function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, reason: (err && err.message) ? err.message : '网络或接口错误' });
      });
    });
  }

  function mergeLlmIntent(parsed, message, ctx, fallback) {
    if (!parsed || typeof parsed !== 'object') return null;
    var module = core();
    var intents = ['clean', 'import', 'export', 'query', 'edit', 'stats', 'undo', 'help'];
    var intent = intents.indexOf(parsed.intent) >= 0 ? parsed.intent : null;
    if (!intent) return null;
    var rebuilt = module && typeof module.parseIntent === 'function' ? module.parseIntent(message, ctx) : null;
    var toolMap = {
      clean: 'assistant.clean', import: 'data.import', export: 'data.export', query: 'data.query',
      edit: 'data.edit', stats: 'data.stats', undo: 'data.undo', help: 'assistant.help'
    };
    var tool = toolMap[intent];
    var spec = module && typeof module.toolSpec === 'function' ? module.toolSpec(tool) : null;
    var datasetType = parsed.datasetType === 'events' || parsed.datasetType === 'material_library' ? parsed.datasetType : 'unknown';
    var params = {};
    if (datasetType !== 'unknown') params.datasetType = datasetType;
    if (intent === 'export') {
      params.exportScope = parsed.params && parsed.params.exportScope === 'all' ? 'all' : 'current_filter';
      params.format = parsed.params && parsed.params.format === 'xlsx' ? 'xlsx' : 'csv';
    }
    return {
      intent: intent,
      datasetType: datasetType,
      tool: tool,
      params: params,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      reply: text(parsed.reply) || (rebuilt ? rebuilt.reply : '好的。'),
      source: 'llm',
      needsFile: spec ? Boolean(!spec.runnableWithoutFile && !(ctx.hasPendingFile || ctx.hasPendingRows)) : false,
      needsConfirm: spec ? Boolean(spec.requiresConfirm) : false
    };
  }

  /* ---------------- 清洗/导入/撤销 的对话入口 ---------------- */

  function requestFileReply() {
    reply('需要先有文件：点左下角「上传」选一个 CSV / Excel（可先用「数据录入」页的模板填写），我再清洗并给出问题明细。');
  }

  function handleCleanIntent(intent) {
    if (state.pendingCleaning) {
      pushAssistant({ text: describeCleaning(state.pendingCleaning.report), cleaning: attachCleaningActions(state.pendingCleaning.report) });
      render();
      return;
    }
    if (state.pendingFile) {
      runCleaning(state.pendingFile.rows, state.pendingFile.name, state.pendingFile.sheetName);
      return;
    }
    if (intent && intent.reply) reply(intent.reply);
    else requestFileReply();
  }

  function showImportConfirm() {
    var pending = state.pendingCleaning;
    var report = pending.report;
    var summary = report.summary || {};
    pushAssistant({
      text: '',
      operation: {
        tool: 'data.import',
        datasetType: report.datasetType,
        title: '导入预览',
        detail: '将写入 ' + (summary.cleanRows || 0) + ' 行' + (report.fileName ? '（' + report.fileName + '）' : '') + '，写入后可一键撤销。',
        metrics: [
          { label: '可导入行', value: String(summary.cleanRows || 0), tone: 'ok' },
          { label: '错误行', value: String(summary.errorCount || 0), tone: summary.errorCount ? 'danger' : '' },
          { label: '警告行', value: String(summary.warningCount || 0), tone: summary.warningCount ? 'warn' : '' }
        ],
        warnings: summary.warningCount ? ['有警告行，导入后请到「数据录入」页抽查。'] : [],
        status: 'ready',
        primaryAction: { id: 'import-confirm', label: '确认导入' },
        secondaryActions: [{ id: 'clean-cancel', label: '取消', tone: 'ghost' }]
      }
    });
    render();
  }

  function handleImportIntent(intent) {
    if (state.pendingCleaning) {
      if (!pendingCleaningImportable()) {
        reply('当前清洗结果不可导入（有错误行或数据集未识别）。请按清洗卡片修正后重新上传。');
        return;
      }
      showImportConfirm();
      return;
    }
    if (state.pendingFile) {
      runCleaning(state.pendingFile.rows, state.pendingFile.name, state.pendingFile.sheetName);
      return;
    }
    if (intent && intent.reply) reply(intent.reply);
    else requestFileReply();
  }

  function handleEditIntent(intent, message) {
    var module = core();
    var plan = module && typeof module.parseEdit === 'function' ? module.parseEdit(message) : null;
    if (!plan) {
      reply('我可以修改单条记录的单个字段。请给出管段编码、字段和新值，例如：「把 1-WW-FR-008-0003-000 的最新测厚记录厚度改成 6.8」。');
      return;
    }
    executeEdit(plan);
  }

  function handleUndoIntent() {
    if (state.lastImport) {
      var last = state.lastImport;
      var detail = last.kind === 'material_library'
        ? '将把材料库恢复到导入前的状态（' + (last.imported || 0) + ' 条记录被回滚）。'
        : '将移除本次导入新增的事件 ' + (last.importedEvents || 0) + ' 条、更换 ' + (last.importedReplacements || 0) + ' 条。';
      pushAssistant({
        text: '',
        operation: {
          tool: 'data.undo',
          datasetType: last.kind === 'material_library' ? 'material_library' : 'events',
          title: '撤销导入预览',
          detail: detail,
          metrics: [],
          warnings: ['只回滚助手自己最近一次导入，页面原有导入不受影响。'],
          status: 'ready',
          primaryAction: { id: 'undo-last-import', label: '确认撤销' },
          secondaryActions: []
        }
      });
      render();
      return;
    }
    if (state.lastEdit) {
      reply('没有可撤销的导入。最近一次修改可以撤销：点消息里的「撤销这次修改」，或直接说「撤销修改」。');
      return;
    }
    reply('没有可撤销的导入记录（只记录助手最近一次导入）。');
  }

  /* ---------------- 导出清洗结果 / 问题明细 ---------------- */

  function exportCleanedRows() {
    var pending = state.pendingCleaning;
    if (!pending || !pending.cleanRows || pending.cleanRows.length < 2) { reply('没有可导出的清洗结果，请先上传文件。'); return; }
    var columns = pending.cleanRows[0].map(text);
    var rows = pending.cleanRows.slice(1).map(function (cells) {
      var item = {};
      columns.forEach(function (column, index) { item[column] = text(cells[index]); });
      return item;
    });
    var fileName = 'AI助手_清洗后数据_' + new Date().toISOString().slice(0, 10) + '.csv';
    if (downloadCsv(columns, rows, fileName)) reply('已导出清洗后数据 ' + rows.length + ' 条（CSV）。');
  }

  function exportIssueRows() {
    var pending = state.pendingCleaning;
    if (!pending || !pending.report) { reply('没有可导出的问题明细，请先上传文件。'); return; }
    var rows = [];
    (pending.report.checks || []).forEach(function (check) {
      (check.rows || []).forEach(function (rowNo) {
        rows.push({
          '问题级别': text(check.severity),
          '问题标题': text(check.title),
          '说明': text(check.detail),
          '行号': rowNo,
          '建议': text(check.suggestion)
        });
      });
    });
    if (!rows.length) { reply('本次清洗没有发现问题，无需导出问题明细。'); return; }
    var columns = ['问题级别', '问题标题', '说明', '行号', '建议'];
    if (downloadCsv(columns, rows, 'AI助手_问题明细_' + new Date().toISOString().slice(0, 10) + '.csv')) {
      reply('已导出问题明细 ' + rows.length + ' 条（CSV）。');
    }
  }

  /* ---------------- 动作分发 ---------------- */

  function confirmDialog(message) {
    try {
      if (typeof global.confirm === 'function') return Boolean(global.confirm(message));
    } catch (err) { /* 无 confirm 时直接执行 */ }
    return true;
  }

  function handleAction(actionId) {
    if (actionId === 'import-confirm') { executeImport(); return; }
    if (actionId === 'clean-cancel') {
      state.pendingCleaning = null;
      state.pendingFile = null;
      reply('已取消本次清洗结果，需要时重新上传文件即可。');
      return;
    }
    if (actionId === 'export-cleaned') { exportCleanedRows(); return; }
    if (actionId === 'export-issues') { exportIssueRows(); return; }
    if (actionId === 'export-query') { exportQueryResult(); return; }
    if (actionId === 'edit-confirm') { confirmEdit(); return; }
    if (actionId === 'edit-cancel') { state.pendingEdit = null; reply('已取消本次修改，没有写入任何数据。'); return; }
    if (actionId === 'undo-last-edit') { undoLastEdit(); return; }
    if (actionId === 'undo-last-import') {
      if (!state.lastImport) { reply('没有可撤销的导入记录。'); return; }
      if (!confirmDialog('确认撤销助手最近一次导入？该操作会移除本次新增的记录。')) { reply('已取消撤销。'); return; }
      undoLastImport();
      return;
    }
  }

  /* ---------------- 对话主流程 ---------------- */

  function buildContext() {
    var snap = snapshot();
    return {
      role: currentRole(),
      currentView: currentViewId(),
      hasPendingFile: Boolean(state.pendingFile),
      hasPendingRows: Boolean(state.pendingCleaning),
      fileName: state.pendingFile ? state.pendingFile.name : '',
      headers: state.pendingFile && state.pendingFile.rows && state.pendingFile.rows[0] ? state.pendingFile.rows[0] : undefined,
      activeDatasetType: state.pendingCleaning && state.pendingCleaning.report ? state.pendingCleaning.report.datasetType : undefined,
      counts: {
        events: (snap.events || []).length,
        replacements: (snap.replacements || []).length,
        materialLibrary: (snap.materialLibrary || []).length
      }
    };
  }

  function currentViewId() {
    var doc = global.document;
    if (!doc) return '';
    var active = doc.querySelector ? doc.querySelector('.view.active') : null;
    return active && active.id ? String(active.id).replace('view-', '') : '';
  }

  function routeIntent(intent, message) {
    if (!intent) { reply('没太听懂，可以说「帮助」查看示例。'); return; }
    if (intent.intent === 'help') { executeHelp(); return; }
    if (intent.intent === 'stats') { executeStats(); return; }
    if (intent.intent === 'clean') { handleCleanIntent(intent); return; }
    if (intent.intent === 'import') { handleImportIntent(intent); return; }
    if (intent.intent === 'export') { executeExport(intent.params); return; }
    if (intent.intent === 'query') { executeQuery(intent, message); return; }
    if (intent.intent === 'edit') { handleEditIntent(intent, message); return; }
    if (intent.intent === 'undo') { handleUndoIntent(); return; }
    reply(intent.reply || '没太听懂，可以说「帮助」查看示例。');
  }

  function send(message) {
    var raw = text(message).trim();
    if (!raw || state.busy) return;
    pushUser({ text: raw });
    state.lastMessage = raw;
    state.pendingQuery = null;
    setBusy(true);
    render();
    var ctx = buildContext();
    var module = core();
    var intent = module && typeof module.parseIntent === 'function' ? module.parseIntent(raw, ctx) : null;
    if (!intent) {
      setBusy(false);
      reply('助手组件还没有加载完成，请刷新页面后重试。');
      return;
    }
    if (intent.intent !== 'unknown' || !llmConfigured()) {
      setBusy(false);
      routeIntent(intent, raw);
      return;
    }
    parseIntentWithLlm(raw, ctx).then(function (result) {
      setBusy(false);
      var merged = result && result.ok ? mergeLlmIntent(result.parsed, raw, ctx, intent) : null;
      routeIntent(merged || intent, raw);
      if (!merged) {
        var reason = result && result.reason ? result.reason : '模型未返回可用结果';
        reply('模型调用失败：' + reason + '（已降级为规则解析）');
      }
    }).catch(function (err) {
      setBusy(false);
      routeIntent(intent, raw);
      reply('模型调用失败：' + ((err && err.message) || '未知错误') + '（已降级为规则解析）');
    });
  }

  /* ---------------- 面板挂载 ---------------- */

  function openModelSettings() {
    if (typeof global.switchView === 'function') global.switchView('dashboard');
    var doc = global.document;
    var details = doc && doc.querySelector ? doc.querySelector('.llm-panel details') : null;
    if (details) {
      details.open = true;
      if (typeof details.scrollIntoView === 'function') details.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    toast('已打开「模型接口配置」，保存后回到助手即可使用大模型增强。', 'info');
  }

  function dispatch(event) {
    if (!event || !event.kind) return;
    if (event.kind === 'send') { send(event.text); return; }
    if (event.kind === 'file') { handleFile(event.file); return; }
    if (event.kind === 'action') { handleAction(event.actionId); return; }
    if (event.kind === 'toggle-history') { state.historyOpen = !state.historyOpen; render(); return; }
    if (event.kind === 'select-history') { openConversation(event.conversationId); return; }
    if (event.kind === 'delete-history') { deleteConversation(event.conversationId); return; }
    if (event.kind === 'new-chat') { startNewConversation(); return; }
    if (event.kind === 'open-settings') { openModelSettings(); return; }
  }

  function mount() {
    if (state.mounted) return api;
    var uiModule = ui();
    var doc = global.document;
    if (!uiModule || !doc || typeof uiModule.mount !== 'function') return api;
    var root = doc.getElementById ? doc.getElementById('assistantMount') : null;
    if (!root) {
      root = doc.createElement('div');
      root.id = 'assistantMount';
      (doc.body || doc.documentElement).appendChild(root);
    }
    state.lastImport = readJSON(LAST_IMPORT_KEY, null);
    state.lastEdit = readJSON(LAST_EDIT_KEY, null);
    loadHistory();
    if (!state.activeConversationId && state.conversations.length) {
      var first = state.conversations[0];
      state.activeConversationId = first.id;
      state.messages = first.messages.map(function (msg) {
        return { id: msg.id, role: msg.role, text: msg.text, createdAt: msg.createdAt };
      });
    }
    controller = uiModule.mount({
      root: root,
      document: doc,
      state: viewState,
      dispatch: dispatch
    });
    state.mounted = true;
    return api;
  }

  /* ---------------- 对外门面（§7） ---------------- */

  var api = {
    version: VERSION,
    mount: mount,
    open: function () {
      mount();
      if (controller && typeof controller.open === 'function') controller.open();
      return api;
    },
    close: function () {
      if (controller && typeof controller.close === 'function') controller.close();
      return api;
    },
    toggle: function () {
      mount();
      if (controller && typeof controller.toggle === 'function') controller.toggle();
      return api;
    },
    isOpen: function () {
      return Boolean(controller && typeof controller.isOpen === 'function' && controller.isOpen());
    },
    send: send,
    handleFile: handleFile,
    refresh: function () {
      loadHistory();
      render();
      return api;
    }
  };

  global.BTAssistant = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (typeof global.document !== 'undefined' && global.document) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', function () { mount(); });
    } else {
      setTimeout(function () { mount(); }, 0);
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
