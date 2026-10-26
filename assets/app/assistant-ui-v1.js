/* ============================================================
   BOILER-TUBE LIFECYCLE MANAGEMENT SYSTEM · AI 数据助手 · UI 层
   assets/app/assistant-ui-v1.js · v1.0.0
   ------------------------------------------------------------
   职责（契约 docs/ai-assistant-spec.md §6）：
   1. 纯渲染函数：返回 HTML 字符串，绝不操作 DOM；
   2. mount() 控制器：挂载面板、事件委托、开关与状态机。
   依赖：无（不依赖业务层、不依赖 core、不引入任何第三方库）。
   风格：经典脚本 IIFE，挂 window.BTAssistantUI，兼容 module.exports 便于 Node 测试。
   ============================================================ */
(function (global) {
  'use strict';

  var VERSION = '1.0.0';
  var DEFAULT_TITLE = 'AI 数据助手';

  var ROLE_LABELS = { viewer: '只读', editor: '编辑', admin: '管理员' };
  var DATASET_LABELS = { events: '寿命事件', material_library: '受热面材料库', unknown: '未知数据集' };
  var SEVERITY_LABELS = { info: '提示', warning: '警告', error: '错误' };
  var STATUS_META = {
    pending: { label: '待确认', tone: 'pending' },
    ready: { label: '待执行', tone: 'accent' },
    running: { label: '处理中', tone: 'accent' },
    done: { label: '已完成', tone: 'ok' },
    error: { label: '失败', tone: 'danger' }
  };

  var DOM_IDS = Object.freeze([
    'assistantLauncher', 'assistantPanel', 'assistantClose', 'assistantHistoryBtn',
    'assistantNewChat', 'assistantTitle', 'assistantStatus', 'assistantMessages',
    'assistantQuick', 'assistantInput', 'assistantSend', 'assistantAttach',
    'assistantFile', 'assistantHistory', 'assistantModelHint', 'assistantTyping'
  ]);

  var HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  /* ---------------- 基础工具 ---------------- */

  function toText(value) {
    if (value === null || value === undefined) return '';
    return typeof value === 'string' ? value : String(value);
  }

  function escapeHtml(value) {
    return toText(value).replace(/[&<>"']/g, function (ch) { return HTML_ESCAPES[ch]; });
  }

  function num(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function formatCount(value) {
    var rounded = Math.round(num(value));
    var negative = rounded < 0;
    var digits = String(Math.abs(rounded)).split('');
    var out = '';
    for (var i = 0; i < digits.length; i += 1) {
      if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
      out += digits[i];
    }
    return (negative ? '-' : '') + out;
  }

  function formatBytes(value) {
    var size = Number(value);
    if (!Number.isFinite(size) || size <= 0) return '';
    if (size < 1024) return Math.round(size) + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1).replace(/\.0$/, '') + ' KB';
    return (size / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + ' MB';
  }

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function toDate(value) {
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    if (typeof value === 'number' && isFinite(value)) {
      var fromNumber = new Date(value);
      return isNaN(fromNumber.getTime()) ? null : fromNumber;
    }
    if (typeof value === 'string' && value.trim()) {
      var fromText = new Date(value.trim());
      return isNaN(fromText.getTime()) ? null : fromText;
    }
    return null;
  }

  function formatClock(value) {
    var date = toDate(value);
    if (!date) return '';
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  function formatDateTime(value) {
    var date = toDate(value);
    if (!date) return '';
    return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  function roleLabel(role) {
    var key = toText(role).toLowerCase();
    return ROLE_LABELS[key] || ROLE_LABELS.viewer;
  }

  function normalizeRole(role) {
    var key = toText(role).toLowerCase();
    return ROLE_LABELS[key] ? key : 'editor';
  }

  function datasetLabel(type) {
    var key = toText(type);
    return DATASET_LABELS[key] || DATASET_LABELS.unknown;
  }

  function statusText(configured) {
    return configured ? '模型接口已就绪 · 规则兜底' : '规则引擎（离线）';
  }

  function modelHintText(configured) {
    return configured ? '模型接口已配置 · 点击前往设置' : '模型接口未配置 · 点击前往设置';
  }

  function modelHintLabel(configured) {
    return configured ? '模型接口已配置，点击前往模型设置' : '模型接口未配置，点击前往模型设置';
  }

  function fileKind(name) {
    var match = /\.([a-z0-9]+)$/i.exec(toText(name));
    if (!match) return '文件';
    return match[1].toUpperCase().slice(0, 4);
  }

  function rowSummary(rows) {
    if (!Array.isArray(rows)) return '';
    var list = rows.map(function (item) { return Math.round(num(item)); }).filter(function (item) { return item > 0; });
    if (!list.length) return '';
    var head = list.slice(0, 8).join('、');
    return list.length > 8 ? head + ' 等 ' + list.length + ' 行' : head;
  }

  /* ---------------- 纯渲染：悬浮入口 ---------------- */

  function launcherMarkup(options) {
    var opts = options && typeof options === 'object' ? options : {};
    var unread = !!opts.unread;
    return [
      '<button type="button" id="assistantLauncher" class="assistant-launcher" data-assistant="launcher" aria-label="打开 AI 数据助手" aria-haspopup="dialog" aria-controls="assistantPanel" aria-expanded="false" title="AI 数据助手">',
      '  <span class="assistant-launcher-orb" aria-hidden="true">AI</span>',
      '  <span class="assistant-launcher-label">数据助手</span>',
      '  <span class="assistant-launcher-badge"' + (unread ? '' : ' hidden') + ' aria-hidden="true"></span>',
      '</button>'
    ].join('\n');
  }

  /* ---------------- 纯渲染：面板骨架 ---------------- */

  function panelMarkup(options) {
    var opts = options && typeof options === 'object' ? options : {};
    var configured = !!opts.configured;
    var role = normalizeRole(opts.role);
    var title = opts.title ? toText(opts.title) : DEFAULT_TITLE;
    return [
      '<section id="assistantPanel" class="assistant-panel" role="dialog" aria-modal="true" aria-label="AI 数据助手" hidden>',
      '  <header class="assistant-head">',
      '    <div class="assistant-ident">',
      '      <span class="assistant-ident-orb" aria-hidden="true">AI</span>',
      '      <div class="assistant-ident-text">',
      '        <h2 class="assistant-title" id="assistantTitle">' + escapeHtml(title) + '</h2>',
      '        <p class="assistant-status' + (configured ? ' is-online' : ' is-offline') + '" id="assistantStatus" role="status" aria-live="polite">' + escapeHtml(statusText(configured)) + '</p>',
      '      </div>',
      '    </div>',
      '    <div class="assistant-head-actions">',
      '      <button type="button" class="assistant-icon-btn" id="assistantExportChat" data-assistant="export-chat" aria-label="导出对话" title="导出当前对话（Markdown）">⇩</button>',
      '      <button type="button" class="assistant-icon-btn" id="assistantHistoryBtn" data-assistant="history" aria-label="会话历史" aria-controls="assistantHistory" aria-expanded="false" title="会话历史">☰</button>',
      '      <button type="button" class="assistant-icon-btn" id="assistantNewChat" data-assistant="new-chat" aria-label="新建会话" title="新建会话">＋</button>',
      '      <button type="button" class="assistant-icon-btn assistant-icon-btn--close" id="assistantClose" data-assistant="close" aria-label="关闭助手面板" title="关闭（Esc）">×</button>',
      '    </div>',
      '  </header>',
      '  <div class="assistant-history" id="assistantHistory" role="region" aria-label="历史会话" hidden></div>',
      '  <div class="assistant-attachments" id="assistantAttachments" hidden></div>',
      '  <div class="assistant-messages" id="assistantMessages" role="log" aria-live="polite" aria-relevant="additions text" aria-label="对话消息"></div>',
      '  <div class="assistant-quick" id="assistantQuick" role="group" aria-label="快捷指令" hidden></div>',
      '  <div class="assistant-typing" id="assistantTyping" role="status" aria-label="助手正在思考" hidden>',
      '    <span class="assistant-typing-dot" aria-hidden="true"></span>',
      '    <span class="assistant-typing-dot" aria-hidden="true"></span>',
      '    <span class="assistant-typing-dot" aria-hidden="true"></span>',
      '  </div>',
      '  <div class="assistant-composer">',
      '    <label class="assistant-attach" id="assistantAttach" data-assistant="attach" for="assistantFile" role="button" tabindex="0" aria-label="上传表格 / 图片 / PDF 文件" title="上传 CSV / Excel / 图片 / PDF">上传</label>',
      '    <input class="assistant-file" id="assistantFile" type="file" multiple accept=".csv,.xlsx,.xls,.png,.jpg,.jpeg,.webp,.pdf" tabindex="-1" aria-hidden="true" />',
      '    <textarea class="assistant-input" id="assistantInput" rows="1" maxlength="2000" placeholder="用一句话说明需求；表格/图片/PDF 可直接拖入本窗口" aria-label="向 AI 数据助手提问"></textarea>',
      '    <button type="button" class="assistant-send" id="assistantSend" data-assistant="send" aria-label="发送">↑</button>',
      '  </div>',
      '  <footer class="assistant-foot">',
      '    <button type="button" class="assistant-model-hint' + (configured ? ' is-configured' : '') + '" id="assistantModelHint" data-assistant="settings" aria-label="' + escapeHtml(modelHintLabel(configured)) + '">' + escapeHtml(modelHintText(configured)) + '</button>',
      '    <span class="assistant-role" title="当前权限">' + escapeHtml(roleLabel(role)) + '</span>',
      '  </footer>',
      '</section>'
    ].join('\n');
  }

  /* ---------------- 纯渲染：附件 ---------------- */

  function attachmentMarkup(attachment) {
    var att = attachment && typeof attachment === 'object' ? attachment : { name: toText(attachment) };
    var name = toText(att.name) || '未命名文件';
    var size = formatBytes(att.size);
    var lines = [
      '    <div class="assistant-attachment" title="' + escapeHtml(name) + '">',
      '      <span class="assistant-attachment-icon" aria-hidden="true">' + escapeHtml(fileKind(name)) + '</span>',
      '      <span class="assistant-attachment-name">' + escapeHtml(name) + '</span>'
    ];
    if (size) lines.push('      <span class="assistant-attachment-size">' + escapeHtml(size) + '</span>');
    lines.push('    </div>');
    return lines.join('\n');
  }

  /* ---------------- 纯渲染：会话附件条（多轮上下文） ---------------- */

  var ATTACHMENT_KIND_LABELS = { image: '图片', pdf: 'PDF', table: '表格' };

  function attachmentKindLabel(kind) {
    return ATTACHMENT_KIND_LABELS[toText(kind)] || '附件';
  }

  /* 会话附件条：空数组返回 ''（容器保持 hidden）；当前项加 .is-current。
     只渲染元信息（序号/名称/类型/行数），明细与原图留在接线层，UI 层不碰数据。 */
  function attachmentBarMarkup(attachments, currentId) {
    var list = Array.isArray(attachments) ? attachments : [];
    if (!list.length) return '';
    var current = toText(currentId);
    if (!current) {
      var tail = list[list.length - 1];
      current = toText(tail && tail.id);
    }
    var lines = [];
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i] && typeof list[i] === 'object' ? list[i] : {};
      var id = toText(item.id);
      var name = toText(item.name) || '未命名附件';
      var kind = toText(item.kind) || 'table';
      var seq = Math.round(num(item.seq)) > 0 ? Math.round(num(item.seq)) : i + 1;
      var rowCount = Math.round(num(item.rowCount));
      var isCurrent = !!id && id === current;
      var meta = attachmentKindLabel(kind) + (rowCount > 0 ? ' · ' + formatCount(rowCount) + ' 行' : '');
      var title = name + ' · ' + meta;
      if (toText(item.notes)) title += ' · 识别备注：' + toText(item.notes);
      if (toText(item.importedAt)) title += ' · 已导入 ' + formatDateTime(item.importedAt);
      lines.push('  <div class="assistant-attachment-chip' + (isCurrent ? ' is-current' : '') + '"'
        + ' data-assistant="attachment" data-attachment-id="' + escapeHtml(id) + '" data-attachment-action="select"'
        + ' role="button" tabindex="0" aria-pressed="' + (isCurrent ? 'true' : 'false') + '" title="' + escapeHtml(title) + '">');
      lines.push('    <span class="assistant-attachment-seq" aria-hidden="true">' + escapeHtml(String(seq)) + '</span>');
      lines.push('    <span class="assistant-attachment-label">' + escapeHtml(name) + '</span>');
      lines.push('    <span class="assistant-attachment-meta">' + escapeHtml(meta) + '</span>');
      lines.push('    <button type="button" class="assistant-attachment-remove" data-assistant="attachment" data-attachment-id="'
        + escapeHtml(id) + '" data-attachment-action="remove" aria-label="移除附件：' + escapeHtml(name) + '" title="移除附件">×</button>');
      lines.push('  </div>');
    }
    return lines.join('\n');
  }

  /* ---------------- 纯渲染：清洗报告卡片 ---------------- */

  function checkMarkup(check) {
    var item = check && typeof check === 'object' ? check : {};
    var severity = SEVERITY_LABELS[item.severity] ? item.severity : 'info';
    var rows = Array.isArray(item.rows) ? item.rows : [];
    var sample = Array.isArray(item.sample) ? item.sample : [];
    var title = toText(item.title) || '数据检查';
    var detail = toText(item.detail);
    var suggestion = toText(item.suggestion);
    var lines = [
      '      <li class="assistant-check" data-severity="' + severity + '">',
      '        <span class="assistant-check-tag">' + escapeHtml(SEVERITY_LABELS[severity]) + '</span>',
      '        <div class="assistant-check-body">',
      '          <p class="assistant-check-title">' + escapeHtml(title) + (rows.length ? '<span class="assistant-check-rows">涉及 ' + formatCount(rows.length) + ' 行</span>' : '') + '</p>'
    ];
    if (detail) lines.push('          <p class="assistant-check-detail">' + escapeHtml(detail) + '</p>');
    if (rows.length) lines.push('          <p class="assistant-check-rows-line">第 ' + escapeHtml(rowSummary(rows)) + ' 行</p>');
    if (sample.length) lines.push('          <p class="assistant-check-sample">例：' + escapeHtml(sample.join(' / ')) + '</p>');
    if (suggestion) lines.push('          <p class="assistant-check-suggest">建议：' + escapeHtml(suggestion) + '</p>');
    lines.push('        </div>');
    lines.push('      </li>');
    return lines.join('\n');
  }

  function metricMarkup(metric) {
    var item = metric && typeof metric === 'object' ? metric : {};
    var tone = item.tone === 'ok' || item.tone === 'warn' || item.tone === 'danger' || item.tone === 'accent' ? item.tone : '';
    return [
      '      <div class="assistant-metric"' + (tone ? ' data-tone="' + tone + '"' : '') + '>',
      '        <span class="assistant-metric-k">' + escapeHtml(toText(item.label) || '指标') + '</span>',
      '        <span class="assistant-metric-v">' + escapeHtml(toText(item.value) || '0') + '</span>',
      '      </div>'
    ].join('\n');
  }

  function actionButtonMarkup(action, options) {
    var item = action && typeof action === 'object' ? action : null;
    if (!item) return '';
    var actionId = toText(item.id);
    if (!actionId) return '';
    var opts = options && typeof options === 'object' ? options : {};
    var tone = item.tone === 'primary' || item.tone === 'danger' || item.tone === 'ghost' ? item.tone : 'default';
    var classes = 'assistant-btn';
    if (tone === 'primary') classes += ' assistant-btn--primary';
    else if (tone === 'danger') classes += ' assistant-btn--danger';
    else if (tone === 'ghost') classes += ' assistant-btn--ghost';
    var attrs = [
      'type="button"',
      'class="' + classes + '"',
      'data-assistant="action"',
      'data-action-id="' + escapeHtml(actionId) + '"'
    ];
    if (opts.tool) attrs.push('data-tool="' + escapeHtml(opts.tool) + '"');
    if (opts.disabled) attrs.push('disabled');
    return '<button ' + attrs.join(' ') + '>' + escapeHtml(toText(item.label) || '执行') + '</button>';
  }

  function actionButtonsMarkup(actions, options) {
    var list = Array.isArray(actions) ? actions : [];
    var buttons = list.map(function (action) { return actionButtonMarkup(action, options); }).filter(function (item) { return !!item; });
    if (!buttons.length) return '';
    return [
      '      <div class="assistant-actions">',
      '        ' + buttons.join('\n        '),
      '      </div>'
    ].join('\n');
  }

  function cleaningMarkup(report) {
    var rep = report && typeof report === 'object' ? report : {};
    var summary = rep.summary && typeof rep.summary === 'object' ? rep.summary : {};
    var checks = Array.isArray(rep.checks) ? rep.checks : [];
    var actions = Array.isArray(rep.actions) ? rep.actions : [];
    var normalizations = Array.isArray(rep.normalizations) ? rep.normalizations : [];
    var datasetType = toText(rep.datasetType) || 'unknown';
    var errorCount = num(summary.errorCount);
    var warningCount = num(summary.warningCount);
    var duplicateRows = num(summary.duplicateRows);
    var cleanRowCount = Array.isArray(summary.cleanRows) ? summary.cleanRows.length : num(summary.cleanRows);
    var totalRows = num(summary.totalRows);
    var importable = typeof summary.importable === 'boolean'
      ? summary.importable
      : (errorCount === 0 && cleanRowCount > 0 && datasetType !== 'unknown');
    var tone = importable ? 'ok' : (errorCount > 0 ? 'danger' : 'warn');
    var chipLabel = importable
      ? '可导入'
      : (datasetType === 'unknown' ? '未识别数据集' : (errorCount > 0 ? '需修正 ' + formatCount(errorCount) + ' 行' : '待确认'));
    var subtitle = toText(rep.fileName);
    if (toText(rep.sheetName)) subtitle += (subtitle ? ' · ' : '') + toText(rep.sheetName);

    var lines = [
      '<div class="assistant-cleaning" data-tone="' + tone + '" data-dataset="' + escapeHtml(datasetType) + '">',
      '  <div class="assistant-card-head">',
      '    <span class="assistant-chip" data-tone="' + tone + '">' + escapeHtml(chipLabel) + '</span>',
      '    <span class="assistant-card-title">清洗报告 · ' + escapeHtml(datasetLabel(datasetType)) + '</span>',
      subtitle ? '    <span class="assistant-card-sub" title="' + escapeHtml(subtitle) + '">' + escapeHtml(subtitle) + '</span>' : '',
      '  </div>',
      '  <div class="assistant-metrics">',
      metricMarkup({ label: '数据行', value: formatCount(totalRows) }),
      metricMarkup({ label: '可导入', value: formatCount(cleanRowCount), tone: cleanRowCount > 0 ? 'ok' : '' }),
      metricMarkup({ label: '错误行', value: formatCount(errorCount), tone: errorCount > 0 ? 'danger' : '' }),
      metricMarkup({ label: '警告行', value: formatCount(warningCount), tone: warningCount > 0 ? 'warn' : '' }),
      metricMarkup({ label: '重复丢弃', value: formatCount(duplicateRows), tone: duplicateRows > 0 ? 'warn' : '' }),
      '  </div>',
      '  <ul class="assistant-checks">'
    ];
    if (checks.length) {
      for (var i = 0; i < checks.length; i += 1) lines.push(checkMarkup(checks[i]));
    } else {
      lines.push('      <li class="assistant-check" data-severity="info"><span class="assistant-check-tag">提示</span><div class="assistant-check-body"><p class="assistant-check-title">未发现数据问题</p><p class="assistant-check-detail">所有数据行均可直接交给导入流程。</p></div></li>');
    }
    lines.push('  </ul>');
    if (normalizations.length) {
      lines.push('  <details class="assistant-cleaning-notes">');
      lines.push('    <summary>归一化处理 ' + formatCount(normalizations.length) + ' 项</summary>');
      lines.push('    <ul>');
      for (var n = 0; n < normalizations.length; n += 1) lines.push('      <li>' + escapeHtml(normalizations[n]) + '</li>');
      lines.push('    </ul>');
      lines.push('  </details>');
    }
    if (actions.length) lines.push(actionButtonsMarkup(actions, { tool: toText(rep.tool) }));
    lines.push('</div>');
    return lines.join('\n');
  }

  /* ---------------- 纯渲染：操作卡片 ---------------- */

  function operationMarkup(card) {
    var op = card && typeof card === 'object' ? card : {};
    var status = STATUS_META[op.status] ? op.status : 'pending';
    var meta = STATUS_META[status];
    var metrics = Array.isArray(op.metrics) ? op.metrics : [];
    var warnings = Array.isArray(op.warnings) ? op.warnings : [];
    var primary = op.primaryAction && typeof op.primaryAction === 'object' ? op.primaryAction : null;
    var secondary = Array.isArray(op.secondaryActions) ? op.secondaryActions : [];
    var datasetType = toText(op.datasetType) || 'unknown';
    var tone = op.resultTone === 'success' || op.resultTone === 'warning' || op.resultTone === 'error' ? op.resultTone : '';
    var running = status === 'running';
    var title = toText(op.title) || '操作';
    var detail = toText(op.detail);
    var summaryText = toText(op.summaryText);

    var actionList = [];
    if (primary) {
      actionList.push({ id: primary.id, label: primary.label, tone: 'primary' });
    }
    for (var i = 0; i < secondary.length; i += 1) {
      actionList.push(secondary[i]);
    }

    var lines = [
      '<div class="assistant-op" data-status="' + status + '"' + (tone ? ' data-tone="' + tone + '"' : '') + (op.tool ? ' data-tool="' + escapeHtml(op.tool) + '"' : '') + '>',
      '  <div class="assistant-card-head">',
      '    <span class="assistant-chip" data-tone="' + meta.tone + '">' + escapeHtml(meta.label) + '</span>',
      '    <span class="assistant-card-title">' + escapeHtml(title) + '</span>',
      datasetType !== 'unknown' ? '    <span class="assistant-card-sub">' + escapeHtml(datasetLabel(datasetType)) + '</span>' : '',
      '  </div>'
    ];
    if (detail) lines.push('  <p class="assistant-op-detail">' + escapeHtml(detail) + '</p>');
    if (metrics.length) {
      lines.push('  <div class="assistant-metrics">');
      for (var m = 0; m < metrics.length; m += 1) lines.push(metricMarkup(metrics[m]));
      lines.push('  </div>');
    }
    if (warnings.length) {
      lines.push('  <ul class="assistant-warnings">');
      for (var w = 0; w < warnings.length; w += 1) lines.push('    <li class="assistant-warning">' + escapeHtml(warnings[w]) + '</li>');
      lines.push('  </ul>');
    }
    if (summaryText) lines.push('  <p class="assistant-op-summary">' + escapeHtml(summaryText) + '</p>');
    var buttons = actionButtonsMarkup(actionList, { tool: toText(op.tool), disabled: running });
    if (buttons) lines.push(buttons);
    lines.push('</div>');
    return lines.join('\n');
  }

  /* ---------------- 纯渲染：分析卡片 ---------------- */

  function tableMarkup(table, limit) {
    var data = table && typeof table === 'object' ? table : {};
    var columns = Array.isArray(data.columns) ? data.columns : [];
    var rows = Array.isArray(data.rows) ? data.rows : [];
    if (!columns.length || !rows.length) return '';
    var max = typeof limit === 'number' && limit > 0 ? limit : 6;
    var shown = rows.slice(0, max);
    var lines = [
      '<div class="assistant-analysis-table">',
      '  <table>',
      '    <thead><tr>' + columns.map(function (column) {
        return '<th>' + escapeHtml(toText(column)) + '</th>';
      }).join('') + '</tr></thead>',
      '    <tbody>'
    ];
    for (var i = 0; i < shown.length; i += 1) {
      lines.push('      <tr>' + columns.map(function (column) {
        var value = shown[i] && typeof shown[i] === 'object' ? shown[i][column] : '';
        return '<td>' + escapeHtml(toText(value)) + '</td>';
      }).join('') + '</tr>');
    }
    lines.push('    </tbody>');
    lines.push('  </table>');
    if (rows.length > shown.length) {
      lines.push('  <p class="assistant-analysis-more">仅显示前 ' + formatCount(shown.length) + ' 行，共 ' + formatCount(rows.length) + ' 行；导出可得完整明细。</p>');
    }
    lines.push('</div>');
    return lines.join('\n');
  }

  function analysisMarkup(card) {
    var analysis = card && typeof card === 'object' ? card : {};
    var module = global.BTAssistantAnalysis;
    var kindLabel = toText(analysis.kindLabel) || '分析';
    var title = toText(analysis.title) || kindLabel;
    var metrics = Array.isArray(analysis.metrics) ? analysis.metrics : [];
    var insights = Array.isArray(analysis.insights) ? analysis.insights : [];
    var actions = Array.isArray(analysis.actions) ? analysis.actions : [];
    var chartSvg = toText(analysis.chartSvg);
    if (!chartSvg && module && typeof module.chartSvg === 'function' && analysis.chart) {
      try { chartSvg = module.chartSvg(analysis.chart); } catch (err) { chartSvg = ''; }
    }
    var sampleSize = num(analysis.sampleSize);
    var datasetType = toText(analysis.datasetType) || 'unknown';
    var tone = analysis.tone === 'warn' || analysis.tone === 'danger' ? analysis.tone : '';
    var source = analysis.source === 'llm' ? 'llm' : 'rules';
    var note = toText(analysis.note);
    var advice = toText(analysis.advice);

    var lines = [
      '<div class="assistant-analysis" data-kind="' + escapeHtml(toText(analysis.kind) || 'overview') + '" data-source="' + source + '"' + (tone ? ' data-tone="' + tone + '"' : '') + '>',
      '  <div class="assistant-card-head">',
      '    <span class="assistant-chip" data-tone="accent">' + escapeHtml(kindLabel) + '</span>',
      '    <span class="assistant-card-title">' + escapeHtml(title) + '</span>',
      source === 'llm' ? '    <span class="assistant-analysis-badge">模型解读</span>' : '',
      datasetType !== 'unknown' ? '    <span class="assistant-card-sub">' + escapeHtml(datasetLabel(datasetType)) + '</span>' : '',
      '  </div>'
    ];
    if (metrics.length) {
      lines.push('  <div class="assistant-metrics">');
      for (var i = 0; i < metrics.length; i += 1) lines.push(metricMarkup(metrics[i]));
      lines.push('  </div>');
    }
    lines.push('  <figure class="assistant-analysis-chart">');
    if (chartSvg) {
      lines.push(chartSvg);
    } else {
      lines.push('    <p class="assistant-analysis-chart-empty">当前图表暂无可绘制数据</p>');
    }
    if (sampleSize !== null) {
      lines.push('    <figcaption class="assistant-analysis-caption">样本 ' + escapeHtml(formatCount(sampleSize)) + ' 条 · 数据来自当前浏览器已同步的记录</figcaption>');
    }
    lines.push('  </figure>');
    if (insights.length) {
      lines.push('  <ul class="assistant-insights">');
      for (var k = 0; k < insights.length; k += 1) {
        lines.push('    <li class="assistant-insight">' + escapeHtml(toText(insights[k])) + '</li>');
      }
      lines.push('  </ul>');
    }
    lines.push(tableMarkup(analysis.table, 6));
    if (advice) {
      lines.push('  <p class="assistant-analysis-advice"><b>建议</b>' + escapeHtml(advice) + '</p>');
    }
    if (note) lines.push('  <p class="assistant-analysis-note">' + escapeHtml(note) + '</p>');
    if (actions.length) lines.push(actionButtonsMarkup(actions, { tool: toText(analysis.tool) }));
    lines.push('</div>');
    return lines.filter(function (line) { return line !== ''; }).join('\n');
  }

  /* ---------------- 纯渲染：消息 ---------------- */

  function messageMarkup(message) {
    var msg = message && typeof message === 'object' ? message : {};
    var role = msg.role === 'user' ? 'user' : 'assistant';
    var id = toText(msg.id);
    var text = toText(msg.text);
    var clock = formatClock(msg.createdAt);
    var lines = [
      '<article class="assistant-msg" data-role="' + role + '"' + (id ? ' data-message-id="' + escapeHtml(id) + '"' : '') + '>',
      '  <span class="assistant-avatar" aria-hidden="true">' + (role === 'user' ? '我' : 'AI') + '</span>',
      '  <div class="assistant-bubble-wrap">'
    ];
    if (msg.attachment) lines.push(attachmentMarkup(msg.attachment));
    if (text) {
      lines.push('    <div class="assistant-bubble">');
      lines.push('      <p class="assistant-bubble-text">' + escapeHtml(text) + '</p>');
      if (clock) lines.push('      <span class="assistant-msg-time">' + escapeHtml(clock) + '</span>');
      lines.push('    </div>');
    }
    if (msg.cleaning) lines.push(cleaningMarkup(msg.cleaning));
    if (msg.operation) lines.push(operationMarkup(msg.operation));
    if (msg.analysis) lines.push(analysisMarkup(msg.analysis));
    if (msg.source === 'llm' || msg.source === 'rules') {
      lines.push('    <span class="assistant-source">' + (msg.source === 'llm' ? '模型解析' : '规则解析') + '</span>');
    }
    if (!text && !msg.attachment && !msg.cleaning && !msg.operation && !msg.analysis) {
      lines.push('    <div class="assistant-bubble assistant-bubble--empty"><p class="assistant-bubble-text">（无内容）</p></div>');
    }
    lines.push('  </div>');
    lines.push('</article>');
    return lines.join('\n');
  }

  /* ---------------- 纯渲染：快捷指令 ---------------- */

  function quickPromptMarkup(prompts) {
    var list = Array.isArray(prompts) ? prompts : [];
    var chips = [];
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i];
      var prompt = '';
      var label = '';
      if (typeof item === 'string') {
        prompt = item;
        label = item;
      } else if (item && typeof item === 'object') {
        prompt = toText(item.prompt || item.text || item.label);
        label = toText(item.label || item.prompt || item.text);
      }
      if (!prompt) continue;
      chips.push('  <button type="button" class="assistant-chip assistant-chip--prompt" data-assistant="quick" data-prompt="' + escapeHtml(prompt) + '">' + escapeHtml(label || prompt) + '</button>');
    }
    return chips.join('\n');
  }

  /* ---------------- 纯渲染：历史会话 ---------------- */

  function historyMarkup(conversations, activeId) {
    var list = Array.isArray(conversations) ? conversations.slice(0, 20) : [];
    var lines = [
      '<div class="assistant-history-head">',
      '  <span class="assistant-history-title">历史会话</span>',
      '  <span class="assistant-history-count">' + formatCount(list.length) + ' / 20</span>',
      '  <button type="button" class="assistant-history-close" data-assistant="history" aria-label="关闭历史会话" title="关闭">×</button>',
      '</div>'
    ];
    if (!list.length) {
      lines.push('<p class="assistant-history-empty">暂无历史会话；发送第一条消息后会保存在本浏览器。</p>');
      return lines.join('\n');
    }
    lines.push('<div class="assistant-history-list" role="list">');
    for (var i = 0; i < list.length; i += 1) {
      var conv = list[i] && typeof list[i] === 'object' ? list[i] : {};
      var convId = toText(conv.id);
      var active = !!activeId && convId === toText(activeId);
      var title = escapeHtml(toText(conv.title) || '未命名会话');
      var count = Array.isArray(conv.messages) ? conv.messages.length : 0;
      var time = formatDateTime(conv.updatedAt);
      var meta = (count ? formatCount(count) + ' 条' : '') + (count && time ? ' · ' : '') + time;
      lines.push('  <div class="assistant-history-item' + (active ? ' is-active' : '') + '" role="listitem">');
      lines.push('    <button type="button" class="assistant-history-open" data-assistant="history-item" data-conversation-id="' + escapeHtml(convId) + '" aria-current="' + (active ? 'true' : 'false') + '" aria-label="打开会话：' + title + '">');
      lines.push('      <span class="assistant-history-name">' + title + '</span>');
      lines.push('      <span class="assistant-history-meta">' + escapeHtml(meta) + '</span>');
      lines.push('    </button>');
      lines.push('    <button type="button" class="assistant-history-del" data-assistant="history-delete" data-conversation-id="' + escapeHtml(convId) + '" aria-label="删除会话：' + title + '" title="删除会话">×</button>');
      lines.push('  </div>');
    }
    lines.push('</div>');
    return lines.join('\n');
  }

  /* ---------------- 纯渲染：空态 ---------------- */

  function emptyStateMarkup(state) {
    var current = state && typeof state === 'object' ? state : {};
    var role = normalizeRole(current.role);
    return [
      '<div class="assistant-empty">',
      '  <p class="assistant-empty-title">你好，我是锅炉炉管数据助手</p>',
      '  <p class="assistant-empty-desc">用一句中文就能完成清洗、导入、导出、撤销、查询、统计、分析与单条修改，分析结果直接出图表。</p>',
      '  <ul class="assistant-empty-list">',
      '    <li>「近两年壁厚趋势」出一张折线图</li>',
      '    <li>「现在数据质量怎么样」查看统计与问题清单</li>',
      '    <li>「查询 1 号炉 HSH 的测厚记录」</li>',
      '    <li>「帮我检查这份 CSV 能不能导入」</li>',
      '  </ul>',
      '  <p class="assistant-empty-role">当前权限：' + escapeHtml(roleLabel(role)) + '</p>',
      '</div>'
    ].join('\n');
  }

  /* ---------------- DOM 控制器 ---------------- */

  var mountedRoots = new WeakMap();

  function mount(options) {
    var opts = options && typeof options === 'object' ? options : {};
    var doc = opts.document || opts.doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof doc.createElement !== 'function') {
      throw new Error('BTAssistantUI.mount 需要一个可用的 document（浏览器环境或测试用 DOM stub）');
    }
    var root = opts.root || doc.body || null;
    if (!root || typeof root.appendChild !== 'function') {
      throw new Error('BTAssistantUI.mount 需要一个可挂载的 root 节点');
    }

    var previous = mountedRoots.get(root);
    if (previous && typeof previous.destroy === 'function') previous.destroy();

    var stateSource = opts.state;
    var dispatchSource = opts.dispatch;

    function readState() {
      try {
        var value = typeof stateSource === 'function' ? stateSource() : stateSource;
        return value && typeof value === 'object' ? value : {};
      } catch (err) {
        if (global.console && typeof global.console.error === 'function') global.console.error('[BTAssistantUI] state() 读取失败', err);
        return {};
      }
    }

    function emit(event) {
      if (typeof dispatchSource !== 'function') return;
      try {
        dispatchSource(event);
      } catch (err) {
        if (global.console && typeof global.console.error === 'function') global.console.error('[BTAssistantUI] dispatch 处理失败', err);
      }
    }

    var host = doc.createElement('div');
    host.className = 'assistant-root';
    var bootState = readState();
    host.innerHTML = launcherMarkup({}) + '\n' + panelMarkup({
      configured: !!bootState.configured,
      role: bootState.role,
      title: bootState.title
    });
    root.appendChild(host);

    function pick(selector) {
      if (!host || typeof host.querySelector !== 'function') return null;
      return host.querySelector(selector);
    }

    var els = {
      launcher: pick('#assistantLauncher'),
      panel: pick('#assistantPanel'),
      close: pick('#assistantClose'),
      historyBtn: pick('#assistantHistoryBtn'),
      newChat: pick('#assistantNewChat'),
      title: pick('#assistantTitle'),
      status: pick('#assistantStatus'),
      messages: pick('#assistantMessages'),
      attachments: pick('#assistantAttachments'),
      quick: pick('#assistantQuick'),
      input: pick('#assistantInput'),
      send: pick('#assistantSend'),
      attach: pick('#assistantAttach'),
      file: pick('#assistantFile'),
      history: pick('#assistantHistory'),
      modelHint: pick('#assistantModelHint'),
      typing: pick('#assistantTyping'),
      badge: pick('.assistant-launcher-badge'),
      roleHint: pick('.assistant-role')
    };

    var missing = [];
    DOM_IDS.forEach(function (id) {
      if (!host || typeof host.querySelector !== 'function') return;
      if (!host.querySelector('#' + id)) missing.push(id);
    });
    if (missing.length) {
      throw new Error('BTAssistantUI.mount 构建面板失败，缺少节点：#' + missing.join('、#'));
    }

    var manualBusy = null;
    var stickToBottom = true;
    var lastFocused = null;

    function currentBusy() {
      if (manualBusy !== null) return manualBusy;
      return !!readState().busy;
    }

    function isOpen() {
      return !!(els.panel && els.panel.hidden !== true);
    }

    function isAtBottom() {
      var el = els.messages;
      if (!el) return true;
      var scrollHeight = typeof el.scrollHeight === 'number' ? el.scrollHeight : 0;
      var clientHeight = typeof el.clientHeight === 'number' ? el.clientHeight : 0;
      var scrollTop = typeof el.scrollTop === 'number' ? el.scrollTop : 0;
      return scrollHeight - scrollTop - clientHeight <= 24;
    }

    function scrollToBottom(force) {
      if (!els.messages) return;
      if (!force && !stickToBottom) return;
      var height = typeof els.messages.scrollHeight === 'number' ? els.messages.scrollHeight : 0;
      els.messages.scrollTop = height;
    }

    function focusInput() {
      if (!els.input || typeof els.input.focus !== 'function') return;
      try { els.input.focus(); } catch (err) { /* 聚焦失败不影响功能 */ }
    }

    function adjustInputHeight() {
      var input = els.input;
      if (!input || !input.style) return;
      var height = typeof input.scrollHeight === 'number' ? input.scrollHeight : 0;
      if (height <= 0) {
        input.style.height = '';
        return;
      }
      input.style.height = 'auto';
      input.style.height = Math.min(height, 132) + 'px';
    }

    function applyBusy(busy) {
      if (els.input) els.input.disabled = busy;
      if (els.send) {
        els.send.disabled = busy;
        els.send.setAttribute('aria-label', busy ? '正在处理，请稍候' : '发送');
      }
      if (els.file) els.file.disabled = busy;
      if (els.attach) {
        els.attach.classList.toggle('is-disabled', busy);
        els.attach.setAttribute('aria-disabled', busy ? 'true' : 'false');
      }
      if (els.quick) {
        els.quick.classList.toggle('is-disabled', busy);
        els.quick.setAttribute('aria-disabled', busy ? 'true' : 'false');
      }
      if (els.typing) els.typing.hidden = !busy;
      if (host) host.classList.toggle('is-busy', busy);
    }

    function updateChrome(state) {
      var configured = !!state.configured;
      if (els.title) els.title.textContent = state.title ? toText(state.title) : DEFAULT_TITLE;
      if (els.status) {
        els.status.textContent = statusText(configured);
        els.status.classList.toggle('is-offline', !configured);
        els.status.classList.toggle('is-online', configured);
      }
      if (els.modelHint) {
        els.modelHint.textContent = modelHintText(configured);
        els.modelHint.classList.toggle('is-configured', configured);
        els.modelHint.setAttribute('aria-label', modelHintLabel(configured));
      }
      if (els.roleHint) els.roleHint.textContent = roleLabel(state.role);
      if (els.historyBtn) els.historyBtn.setAttribute('aria-expanded', state.historyOpen ? 'true' : 'false');
      if (els.badge) els.badge.hidden = !state.unread;
      if (els.panel) els.panel.setAttribute('aria-busy', currentBusy() ? 'true' : 'false');
    }

    function render() {
      manualBusy = null;
      var state = readState();
      var busy = !!state.busy;
      var messages = Array.isArray(state.messages) ? state.messages : [];
      var prompts = Array.isArray(state.quickPrompts) ? state.quickPrompts : [];
      var conversations = Array.isArray(state.conversations) ? state.conversations : [];
      var shouldStick = stickToBottom;

      if (els.attachments) {
        var attachments = Array.isArray(state.attachments) ? state.attachments : [];
        var barMarkup = attachmentBarMarkup(attachments, state.currentAttachmentId);
        els.attachments.innerHTML = barMarkup;
        els.attachments.hidden = !barMarkup;
      }
      if (els.messages) {
        els.messages.innerHTML = messages.length
          ? messages.map(messageMarkup).join('\n')
          : emptyStateMarkup(state);
      }
      if (els.quick) {
        els.quick.innerHTML = quickPromptMarkup(prompts);
        els.quick.hidden = prompts.length === 0;
      }
      if (els.history) {
        els.history.innerHTML = historyMarkup(conversations, state.activeConversationId);
        els.history.hidden = !state.historyOpen;
      }
      applyBusy(busy);
      updateChrome(state);
      if (shouldStick) scrollToBottom(true);
      return controller;
    }

    function open() {
      if (!els.panel) return controller;
      lastFocused = doc.activeElement || null;
      els.panel.hidden = false;
      if (host) host.classList.add('is-open');
      if (els.launcher) els.launcher.setAttribute('aria-expanded', 'true');
      stickToBottom = true;
      render();
      scrollToBottom(true);
      focusInput();
      return controller;
    }

    function close() {
      if (!els.panel) return controller;
      var state = readState();
      if (state.historyOpen) emit({ kind: 'toggle-history' });
      els.panel.hidden = true;
      if (host) host.classList.remove('is-open');
      if (els.history) els.history.hidden = true;
      if (els.launcher) {
        els.launcher.setAttribute('aria-expanded', 'false');
        var restore = lastFocused && lastFocused !== els.input ? lastFocused : null;
        var insideHost = false;
        var node = restore;
        while (node) {
          if (node === host) { insideHost = true; break; }
          node = node.parentNode || null;
        }
        if (restore && !insideHost && typeof restore.focus === 'function') {
          try { restore.focus(); } catch (err) { /* 忽略 */ }
        } else {
          try { els.launcher.focus(); } catch (err) { /* 忽略 */ }
        }
      }
      lastFocused = null;
      return controller;
    }

    function toggle() {
      if (isOpen()) close();
      else open();
      return controller;
    }

    function setBusy(busy) {
      manualBusy = !!busy;
      applyBusy(manualBusy);
      if (host) host.classList.toggle('is-busy', manualBusy);
      return controller;
    }

    function sendFromInput() {
      if (!els.input) return;
      if (currentBusy()) return;
      var text = toText(els.input.value).trim();
      if (!text) {
        focusInput();
        return;
      }
      els.input.value = '';
      adjustInputHeight();
      emit({ kind: 'send', text: text });
    }

    function findAssistantTarget(node) {
      var current = node;
      while (current && current !== host) {
        if (typeof current.getAttribute === 'function' && current.getAttribute('data-assistant')) return current;
        current = current.parentNode || null;
      }
      return null;
    }

    function onClick(event) {
      if (!event) return;
      var target = findAssistantTarget(event.target);
      if (!target) return;
      var action = target.getAttribute('data-assistant');
      if (action === 'launcher') {
        event.preventDefault ? event.preventDefault() : null;
        toggle();
        return;
      }
      if (action === 'close') {
        event.preventDefault ? event.preventDefault() : null;
        close();
        return;
      }
      if (action === 'attach') {
        if (currentBusy()) {
          if (event.preventDefault) event.preventDefault();
        }
        return;
      }
      if (action === 'send') {
        if (event.preventDefault) event.preventDefault();
        sendFromInput();
        return;
      }
      if (action === 'quick') {
        if (event.preventDefault) event.preventDefault();
        if (currentBusy()) return;
        var prompt = toText(target.getAttribute('data-prompt'));
        if (prompt) emit({ kind: 'send', text: prompt });
        return;
      }
      if (action === 'export-chat') {
        if (event.preventDefault) event.preventDefault();
        emit({ kind: 'export-chat' });
        return;
      }
      if (action === 'history') {
        if (event.preventDefault) event.preventDefault();
        emit({ kind: 'toggle-history' });
        return;
      }
      if (action === 'history-item') {
        var selected = toText(target.getAttribute('data-conversation-id'));
        if (selected) emit({ kind: 'select-history', conversationId: selected });
        return;
      }
      if (action === 'history-delete') {
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        var removed = toText(target.getAttribute('data-conversation-id'));
        if (removed) emit({ kind: 'delete-history', conversationId: removed });
        return;
      }
      if (action === 'new-chat') {
        if (event.preventDefault) event.preventDefault();
        emit({ kind: 'new-chat' });
        return;
      }
      if (action === 'settings') {
        if (event.preventDefault) event.preventDefault();
        emit({ kind: 'open-settings' });
        return;
      }
      if (action === 'attachment') {
        var attachmentId = toText(target.getAttribute('data-attachment-id'));
        var attachmentAction = toText(target.getAttribute('data-attachment-action'));
        if (!attachmentId) return;
        if (attachmentAction === 'remove') {
          if (event.preventDefault) event.preventDefault();
          if (event.stopPropagation) event.stopPropagation();
          emit({ kind: 'remove-attachment', id: attachmentId });
          return;
        }
        emit({ kind: 'select-attachment', id: attachmentId });
        return;
      }
      if (action === 'action') {
        if (currentBusy()) return;
        var actionId = toText(target.getAttribute('data-action-id'));
        var tool = toText(target.getAttribute('data-tool'));
        if (!actionId) return;
        var payload = { kind: 'action', actionId: actionId };
        if (tool) payload.tool = tool;
        emit(payload);
      }
    }

    function onInputKeyDown(event) {
      if (!event) return;
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      if (event.preventDefault) event.preventDefault();
      sendFromInput();
    }

    function onAttachKeyDown(event) {
      if (!event) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.preventDefault) event.preventDefault();
      if (currentBusy()) return;
      if (els.file && typeof els.file.click === 'function') els.file.click();
    }

    /* 附件项声明了 role="button" tabindex="0"，必须能用键盘（Enter / 空格）激活，
       与「上传」保持同一套可访问性标准。只处理 select：移除按钮是原生 <button>，
       键盘激活已由 click 委派负责，这里再处理会重复派发。 */
    function onAttachmentsKeyDown(event) {
      if (!event) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      var target = event.target;
      if (!target || typeof target.getAttribute !== 'function') return;
      if (toText(target.getAttribute('data-attachment-action')) !== 'select') return;
      var id = toText(target.getAttribute('data-attachment-id'));
      if (!id) return;
      if (event.preventDefault) event.preventDefault();
      emit({ kind: 'select-attachment', id: id });
    }

    /* 一次选择/拖入的多个文件按数量分流：1 个走原有单文件事件，多个走批量事件 */
    function collectFiles(fileList) {
      var files = [];
      if (!fileList || typeof fileList.length !== 'number') return files;
      for (var i = 0; i < fileList.length; i += 1) {
        if (fileList[i]) files.push(fileList[i]);
      }
      return files;
    }

    function emitFiles(files) {
      if (!files.length) return;
      if (currentBusy()) return;
      if (files.length === 1) { emit({ kind: 'file', file: files[0] }); return; }
      emit({ kind: 'files', files: files });
    }

    function onFileChange() {
      var files = collectFiles(els.file && els.file.files);
      if (els.file) {
        try { els.file.value = ''; } catch (err) { /* 某些浏览器禁止清空，忽略 */ }
      }
      /* 清空后再派发，保证同一批文件可以再次选择 */
      emitFiles(files);
    }

    function onMessagesScroll() {
      stickToBottom = isAtBottom();
    }

    /* 拖拽：文件拖到助手面板任意位置即触发上传（与点“上传”同一条链路） */
    var dragDepth = 0;

    function onPanelDragEnter(event) {
      if (!event || !event.dataTransfer) return;
      var kinds = event.dataTransfer.types;
      var hasFiles = false;
      if (kinds && typeof kinds.indexOf === 'function') hasFiles = kinds.indexOf('Files') >= 0;
      else if (kinds && typeof kinds.contains === 'function') hasFiles = kinds.contains('Files');
      if (!hasFiles) return;
      if (event.preventDefault) event.preventDefault();
      dragDepth += 1;
      if (els.panel && typeof els.panel.classList !== 'undefined') els.panel.classList.add('is-dragover');
    }

    function onPanelDragOver(event) {
      if (!event || !event.dataTransfer) return;
      if (event.preventDefault) event.preventDefault();
      if (event.dataTransfer.dropEffect) {
        try { event.dataTransfer.dropEffect = 'copy'; } catch (err) { /* 只读场景忽略 */ }
      }
    }

    function onPanelDragLeave(event) {
      if (event && event.preventDefault) event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0 && els.panel && typeof els.panel.classList !== 'undefined') {
        els.panel.classList.remove('is-dragover');
      }
    }

    function onPanelDrop(event) {
      if (!event) return;
      if (event.preventDefault) event.preventDefault();
      if (event.stopPropagation) event.stopPropagation();
      dragDepth = 0;
      if (els.panel && typeof els.panel.classList !== 'undefined') els.panel.classList.remove('is-dragover');
      emitFiles(collectFiles(event.dataTransfer && event.dataTransfer.files));
    }

    function onDocKeyDown(event) {
      if (!event) return;
      if (event.key !== 'Escape' && event.key !== 'Esc') return;
      if (!isOpen()) return;
      if (event.preventDefault) event.preventDefault();
      var state = readState();
      if (state.historyOpen) {
        emit({ kind: 'toggle-history' });
        return;
      }
      close();
    }

    if (host && typeof host.addEventListener === 'function') {
      host.addEventListener('click', onClick);
    }
    if (els.input && typeof els.input.addEventListener === 'function') {
      els.input.addEventListener('keydown', onInputKeyDown);
      els.input.addEventListener('input', adjustInputHeight);
    }
    if (els.attach && typeof els.attach.addEventListener === 'function') {
      els.attach.addEventListener('keydown', onAttachKeyDown);
    }
    if (els.attachments && typeof els.attachments.addEventListener === 'function') {
      els.attachments.addEventListener('keydown', onAttachmentsKeyDown);
    }
    if (els.file && typeof els.file.addEventListener === 'function') {
      els.file.addEventListener('change', onFileChange);
    }
    if (els.messages && typeof els.messages.addEventListener === 'function') {
      els.messages.addEventListener('scroll', onMessagesScroll);
    }
    if (els.panel && typeof els.panel.addEventListener === 'function') {
      els.panel.addEventListener('dragenter', onPanelDragEnter);
      els.panel.addEventListener('dragover', onPanelDragOver);
      els.panel.addEventListener('dragleave', onPanelDragLeave);
      els.panel.addEventListener('drop', onPanelDrop);
    }
    if (typeof doc.addEventListener === 'function') {
      doc.addEventListener('keydown', onDocKeyDown);
    }

    var controller = {
      host: host,
      open: open,
      close: close,
      toggle: toggle,
      isOpen: isOpen,
      render: render,
      setBusy: setBusy,
      focusInput: focusInput,
      scrollToBottom: scrollToBottom,
      destroy: function destroy() {
        if (host && typeof host.removeEventListener === 'function') host.removeEventListener('click', onClick);
        if (els.input && typeof els.input.removeEventListener === 'function') {
          els.input.removeEventListener('keydown', onInputKeyDown);
          els.input.removeEventListener('input', adjustInputHeight);
        }
        if (els.attach && typeof els.attach.removeEventListener === 'function') els.attach.removeEventListener('keydown', onAttachKeyDown);
        if (els.attachments && typeof els.attachments.removeEventListener === 'function') els.attachments.removeEventListener('keydown', onAttachmentsKeyDown);
        if (els.file && typeof els.file.removeEventListener === 'function') els.file.removeEventListener('change', onFileChange);
        if (els.messages && typeof els.messages.removeEventListener === 'function') els.messages.removeEventListener('scroll', onMessagesScroll);
        if (els.panel && typeof els.panel.removeEventListener === 'function') {
          els.panel.removeEventListener('dragenter', onPanelDragEnter);
          els.panel.removeEventListener('dragover', onPanelDragOver);
          els.panel.removeEventListener('dragleave', onPanelDragLeave);
          els.panel.removeEventListener('drop', onPanelDrop);
        }
        if (typeof doc.removeEventListener === 'function') doc.removeEventListener('keydown', onDocKeyDown);
        if (host && host.parentNode && typeof host.parentNode.removeChild === 'function') host.parentNode.removeChild(host);
        if (mountedRoots.get(root) === controller) mountedRoots.delete(root);
      }
    };

    mountedRoots.set(root, controller);
    render();
    return controller;
  }

  var api = {
    version: VERSION,
    domIds: DOM_IDS,
    escapeHtml: escapeHtml,
    launcherMarkup: launcherMarkup,
    panelMarkup: panelMarkup,
    messageMarkup: messageMarkup,
    attachmentBarMarkup: attachmentBarMarkup,
    cleaningMarkup: cleaningMarkup,
    operationMarkup: operationMarkup,
    analysisMarkup: analysisMarkup,
    tableMarkup: tableMarkup,
    quickPromptMarkup: quickPromptMarkup,
    historyMarkup: historyMarkup,
    mount: mount
  };

  global.BTAssistantUI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
