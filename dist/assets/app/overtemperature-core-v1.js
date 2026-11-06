/* 超温纯领域层。无 DOM、网络、存储依赖；先以 side-effect 加载 assistant-core-v1.js。
 * 时间/配置/统计窗口统一 [start, end)，observation 为时点；null 不代表正常。
 * 所有温度/区间均来自人工记录，绝不从峰值推断持续时间。
 */
(function (root) {
  'use strict';
  var Assistant = root.BTAssistantCore || (typeof globalThis !== 'undefined' && globalThis.BTAssistantCore);
  if (!Assistant || typeof Assistant.canonicalTubeCode !== 'function' || typeof Assistant.validateTubeCode !== 'function') {
    throw new Error('BTOvertemperatureCore requires BTAssistantCore to be loaded first');
  }

  // app-v7.9.js matrix 的镜像；仅去掉 spec/mat/badge。测试直接提取主源码防漂移。
  var MATRIX = [
    { name:'水冷壁-前墙', sys:'SLB', comp:'WB', pos:'F000', dirs:['R','L'], tMax:192 },
    { name:'水冷壁-后墙', sys:'SLB', comp:'WB', pos:'B000', dirs:['R','L'], tMax:192 },
    { name:'水冷壁-左墙（B侧）', sys:'SLB', comp:'WB', pos:'L000', dirs:['F','B'], tMax:169 },
    { name:'水冷壁-右墙（A侧）', sys:'SLB', comp:'WB', pos:'R000', dirs:['F','B'], tMax:169 },
    { name:'冷灰斗-前坡', sys:'SLB', comp:'LHD', pos:'F000', dirs:['L','R'], tMax:96 },
    { name:'冷灰斗-后坡', sys:'SLB', comp:'LHD', pos:'B000', dirs:['L','R'], tMax:96 },
    { name:'燃烧器区域', sys:'SLB', comp:'RSQ', special:'rsq', corners:[1,4], layers:['A','B','C','D','E','F'], nozzles:[1,8] },
    { name:'全大屏过热器', sys:'DPGRQ', comp:'GQ', posLetters:['L','R'], pMax:6, pos2Letters:['F','B'], p2Max:4, dirs:['F','B'], tMax:14, loopPairing:true },
    { name:'后屏过热器', sys:'HPGRQ', comp:'GQ', posLetters:['L','R'], pMax:21, dirs:['F','B'], tMax:13, loopPairing:true },
    { name:'高温过热器', sys:'GGRQ', comp:'GQ', posLetters:['L','R'], pMax:32, dirs:['F','B'], tMax:12, loopPairing:true },
    { name:'高温再热器', sys:'GZRQ', comp:'GQ', posLetters:['L','R'], pMax:64, dirs:['F','B'], tMax:7, loopPairing:true },
    { name:'低温过热器', sys:'DGRQ', comp:'GQ', spaces:[1,5], posLetters:['L','R'], pMax:112, dirs:['D','U'], tMax:5 },
    { name:'低温再热器', sys:'DZRQ', comp:'GQ', spaces:[1,6], posLetters:['L','R'], pMax:112, dirs:['D','U'], tMax:6, tubeOptional:true },
    { name:'省煤器蛇形管', sys:'SMQ', comp:'SG', posLetters:['L','R'], pMax:124, dirs:['U','D'], tMax:1 },
    { name:'省煤器进口集箱', sys:'SMQ', comp:'EXIN', posLetters:['L','R'], pMax:124, dirs:['U','D'], tMax:1 },
    { name:'省煤器出口集箱', sys:'SMQ', comp:'EXOUT', posLetters:['L','R'], pMax:124, dirs:['U','D'], tMax:1 }
  ];
  function freeze(value) {
    if (value && typeof value === 'object') { Object.keys(value).forEach(function (key) { freeze(value[key]); }); Object.freeze(value); }
    return value;
  }
  freeze(MATRIX);
  var own = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  var object = function (o) { return !!o && typeof o === 'object' && !Array.isArray(o); };
  var finite = function (n) { return typeof n === 'number' && Number.isFinite(n); };
  var text = function (s) { return typeof s === 'string' && s.trim().length > 0; };
  var pad = function (n, width) { return String(n).padStart(width || 2, '0'); };
  var result = function (value, errors) { return { ok:errors.length === 0, value:errors.length ? null : value, errors:errors }; };
  var rowsOf = function (rows) { return rows === undefined ? MATRIX : (Array.isArray(rows) ? rows : []); };

  function parseTime(value) {
    if (finite(value)) return Number.isSafeInteger(value) && Math.abs(value) <= 8640000000000000 ? value : null;
    if (typeof value !== 'string') return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(value);
    if (!m || (m[7] && !m[8])) return null;
    var y = +m[1], mo = +m[2], day = +m[3], h = +m[4], min = +m[5], sec = +(m[6] || 0);
    var leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    var days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (y < 1 || mo < 1 || mo > 12 || day < 1 || day > days[mo - 1] || h > 23 || min > 59 || sec > 59) return null;
    var offset = 480;
    if (m[8] === 'Z') offset = 0;
    else if (m[8]) {
      var z = /^([+-])(\d{2}):?(\d{2})$/.exec(m[8]);
      if (+z[2] > 23 || +z[3] > 59) return null;
      offset = (+z[2] * 60 + +z[3]) * (z[1] === '-' ? -1 : 1);
    }
    var d = new Date(0);
    d.setUTCFullYear(y, mo - 1, day);
    d.setUTCHours(h, min, sec, m[7] ? +(m[7] + '00').slice(0, 3) : 0);
    return parseTime(d.getTime() - offset * 60000);
  }
  function toInputTime(value) {
    var ms = parseTime(value);
    if (ms === null) return '';
    var d = new Date(ms + 480 * 60000);
    if (!Number.isFinite(d.getTime()) || d.getUTCFullYear() < 1 || d.getUTCFullYear() > 9999) return '';
    return pad(d.getUTCFullYear(), 4) + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
  }
  function formatTime(value) { var s = toInputTime(value); return s ? s.replace('T', ' ') + ' +08:00' : ''; }

  var REGION_KEYS = ['sys','comp','wall','spaces','posFrom','posTo','pos2From','pos2To','tubeFrom','tubeTo','dirs','parts','corners','layers','nozzles'];
  var ARRAY_KEYS = ['spaces','dirs','parts','corners','layers','nozzles'];
  var NUMBER_KEYS = ['posFrom','posTo','pos2From','pos2To','tubeFrom','tubeTo'];
  function canonicalDirs(row) { return row.loopPairing ? row.dirs : [row.dirs[0]]; }
  function between(n, lo, hi) { return n >= lo && n <= hi; }
  function selected(list, x) { return list === null || list.indexOf(x) !== -1; }
  function rangeContains(n, lo, hi) { return n !== null && (lo === null || n >= lo) && (hi === null || n <= hi); }
  function regionRows(r, rows) { return rows.filter(function (row) { return row && row.sys === r.sys && row.comp === r.comp && (r.wall === null || row.pos === r.wall); }); }

  function validateRegion(region, matrixRows) {
    var errors = [], rows = rowsOf(matrixRows);
    if (!object(region)) return result(null, ['region 必须为对象']);
    REGION_KEYS.forEach(function (k) { if (!own(region, k)) errors.push(k + ' 必须明确填写；全部/不适用使用 null'); });
    Object.keys(region).forEach(function (k) { if (REGION_KEYS.indexOf(k) < 0) errors.push('未知 region 字段: ' + k); });
    var r = {};
    REGION_KEYS.forEach(function (k) { r[k] = Array.isArray(region[k]) ? region[k].slice() : region[k]; });
    if (!text(r.sys) || !text(r.comp)) errors.push('sys/comp 必须为系统和部件代码');
    if (r.wall !== null && ['F000','B000','L000','R000'].indexOf(r.wall) < 0) errors.push('wall 无效');
    NUMBER_KEYS.forEach(function (k) { if (r[k] !== null && (!Number.isSafeInteger(r[k]) || r[k] < 1)) errors.push(k + ' 必须为正整数或 null'); });
    ARRAY_KEYS.forEach(function (k) {
      if (r[k] === null) return;
      if (!Array.isArray(r[k]) || !r[k].length) { errors.push(k + ' 必须为非空数组或 null'); return; }
      var numeric = ['spaces','corners','nozzles'].indexOf(k) >= 0;
      if (r[k].some(function (v) { return numeric ? !Number.isSafeInteger(v) || v < 1 : !text(v); })) errors.push(k + ' 元素类型无效');
      r[k] = Array.from(new Set(r[k]));
    });
    [['posFrom','posTo'],['pos2From','pos2To'],['tubeFrom','tubeTo']].forEach(function (p) { if (r[p[0]] !== null && r[p[1]] !== null && r[p[0]] > r[p[1]]) errors.push(p[0] + ' 不得大于 ' + p[1]); });
    if (errors.length) return result(null, errors);
    var matches = regionRows(r, rows);
    if (!matches.length) return result(null, ['系统/部件/墙面组合不在矩阵内']);
    var applicable = function (keys, predicate) {
      if (!matches.some(predicate)) keys.forEach(function (k) { if (r[k] !== null) errors.push(k + ' 不适用于此系统部件，应为 null'); });
    };
    applicable(['wall'], function (row) { return !!row.pos; });
    applicable(['spaces'], function (row) { return !!row.spaces; });
    applicable(['posFrom','posTo'], function (row) { return !!row.pMax; });
    applicable(['pos2From','pos2To'], function (row) { return !!row.p2Max; });
    applicable(['tubeFrom','tubeTo','dirs'], function (row) { return row.special !== 'rsq'; });
    applicable(['corners','layers','nozzles'], function (row) { return row.special === 'rsq'; });
    function checkArray(k, valid) { if (r[k] !== null && r[k].some(function (v) { return !matches.some(function (row) { return valid(v, row); }); })) errors.push(k + ' 含矩阵外或非规范方向的值'); }
    checkArray('parts', function (v) { return v === 'Q' || v === 'W'; });
    checkArray('spaces', function (v, row) { return row.spaces && between(v, row.spaces[0], row.spaces[1]); });
    checkArray('dirs', function (v, row) { return row.dirs && canonicalDirs(row).indexOf(v) >= 0; });
    checkArray('corners', function (v, row) { return row.corners && between(v, row.corners[0], row.corners[1]); });
    checkArray('layers', function (v, row) { return row.layers && row.layers.indexOf(v) >= 0; });
    checkArray('nozzles', function (v, row) { return row.nozzles && between(v, row.nozzles[0], row.nozzles[1]); });
    [['posFrom','pMax'],['posTo','pMax'],['pos2From','p2Max'],['pos2To','p2Max'],['tubeFrom','tMax'],['tubeTo','tMax']].forEach(function (entry) {
      if (r[entry[0]] !== null && matches.some(function (row) { return row[entry[1]] && r[entry[0]] > row[entry[1]]; })) errors.push(entry[0] + ' 超出所选范围；请缩小墙面/部件范围');
    });
    if (r.parts && r.parts.indexOf('W') >= 0 && r.dirs && matches.every(function (row) { return row.loopPairing; }) && r.dirs.indexOf('F') < 0) errors.push('W 的规范方向为 F，不能选择仅 B 的弯头范围');
    return result(r, errors);
  }

  // parseTubeCodeParts 目前未直接导出；validateTubeCode.parts 来自同一个内部解析器。
  function canonicalParts(code, matrixRows) {
    var rows = rowsOf(matrixRows), normalized = code;
    for (var i = 0; i < 4; i += 1) {
      var changed = Assistant.canonicalTubeCode(normalized, rows);
      if (!changed || changed.code === normalized) break;
      normalized = changed.code;
    }
    var checked = Assistant.validateTubeCode(normalized, rows);
    if (!checked.valid || !checked.matched || checked.fieldPosition) return null;
    var p = typeof Assistant.parseTubeCodeParts === 'function' ? Assistant.parseTubeCodeParts(checked.code) : checked.parts;
    if (!p) return null;
    p = Object.assign({}, p);
    if ((p.sys === 'DGRQ' || p.sys === 'DZRQ') && p.space === null) p.space = 1;
    var body = [];
    if (p.corner !== null) body = ['J' + p.corner, p.layer + p.nozzle];
    else {
      if (p.space !== null) body.push(p.space + 'KJ');
      body.push(p.pos);
      if (p.pos2) body.push(p.pos2);
      if (p.tube !== null) body.push(p.dir + pad(p.tube, 3));
    }
    return { code:[p.unit,p.sys,p.comp].concat(body, [p.partKind]).join('-'), parts:p, row:checked.matched };
  }
  function matchParts(p, r) {
    if (p.sys !== r.sys || p.comp !== r.comp || (r.wall !== null && p.pos !== r.wall) || !selected(r.parts, p.partKind)) return false;
    if (!selected(r.spaces, p.space) || !selected(r.corners, p.corner) || !selected(r.layers, p.layer) || !selected(r.nozzles, p.nozzle)) return false;
    if ((r.posFrom !== null || r.posTo !== null) && !rangeContains(p.posNum, r.posFrom, r.posTo)) return false;
    if ((r.pos2From !== null || r.pos2To !== null) && !rangeContains(p.pos2Num, r.pos2From, r.pos2To)) return false;
    // 低再未提供管号是未知单管身份，不等于 F001，不能命中任何指定单管/方向范围。
    if ((r.tubeFrom !== null || r.tubeTo !== null) && !rangeContains(p.tube, r.tubeFrom, r.tubeTo)) return false;
    return selected(r.dirs, p.dir);
  }
  function matchesRegion(code, region, unit, matrixRows) {
    if (unit !== '1' && unit !== '2') return false;
    var checked = validateRegion(region, matrixRows);
    if (!checked.ok) return false;
    var canonical = canonicalParts(code, matrixRows);
    return !!canonical && canonical.parts.boiler === unit && matchParts(canonical.parts, checked.value);
  }
  function ints(lo, hi) { var a = []; for (var i = lo; i <= hi; i += 1) a.push(i); return a; }
  function expandRegion(region, unit, matrixRows, limit) {
    var rows = rowsOf(matrixRows), checked = validateRegion(region, rows);
    if (!checked.ok || (unit !== '1' && unit !== '2')) return { count:0, codes:[] };
    limit = limit === undefined ? 20 : limit;
    if (!Number.isSafeInteger(limit) || limit < 0) limit = 0;
    var r = checked.value, seen = new Set(), codes = [];
    function add(code) {
      var normalized = canonicalParts(code, rows);
      if (!normalized || !matchParts(normalized.parts, r) || seen.has(normalized.code)) return;
      seen.add(normalized.code);
      if (codes.length < limit) codes.push(normalized.code);
    }
    regionRows(r, rows).forEach(function (row) {
      var prefix = unit + 'G-' + row.sys + '-' + row.comp;
      var parts = r.parts || ['Q','W'];
      if (row.special === 'rsq') {
        (r.corners || ints(row.corners[0], row.corners[1])).forEach(function (c) {
          (r.layers || row.layers).forEach(function (layer) {
            (r.nozzles || ints(row.nozzles[0], row.nozzles[1])).forEach(function (n) { parts.forEach(function (part) { add(prefix + '-J' + c + '-' + layer + n + '-' + part); }); });
          });
        });
        return;
      }
      var positions = row.pos ? [row.pos] : ints(r.posFrom || 1, r.posTo || row.pMax).map(function (n) { return row.posLetters[0] + pad(n, 3); });
      var positions2 = row.p2Max ? ints(r.pos2From || 1, r.pos2To || row.p2Max).map(function (n) { return row.pos2Letters[0] + pad(n, 3); }) : [null];
      var spaces = row.spaces ? (r.spaces || ints(row.spaces[0], row.spaces[1])) : [null];
      var dirs = canonicalDirs(row).filter(function (dir) { return selected(r.dirs, dir); });
      spaces.forEach(function (space) { positions.forEach(function (pos) { positions2.forEach(function (pos2) { dirs.forEach(function (dir) {
        ints(r.tubeFrom || 1, r.tubeTo || row.tMax).forEach(function (tube) { parts.forEach(function (part) {
          // 弯头只记 F，B-W 归一后去重；B-only/null-parts 不扩大到 F。
          if (row.loopPairing && part === 'W' && dir !== 'F') return;
          add(prefix + '-' + [space === null ? null : space + 'KJ',pos,pos2,dir + pad(tube, 3),part].filter(function (x) { return x !== null; }).join('-'));
        }); });
      }); }); }); });
    });
    return { count:seen.size, codes:codes };
  }

  function pointErrors(point) {
    return !object(point) || !text(point.id) || (point.unit !== '1' && point.unit !== '2') ? ['point 必须含有效 id 和 unit（1/2 字符串）'] : [];
  }
  function resolveConfig(configs, pointId, at) {
    var time = parseTime(at);
    if (time === null || !Array.isArray(configs)) return null;
    var found = null, ambiguous = false;
    configs.forEach(function (c) {
      if (!object(c) || c.pointId !== pointId) return;
      var t = parseTime(c.effectiveFrom);
      if (t === null || t > time) return;
      if (!found || t > parseTime(found.effectiveFrom)) { found = c; ambiguous = false; }
      else if (t === parseTime(found.effectiveFrom) && c.id !== found.id) ambiguous = true;
    });
    return ambiguous ? null : found;
  }
  function getConfigEffectiveTo(config, configs) {
    var start = parseTime(config && config.effectiveFrom), end = null;
    if (start === null) return null;
    (Array.isArray(configs) ? configs : []).forEach(function (c) {
      if (!c || c.pointId !== config.pointId || c.id === config.id) return;
      var t = parseTime(c.effectiveFrom);
      if (t !== null && t > start && (end === null || t < end)) end = t;
    });
    return end;
  }
  function covers(record, config, configs) {
    var start = parseTime(record.startAt), end = record.endAt === null ? null : parseTime(record.endAt);
    if (start === null || config.pointId !== record.pointId) return false;
    var at = resolveConfig(configs, record.pointId, start);
    if (!at || at.id !== config.id) return false;
    if (record.kind === 'observation') return record.endAt === null;
    if (record.kind !== 'interval' || (record.endAt !== null && (end === null || end <= start))) return false;
    var boundary = getConfigEffectiveTo(config, configs);
    return boundary === null || (end !== null && end <= boundary);
  }
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (object(value)) return '{' + Object.keys(value).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(value[k]); }).join(',') + '}';
    return JSON.stringify(value);
  }
  function hasLimit(config) { return !!config && finite(config.limitC) && text(config.limitBasis); }
  function validateConfig(config, point, existingConfigs, records) {
    var errors = pointErrors(point);
    if (!object(config)) return result(null, errors.concat(['config 必须为对象']));
    existingConfigs = Array.isArray(existingConfigs) ? existingConfigs : [];
    records = Array.isArray(records) ? records : [];
    var c = Object.assign({}, config), time = parseTime(c.effectiveFrom);
    if (!text(c.id)) errors.push('config.id 不能为空');
    if (!point || c.pointId !== point.id) errors.push('config.pointId 与测点不一致');
    if (!Number.isSafeInteger(c.revision) || c.revision < 1) errors.push('config.revision 必须为正整数');
    if (time === null) errors.push('effectiveFrom 必须为有效时间'); else c.effectiveFrom = time;
    if (own(c, 'effectiveTo')) errors.push('effectiveTo 由下一配置推导，不可写入');
    if (typeof c.mappingConfirmed !== 'boolean') errors.push('mappingConfirmed 必须为布尔值');
    if (typeof c.mappingBasis !== 'string' || typeof c.limitBasis !== 'string') errors.push('mappingBasis/limitBasis 必须为字符串');
    if (c.limitC !== null && !finite(c.limitC)) errors.push('limitC 必须为有限温度或 null，不能默认为零');
    if (c.limitC !== null && !text(c.limitBasis)) errors.push('有温度限值必须填写依据');
    if (!Array.isArray(c.regions)) errors.push('regions 必须为数组');
    else {
      c.regions = c.regions.map(function (r, index) {
        var validated = validateRegion(r);
        validated.errors.forEach(function (e) { errors.push('regions[' + index + ']: ' + e); });
        return validated.value;
      });
    }
    if (c.mappingConfirmed && (!Array.isArray(c.regions) || !c.regions.length || !text(c.mappingBasis))) errors.push('确认映射必须有区域和映射依据');
    var same = existingConfigs.filter(function (x) { return x && x.id === c.id; });
    if (same.length && same.some(function (x) { return stable(x) !== stable(c); })) errors.push('历史配置不可修改；请新建配置版本');
    var others = existingConfigs.filter(function (x) { return x && x.id !== c.id; });
    var siblings = others.filter(function (x) { return x.pointId === c.pointId; });
    if (siblings.some(function (x) { return parseTime(x.effectiveFrom) === time; })) errors.push('同一测点的配置生效时间不能重复');
    if (siblings.some(function (x) { return x.revision === c.revision; })) errors.push('同一测点的配置序号不能重复');
    if (!same.length) {
      var maxRevision = siblings.reduce(function (n, x) { return Number.isSafeInteger(x.revision) ? Math.max(n, x.revision) : n; }, 0);
      if (c.revision !== maxRevision + 1) errors.push('新配置 revision 必须为现有最大序号加一');
    }
    if (!errors.length) {
      var proposed = others.concat([c]);
      records.forEach(function (r) {
        if (!r || r.pointId !== c.pointId) return;
        var ref = proposed.find(function (x) { return x.id === r.configId && x.pointId === r.pointId; });
        if (!ref || !covers(r, ref, proposed)) errors.push('配置生效期会改变既有记录版本或跨越区间: ' + (r.id || '(无编号)'));
      });
    }
    return result(c, errors);
  }
  function validateRecord(record, point, configs, now) {
    var errors = pointErrors(point);
    if (!object(record)) return result(null, errors.concat(['record 必须为对象']));
    configs = Array.isArray(configs) ? configs : [];
    var r = Object.assign({}, record), start = parseTime(r.startAt), end = r.endAt === null ? null : parseTime(r.endAt);
    var current = parseTime(now === undefined ? Date.now() : now);
    if (!text(r.id)) errors.push('record.id 不能为空');
    if (!point || r.pointId !== point.id) errors.push('record.pointId 与测点不一致');
    if (['observation','interval'].indexOf(r.kind) < 0) errors.push('kind 必须为 observation 或 interval');
    if (['active','void'].indexOf(r.status) < 0) errors.push('status 必须为 active 或 void');
    if (!Number.isSafeInteger(r.revision) || r.revision < 1) errors.push('record.revision 必须为正整数');
    if (typeof r.verified !== 'boolean') errors.push('verified 必须为布尔值');
    if (typeof r.note !== 'string') errors.push('note 必须为字符串');
    if (r.kind === 'interval' && !text(r.note)) errors.push('interval 必须填写人工核定依据/备注 note');
    if (!finite(r.temperatureC)) errors.push('temperatureC 必须为有限数值且不可为空');
    if (start === null) errors.push('startAt 必须为有效时间'); else r.startAt = start;
    if (r.endAt !== null && end === null) errors.push('endAt 必须为有效时间或 null'); else r.endAt = end;
    if (current === null) errors.push('now 必须为有效时间');
    else if ((start !== null && start > current) || (end !== null && end > current)) errors.push('记录时间不得位于未来');
    if (r.kind === 'observation' && record.endAt !== null) errors.push('observation 只能为时点，endAt 必须为 null');
    if (r.kind === 'interval' && end !== null && start !== null && end <= start) errors.push('interval 结束必须晚于开始');
    var config = configs.find(function (c) { return c && c.id === r.configId && c.pointId === r.pointId; });
    if (!config) errors.push('configId 必须引用本测点的配置');
    else {
      if (!covers(r, config, configs)) errors.push('configId 与生效期不一致，区间不得跨配置边界（未结束区间须先结束）');
      if (r.kind === 'interval') {
        if (!hasLimit(config)) errors.push('interval 需要有依据的确认限值');
        else if (!finite(r.temperatureC) || r.temperatureC < config.limitC) errors.push('interval 温度不得低于限值');
      }
    }
    if (r.kind === 'interval' && end !== null && r.verified !== true) errors.push('已结束 interval 必须人工核定 verified=true');
    return result(r, errors);
  }

  function windowBounds(options) {
    options = object(options) ? options : {};
    var from = options.from === undefined || options.from === null ? -Infinity : parseTime(options.from);
    var to = options.to === undefined || options.to === null ? Infinity : parseTime(options.to);
    return { from:from, to:to, valid:from !== null && to !== null && from <= to };
  }
  function mergeIntervals(intervals, options) {
    var w = windowBounds(options);
    if (!w.valid || w.from === w.to) return [];
    var sorted = (Array.isArray(intervals) ? intervals : []).map(function (r) {
      if (!r) return null;
      var a = parseTime(r.startAt), b = parseTime(r.endAt);
      if (a === null || b === null || b <= a) return null;
      a = Math.max(a, w.from); b = Math.min(b, w.to);
      return b > a ? { startAt:a, endAt:b } : null;
    }).filter(Boolean).sort(function (a, b) { return a.startAt - b.startAt || a.endAt - b.endAt; });
    var merged = [];
    sorted.forEach(function (r) {
      var last = merged[merged.length - 1];
      if (last && r.startAt <= last.endAt) last.endAt = Math.max(last.endAt, r.endAt);
      else merged.push({ startAt:r.startAt, endAt:r.endAt });
    });
    return merged;
  }
  function latestRecords(records) {
    var byId = new Map(), anonymous = [];
    (Array.isArray(records) ? records : []).forEach(function (r) {
      if (!object(r)) return;
      if (!text(r.id)) { anonymous.push(r); return; }
      var old = byId.get(r.id);
      if (!old || (r.revision || 0) >= (old.revision || 0)) byId.set(r.id, r);
    });
    return Array.from(byId.values()).concat(anonymous);
  }
  function emptySummary() {
    return { recordCount:0, observationCount:0, intervalRecordCount:0, openCount:0, mergedCount:0, durationMs:0, longestMs:0, peakC:null, maxExcessC:null, intervals:[], latestAt:null, partialPeak:false, peakFromClippedInterval:false, estimatedPeakC:null, estimatedMaxExcessC:null, peakIncludesObservations:false, partialIntervalCount:0, excludedIntervalCount:0 };
  }
  function maxNullable(a, b) { return a === null ? b : Math.max(a, b); }
  function summarize(records, configs, options) {
    var s = emptySummary(), w = windowBounds(options), intervals = [];
    configs = Array.isArray(configs) ? configs : [];
    if (!w.valid) { s.errors = ['统计窗口无效']; return s; }
    if (w.from === w.to) return s;
    latestRecords(records).forEach(function (r) {
      if (r.status !== 'active' || !finite(r.temperatureC)) return;
      var start = parseTime(r.startAt), end = r.endAt === null ? null : parseTime(r.endAt);
      var config = configs.find(function (c) { return c && c.id === r.configId && c.pointId === r.pointId; });
      if (!config || start === null || !covers(r, config, configs)) return;
      var observation = r.kind === 'observation';
      if (observation ? start < w.from || start >= w.to : start >= w.to || (end !== null && end <= w.from)) return;
      s.recordCount += 1;
      var partial = false, estimate = false;
      if (observation) s.observationCount += 1;
      else {
        s.intervalRecordCount += 1;
        if (end === null) { s.openCount += 1; estimate = true; }
        else {
          partial = start < w.from || end > w.to;
          estimate = partial;
          if (partial) { s.partialIntervalCount += 1; s.partialPeak = true; s.peakFromClippedInterval = true; }
          if (r.verified === true && text(r.note) && hasLimit(config) && r.temperatureC >= config.limitC) intervals.push({ startAt:start, endAt:end });
          else s.excludedIntervalCount += 1;
        }
      }
      var excess = hasLimit(config) ? Math.max(0, r.temperatureC - config.limitC) : null;
      if (estimate) {
        s.estimatedPeakC = maxNullable(s.estimatedPeakC, r.temperatureC);
        if (excess !== null) s.estimatedMaxExcessC = maxNullable(s.estimatedMaxExcessC, excess);
      } else {
        if (s.peakC === null || r.temperatureC > s.peakC) s.peakIncludesObservations = observation;
        else if (r.temperatureC === s.peakC && observation) s.peakIncludesObservations = true;
        s.peakC = maxNullable(s.peakC, r.temperatureC);
        if (excess !== null) s.maxExcessC = maxNullable(s.maxExcessC, excess);
      }
      // latestAt 是窗口内已有证据覆盖的最近边界，不把 open 延长到 now。
      var latest = observation || end === null ? start : Math.min(end, w.to);
      if (latest >= w.from) s.latestAt = maxNullable(s.latestAt, latest);
    });
    s.intervals = mergeIntervals(intervals, options);
    s.mergedCount = s.intervals.length;
    s.intervals.forEach(function (r) { var ms = r.endAt - r.startAt; s.durationMs += ms; s.longestMs = Math.max(s.longestMs, ms); });
    return s;
  }
  function summarizeTube(code, points, configs, records, options, matrixRows) {
    options = object(options) ? options : {};
    points = Array.isArray(points) ? points : []; configs = Array.isArray(configs) ? configs : [];
    var rows = rowsOf(matrixRows), normalized = canonicalParts(code, rows);
    var installedAt = options.installedAt === undefined || options.installedAt === null ? null : parseTime(options.installedAt);
    var w = windowBounds(options), currentOptions = { from:options.from, to:options.to };
    var currentAt = parseTime(options.now === undefined ? Date.now() : options.now);
    var errors = [];
    if (currentAt === null) errors.push('now 必须为有效时间');
    if (installedAt === null && options.installedAt !== undefined && options.installedAt !== null) errors.push('installedAt 无效；不能忽略换管边界');
    if (!w.valid) errors.push('统计窗口无效');
    if (installedAt !== null && w.valid) currentOptions.from = Math.max(w.from, installedAt);
    if (errors.length || (w.valid && currentOptions.from !== undefined && parseTime(currentOptions.from) > w.to)) currentOptions = { from:0, to:0 };
    var associations = [], allRecords = [], deduped = latestRecords(records), seenPoints = new Set();
    if (normalized) points.forEach(function (point) {
      if (!point || seenPoints.has(point.id) || point.unit !== normalized.parts.boiler) return;
      seenPoints.add(point.id);
      var mapped = configs.filter(function (c) {
        return c && c.pointId === point.id && c.mappingConfirmed === true && text(c.mappingBasis) && Array.isArray(c.regions) && c.regions.some(function (region) {
          var check = validateRegion(region, rows);
          return check.ok && matchParts(normalized.parts, check.value);
        });
      });
      if (!mapped.length) return;
      var ids = new Set(mapped.map(function (c) { return c.id; }));
      var matchingRecords = deduped.filter(function (r) { return r.pointId === point.id && ids.has(r.configId); });
      var currentConfig = resolveConfig(configs, point.id, currentAt);
      var currentlyMapped = currentConfig && ids.has(currentConfig.id);
      var hasHistoricalEvidence = summarize(matchingRecords, configs).recordCount > 0;
      // 未来/已迁走且无有效 active 证据的旧映射，不伪装成当前关联。
      if (!currentlyMapped && !hasHistoricalEvidence) return;
      allRecords = allRecords.concat(matchingRecords);
      associations.push({ point:point, configs:mapped, summary:summarize(matchingRecords, configs, currentOptions), areaSummary:summarize(matchingRecords, configs, options) });
    });
    var summary = summarize(allRecords, configs, currentOptions);
    var out = { status:!associations.length ? 'unmapped' : summary.recordCount ? 'available' : 'no-records', points:associations, summary:summary, areaSummary:summarize(allRecords, configs, options), installedAt:installedAt, code:normalized ? normalized.code : null };
    if (!normalized) errors.push('管段编码无效或未在已确认矩阵范围内');
    if (errors.length) out.errors = errors;
    return out;
  }

  var api = { MATRIX:MATRIX, parseTime:parseTime, formatTime:formatTime, toInputTime:toInputTime, validateRegion:validateRegion, expandRegion:expandRegion, matchesRegion:matchesRegion, validateConfig:validateConfig, resolveConfig:resolveConfig, validateRecord:validateRecord, mergeIntervals:mergeIntervals, summarize:summarize, summarizeTube:summarizeTube, getConfigEffectiveTo:getConfigEffectiveTo };
  root.BTOvertemperatureCore = api;
  if (typeof globalThis !== 'undefined') globalThis.BTOvertemperatureCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
