/* 超温月度报表 / 基础测点台账导入解析。
 * 纯函数模块，供 overtemperature-v1.js 调用，也可在 Node 测试中直接 require。
 * 只负责“把表格行变成可核对的导入项”，不直接发请求、不写业务数据。 */
(function (root) {
  'use strict';

  var TYPE_ALIASES = {
    tube_wall: 'tube_wall', header_wall: 'header_wall', steam: 'steam', flue: 'flue', other: 'other',
    '管壁温度': 'tube_wall', '管壁': 'tube_wall', '管子壁温': 'tube_wall',
    '集箱壁温': 'header_wall', '集箱壁温度': 'header_wall', '集箱管壁温度': 'header_wall',
    '蒸汽温度': 'steam', '汽温': 'steam', '过热蒸汽温度': 'steam', '再热蒸汽温度': 'steam',
    '烟气温度': 'flue', '烟温': 'flue', '其他测量': 'other', '其他': 'other'
  };
  var POINT_ALIASES = {
    unit: ['机组', '机组代码', 'unit'],
    tag: ['dcstag', '点位', '点位编号', '测点编号', 'tag'],
    name: ['测点名称', '名称', '描述', '测点描述', 'name'],
    measurementType: ['测量类型代码', '测量类型', 'measurementtype', 'type'],
    location: ['安装位置', '位置', 'location'],
    limitC: ['温度限值(℃)', '温度限值', '限值(℃)', '限值', 'limitc'],
    limitBasis: ['限值依据', '依据', 'limitbasis'],
    active: ['启用状态', '状态', 'active'],
    system: ['系统码', '系统', 'system'],
    group: ['测点分组', '分组', 'group'],
    panel: ['管屏', '管屏/部位', 'panel'],
    commissionedAt: ['投产日期', '投运日期', '投运时间', 'commissionedat']
  };
  var REPORT_ALIASES = {
    tag: ['点位', 'dcstag', '点位编号', '测点编号', 'tag'],
    name: ['描述', '测点名称', '名称', 'name'],
    limitC: ['限值(℃)', '限值', 'limitc'],
    temperatureC: ['最值', '最高温度', '温度', 'temperaturec'],
    duration: ['总时长(秒)', '总时长', '时长', 'duration'],
    startAt: ['开始时间', '起始时间', 'startat'],
    endAt: ['结束时间', 'endat'],
    crew: ['班组', 'crew'],
    meanC: ['均值', 'meanc'],
    overType: ['越限类型', '类型', 'overtype']
  };

  function text(value) { return value === undefined || value === null ? '' : String(value).trim(); }
  function pad(value, length) { return String(value).padStart(length || 2, '0'); }
  function headerKey(value) {
    return text(value)
      .replace(/（/g, '(').replace(/）/g, ')').replace(/／/g, '/')
      .replace(/\s+/g, '')
      .replace(/[?？]+$/, '')
      .toLowerCase();
  }
  function number(value) {
    if (value === '' || value === null || value === undefined) return null;
    var normalized = text(value).replace(/,/g, '');
    if (!normalized) return null;
    var parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  function table(matrix) {
    if (!Array.isArray(matrix) || !matrix.length) return { rows: [], headers: [] };
    var headers = matrix[0].map(headerKey);
    var rows = [];
    for (var i = 1; i < matrix.length; i += 1) {
      var source = Array.isArray(matrix[i]) ? matrix[i] : [];
      var blank = source.every(function (value) { return text(value) === ''; });
      if (blank) continue;
      var item = { __row: i + 1 };
      headers.forEach(function (key, index) { if (key) item[key] = source[index]; });
      rows.push(item);
    }
    return { rows: rows, headers: headers };
  }
  function pick(row, aliases) {
    for (var i = 0; i < aliases.length; i += 1) {
      var value = row[headerKey(aliases[i])];
      if (value !== undefined && text(value) !== '') return value;
    }
    return '';
  }
  function toBool(value, fallback) {
    var raw = text(value).toLowerCase();
    if (!raw) return fallback;
    if (['启用', '是', 'true', '1', 'active', '正常'].indexOf(raw) >= 0) return true;
    if (['停用', '否', 'false', '0', 'inactive', '已停用'].indexOf(raw) >= 0) return false;
    return fallback;
  }
  function normalizeType(value) {
    var raw = text(value).toLowerCase();
    if (!raw) return '';
    return TYPE_ALIASES[raw] || TYPE_ALIASES[text(value)] || '';
  }
  function unitFromTag(tag) {
    var match = /^DCS([12])_/i.exec(text(tag));
    return match ? match[1] : '';
  }
  var SYSTEM_PATTERNS = [
    [/全大屏过热器|大屏过热器/, 'DPGRQ'],
    [/后屏过热器/, 'PSGRQ'],
    [/高温过热器|高过/, 'GGRQ'],
    [/低温过热器|低过/, 'DGRQ'],
    [/高温再热器|高再/, 'GZRQ'],
    [/低温再热器|低再/, 'DZRQ'],
    [/省煤器/, 'SMQ'],
    [/水冷壁/, 'SLB']
  ];
  /* 历史系统码别名：导入旧台账时把 HPGRQ 归一为 PSGRQ，避免新建测点沿用旧码。 */
  var SYSTEM_ALIASES = { HPGRQ: 'PSGRQ' };
  function canonicalSystem(value) {
    var raw = text(value);
    return SYSTEM_ALIASES[raw.toUpperCase()] || raw;
  }
  function inferMeasurementType(name) {
    var raw = text(name);
    if (/集箱/.test(raw)) return 'header_wall';
    if (/汽温|蒸汽温度/.test(raw)) return 'steam';
    if (/烟温|烟气/.test(raw)) return 'flue';
    return 'tube_wall';
  }
  function inferSystem(name) {
    var raw = text(name);
    for (var i = 0; i < SYSTEM_PATTERNS.length; i += 1) if (SYSTEM_PATTERNS[i][0].test(raw)) return SYSTEM_PATTERNS[i][1];
    return '';
  }
  function autoPointFrom(item) {
    return {
      unit: item.unit, tag: item.tag, name: item.name || item.tag,
      measurementType: inferMeasurementType(item.name), system: inferSystem(item.name),
      location: '', panel: '', active: true
    };
  }
  function parseDurationSeconds(value) {
    if (value === '' || value === null || value === undefined) return { seconds: null, kind: 'empty' };
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < 0) return { seconds: null, kind: 'invalid' };
      if (value <= 1) return { seconds: Math.round(value * 86400), kind: 'excel-time' };
      return { seconds: Math.round(value), kind: 'seconds' };
    }
    var raw = text(value);
    var clock = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(raw);
    if (clock) return { seconds: Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3] || 0), kind: 'clock' };
    var seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return { seconds: Math.round(seconds), kind: 'seconds' };
    return { seconds: null, kind: 'invalid' };
  }
  function wallClockString(date) {
    return pad(date.getFullYear(), 4) + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }
  function excelSerialString(serial) {
    var date = new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000));
    return pad(date.getUTCFullYear(), 4) + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate()) +
      'T' + pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes()) + ':' + pad(date.getUTCSeconds());
  }
  function parseTimestamp(value, parseTime) {
    if (typeof parseTime !== 'function') return null;
    if (value instanceof Date && Number.isFinite(value.getTime())) return parseTime(wallClockString(value));
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value > 100000000000) return parseTime(value);
      return parseTime(excelSerialString(value));
    }
    var raw = text(value);
    if (!raw) return null;
    var zone = '';
    var zoneMatch = /(Z|[+-]\d{2}:?\d{2})$/.exec(raw);
    if (zoneMatch) { zone = zoneMatch[1]; raw = raw.slice(0, -zone.length).trim(); }
    var match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.\d{1,6})?)?)?$/.exec(raw);
    if (!match) return null;
    var iso = match[1] + '-' + pad(match[2]) + '-' + pad(match[3]) + 'T' +
      pad(match[4] || 0) + ':' + pad(match[5] || 0) + ':' + pad(match[6] || 0) + zone;
    return parseTime(iso);
  }
  function normalizePointMatrix(matrix, parseTime) {
    var parsed = table(matrix);
    var items = [], errors = [];
    parsed.rows.forEach(function (row) {
      var tag = text(pick(row, POINT_ALIASES.tag));
      var name = text(pick(row, POINT_ALIASES.name));
      var unitValue = text(pick(row, POINT_ALIASES.unit));
      var commissionedRaw = pick(row, POINT_ALIASES.commissionedAt);
      var commissionedAt = parseTime ? parseTimestamp(commissionedRaw, parseTime) : null;
      var tagUnit = unitFromTag(tag);
      var unitMatch = /([12])/.exec(unitValue);
      var unit = unitMatch ? unitMatch[1] : tagUnit;
      var messages = [];
      if (text(commissionedRaw) && commissionedAt === null) messages.push('投产日期无效，应为 YYYY-MM-DD');
      if (tagUnit && unitMatch && tagUnit !== unitMatch[1]) messages.push('机组列与 DCS Tag 前缀不一致');
      var measurementType = normalizeType(pick(row, POINT_ALIASES.measurementType));
      var limitC = number(pick(row, POINT_ALIASES.limitC));
      var limitBasis = text(pick(row, POINT_ALIASES.limitBasis));
      if (!tag) messages.push('缺少 DCS Tag / 点位');
      if (!name) messages.push('缺少测点名称');
      if (unit !== '1' && unit !== '2') messages.push('无法判断机组（Tag 应以 DCS1_/DCS2_ 开头，或填写机组列）');
      if (!measurementType) messages.push('测量类型无效，需为 tube_wall/header_wall/steam/flue/other 或中文类型');
      if (limitC !== null && limitC <= 0) messages.push('温度限值必须大于 0');
      if (limitC !== null && !limitBasis) messages.push('有限值时必须填写限值依据');
      if (messages.length) errors.push({ row: row.__row, tag: tag, messages: messages });
      items.push({
        row: row.__row, unit: unit, tag: tag, name: name, measurementType: measurementType,
        location: text(pick(row, POINT_ALIASES.location)),
        commissionedAt: commissionedAt,
        limitC: limitC, limitBasis: limitBasis,
        active: toBool(pick(row, POINT_ALIASES.active), true),
        system: canonicalSystem(pick(row, POINT_ALIASES.system)),
        group: text(pick(row, POINT_ALIASES.group)),
        panel: text(pick(row, POINT_ALIASES.panel)),
        errors: messages
      });
    });
    if (!parsed.rows.length) errors.push({ row: 1, messages: ['文件没有数据行'] });
    return { items: items, errors: errors };
  }
  function normalizeReportMatrix(matrix, parseTime, options) {
    var parsed = table(matrix), items = [], errors = [];
    var ignoreDuration = options && options.ignoreDuration;
    parsed.rows.forEach(function (row) {
      var tag = text(pick(row, REPORT_ALIASES.tag));
      var startAt = parseTimestamp(pick(row, REPORT_ALIASES.startAt), parseTime);
      var endAt = parseTimestamp(pick(row, REPORT_ALIASES.endAt), parseTime);
      var temperatureC = number(pick(row, REPORT_ALIASES.temperatureC));
      var limitC = number(pick(row, REPORT_ALIASES.limitC));
      var duration = parseDurationSeconds(pick(row, REPORT_ALIASES.duration));
      var messages = [];
      if (!tag) messages.push('缺少点位');
      if (!Number.isSafeInteger(startAt)) messages.push('开始时间无效');
      if (!Number.isSafeInteger(endAt)) messages.push('结束时间无效');
      if (Number.isSafeInteger(startAt) && Number.isSafeInteger(endAt) && endAt <= startAt) messages.push('结束时间必须晚于开始时间');
      if (temperatureC === null) messages.push('最值温度无效');
      if (limitC !== null && limitC <= 0) messages.push('报表限值无效');
      if (duration.kind === 'invalid') messages.push('总时长无法解析（应为 HH:mm:ss）');
      var intervalSeconds = Number.isSafeInteger(startAt) && Number.isSafeInteger(endAt) ? Math.round((endAt - startAt) / 1000) : null;
      var durationSeconds = duration.seconds;
      if (durationSeconds === null && intervalSeconds !== null) durationSeconds = Math.max(0, intervalSeconds);
      if (!ignoreDuration && durationSeconds !== null && intervalSeconds !== null && Math.abs(durationSeconds - intervalSeconds) > 5) {
        messages.push('总时长 ' + durationSeconds + ' 秒与起止时间差 ' + intervalSeconds + ' 秒不一致，请核对');
      }
      if (messages.length) errors.push({ row: row.__row, tag: tag, messages: messages });
      items.push({
        row: row.__row, tag: tag, unit: unitFromTag(tag), name: text(pick(row, REPORT_ALIASES.name)),
        limitC: limitC, temperatureC: temperatureC, startAt: startAt, endAt: endAt,
        durationSeconds: durationSeconds, durationKind: duration.kind,
        crew: text(pick(row, REPORT_ALIASES.crew)),
        meanC: number(pick(row, REPORT_ALIASES.meanC)),
        overType: text(pick(row, REPORT_ALIASES.overType)) || '越高限',
        errors: messages
      });
    });
    if (!parsed.rows.length) errors.push({ row: 1, messages: ['文件没有数据行'] });
    return { items: items, errors: errors };
  }
  function fingerprintOf(item) {
    return [item.pointId || item.tag, item.startAt, item.endAt, item.kind || 'interval'].join('|');
  }
  function fnv1a(value) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }
  function stableId(prefix, parts) {
    var source = parts.join('|');
    return prefix + '-' + fnv1a(source) + fnv1a(source + '#2');
  }
  function evaluatePoints(items, existingKeys) {
    var seen = {}, rows = [], summary = { total: items.length, ok: 0, duplicate: 0, error: 0 };
    (items || []).forEach(function (item) {
      var key = item.unit + '|' + text(item.tag).toUpperCase();
      var row = { item: item, status: 'ok', importable: true, messages: (item.errors || []).slice() };
      if (row.messages.length) { row.status = 'error'; row.importable = false; }
      else if (existingKeys && existingKeys.has(key)) { row.status = 'duplicate'; row.importable = false; row.messages = ['同机组 Tag 已存在，跳过']; }
      else if (seen[key]) { row.status = 'duplicate'; row.importable = false; row.messages = ['文件内重复 Tag，仅保留首行']; }
      if (!row.messages.length) seen[key] = true;
      summary[row.status === 'ok' ? 'ok' : row.status === 'duplicate' ? 'duplicate' : 'error'] += 1;
      rows.push(row);
    });
    return { rows: rows, summary: summary };
  }
  function evaluateReport(items, context) {
    var core = context.core, now = context.now, seen = {}, rows = [];
    var autoCreate = context.autoCreate === true;
    var summary = { total: items.length, ok: 0, duplicate: 0, error: 0 };
    (items || []).forEach(function (item) {
      var row = { item: item, point: null, config: null, draftPoint: null, willCreate: false, status: 'ok', importable: true, messages: (item.errors || []).slice() };
      var key = item.unit + '|' + text(item.tag).toUpperCase();
      row.point = context.pointsByTag ? context.pointsByTag[key] : null;
      if (!row.messages.length && !row.point) {
        if (!autoCreate) row.messages.push('未找到该机组与点位对应的测点，请先导入测点台账');
        else if (item.limitC === null || item.limitC <= 0) row.messages.push('未登记测点，且报表缺少有效限值，无法自动建点');
        else if (!text(item.name)) row.messages.push('未登记测点，且报表缺少描述，无法自动建点');
        else { row.willCreate = true; row.draftPoint = autoPointFrom(item); }
      }
      if (!row.messages.length && row.point) {
        var configs = context.configsFor(row.point.id);
        row.config = core.resolveConfig(configs, row.point.id, item.startAt);
        if (!row.config) row.messages.push('开始时间没有唯一有效配置，无法确定当时限值');
        else if (!Number.isFinite(Number(row.config.limitC)) || !text(row.config.limitBasis)) {
          row.messages.push('该测点配置缺少有依据的温度限值');
        } else if (item.limitC !== null && Math.abs(Number(row.config.limitC) - item.limitC) > 0.05) {
          row.messages.push('报表限值 ' + item.limitC + '℃ 与系统配置 ' + row.config.limitC + '℃ 不一致，请先核对配置版本');
        } else if (item.temperatureC < Number(row.config.limitC)) {
          row.messages.push('最值 ' + item.temperatureC + '℃ 低于限值 ' + row.config.limitC + '℃，不能作为超温区间');
        } else {
          var boundary = core.getConfigEffectiveTo(row.config, configs);
          if (boundary !== null && item.endAt > boundary) row.messages.push('区间跨越配置生效边界，需先拆分或核对配置版本');
        }
      }
      if (!row.messages.length && row.willCreate && item.temperatureC < item.limitC) row.messages.push('最值 ' + item.temperatureC + '℃ 低于限值 ' + item.limitC + '℃，不能作为超温区间');
      if (!row.messages.length && item.endAt > now) row.messages.push('记录时间不得位于未来');
      var fingerprint = row.point ? [row.point.id, item.startAt, item.endAt, 'interval'].join('|') : row.willCreate ? ['new', item.unit, text(item.tag).toUpperCase(), item.startAt, item.endAt].join('|') : '';
      if (!row.messages.length && fingerprint && seen[fingerprint]) { row.status = 'duplicate'; row.importable = false; row.messages = ['文件内重复事件，仅保留首条']; }
      else if (!row.messages.length && fingerprint && row.point && context.existing && context.existing.has(fingerprint)) { row.status = 'duplicate'; row.importable = false; row.messages = ['共享台账中已存在相同区间，跳过']; }
      if (fingerprint) seen[fingerprint] = true;
      if (row.messages.length && row.status !== 'duplicate') { row.status = 'error'; row.importable = false; }
      summary[row.status === 'ok' ? 'ok' : row.status === 'duplicate' ? 'duplicate' : 'error'] += 1;
      rows.push(row);
    });
    return { rows: rows, summary: summary };
  }
  function noteFrom(item, fileName) {
    return '月度超温报表导入｜' + item.overType +
      (item.crew ? '｜班组：' + item.crew : '') +
      (item.meanC !== null ? '｜均值：' + item.meanC + '℃' : '') +
      (item.limitC !== null ? '｜报表限值：' + item.limitC + '℃' : '') +
      '｜来源：' + (fileName || '月度报表');
  }
  function recordFrom(item, point, config, fileName) {
    return {
      id: stableId('tr', [point.id, item.startAt, item.endAt]),
      pointId: point.id, configId: config.id, kind: 'interval',
      startAt: item.startAt, endAt: item.endAt, temperatureC: item.temperatureC,
      verified: true, note: noteFrom(item, fileName), status: 'active', revision: 1
    };
  }
  var api = {
    headerKey: headerKey, table: table, number: number,
    parseDurationSeconds: parseDurationSeconds, parseTimestamp: parseTimestamp,
    normalizeType: normalizeType, unitFromTag: unitFromTag,
    inferMeasurementType: inferMeasurementType, inferSystem: inferSystem, autoPointFrom: autoPointFrom,
    normalizePointMatrix: normalizePointMatrix, normalizeReportMatrix: normalizeReportMatrix,
    fingerprintOf: fingerprintOf, stableId: stableId,
    evaluatePoints: evaluatePoints, evaluateReport: evaluateReport,
    noteFrom: noteFrom, recordFrom: recordFrom
  };
  root.BTOvertemperatureImport = api;
  if (typeof globalThis !== 'undefined') globalThis.BTOvertemperatureImport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
