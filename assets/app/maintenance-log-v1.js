/* ============================================================
   BOILER-TUBE LIFECYCLE MANAGEMENT SYSTEM · 维护记录（操作日志）
   assets/app/maintenance-log-v1.js · v1.0.0
   ------------------------------------------------------------
   职责：
   1. 记录每一次数据维护动作（新增 / 修改 / 删除 / 导入 / 撤销 / 更换登记 / 材料库变更）
   2. 落盘 localStorage（boiler_maintenance_log），并与云端 KV 做「按 id 合并」，
      避免两端同时写入时用 last-write-wins 把历史冲掉
   3. 渲染「维护记录」视图：统计、筛选、字段级差异、导出 CSV

   边界：
   - 只写自己的 localStorage 键，不碰 boiler_user_db / boiler_material_library
   - 日志写入失败绝不能影响主业务流程（调用方全部包在 try/catch 里）
   - 本模块不做数据修改，只做记录与展示
   ============================================================ */

(function (global) {
  'use strict';

  var VERSION = 'v1';
  var STORAGE_KEY = 'boiler_maintenance_log';
  var MAX_ENTRIES = 800;
  var MAX_FIELD_TEXT = 120;

  /* ============================================================
   * 1. 元数据（动作 / 来源 / 字段）
   * ============================================================ */

  var ACTION_META = {
    create: { label: '新增', tone: 'ok' },
    update: { label: '修改', tone: 'accent' },
    delete: { label: '删除', tone: 'danger' },
    import: { label: '导入', tone: 'accent' },
    undo: { label: '撤销', tone: 'warn' },
    replace: { label: '更换登记', tone: 'accent' },
    material: { label: '材料库', tone: 'accent' },
    system: { label: '系统', tone: 'pending' }
  };

  var SOURCE_LABEL = {
    manual: '手工操作',
    assistant: 'AI 助手',
    import: '文件导入',
    system: '系统'
  };

  var FIELD_LABELS = {
    date: '日期',
    code: '管段编码',
    type: '事件类型',
    desc: '详细描述/结论',
    thickness: '厚度(mm)',
    hardness: '硬度(HB)',
    spec: '规格',
    material: '材质',
    boiler: '机组',
    component: '部件名称',
    position: '分段/位置',
    shape: '结构形式',
    diameter: '管径',
    wallThickness: '壁厚',
    stockQty: '库存根数',
    totalLengthM: '库存总长度(m)',
    reserveLocation: '预留位置',
    remark: '备注',
    reason: '更换原因',
    oldCode: '旧管段编码',
    newCode: '新管段编码'
  };

  var DATASET_LABEL = {
    events: '寿命事件',
    replacements: '更换记录',
    material_library: '受热面材料库'
  };

  /* ============================================================
   * 2. 基础工具
   * ============================================================ */

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function trimText(value) {
    return text(value).trim();
  }

  function escapeHtml(value) {
    return text(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function nowMs() {
    return Date.now();
  }

  function isoOf(ms) {
    try { return new Date(ms).toISOString(); } catch (err) { return ''; }
  }

  function pad2(value) {
    var n = Number(value);
    return n < 10 ? '0' + n : String(n);
  }

  function formatDateTime(ms) {
    var date = new Date(Number(ms));
    if (!isFinite(date.getTime())) return '—';
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
      ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  function formatClock(ms) {
    var date = new Date(Number(ms));
    if (!isFinite(date.getTime())) return '—';
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
  }

  function relativeTime(ms) {
    var delta = nowMs() - Number(ms);
    if (!isFinite(delta)) return '—';
    if (delta < 60 * 1000) return '刚刚';
    if (delta < 60 * 60 * 1000) return Math.floor(delta / 60000) + ' 分钟前';
    if (delta < 24 * 60 * 60 * 1000) return Math.floor(delta / 3600000) + ' 小时前';
    if (delta < 30 * 24 * 60 * 60 * 1000) return Math.floor(delta / 86400000) + ' 天前';
    return formatDateTime(ms);
  }

  function makeId() {
    return 'log-' + nowMs().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function clip(value) {
    var s = text(value);
    if (s.length <= MAX_FIELD_TEXT) return s;
    return s.slice(0, MAX_FIELD_TEXT) + '…';
  }

  function fieldLabel(field) {
    return FIELD_LABELS[field] || text(field);
  }

  /* ============================================================
   * 3. 读写（localStorage + 云端合并）
   * ============================================================ */

  var entries = [];
  var loaded = false;
  var sourceStack = [];

  function storage() {
    try { return global.localStorage || null; } catch (err) { return null; }
  }

  function readStorage() {
    var store = storage();
    if (!store) return [];
    try {
      var raw = store.getItem(STORAGE_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isValidEntry) : [];
    } catch (err) {
      return [];
    }
  }

  function isValidEntry(item) {
    return Boolean(item && typeof item === 'object' && item.id && item.at);
  }

  function sortDesc(list) {
    return list.slice().sort(function (a, b) { return Number(b.at) - Number(a.at); });
  }

  function capList(list) {
    return sortDesc(list).slice(0, MAX_ENTRIES);
  }

  function saveLocal(list) {
    entries = capList(list);
    var store = storage();
    if (!store) return;
    try { store.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch (err) {
      /* 配额写满时退一半再试一次，尽量不丢最新记录 */
      try {
        entries = entries.slice(0, Math.max(50, Math.floor(MAX_ENTRIES / 2)));
        store.setItem(STORAGE_KEY, JSON.stringify(entries));
      } catch (err2) { /* 放弃落盘，内存里仍可见 */ }
    }
  }

  function queueCloud() {
    try {
      if (typeof global.queueCloudStorageSave === 'function') global.queueCloudStorageSave(STORAGE_KEY, entries);
    } catch (err) { /* 云端不可用时忽略 */ }
  }

  function mergeById(localList, remoteList) {
    var map = {};
    var out = [];
    var all = (Array.isArray(remoteList) ? remoteList : []).concat(Array.isArray(localList) ? localList : []);
    for (var i = 0; i < all.length; i += 1) {
      var item = all[i];
      if (!isValidEntry(item)) continue;
      if (map[item.id]) continue;
      map[item.id] = true;
      out.push(item);
    }
    return out;
  }

  /* 云端只做并集合并：两边各自离线新增的记录都不会被覆盖掉 */
  function mergeCloud() {
    if (typeof global.cloudStorageEnabled === 'function' && !global.cloudStorageEnabled()) return;
    if (typeof global.cloudStorageRequest !== 'function') return;
    var request;
    try { request = global.cloudStorageRequest(STORAGE_KEY); } catch (err) { return; }
    if (!request || typeof request.then !== 'function') return;
    request.then(function (remote) {
      if (!remote || !remote.found || !Array.isArray(remote.value)) return;
      var remoteList = remote.value.filter(isValidEntry);
      if (!remoteList.length) return;
      var localIds = {};
      entries.forEach(function (item) { localIds[item.id] = true; });
      var added = remoteList.filter(function (item) { return !localIds[item.id]; });
      if (!added.length) return;
      saveLocal(mergeById(entries, remoteList));
      if (typeof global.queueCloudStorageSave === 'function') global.queueCloudStorageSave(STORAGE_KEY, entries);
      render();
    }).catch(function () { /* 离线时静默 */ });
  }

  function load() {
    if (loaded) return entries;
    entries = capList(readStorage());
    loaded = true;
    return entries;
  }

  /* ============================================================
   * 4. 记录（核心写入 API）
   * ============================================================ */

  function currentOperator() {
    var session = null;
    try {
      if (typeof currentAuthSession !== 'undefined') session = currentAuthSession;
    } catch (err) { session = null; }
    if (session && session.username) return text(session.username);
    return '本机用户';
  }

  function currentRole() {
    var session = null;
    try {
      if (typeof currentAuthSession !== 'undefined') session = currentAuthSession;
    } catch (err) { session = null; }
    if (session && session.role) return text(session.role);
    return 'local';
  }

  function currentSource() {
    return sourceStack.length ? sourceStack[sourceStack.length - 1] : 'manual';
  }

  /* 助手写数据时把来源切到 assistant，结束后自动还原 */
  function withSource(source, fn) {
    sourceStack.push(text(source) || 'manual');
    try {
      return fn();
    } finally {
      sourceStack.pop();
    }
  }

  /* 清空属于破坏性操作：登录态要求管理员；本地离线模式（无会话）允许 */
  function canClear() {
    var session = null;
    try {
      if (typeof currentAuthSession !== 'undefined') session = currentAuthSession;
    } catch (err) { session = null; }
    if (!session || !session.role) return true;
    return session.role === 'admin';
  }

  function record(entry) {
    load();
    var item = entry && typeof entry === 'object' ? entry : {};
    var action = ACTION_META[item.action] ? item.action : 'system';
    var at = Number(item.at) || nowMs();
    var normalized = {
      id: text(item.id) || makeId(),
      at: at,
      ts: text(item.ts) || isoOf(at),
      action: action,
      target: text(item.target) || 'dataset',
      targetKey: text(item.targetKey),
      targetLabel: text(item.targetLabel),
      summary: text(item.summary) || (ACTION_META[action] ? ACTION_META[action].label : '变更'),
      changes: Array.isArray(item.changes) ? item.changes.slice(0, 12) : [],
      meta: item.meta && typeof item.meta === 'object' ? item.meta : {},
      operator: text(item.operator) || currentOperator(),
      role: text(item.role) || currentRole(),
      source: SOURCE_LABEL[item.source] ? item.source : currentSource(),
      note: text(item.note)
    };
    var list = entries.slice();
    list.push(normalized);
    saveLocal(list);
    queueCloud();
    if (isViewActive()) render();
    return normalized;
  }

  /* ============================================================
   * 5. 业务钩子：把业务对象翻译成日志条目
   * ============================================================ */

  function diffFields(before, after, fields) {
    var changes = [];
    var keys = Array.isArray(fields) ? fields : Object.keys(after || {});
    for (var i = 0; i < keys.length; i += 1) {
      var field = keys[i];
      var oldValue = trimText(before ? before[field] : '');
      var newValue = trimText(after ? after[field] : '');
      if (oldValue === newValue) continue;
      changes.push({
        field: field,
        label: fieldLabel(field),
        before: clip(oldValue),
        after: clip(newValue)
      });
    }
    return changes;
  }

  function summarizeChanges(changes) {
    if (!changes || !changes.length) return '无字段变化';
    return changes.slice(0, 3).map(function (item) {
      return item.label + ' ' + (item.before || '空') + ' → ' + (item.after || '空');
    }).join('；') + (changes.length > 3 ? ' 等 ' + changes.length + ' 项' : '');
  }

  function eventTargetLabel(record) {
    var code = trimText(record && record.code);
    var date = trimText(record && record.date);
    var type = trimText(record && record.type);
    var parts = [code || '（无管码）'];
    if (type) parts.push(type);
    if (date) parts.push(date);
    return parts.join(' · ');
  }

  function hook(kind, payload) {
    var data = payload && typeof payload === 'object' ? payload : {};
    if (kind === 'create') {
      var created = data.record || data;
      return record({
        action: 'create',
        target: 'event',
        targetKey: trimText(created.code),
        targetLabel: eventTargetLabel(created),
        summary: '新增' + (trimText(created.type) || '寿命事件') + (trimText(created.thickness) ? '，厚度 ' + trimText(created.thickness) + 'mm' : ''),
        changes: [],
        meta: {
          code: trimText(created.code),
          date: trimText(created.date),
          type: trimText(created.type),
          thickness: trimText(created.thickness),
          hardness: trimText(created.hardness)
        },
        source: data.source || currentSource()
      });
    }
    if (kind === 'replace') {
      var replacement = data.record || data;
      return record({
        action: 'replace',
        target: 'replacement',
        targetKey: trimText(replacement.oldCode),
        targetLabel: trimText(replacement.oldCode) + ' → ' + trimText(replacement.newCode),
        summary: '更换登记：' + trimText(replacement.oldCode) + ' → ' + trimText(replacement.newCode) +
          (trimText(replacement.reason) ? '（' + trimText(replacement.reason) + '）' : ''),
        changes: [
          { field: 'oldCode', label: '旧管段编码', before: '', after: trimText(replacement.oldCode) },
          { field: 'newCode', label: '新管段编码', before: '', after: trimText(replacement.newCode) },
          { field: 'reason', label: '更换原因', before: '', after: clip(replacement.reason) }
        ],
        meta: { date: trimText(replacement.date) },
        source: data.source || currentSource()
      });
    }
    if (kind === 'delete') {
      var removed = data.record || data;
      if (!removed || !trimText(removed.code)) return null;
      return record({
        action: 'delete',
        target: 'event',
        targetKey: trimText(removed.code),
        targetLabel: eventTargetLabel(removed),
        summary: '删除' + (trimText(removed.type) || '寿命事件') + '（' + trimText(removed.date) + '）',
        changes: diffFields(null, {
          date: removed.date,
          code: removed.code,
          type: removed.type,
          thickness: removed.thickness,
          hardness: removed.hardness,
          desc: removed.desc
        }, ['date', 'code', 'type', 'thickness', 'hardness', 'desc']),
        meta: { snapshot: { code: trimText(removed.code), date: trimText(removed.date), desc: clip(removed.desc) } },
        source: data.source || currentSource()
      });
    }
    if (kind === 'update') {
      var target = data.record || {};
      var field = trimText(data.field);
      var before = trimText(data.before);
      var after = trimText(data.after);
      if (!field || before === after) return null;
      return record({
        action: 'update',
        target: 'event',
        targetKey: trimText(target.code || data.code),
        targetLabel: eventTargetLabel(target),
        summary: fieldLabel(field) + '：' + (before || '空') + ' → ' + (after || '空'),
        changes: [{ field: field, label: fieldLabel(field), before: clip(before), after: clip(after) }],
        meta: { code: trimText(target.code || data.code), date: trimText(target.date) },
        note: trimText(data.note),
        source: data.source || currentSource()
      });
    }
    if (kind === 'import') {
      var stats = data.stats && typeof data.stats === 'object' ? data.stats : {};
      var dataset = trimText(data.dataset) || 'events';
      var counts = {
        importedEvents: Number(stats.importedEvents) || 0,
        importedReplacements: Number(stats.importedReplacements) || 0,
        skippedDuplicates: Number(stats.skippedDuplicates) || 0,
        skippedMismatch: Number(stats.skippedMismatch) || 0,
        added: Number(stats.added) || 0,
        updated: Number(stats.updated) || 0,
        removed: Number(stats.removed) || 0
      };
      var total = dataset === 'material_library'
        ? counts.added + counts.updated
        : counts.importedEvents + counts.importedReplacements;
      if (!total && !counts.skippedDuplicates && !counts.skippedMismatch) return null;
      var pieces = [];
      if (dataset === 'material_library') {
        pieces.push('新增 ' + counts.added + ' 条');
        pieces.push('更新 ' + counts.updated + ' 条');
        if (counts.removed) pieces.push('移除 ' + counts.removed + ' 条');
      } else {
        pieces.push('事件 ' + counts.importedEvents + ' 条');
        pieces.push('更换 ' + counts.importedReplacements + ' 条');
        if (counts.skippedDuplicates) pieces.push('跳过重复 ' + counts.skippedDuplicates + ' 条');
        if (counts.skippedMismatch) pieces.push('机组不匹配 ' + counts.skippedMismatch + ' 条');
      }
      return record({
        action: 'import',
        target: dataset,
        targetKey: trimText(data.fileName),
        targetLabel: DATASET_LABEL[dataset] || '数据集',
        summary: '导入' + (DATASET_LABEL[dataset] || '数据') + '：' + pieces.join('，'),
        changes: [],
        meta: {
          fileName: trimText(data.fileName),
          counts: counts
        },
        source: data.source || (currentSource() === 'manual' ? 'import' : currentSource())
      });
    }
    if (kind === 'material') {
      var added = Number(data.added) || 0;
      var updated = Number(data.updated) || 0;
      var removedCount = Number(data.removed) || 0;
      if (!added && !updated && !removedCount) return null;
      var isUndo = trimText(data.reason) === 'undo';
      var parts = [];
      if (added) parts.push('新增 ' + added + ' 条');
      if (updated) parts.push('更新 ' + updated + ' 条');
      if (removedCount) parts.push('移除 ' + removedCount + ' 条');
      return record({
        action: isUndo ? 'undo' : 'material',
        target: 'material_library',
        targetKey: trimText(data.sample),
        targetLabel: '受热面材料库' + (trimText(data.sample) ? ' · ' + trimText(data.sample) : ''),
        summary: (isUndo ? '撤销材料库导入：' : '材料库变更：') + parts.join('，'),
        changes: [],
        meta: { added: added, updated: updated, removed: removedCount },
        source: data.source || currentSource()
      });
    }
    if (kind === 'clear') {
      return record({
        action: 'system',
        target: 'dataset',
        targetLabel: '本地数据',
        summary: '清空本地数据：' + (Number(data.total) || 0) + ' 条（已先导出备份）',
        changes: [],
        meta: { total: Number(data.total) || 0 },
        source: 'system'
      });
    }
    if (kind === 'undo') {
      return record({
        action: 'undo',
        target: trimText(data.target) || 'dataset',
        targetKey: trimText(data.targetKey),
        targetLabel: trimText(data.targetLabel) || '撤销操作',
        summary: trimText(data.summary) || '撤销上一次操作',
        changes: [],
        meta: data.meta && typeof data.meta === 'object' ? data.meta : {},
        source: data.source || currentSource()
      });
    }
    if (kind === 'system') {
      return record({
        action: 'system',
        target: 'log',
        targetLabel: '维护记录',
        summary: trimText(data.summary) || '系统操作',
        changes: [],
        source: 'system'
      });
    }
    return null;
  }

  /* ============================================================
   * 6. 查询与统计
   * ============================================================ */

  function list(filters) {
    load();
    var f = filters && typeof filters === 'object' ? filters : {};
    var action = trimText(f.action);
    var source = trimText(f.source);
    var keyword = trimText(f.keyword).toLowerCase();
    var days = Number(f.days) || 0;
    var cutoff = days > 0 ? nowMs() - days * 86400000 : 0;
    var rows = entries.filter(function (item) {
      if (action && item.action !== action) return false;
      if (source && item.source !== source) return false;
      if (cutoff && Number(item.at) < cutoff) return false;
      if (keyword) {
        var hay = [item.summary, item.targetLabel, item.targetKey, item.note, item.operator]
          .map(text).join(' ').toLowerCase();
        if (hay.indexOf(keyword) < 0) return false;
      }
      return true;
    });
    var limit = Number(f.limit) > 0 ? Number(f.limit) : 200;
    return sortDesc(rows).slice(0, limit);
  }

  function stats() {
    load();
    var now = nowMs();
    var week = now - 7 * 86400000;
    var todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    var byAction = {};
    var recent = 0;
    var today = 0;
    entries.forEach(function (item) {
      byAction[item.action] = (byAction[item.action] || 0) + 1;
      if (Number(item.at) >= week) recent += 1;
      if (Number(item.at) >= todayStart.getTime()) today += 1;
    });
    return {
      total: entries.length,
      today: today,
      week: recent,
      lastAt: entries.length ? sortDesc(entries)[0].at : null,
      byAction: byAction
    };
  }

  function clear() {
    load();
    saveLocal([]);
    queueCloud();
    record({
      action: 'system',
      target: 'log',
      targetLabel: '维护记录',
      summary: '清空维护日志（本地与云端）',
      source: 'system'
    });
    render();
  }

  /* ============================================================
   * 7. 渲染
   * ============================================================ */

  function el(id) {
    var doc = global.document;
    return doc && doc.getElementById ? doc.getElementById(id) : null;
  }

  function isViewActive() {
    var view = el('view-maintainlog');
    if (!view) return false;
    return (view.className || '').indexOf('active') >= 0;
  }

  var filters = { range: '0', action: '', source: '', keyword: '' };

  function readFilters() {
    var range = el('mlog-range');
    var action = el('mlog-action');
    var source = el('mlog-source');
    var keyword = el('mlog-keyword');
    filters.range = range ? text(range.value) : filters.range;
    filters.action = action ? text(action.value) : filters.action;
    filters.source = source ? text(source.value) : filters.source;
    filters.keyword = keyword ? text(keyword.value) : filters.keyword;
    return filters;
  }

  function rowsOfFilters() {
    return list({
      days: Number(filters.range) || 0,
      action: filters.action,
      source: filters.source,
      keyword: filters.keyword,
      limit: 200
    });
  }

  function actionChip(action) {
    var meta = ACTION_META[action] || ACTION_META.system;
    return '<span class="mlog-action" data-tone="' + escapeHtml(meta.tone) + '">' + escapeHtml(meta.label) + '</span>';
  }

  function statCard(label, value, hint, tone) {
    return [
      '<div class="mlog-stat"' + (tone ? ' data-tone="' + tone + '"' : '') + '>',
      '  <span class="mlog-stat-k">' + escapeHtml(label) + '</span>',
      '  <span class="mlog-stat-v">' + escapeHtml(value) + '</span>',
      hint ? '  <span class="mlog-stat-h">' + escapeHtml(hint) + '</span>' : '',
      '</div>'
    ].filter(Boolean).join('\n');
  }

  function renderStats() {
    var host = el('mlog-stats');
    if (!host) return;
    var s = stats();
    host.innerHTML = [
      statCard('累计记录', String(s.total), s.total >= MAX_ENTRIES ? '已达上限，最早的记录会被滚动清理' : '上限 ' + MAX_ENTRIES + ' 条'),
      statCard('今日操作', String(s.today), '按本机时区统计'),
      statCard('近 7 天', String(s.week), '含导入与修改'),
      statCard('最近一次', s.lastAt ? relativeTime(s.lastAt) : '—', s.lastAt ? formatDateTime(s.lastAt) : '暂无记录', s.lastAt ? 'accent' : '')
    ].join('\n');
  }

  function detailRow(item) {
    var changes = Array.isArray(item.changes) ? item.changes : [];
    var lines = ['<tr class="mlog-detail"><td colspan="7">'];
    lines.push('<div class="mlog-detail-box">');
    var actionLabel = (ACTION_META[item.action] || ACTION_META.system).label;
    lines.push('<div class="mlog-detail-head">' + escapeHtml(actionLabel + ' · ' + (item.targetLabel || '—')) + '</div>');
    if (changes.length) {
      lines.push('<table class="mlog-diff"><thead><tr><th>字段</th><th>变更前</th><th>变更后</th></tr></thead><tbody>');
      changes.forEach(function (change) {
        lines.push('<tr><td>' + escapeHtml(change.label || fieldLabel(change.field)) + '</td>' +
          '<td class="mlog-before">' + escapeHtml(change.before || '空') + '</td>' +
          '<td class="mlog-after">' + escapeHtml(change.after || '空') + '</td></tr>');
      });
      lines.push('</tbody></table>');
    } else {
      lines.push('<p class="mlog-detail-empty">本条记录没有字段级差异（批量操作请看变更说明）。</p>');
    }
    var meta = item.meta || {};
    var extra = [];
    if (meta.fileName) extra.push('文件：' + meta.fileName);
    if (meta.code) extra.push('管段：' + meta.code);
    if (meta.date) extra.push('业务日期：' + meta.date);
    if (meta.total) extra.push('清空条数：' + meta.total);
    if (extra.length) lines.push('<p class="mlog-detail-meta">' + escapeHtml(extra.join(' · ')) + '</p>');
    lines.push('<p class="mlog-detail-meta">日志 ID：' + escapeHtml(item.id) + ' · 记录时间：' + escapeHtml(formatDateTime(item.at)) + '</p>');
    lines.push('</div></td></tr>');
    return lines.join('\n');
  }

  function renderTable() {
    var body = el('mlog-body');
    var foot = el('mlog-foot');
    if (!body) return;
    var rows = rowsOfFilters();
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="7" class="mlog-empty">没有符合条件的维护记录。做一次新增、修改、导入或删除后，这里会自动留痕。</td></tr>';
      if (foot) foot.textContent = '共 0 条';
      return;
    }
    var html = rows.map(function (item) {
      var sourceLabel = SOURCE_LABEL[item.source] || item.source;
      return [
        '<tr data-log-id="' + escapeHtml(item.id) + '">',
        '  <td class="mlog-time"><span>' + escapeHtml(formatDateTime(item.at)) + '</span><em>' + escapeHtml(relativeTime(item.at)) + '</em></td>',
        '  <td>' + actionChip(item.action) + '</td>',
        '  <td class="mlog-target"><span>' + escapeHtml(item.targetLabel || '—') + '</span>' +
          (item.targetKey && (item.targetLabel || '').indexOf(item.targetKey) < 0
            ? '<em>' + escapeHtml(item.targetKey) + '</em>' : '') + '</td>',
        '  <td class="mlog-summary">' + escapeHtml(item.summary) + (item.note ? '<em>' + escapeHtml(item.note) + '</em>' : '') + '</td>',
        '  <td class="mlog-operator">' + escapeHtml(item.operator) + '</td>',
        '  <td class="mlog-source" data-source="' + escapeHtml(item.source) + '">' + escapeHtml(sourceLabel) + '</td>',
        '  <td class="mlog-ops"><button type="button" class="btn btn-outline mlog-detail-btn" data-log-toggle="' + escapeHtml(item.id) + '">详情</button></td>',
        '</tr>'
      ].join('\n');
    }).join('\n');
    body.innerHTML = html;
    if (foot) {
      var total = stats().total;
      foot.textContent = '显示最近 ' + rows.length + ' 条 / 共 ' + total + ' 条' +
        (rows.length >= 200 ? '（已截断，请用筛选缩小范围）' : '');
    }
  }

  function render() {
    load();
    if (!el('view-maintainlog')) return;
    renderStats();
    renderTable();
  }

  /* ============================================================
   * 8. 交互
   * ============================================================ */

  function toggleDetail(id) {
    var body = el('mlog-body');
    if (!body) return;
    var row = null;
    var rows = body.querySelectorAll ? body.querySelectorAll('tr[data-log-id]') : [];
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].getAttribute('data-log-id') === id) { row = rows[i]; break; }
    }
    if (!row) return;
    var next = row.nextElementSibling;
    if (next && next.className === 'mlog-detail') {
      next.parentNode.removeChild(next);
      return;
    }
    load();
    var item = null;
    for (var k = 0; k < entries.length; k += 1) {
      if (entries[k].id === id) { item = entries[k]; break; }
    }
    if (!item) return;
    var holder = global.document.createElement('tbody');
    holder.innerHTML = detailRow(item);
    row.parentNode.insertBefore(holder.firstElementChild || holder.firstChild, row.nextSibling);
  }

  function csvCell(value) {
    var raw = text(value);
    if (raw.indexOf(',') >= 0 || raw.indexOf('"') >= 0 || raw.indexOf('\n') >= 0 || raw.indexOf('\r') >= 0) {
      return '"' + raw.replace(/"/g, '""') + '"';
    }
    return raw;
  }

  function buildCsv(rows) {
    var header = ['时间', '动作', '对象', '变更内容', '操作人', '来源', '备注', '日志ID'];
    var lines = [header.map(csvCell).join(',')];
    rows.forEach(function (item) {
      lines.push([
        formatDateTime(item.at),
        (ACTION_META[item.action] || ACTION_META.system).label,
        item.targetLabel,
        item.summary,
        item.operator,
        SOURCE_LABEL[item.source] || item.source,
        item.note,
        item.id
      ].map(csvCell).join(','));
    });
    return '\uFEFF' + lines.join('\r\n');
  }

  function exportCsv() {
    var rows = rowsOfFilters();
    if (!rows.length) {
      if (typeof global.showToast === 'function') global.showToast('当前筛选没有可导出的维护记录', 'info');
      return false;
    }
    var name = '维护记录_' + new Date().toISOString().slice(0, 10) + '.csv';
    var content = buildCsv(rows);
    if (typeof global.downloadBlob === 'function') {
      global.downloadBlob(name, content, 'text/csv;charset=utf-8;');
      if (typeof global.showToast === 'function') global.showToast('已导出 ' + rows.length + ' 条维护记录', 'ok');
      return true;
    }
    return false;
  }

  function bind() {
    var doc = global.document;
    if (!doc) return;
    if (bind.done) return;
    bind.done = true;

    ['mlog-range', 'mlog-action', 'mlog-source'].forEach(function (id) {
      var node = el(id);
      if (node && node.addEventListener) {
        node.addEventListener('change', function () { readFilters(); renderTable(); });
      }
    });
    var keyword = el('mlog-keyword');
    if (keyword && keyword.addEventListener) {
      keyword.addEventListener('input', function () {
        readFilters();
        if (bind.timer) clearTimeout(bind.timer);
        bind.timer = setTimeout(function () { renderTable(); }, 160);
      });
    }
    var refresh = el('mlog-refresh');
    if (refresh && refresh.addEventListener) {
      refresh.addEventListener('click', function () { readFilters(); load(); render(); mergeCloud(); });
    }
    var exportBtn = el('mlog-export');
    if (exportBtn && exportBtn.addEventListener) {
      exportBtn.addEventListener('click', function () { readFilters(); exportCsv(); });
    }
    var clearBtn = el('mlog-clear');
    if (clearBtn && clearBtn.addEventListener) {
      clearBtn.addEventListener('click', function () {
        var s = stats();
        if (!s.total) {
          if (typeof global.showToast === 'function') global.showToast('当前没有维护记录', 'info');
          return;
        }
        if (!canClear()) {
          if (typeof global.showToast === 'function') global.showToast('清空维护日志需要管理员权限，请联系管理员；可先导出 CSV 留档。', 'warn');
          return;
        }
        var ok = typeof global.confirm === 'function'
          ? global.confirm('确认清空全部 ' + s.total + ' 条维护记录？建议先导出 CSV 留档。')
          : false;
        if (!ok) return;
        clear();
        if (typeof global.showToast === 'function') global.showToast('维护记录已清空', 'ok');
      });
    }
    var body = el('mlog-body');
    if (body && body.addEventListener) {
      body.addEventListener('click', function (event) {
        var node = event.target;
        while (node && node !== body) {
          if (node.getAttribute && node.getAttribute('data-log-toggle')) {
            toggleDetail(node.getAttribute('data-log-toggle'));
            return;
          }
          node = node.parentNode;
        }
      });
    }
  }

  function mount() {
    load();
    bind();
    render();
    mergeCloud();
    return api;
  }

  /* ============================================================
   * 9. 导出
   * ============================================================ */

  var api = {
    version: VERSION,
    STORAGE_KEY: STORAGE_KEY,
    MAX_ENTRIES: MAX_ENTRIES,
    ACTION_META: ACTION_META,
    SOURCE_LABEL: SOURCE_LABEL,
    FIELD_LABELS: FIELD_LABELS,
    record: record,
    hook: hook,
    list: list,
    stats: stats,
    clear: clear,
    render: render,
    mount: mount,
    exportCsv: exportCsv,
    buildCsv: buildCsv,
    mergeCloud: mergeCloud,
    withSource: withSource,
    canClear: canClear,
    currentSource: currentSource,
    formatDateTime: formatDateTime,
    fieldLabel: fieldLabel,
    diffFields: diffFields,
    summarizeChanges: summarizeChanges,
    toggleDetail: toggleDetail,
    /* 测试用：清空内存态，强制从 localStorage 重新加载 */
    _reset: function () { entries = []; loaded = false; sourceStack = []; }
  };

  global.BTMaintenanceLog = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (typeof global.document !== 'undefined' && global.document) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', function () { mount(); });
    } else {
      mount();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
