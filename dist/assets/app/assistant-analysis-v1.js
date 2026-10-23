/* ============================================================
   BOILER-TUBE LIFECYCLE MANAGEMENT SYSTEM · AI 数据助手 · 分析领域层
   assets/app/assistant-analysis-v1.js · v1.0.0
   ------------------------------------------------------------
   职责（纯函数，无 DOM、无 IO、无存储）：
   1. parseAnalysis(message, context)  把中文问法解析成分析规格 spec
   2. runAnalysis(spec, snapshot)      在数据快照上聚合计算，产出指标/洞察/明细
   3. chartSvg(chart, options)         把图表规格渲染成纯 SVG 字符串
   4. capabilities()                   对外能力清单（帮助文案用）

   设计约束：
   - 只读：本层不写任何数据，分析结果只用于展示与导出。
   - 口径复用：过滤条件直接复用 BTAssistantCore.parseQuery 的结果，
     与「查询」功能保持同一套机组/受热面/类型/日期/壁厚口径。
   - 图表颜色全部用 app-v8.0.css 已定义的设计令牌，深浅主题自动跟随。
   ============================================================ */

(function (global) {
  'use strict';

  var VERSION = 'v1';

  function core() {
    return global.BTAssistantCore || null;
  }

  /* ============================================================
   * 1. 常量
   * ============================================================ */

  var KIND_META = {
    trend: { label: '趋势分析', hint: '按时间看指标怎么变化' },
    distribution: { label: '分布分析', hint: '看数据集中在哪个区间或类别' },
    ranking: { label: '排行分析', hint: '按维度排出高低顺序' },
    compare: { label: '对比分析', hint: '把两个对象放在一起比' },
    correlation: { label: '相关性分析', hint: '看两个指标是否同向变化' },
    outlier: { label: '异常识别', hint: '挑出偏离整体或越过阈值的记录' },
    profile: { label: '单管剖面', hint: '一根管子的壁厚演化过程' },
    overview: { label: '综合画像', hint: '一次看全整体情况' }
  };

  var KIND_ORDER = ['correlation', 'outlier', 'profile', 'trend', 'ranking', 'compare', 'distribution', 'overview'];

  var PALETTE = [
    'var(--accent)',
    'var(--info-violet)',
    'var(--ok)',
    'var(--warn)',
    'var(--danger)',
    'var(--text-dim)'
  ];

  var UNIT_LABEL = { '1': '1 号机组', '2': '2 号机组' };

  /* ============================================================
   * 2. 通用小工具
   * ============================================================ */

  function toArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function num(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return isFinite(value) ? value : null;
    var text = String(value).replace(/[^0-9.+-]/g, '');
    if (!text || text === '-' || text === '+' || text === '.') return null;
    var parsed = Number(text);
    return isFinite(parsed) ? parsed : null;
  }

  function esc(value) {
    var module = core();
    if (module && typeof module.escapeHtml === 'function') return module.escapeHtml(value);
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function normDate(value) {
    var module = core();
    if (module && typeof module.normalizeDateText === 'function') return module.normalizeDateText(value);
    return null;
  }

  function normCode(value) {
    var module = core();
    if (module && typeof module.normalizeCode === 'function') return module.normalizeCode(value);
    return String(value === null || value === undefined ? '' : value).trim().toUpperCase();
  }

  function sysLabelOf(sys) {
    var module = core();
    if (module && typeof module.sysLabel === 'function') return module.sysLabel(sys);
    return String(sys || '');
  }

  function intText(value) {
    var n = Math.round(Number(value) || 0);
    var module = core();
    if (module && typeof module.formatNumber === 'function') return module.formatNumber(n);
    return String(n);
  }

  function fixed(value, digits) {
    var n = num(value);
    if (n === null) return '—';
    var d = typeof digits === 'number' ? digits : 2;
    var text = n.toFixed(d);
    if (text.indexOf('.') >= 0) text = text.replace(/0+$/, '').replace(/[.]$/, '');
    return text;
  }

  function pct(value, digits) {
    var n = num(value);
    if (n === null || !isFinite(n)) return '—';
    return fixed(n * 100, typeof digits === 'number' ? digits : 1) + '%';
  }

  function sum(list) {
    var total = 0;
    for (var i = 0; i < list.length; i += 1) total += Number(list[i]) || 0;
    return total;
  }

  function mean(list) {
    return list.length ? sum(list) / list.length : null;
  }

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    var pos = (sorted.length - 1) * q;
    var lo = Math.floor(pos);
    var hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function median(list) {
    if (!list.length) return null;
    var sorted = list.slice().sort(function (a, b) { return a - b; });
    return quantile(sorted, 0.5);
  }

  function pearson(pairs) {
    var n = pairs.length;
    if (n < 3) return null;
    var sx = 0;
    var sy = 0;
    for (var i = 0; i < n; i += 1) { sx += pairs[i][0]; sy += pairs[i][1]; }
    var mx = sx / n;
    var my = sy / n;
    var sxy = 0;
    var sxx = 0;
    var syy = 0;
    for (var j = 0; j < n; j += 1) {
      var dx = pairs[j][0] - mx;
      var dy = pairs[j][1] - my;
      sxy += dx * dy;
      sxx += dx * dx;
      syy += dy * dy;
    }
    if (sxx <= 0 || syy <= 0) return null;
    return sxy / Math.sqrt(sxx * syy);
  }

  function correlationLabel(r) {
    var abs = Math.abs(r);
    var strength = abs >= 0.7 ? '强' : (abs >= 0.4 ? '中等' : (abs >= 0.2 ? '弱' : '几乎无'));
    var direction = r > 0 ? '正' : '负';
    if (abs < 0.2) return '几乎不相关';
    return strength + direction + '相关';
  }

  function niceStep(raw) {
    var value = Math.abs(Number(raw)) || 1;
    var exp = Math.pow(10, Math.floor(Math.log(value) / Math.LN10));
    var f = value / exp;
    var nice = f <= 1 ? 1 : (f <= 2 ? 2 : (f <= 5 ? 5 : 10));
    return nice * exp;
  }

  function roundTo(value, step) {
    if (!step) return value;
    return Math.round(value / step) * step;
  }

  function axisText(value) {
    var n = Number(value) || 0;
    if (Math.abs(n) >= 1000) return intText(n);
    if (Math.abs(n - Math.round(n)) < 0.001) return String(Math.round(n));
    return fixed(n, 1);
  }

  function clampInt(value, min, max) {
    var n = Math.round(Number(value));
    if (!isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  }

  /* ============================================================
   * 3. 记录标准化（把页面数据结构拍平成分析用的行）
   * ============================================================ */

  /* 从规格串里取名义壁厚：Φ63.5×7.5 / φ51*8 / 63.5x7.5 */
  function parseNominalWall(spec) {
    var text = String(spec === null || spec === undefined ? '' : spec).trim();
    if (!text) return null;
    var match = text.match(/[×xX*]\s*(\d+(?:\.\d+)?)/);
    if (match) {
      var value = Number(match[1]);
      if (isFinite(value) && value > 0 && value < 100) return value;
    }
    return null;
  }

  function splitCode(code) {
    var parts = String(code || '').split('-');
    return {
      unit: parts[0] || '',
      sys: parts[1] || '',
      zone: parts[2] || ''
    };
  }

  function monthOf(date) {
    return date ? String(date).slice(0, 7) : '';
  }

  function quarterOf(date) {
    if (!date) return '';
    var month = Number(String(date).slice(5, 7));
    if (!month) return '';
    return String(date).slice(0, 4) + 'Q' + Math.ceil(month / 3);
  }

  function yearOf(date) {
    return date ? String(date).slice(0, 4) : '';
  }

  function makeEventRow(event) {
    var item = isObject(event) ? event : {};
    var code = normCode(item.code);
    var parts = splitCode(code);
    var date = normDate(item.date);
    var thickness = num(item.thickness);
    var nominal = parseNominalWall(item.spec);
    return {
      kind: 'event',
      code: code,
      unit: parts.unit || String(item.boiler || '').trim(),
      sys: parts.sys,
      zone: parts.zone,
      date: date || '',
      year: yearOf(date),
      month: monthOf(date),
      quarter: quarterOf(date),
      type: String(item.type === null || item.type === undefined ? '' : item.type).trim(),
      thickness: thickness,
      hardness: num(item.hardness),
      nominal: nominal,
      thinning: (thickness !== null && nominal) ? (nominal - thickness) / nominal : null,
      desc: String(item.desc === null || item.desc === undefined ? '' : item.desc).trim(),
      spec: String(item.spec === null || item.spec === undefined ? '' : item.spec).trim(),
      material: String(item.material === null || item.material === undefined ? '' : item.material).trim(),
      ts: num(item.ts)
    };
  }

  function makeReplacementRow(record) {
    var item = isObject(record) ? record : {};
    var code = normCode(item.oldCode);
    var parts = splitCode(code);
    var date = normDate(item.date);
    return {
      kind: 'replacement',
      code: code,
      newCode: normCode(item.newCode),
      unit: parts.unit || String(item.boiler || '').trim(),
      sys: parts.sys,
      zone: parts.zone,
      date: date || '',
      year: yearOf(date),
      month: monthOf(date),
      quarter: quarterOf(date),
      type: '更换',
      thickness: null,
      hardness: null,
      nominal: null,
      thinning: null,
      reason: String(item.reason === null || item.reason === undefined ? '' : item.reason).trim(),
      desc: String(item.reason === null || item.reason === undefined ? '' : item.reason).trim(),
      ts: num(item.ts)
    };
  }

  function matchFilters(row, filters) {
    var f = isObject(filters) ? filters : {};
    if (f.code && String(row.code).indexOf(f.code) < 0 && String(row.newCode || '').indexOf(f.code) < 0) return false;
    if (f.unit && String(row.unit) !== String(f.unit)) return false;
    if (f.sys) {
      var sysList = Array.isArray(f.sys) ? f.sys : [f.sys];
      if (sysList.indexOf(row.sys) < 0) return false;
    }
    if (f.zone && String(row.zone) !== String(f.zone)) return false;
    if (f.type && String(row.type).indexOf(f.type) < 0) return false;
    if (f.keyword) {
      var hay = [row.desc, row.spec, row.material, row.type, row.code, row.reason].join(' ').toLowerCase();
      if (hay.indexOf(String(f.keyword).toLowerCase()) < 0) return false;
    }
    if (f.dateFrom && row.date && row.date < f.dateFrom) return false;
    if (f.dateTo && row.date && row.date > f.dateTo) return false;
    if (f.minThickness !== undefined && row.thickness !== null && row.thickness <= f.minThickness) return false;
    if (f.maxThickness !== undefined && row.thickness !== null && row.thickness >= f.maxThickness) return false;
    return true;
  }

  function collectRows(snapshot, spec) {
    var snap = isObject(snapshot) ? snapshot : {};
    var dataset = spec && spec.dataset === 'replacements' ? 'replacements' : 'events';
    var source = dataset === 'replacements' ? toArray(snap.replacements) : toArray(snap.events);
    var rows = [];
    for (var i = 0; i < source.length; i += 1) {
      var row = dataset === 'replacements' ? makeReplacementRow(source[i]) : makeEventRow(source[i]);
      if (!row.code && row.kind === 'event') continue;
      if (matchFilters(row, spec && spec.filters)) rows.push(row);
    }
    return rows;
  }

  /* ============================================================
   * 4. 分组与聚合
   * ============================================================ */

  function groupRows(rows, keyFn) {
    var order = [];
    var map = {};
    for (var i = 0; i < rows.length; i += 1) {
      var key = keyFn(rows[i]);
      if (key === null || key === undefined || key === '') continue;
      if (!map[key]) { map[key] = []; order.push(key); }
      map[key].push(rows[i]);
    }
    order.sort();
    return { keys: order, map: map };
  }

  function numbersOf(rows, field) {
    var list = [];
    for (var i = 0; i < rows.length; i += 1) {
      var value = rows[i][field];
      if (typeof value === 'number' && isFinite(value)) list.push(value);
    }
    return list;
  }

  function dimensionKeyOf(row, dimension) {
    if (dimension === 'year') return row.year || '';
    if (dimension === 'quarter') return row.quarter || '';
    if (dimension === 'month') return row.month || '';
    if (dimension === 'unit') return row.unit || '';
    if (dimension === 'sys') return row.sys || '';
    if (dimension === 'zone') return row.zone || '';
    if (dimension === 'type') return row.type || '';
    if (dimension === 'code') return row.code || '';
    return row.month || '';
  }

  function dimensionLabelOf(key, dimension) {
    if (dimension === 'unit') return UNIT_LABEL[key] || (key ? key + ' 号机组' : '未知机组');
    if (dimension === 'sys') return sysLabelOf(key) || key || '未知受热面';
    if (dimension === 'type') return key || '未填写类型';
    if (dimension === 'zone') {
      var module = core();
      return module && typeof module.zoneLabel === 'function' ? module.zoneLabel(key) : key;
    }
    return key;
  }

  /* ============================================================
   * 5. 图表规格 → SVG（纯字符串，无 DOM）
   * ============================================================ */

  function emptyChartSvg(options) {
    var opts = isObject(options) ? options : {};
    var width = num(opts.width) || 460;
    var height = num(opts.height) || 200;
    return [
      '<svg class="assistant-chart-svg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + esc(opts.label || '图表') + '" preserveAspectRatio="none">',
      '  <text x="' + (width / 2) + '" y="' + (height / 2) + '" text-anchor="middle" fill="var(--text-ghost)" font-size="12">' + esc(opts.text || '暂无可绘制的数据') + '</text>',
      '</svg>'
    ].join('\n');
  }

  function chartSvg(chart, options) {
    var c = isObject(chart) ? chart : {};
    var opts = isObject(options) ? options : {};
    var width = num(opts.width) || 460;
    var height = num(opts.height) || 210;
    var type = c.type || 'bar';
    var categories = toArray(c.categories).map(function (item) { return String(item); });
    var series = toArray(c.series).filter(isObject).map(function (item) {
      return { name: String(item.name || ''), values: toArray(item.values).map(function (v) { return num(v); }) };
    });
    var points = toArray(c.points).filter(isObject);

    var label = c.ariaLabel || c.title || '数据分析图表';
    var svgHead = '<svg class="assistant-chart-svg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + esc(label) + '" preserveAspectRatio="xMidYMid meet">';

    if (type === 'donut') {
      if (!categories.length || !series.length) return emptyChartSvg({ width: width, height: height, text: opts.emptyText, label: label });
      return renderDonut(svgHead, categories, series[0], width, height);
    }
    if (type === 'hbar') {
      if (!categories.length || !series.length) return emptyChartSvg({ width: width, height: height, text: opts.emptyText, label: label });
      return renderHBar(svgHead, categories, series[0], width, height);
    }
    if (type === 'scatter') {
      if (!points.length) return emptyChartSvg({ width: width, height: height, text: opts.emptyText, label: label });
      return renderScatter(svgHead, points, c, width, height);
    }
    if (!categories.length || !series.length) return emptyChartSvg({ width: width, height: height, text: opts.emptyText, label: label });
    if (type === 'line') return renderLine(svgHead, categories, series, c, width, height);
    return renderBar(svgHead, categories, series, c, width, height);
  }

  function plotFrame(width, height, padL, padR, padT, padB) {
    return {
      left: padL,
      right: width - padR,
      top: padT,
      bottom: height - padB,
      w: width - padL - padR,
      h: height - padT - padB
    };
  }

  function maxOfSeries(series) {
    var max = 0;
    for (var s = 0; s < series.length; s += 1) {
      for (var i = 0; i < series[s].values.length; i += 1) {
        var v = series[s].values[i];
        if (typeof v === 'number' && isFinite(v) && v > max) max = v;
      }
    }
    return max;
  }

  function minOfSeries(series) {
    var min = Infinity;
    for (var s = 0; s < series.length; s += 1) {
      for (var i = 0; i < series[s].values.length; i += 1) {
        var v = series[s].values[i];
        if (typeof v === 'number' && isFinite(v) && v < min) min = v;
      }
    }
    return isFinite(min) ? min : 0;
  }

  /* 折线图按数据量级取轴域（不从 0 起算），否则 7.4→6.9 这种趋势会被压成一条平线 */
  function lineAxisRange(series, chart) {
    var max = maxOfSeries(series);
    var min = minOfSeries(series);
    var threshold = chart && chart.threshold ? num(chart.threshold.value) : null;
    if (threshold !== null && threshold < min) min = threshold;
    if (max <= 0 && min <= 0) return { min: 0, max: 1 };
    var span = max - min;
    if (span <= 0) span = Math.abs(max) * 0.1 || 1;
    var low = min - span * 0.18;
    if (low < 0) low = 0;
    var high = max + span * 0.18;
    if (chart && chart.scale === 'zero') low = 0;
    return { min: low, max: high };
  }

  function buildYAxis(frame, maxValue, minValue) {
    var max = maxValue > 0 ? maxValue : 1;
    var min = typeof minValue === 'number' && isFinite(minValue) ? minValue : 0;
    if (min >= max) min = Math.max(0, max - Math.abs(max) * 0.2 || 1);
    var ticks = [];
    var count = 4;
    for (var i = 0; i <= count; i += 1) {
      var value = min + (max - min) * (i / count);
      ticks.push({ value: value, y: frame.bottom - frame.h * (i / count) });
    }
    return { max: max, min: min, ticks: ticks };
  }

  function axisScale(axis, frame) {
    var span = axis.max - axis.min || 1;
    return function (value) {
      return frame.bottom - frame.h * ((value - axis.min) / span);
    };
  }

  function yAxisMarkup(frame, axis, unitText) {
    var lines = [];
    for (var i = 0; i < axis.ticks.length; i += 1) {
      var tick = axis.ticks[i];
      lines.push('  <line x1="' + frame.left + '" y1="' + fixed(tick.y, 1) + '" x2="' + frame.right + '" y2="' + fixed(tick.y, 1) +
        '" stroke="var(--line-subtle)" stroke-width="1" stroke-dasharray="2 4" />');
      lines.push('  <text x="' + (frame.left - 8) + '" y="' + fixed(tick.y + 3.5, 1) + '" text-anchor="end" fill="var(--text-faint)" font-size="10">' +
        esc(axisText(tick.value)) + '</text>');
    }
    if (unitText) {
      lines.push('  <text x="' + frame.right + '" y="' + (frame.top - 8) + '" text-anchor="end" fill="var(--text-faint)" font-size="10">' + esc(unitText) + '</text>');
    }
    return lines;
  }

  function xLabelsMarkup(frame, categories, y) {
    if (!categories.length) return [];
    var step = Math.max(1, Math.ceil(categories.length / 6));
    var lines = [];
    for (var i = 0; i < categories.length; i += 1) {
      if (i % step !== 0 && i !== categories.length - 1) continue;
      var x = frame.left + (categories.length === 1 ? frame.w / 2 : (frame.w * i) / (categories.length - 1));
      lines.push('  <text x="' + fixed(x, 1) + '" y="' + y + '" text-anchor="middle" fill="var(--text-faint)" font-size="10">' + esc(categories[i]) + '</text>');
    }
    return lines;
  }

  function legendMarkup(series, width, y) {
    if (series.length < 2) return [];
    var lines = [];
    var x = 12;
    for (var i = 0; i < series.length && i < 4; i += 1) {
      var color = PALETTE[i % PALETTE.length];
      lines.push('  <rect x="' + x + '" y="' + (y - 8) + '" width="8" height="8" rx="2" fill="' + color + '" />');
      lines.push('  <text x="' + (x + 12) + '" y="' + y + '" fill="var(--text-dim)" font-size="10">' + esc(series[i].name) + '</text>');
      x += 16 + String(series[i].name).length * 10 + 14;
    }
    return lines;
  }

  function renderLine(head, categories, series, chart, width, height) {
    var frame = plotFrame(width, height, 46, 16, 22, 28);
    var range = lineAxisRange(series, chart);
    var axis = buildYAxis(frame, range.max, range.min);
    var scaleY = axisScale(axis, frame);
    var lines = [head, '  <g class="assistant-chart-grid">'];
    lines = lines.concat(yAxisMarkup(frame, axis, chart.yLabel || ''));
    lines.push('  </g>');
    lines = lines.concat(legendMarkup(series, width, 12));
    for (var s = 0; s < series.length; s += 1) {
      var color = PALETTE[s % PALETTE.length];
      var coords = [];
      for (var i = 0; i < categories.length; i += 1) {
        var value = series[s].values[i];
        if (typeof value !== 'number') continue;
        var x = frame.left + (categories.length === 1 ? frame.w / 2 : (frame.w * i) / (categories.length - 1));
        coords.push({ x: x, y: scaleY(value), v: value });
      }
      if (!coords.length) continue;
      var path = coords.map(function (point, index) {
        return (index ? 'L' : 'M') + fixed(point.x, 1) + ' ' + fixed(point.y, 1);
      }).join(' ');
      lines.push('  <path d="' + path + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />');
      for (var k = 0; k < coords.length; k += 1) {
        lines.push('  <circle cx="' + fixed(coords[k].x, 1) + '" cy="' + fixed(coords[k].y, 1) + '" r="3" fill="' + color + '" stroke="var(--surface-sunken)" stroke-width="1" />');
      }
    }
    if (chart.threshold && typeof num(chart.threshold.value) === 'number') {
      var thresholdValue = num(chart.threshold.value);
      if (thresholdValue >= axis.min && thresholdValue <= axis.max) {
        var ty = scaleY(thresholdValue);
        lines.push('  <line x1="' + frame.left + '" y1="' + fixed(ty, 1) + '" x2="' + frame.right + '" y2="' + fixed(ty, 1) + '" stroke="var(--danger)" stroke-width="1.5" stroke-dasharray="6 4" />');
        lines.push('  <text x="' + frame.right + '" y="' + fixed(ty - 5, 1) + '" text-anchor="end" fill="var(--danger)" font-size="10">' + esc(chart.threshold.label || '阈值') + '</text>');
      }
    }
    lines = lines.concat(xLabelsMarkup(frame, categories, frame.bottom + 16));
    lines.push('  <line x1="' + frame.left + '" y1="' + frame.bottom + '" x2="' + frame.right + '" y2="' + frame.bottom + '" stroke="var(--line)" stroke-width="1" />');
    lines.push('</svg>');
    return lines.join('\n');
  }

  function renderBar(head, categories, series, chart, width, height) {
    var frame = plotFrame(width, height, 46, 16, 22, 30);
    var axis = buildYAxis(frame, maxOfSeries(series) * 1.08, 0);
    var lines = [head, '  <g class="assistant-chart-grid">'];
    lines = lines.concat(yAxisMarkup(frame, axis, chart.yLabel || ''));
    lines.push('  </g>');
    lines = lines.concat(legendMarkup(series, width, 12));
    var groups = categories.length;
    var band = frame.w / Math.max(1, groups);
    var barW = Math.max(2, Math.min(28, (band * 0.62) / series.length));
    for (var s = 0; s < series.length; s += 1) {
      var color = PALETTE[s % PALETTE.length];
      for (var i = 0; i < groups; i += 1) {
        var value = series[s].values[i];
        if (typeof value !== 'number' || value <= 0) continue;
        var h = (frame.h * Math.min(value, axis.max)) / axis.max;
        var groupCenter = frame.left + band * (i + 0.5);
        var x = groupCenter - (barW * series.length) / 2 + barW * s;
        lines.push('  <rect x="' + fixed(x, 1) + '" y="' + fixed(frame.bottom - h, 1) + '" width="' + fixed(barW - 1, 1) + '" height="' + fixed(h, 1) +
          '" rx="2" fill="' + color + '" opacity="0.92" />');
      }
    }
    var step = Math.max(1, Math.ceil(groups / 7));
    for (var g = 0; g < groups; g += 1) {
      if (g % step !== 0 && g !== groups - 1) continue;
      lines.push('  <text x="' + fixed(frame.left + band * (g + 0.5), 1) + '" y="' + (frame.bottom + 16) +
        '" text-anchor="middle" fill="var(--text-faint)" font-size="10">' + esc(categories[g]) + '</text>');
    }
    lines.push('  <line x1="' + frame.left + '" y1="' + frame.bottom + '" x2="' + frame.right + '" y2="' + frame.bottom + '" stroke="var(--line)" stroke-width="1" />');
    lines.push('</svg>');
    return lines.join('\n');
  }

  function renderHBar(head, categories, series, width, height) {
    var rows = categories.length;
    var top = 14;
    var rowH = Math.max(16, Math.min(30, (height - top - 10) / Math.max(1, rows)));
    var labelW = Math.min(112, width * 0.28);
    var barLeft = labelW + 8;
    var barMax = width - barLeft - 52;
    var max = Math.max(1, maxOfSeries([series]));
    var lines = [head];
    for (var i = 0; i < rows; i += 1) {
      var value = num(series.values[i]) || 0;
      var y = top + rowH * i;
      var barH = Math.max(6, rowH - 8);
      var len = Math.max(value > 0 ? 3 : 0, (barMax * value) / max);
      lines.push('  <text x="' + (labelW - 6) + '" y="' + fixed(y + barH - 2, 1) + '" text-anchor="end" fill="var(--text-dim)" font-size="10.5">' + esc(categories[i]) + '</text>');
      lines.push('  <rect x="' + barLeft + '" y="' + fixed(y, 1) + '" width="' + fixed(barMax, 1) + '" height="' + fixed(barH, 1) + '" rx="3" fill="var(--surface-sunken)" />');
      if (value > 0) {
        lines.push('  <rect x="' + barLeft + '" y="' + fixed(y, 1) + '" width="' + fixed(len, 1) + '" height="' + fixed(barH, 1) +
          '" rx="3" fill="' + PALETTE[0] + '" opacity="0.92" />');
      }
      lines.push('  <text x="' + fixed(barLeft + barMax + 6, 1) + '" y="' + fixed(y + barH - 2, 1) + '" fill="var(--text-dim)" font-size="10.5">' + esc(axisText(value)) + '</text>');
    }
    lines.push('</svg>');
    return lines.join('\n');
  }

  function renderDonut(head, categories, series, width, height) {
    var values = toArray(series.values).map(function (v) { return Math.max(0, num(v) || 0); });
    var total = sum(values);
    var cx = Math.min(112, width * 0.26);
    var cy = height / 2;
    var r = Math.min(64, height * 0.32);
    var stroke = Math.max(14, r * 0.42);
    var circumference = 2 * Math.PI * r;
    var lines = [head];
    lines.push('  <circle cx="' + cx + '" cy="' + cy + '" r="' + fixed(r, 1) + '" fill="none" stroke="var(--surface-sunken)" stroke-width="' + fixed(stroke, 1) + '" />');
    if (total > 0) {
      var offset = 0;
      for (var i = 0; i < values.length; i += 1) {
        if (!values[i]) continue;
        var len = (circumference * values[i]) / total;
        lines.push('  <circle cx="' + cx + '" cy="' + cy + '" r="' + fixed(r, 1) + '" fill="none" stroke="' + PALETTE[i % PALETTE.length] +
          '" stroke-width="' + fixed(stroke, 1) + '" stroke-dasharray="' + fixed(Math.max(0, len - 1.5), 1) + ' ' + fixed(circumference, 1) +
          '" stroke-dashoffset="' + fixed(-offset, 1) + '" transform="rotate(-90 ' + cx + ' ' + cy + ')" stroke-linecap="butt" />');
        offset += len;
      }
    }
    lines.push('  <text x="' + cx + '" y="' + fixed(cy - 2, 1) + '" text-anchor="middle" fill="var(--text-hi)" font-size="16" font-weight="700">' + esc(intText(total)) + '</text>');
    lines.push('  <text x="' + cx + '" y="' + fixed(cy + 14, 1) + '" text-anchor="middle" fill="var(--text-faint)" font-size="9.5">合计</text>');
    var legendX = cx + r + 28;
    var maxItems = Math.max(1, Math.floor((height - 16) / 18));
    for (var j = 0; j < categories.length && j < maxItems; j += 1) {
      var y = 18 + j * 18;
      var share = total > 0 ? values[j] / total : 0;
      lines.push('  <rect x="' + fixed(legendX, 1) + '" y="' + (y - 7) + '" width="8" height="8" rx="2" fill="' + PALETTE[j % PALETTE.length] + '" />');
      lines.push('  <text x="' + fixed(legendX + 13, 1) + '" y="' + y + '" fill="var(--text-dim)" font-size="10.5">' +
        esc(categories[j]) + ' · ' + esc(intText(values[j])) + '（' + esc(pct(share, 0)) + '）</text>');
    }
    lines.push('</svg>');
    return lines.join('\n');
  }

  function renderScatter(head, points, chart, width, height) {
    var frame = plotFrame(width, height, 46, 18, 22, 30);
    var xs = [];
    var ys = [];
    for (var i = 0; i < points.length; i += 1) {
      var px = num(points[i].x);
      var py = num(points[i].y);
      if (px === null || py === null) continue;
      xs.push(px);
      ys.push(py);
    }
    if (!xs.length) return emptyChartSvg({ width: width, height: height, text: '暂无可配对的数值' });
    var minX = Math.min.apply(null, xs);
    var maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys);
    var maxY = Math.max.apply(null, ys);
    if (maxX === minX) { maxX = minX + 1; minY = minY - 1; }
    if (maxY === minY) maxY = minY + 1;
    var spanX = maxX - minX;
    var spanY = maxY - minY;
    var padX = spanX * 0.08;
    var padY = spanY * 0.1;
    minX -= padX; maxX += padX; minY -= padY; maxY += padY;

    var lines = [head];
    for (var t = 0; t <= 4; t += 1) {
      var yv = minY + ((maxY - minY) * t) / 4;
      var yy = frame.bottom - (frame.h * t) / 4;
      lines.push('  <line x1="' + frame.left + '" y1="' + fixed(yy, 1) + '" x2="' + frame.right + '" y2="' + fixed(yy, 1) + '" stroke="var(--line-subtle)" stroke-width="1" stroke-dasharray="2 4" />');
      lines.push('  <text x="' + (frame.left - 8) + '" y="' + fixed(yy + 3.5, 1) + '" text-anchor="end" fill="var(--text-faint)" font-size="10">' + esc(axisText(yv)) + '</text>');
    }
    for (var k = 0; k < points.length; k += 1) {
      var pxx = num(points[k].x);
      var pyy = num(points[k].y);
      if (pxx === null || pyy === null) continue;
      var cx = frame.left + frame.w * ((pxx - minX) / (maxX - minX));
      var cy = frame.bottom - frame.h * ((pyy - minY) / (maxY - minY));
      lines.push('  <circle cx="' + fixed(cx, 1) + '" cy="' + fixed(cy, 1) + '" r="3.2" fill="var(--accent)" opacity="0.72" />');
    }
    if (chart.threshold && typeof num(chart.threshold.value) === 'number') {
      var tv = num(chart.threshold.value);
      if (tv >= minY && tv <= maxY) {
        var tyy = frame.bottom - frame.h * ((tv - minY) / (maxY - minY));
        lines.push('  <line x1="' + frame.left + '" y1="' + fixed(tyy, 1) + '" x2="' + frame.right + '" y2="' + fixed(tyy, 1) + '" stroke="var(--danger)" stroke-width="1.5" stroke-dasharray="6 4" />');
        lines.push('  <text x="' + frame.right + '" y="' + fixed(tyy - 5, 1) + '" text-anchor="end" fill="var(--danger)" font-size="10">' + esc(chart.threshold.label || '阈值') + '</text>');
      }
    }
    lines.push('  <text x="' + frame.left + '" y="' + (height - 8) + '" fill="var(--text-faint)" font-size="10">' + esc(chart.xLabel || '') + '</text>');
    lines.push('  <text x="' + (frame.left) + '" y="' + (frame.top - 6) + '" fill="var(--text-faint)" font-size="10">' + esc(chart.yLabel || '') + '</text>');
    lines.push('  <line x1="' + frame.left + '" y1="' + frame.bottom + '" x2="' + frame.right + '" y2="' + frame.bottom + '" stroke="var(--line)" stroke-width="1" />');
    lines.push('</svg>');
    return lines.join('\n');
  }

  /* ============================================================
   * 6. 各分析类型的计算
   * ============================================================ */

  function detailTable(rows, limit) {
    var cap = limit || 200;
    var list = rows.slice(0, cap).map(function (row) {
      return {
        '日期': row.date || '—',
        '炉号': row.unit || '—',
        '管段编码': row.code || '—',
        '事件类型': row.type || '—',
        '厚度(mm)': row.thickness === null ? '—' : fixed(row.thickness, 2),
        '硬度(HB)': row.hardness === null ? '—' : fixed(row.hardness, 0),
        '详细描述/结论': row.desc || ''
      };
    });
    return {
      columns: ['日期', '炉号', '管段编码', '事件类型', '厚度(mm)', '硬度(HB)', '详细描述/结论'],
      rows: list
    };
  }

  function metricTone(value, warnAt) {
    if (typeof warnAt === 'number' && value >= warnAt) return 'warn';
    return '';
  }

  function analyzeTrend(rows, spec, snapshot) {
    var dimension = spec.dimension === 'year' || spec.dimension === 'quarter' ? spec.dimension : 'month';
    var isCount = spec.metric === 'count' || spec.metric === 'replacements';
    var field = spec.metric === 'hardness' ? 'hardness' : 'thickness';
    var grouped = groupRows(rows, function (row) { return dimensionKeyOf(row, dimension); });
    var categories = [];
    var avgValues = [];
    var minValues = [];
    var counts = [];
    for (var i = 0; i < grouped.keys.length; i += 1) {
      var bucket = grouped.map[grouped.keys[i]];
      var values = numbersOf(bucket, field);
      categories.push(grouped.keys[i]);
      counts.push(bucket.length);
      avgValues.push(values.length ? mean(values) : null);
      minValues.push(values.length ? Math.min.apply(null, values) : null);
    }
    var metricLabel = spec.metric === 'hardness' ? '平均硬度' : '平均壁厚';
    var unitText = spec.metric === 'hardness' ? 'HB' : 'mm';
    var series = [];
    if (isCount) {
      series.push({ name: spec.dataset === 'replacements' ? '更换记录数' : '事件数', values: counts });
    } else {
      series.push({ name: metricLabel, values: avgValues });
      if (spec.metric === 'thickness') series.push({ name: '最低壁厚', values: minValues });
    }
    var chart = {
      type: 'line',
      categories: categories,
      series: series,
      scale: isCount ? 'zero' : 'auto',
      xLabel: dimension === 'year' ? '年份' : (dimension === 'quarter' ? '季度' : '月份'),
      yLabel: isCount ? '条' : unitText,
      ariaLabel: (isCount ? '记录数' : metricLabel) + '按' + (dimension === 'year' ? '年' : '月') + '变化趋势'
    };

    var insights = [];
    if (isCount) {
      if (categories.length) {
        var peakIndex = 0;
        for (var p = 1; p < counts.length; p += 1) if (counts[p] > counts[peakIndex]) peakIndex = p;
        insights.push('共 ' + intText(rows.length) + ' 条记录，覆盖 ' + categories[0] + ' ~ ' + categories[categories.length - 1] +
          '；峰值在 ' + categories[peakIndex] + '（' + counts[peakIndex] + ' 条）。');
        var gaps = 0;
        for (var g = 0; g < counts.length; g += 1) if (!counts[g]) gaps += 1;
        if (gaps) insights.push('有 ' + gaps + ' 个时间段没有任何记录，可能是检修空档，也可能是漏录，建议核对台账。');
        if (counts.length >= 2) {
          var last = counts[counts.length - 1];
          var prev = counts[counts.length - 2];
          if (prev > 0) {
            var delta = (last - prev) / prev;
            insights.push('最新一期 ' + categories[categories.length - 1] + ' 为 ' + last + ' 条，环比前一期的 ' + prev + ' 条' +
              (delta === 0 ? '持平' : (delta > 0 ? '上升 ' : '下降 ') + pct(Math.abs(delta), 0)) + '。');
          }
        }
      }
    } else {
      var validAvg = avgValues.filter(function (v) { return typeof v === 'number'; });
      if (validAvg.length) {
        var first = validAvg[0];
        var lastV = validAvg[validAvg.length - 1];
        var change = lastV - first;
        insights.push('平均' + (spec.metric === 'hardness' ? '硬度' : '壁厚') + '从 ' + fixed(first, 2) + unitText + ' 变为 ' +
          fixed(lastV, 2) + unitText + '，累计' + (change >= 0 ? '上升 ' : '下降 ') + fixed(Math.abs(change), 2) + unitText +
          (first ? '（' + pct(change / Math.abs(first), 1) + '）' : '') + '。');
        var globalMin = Math.min.apply(null, validAvg);
        insights.push('各期均值最低为 ' + fixed(globalMin, 2) + unitText + '，出现在 ' +
          categories[avgValues.indexOf(globalMin)] + '。');
        var lowCount = 0;
        for (var q = 0; q < rows.length; q += 1) {
          if (rows[q].thinning !== null && rows[q].thinning >= 0.2) lowCount += 1;
        }
        if (lowCount) insights.push('有 ' + lowCount + ' 条记录实测壁厚已低于名义壁厚的 80%，建议列入测点复测计划。');
      } else {
        insights.push('这批记录里没有可用的' + (spec.metric === 'hardness' ? '硬度' : '壁厚') + '数值，无法计算趋势。');
      }
    }
    if (rows.length && categories.length < 2) insights.push('只有 1 个时间段有数据，趋势判断意义有限；建议补充历史数据后再看走势。');

    var metrics = [
      { label: '记录数', value: intText(rows.length) },
      { label: '时间段', value: String(categories.length) }
    ];
    if (!isCount) {
      var allValues = numbersOf(rows, field);
      metrics.push({ label: '均值', value: allValues.length ? fixed(mean(allValues), 2) + unitText : '—' });
      metrics.push({ label: '最低', value: allValues.length ? fixed(Math.min.apply(null, allValues), 2) + unitText : '—', tone: 'warn' });
    } else if (categories.length) {
      metrics.push({ label: '峰值期', value: categories[counts.indexOf(Math.max.apply(null, counts))] });
      metrics.push({ label: '峰值条数', value: intText(Math.max.apply(null, counts)) });
    }

    return {
      chart: chart,
      metrics: metrics,
      insights: insights,
      table: {
        columns: [(dimension === 'year' ? '年份' : (dimension === 'quarter' ? '季度' : '月份'))].concat(
          isCount ? ['记录数'] : [metricLabel, '最低值', '样本数']),
        rows: categories.map(function (key, index) {
          var item = {};
          item[dimension === 'year' ? '年份' : (dimension === 'quarter' ? '季度' : '月份')] = key;
          if (isCount) item['记录数'] = counts[index];
          else {
            item[metricLabel] = avgValues[index] === null ? '' : fixed(avgValues[index], 2);
            item['最低值'] = minValues[index] === null ? '' : fixed(minValues[index], 2);
            item['样本数'] = counts[index];
          }
          return item;
        })
      },
      sampleSize: rows.length
    };
  }

  function analyzeDistribution(rows, spec) {
    var dimension = spec.dimension;
    var metric = spec.metric;
    var categories = [];
    var values = [];
    var chartType = 'bar';
    var title = '事件类型分布';
    var tableColumns = [];
    var tableRows = [];

    if (dimension === 'sys' || dimension === 'unit' || dimension === 'type' || dimension === 'zone') {
      var grouped = groupRows(rows, function (row) { return dimensionKeyOf(row, dimension); });
      for (var i = 0; i < grouped.keys.length; i += 1) {
        categories.push(dimensionLabelOf(grouped.keys[i], dimension));
        values.push(grouped.map[grouped.keys[i]].length);
      }
      chartType = 'donut';
      title = (dimension === 'sys' ? '受热面' : (dimension === 'unit' ? '机组' : (dimension === 'zone' ? '部位' : '事件类型'))) + '分布';
      tableColumns = [dimension === 'sys' ? '受热面' : (dimension === 'unit' ? '机组' : (dimension === 'zone' ? '部位' : '事件类型')), '记录数', '占比'];
      var total = sum(values);
      tableRows = categories.map(function (label, index) {
        var item = {};
        item[tableColumns[0]] = label;
        item['记录数'] = values[index];
        item['占比'] = pct(total ? values[index] / total : 0, 1);
        return item;
      });
    } else {
      var field = metric === 'hardness' ? 'hardness' : 'thickness';
      var all = numbersOf(rows, field);
      var unitText = field === 'hardness' ? 'HB' : 'mm';
      if (!all.length) {
        return { empty: true, message: '这批记录里没有可用的' + (field === 'hardness' ? '硬度' : '壁厚') + '数值，无法做分布分析。' };
      }
      var step = niceStep((Math.max.apply(null, all) - Math.min.apply(null, all)) / 6) || (field === 'hardness' ? 10 : 0.5);
      if (step <= 0) step = field === 'hardness' ? 10 : 0.5;
      var start = Math.floor(Math.min.apply(null, all) / step) * step;
      var bins = [];
      var counts = [];
      for (var b = 0; b < 14; b += 1) {
        var from = roundTo(start + step * b, step);
        bins.push(from);
        counts.push(0);
      }
      for (var k = 0; k < all.length; k += 1) {
        var index = Math.floor((all[k] - start) / step + 1e-9);
        if (index < 0) index = 0;
        if (index >= counts.length) index = counts.length - 1;
        counts[index] += 1;
      }
      var modeIndex = 0;
      for (var m = 1; m < counts.length; m += 1) if (counts[m] > counts[modeIndex]) modeIndex = m;
      categories = bins.map(function (from, index) {
        return fixed(from, 1) + '~' + fixed(from + step, 1);
      });
      values = counts;
      chartType = 'bar';
      title = (field === 'hardness' ? '硬度' : '壁厚') + '分布（区间 ' + fixed(step, 1) + unitText + '）';
      tableColumns = [(field === 'hardness' ? '硬度' : '壁厚') + '区间(' + unitText + ')', '记录数', '占比'];
      var totalAll = sum(counts);
      tableRows = categories.map(function (label, index) {
        var item = {};
        item[tableColumns[0]] = label;
        item['记录数'] = counts[index];
        item['占比'] = pct(totalAll ? counts[index] / totalAll : 0, 1);
        return item;
      });
      var meanValue = mean(all);
      var medianValue = median(all);
      var insights = [
        '共 ' + intText(all.length) + ' 条可用' + (field === 'hardness' ? '硬度' : '壁厚') + '数值，均值 ' + fixed(meanValue, 2) + unitText +
          '、中位数 ' + fixed(medianValue, 2) + unitText + '。',
        '最集中区间是 ' + categories[modeIndex] + '，' + counts[modeIndex] + ' 条，占 ' + pct(totalAll ? counts[modeIndex] / totalAll : 0, 1) + '。'
      ];
      var skew = (meanValue && medianValue !== null) ? (meanValue - medianValue) : 0;
      if (Math.abs(skew) > step * 0.35) {
        insights.push('均值与中位数相差 ' + fixed(Math.abs(skew), 2) + unitText + '，分布' +
          (skew > 0 ? '右偏（有少量高值拉高均值）' : '左偏（有少量低值拉低均值）') + '，建议单独核查尾部记录。');
      }
      if (Math.max.apply(null, all) / Math.min.apply(null, all) > 1.6) {
        insights.push('最大值与最小值相差较大（' + fixed(Math.min.apply(null, all), 2) + ' ~ ' + fixed(Math.max.apply(null, all), 2) + unitText +
          '），存在明显分组特征，可按受热面或机组拆分再看。');
      }
      return {
        chart: { type: chartType, categories: categories, series: [{ name: '记录数', values: values }], xLabel: '区间(' + unitText + ')', yLabel: '条', ariaLabel: title },
        metrics: [
          { label: '样本数', value: intText(all.length) },
          { label: '均值', value: fixed(meanValue, 2) + unitText },
          { label: '中位数', value: fixed(medianValue, 2) + unitText },
          { label: '集中区间', value: categories[modeIndex] }
        ],
        insights: insights,
        table: { columns: tableColumns, rows: tableRows },
        sampleSize: all.length,
        title: title
      };
    }

    var all2 = sum(values);
    var modeIdx = 0;
    for (var n = 1; n < values.length; n += 1) if (values[n] > values[modeIdx]) modeIdx = n;
    var topShare = all2 ? values[modeIdx] / all2 : 0;
    return {
      chart: { type: chartType, categories: categories, series: [{ name: '记录数', values: values }], ariaLabel: title },
      metrics: [
        { label: '记录数', value: intText(rows.length) },
        { label: '类别数', value: String(categories.length) },
        { label: '最多类别', value: categories[modeIdx] || '—' },
        { label: '占比', value: pct(topShare, 1), tone: topShare >= 0.5 ? 'warn' : '' }
      ],
      insights: [
        '「' + (categories[modeIdx] || '—') + '」记录最多（' + intText(values[modeIdx] || 0) + ' 条，占 ' + pct(topShare, 1) + '）。',
        categories.length > 3
          ? '共 ' + categories.length + ' 个类别，前 3 类合计占 ' + pct(all2 ? (values.slice().sort(function (a, b) { return b - a; }).slice(0, 3).reduce(function (a, b) { return a + b; }, 0) / all2) : 0, 1) + '。'
          : '类别数较少（' + categories.length + ' 类），分布判断仅供参考。',
        topShare >= 0.5 ? '单一类别占比过半，建议核对是否存在重复录入或导入偏移。' : '分布相对分散，符合多点位检测的常见形态。'
      ],
      table: { columns: tableColumns, rows: tableRows },
      sampleSize: rows.length,
      title: title
    };
  }

  function analyzeRanking(rows, spec) {
    var dimension = spec.dimension === 'unit' || spec.dimension === 'type' || spec.dimension === 'code' ? spec.dimension : 'sys';
    var ascending = spec.order === 'asc';
    var grouped = groupRows(rows, function (row) { return dimensionKeyOf(row, dimension); });
    var items = [];
    for (var i = 0; i < grouped.keys.length; i += 1) {
      var bucket = grouped.map[grouped.keys[i]];
      var value = bucket.length;
      if (spec.metric === 'thickness') {
        var thicknessValues = numbersOf(bucket, 'thickness');
        if (!thicknessValues.length) continue;
        value = ascending ? Math.min.apply(null, thicknessValues) : mean(thicknessValues);
      } else if (spec.metric === 'hardness') {
        var hardnessValues = numbersOf(bucket, 'hardness');
        if (!hardnessValues.length) continue;
        value = ascending ? Math.min.apply(null, hardnessValues) : mean(hardnessValues);
      }
      items.push({
        key: grouped.keys[i],
        label: dimensionLabelOf(grouped.keys[i], dimension),
        value: value,
        count: bucket.length
      });
    }
    items.sort(function (a, b) {
      return ascending ? a.value - b.value : b.value - a.value;
    });
    var limit = clampInt(spec.limit || 8, 3, 20);
    var top = items.slice(0, limit);
    var isCount = spec.metric !== 'thickness' && spec.metric !== 'hardness';
    var unitText = isCount ? '条' : (spec.metric === 'hardness' ? 'HB' : 'mm');
    var digits = isCount ? 0 : 2;
    var metricName = isCount ? '记录数' : (spec.metric === 'hardness' ? '平均硬度(HB)' : (ascending ? '最低壁厚(mm)' : '平均壁厚(mm)'));
    var dimColumn = dimension === 'sys' ? '受热面' : (dimension === 'unit' ? '机组' : (dimension === 'code' ? '管段编码' : '事件类型'));

    var totalValue = sum(items.map(function (item) { return item.value; }));
    var top3 = sum(top.slice(0, 3).map(function (item) { return item.value; }));
    var title = (dimension === 'sys' ? '受热面' : (dimension === 'unit' ? '机组' : (dimension === 'code' ? '管段' : '类型'))) +
      (isCount ? '记录数排行' : (ascending ? '壁厚最低排行' : '指标排行'));

    var insights = top.length ? [
      '第 1 名是「' + top[0].label + '」，' + metricName + ' ' + fixed(top[0].value, digits) + unitText +
        (isCount ? '，占全部记录的 ' + pct(totalValue ? top[0].value / totalValue : 0, 1) : '') + '。'
    ] : ['当前筛选条件下没有可排行的数据。'];
    if (top.length && isCount) {
      insights.push('前 3 名合计占 ' + pct(totalValue ? top3 / totalValue : 0, 1) + '，集中度' +
        (top3 / (totalValue || 1) >= 0.6 ? '偏高，建议优先安排检修资源' : '适中') + '。');
      insights.push('记录数多不等于缺陷多，也可能只是测点更密；需要结合壁厚/更换情况一起看。');
    } else if (top.length) {
      insights.push('该排行按' + metricName + '排序，共 ' + items.length + ' 个' + dimColumn + '参与比较。');
      insights.push('排行按当前筛选范围计算，可用「1 号炉」「水冷壁」等条件收窄后再看。');
    }

    return {
      chart: {
        type: 'hbar',
        categories: top.map(function (item) { return item.label; }),
        series: [{ name: metricName, values: top.map(function (item) { return item.value; }) }],
        ariaLabel: title + '（前 ' + top.length + ' 名）'
      },
      metrics: [
        { label: '参与统计', value: String(items.length) },
        { label: '第一名', value: top.length ? String(top[0].label).replace(/（[^）]*）/g, '') : '—', tone: 'accent' },
        { label: '第一值', value: top.length ? fixed(top[0].value, digits) + unitText : '—' },
        { label: isCount ? '前 3 占比' : '有效记录', value: isCount ? (totalValue ? pct(top3 / totalValue, 1) : '—') : intText(rows.length) }
      ],
      insights: insights,
      table: {
        columns: isCount ? ['排名', dimColumn, '记录数'] : ['排名', dimColumn, metricName, '记录数'],
        rows: top.map(function (item, index) {
          var row = {};
          row['排名'] = index + 1;
          row[dimColumn] = item.label;
          row[metricName] = fixed(item.value, digits);
          if (!isCount) row['记录数'] = item.count;
          return row;
        })
      },
      sampleSize: rows.length,
      title: title
    };
  }

  function analyzeCompare(rows, spec, snapshot) {
    var dimension = spec.dimension === 'sys' ? 'sys' : (spec.dimension === 'year' ? 'year' : 'unit');
    var grouped = groupRows(rows, function (row) { return dimensionKeyOf(row, dimension); });
    var labels = [];
    var counts = [];
    var means = [];
    var unitText = spec.metric === 'thickness' ? 'mm' : (spec.metric === 'hardness' ? 'HB' : '条');
    for (var i = 0; i < grouped.keys.length; i += 1) {
      var bucket = grouped.map[grouped.keys[i]];
      labels.push(dimensionLabelOf(grouped.keys[i], dimension));
      counts.push(bucket.length);
      means.push(mean(numbersOf(bucket, spec.metric === 'hardness' ? 'hardness' : 'thickness')));
    }
    var isMetric = spec.metric === 'thickness' || spec.metric === 'hardness';
    var values = isMetric ? means.map(function (v) { return v === null ? 0 : v; }) : counts;
    var title = (dimension === 'unit' ? '机组' : (dimension === 'sys' ? '受热面' : '年度')) + '对比（' +
      (isMetric ? (spec.metric === 'hardness' ? '平均硬度' : '平均壁厚') : '记录数') + '）';

    var insights = [];
    if (labels.length >= 2) {
      var bestIndex = 0;
      for (var b = 1; b < values.length; b += 1) if (values[b] > values[bestIndex]) bestIndex = b;
      var lowIndex = 0;
      for (var l = 1; l < values.length; l += 1) if (values[l] < values[lowIndex] && values[l] > 0) lowIndex = l;
      if (isMetric) {
        var diff = values[bestIndex] - values[lowIndex];
        if (Math.abs(diff) < 1e-9 || bestIndex === lowIndex) {
          insights.push('各组' + (spec.metric === 'hardness' ? '平均硬度' : '平均壁厚') + '基本一致（' +
            fixed(values[bestIndex], 2) + unitText + '），当前筛选范围内没有明显差异。');
        } else {
          insights.push('最高是「' + labels[bestIndex] + '」（' + fixed(values[bestIndex], 2) + unitText + '），最低是「' +
            labels[lowIndex] + '」（' + fixed(values[lowIndex], 2) + unitText + '），相差 ' + fixed(diff, 2) + unitText +
            (values[lowIndex] ? '（' + pct(diff / values[lowIndex], 1) + '）' : '') + '。');
          if (dimension === 'unit' && labels.length === 2) {
            insights.push('两台机组壁厚差异达到 ' + pct(Math.abs(diff) / Math.max(values[0] || 1, values[1] || 1), 1) +
              '，建议核对煤质、负荷与检修记录是否也有对应差异。');
          }
        }
      } else {
        if (bestIndex === lowIndex) {
          insights.push('各组记录数一致（各 ' + intText(values[0]) + ' 条），样本分布比较均衡。');
        } else {
          insights.push('「' + labels[bestIndex] + '」记录最多（' + intText(values[bestIndex]) + ' 条），「' + labels[lowIndex] +
            '」最少（' + intText(values[lowIndex]) + ' 条）。');
          if (labels.length === 2 && values[0] && values[1]) {
            insights.push('两者数量比为 ' + fixed(values[0] / values[1], 2) + ' : 1，数量差异可能来自测点密度不同，不直接等于缺陷率差异。');
          }
        }
      }
    } else {
      insights.push('当前筛选范围内只有 1 组数据，无法做对比；可去掉机组或受热面条件后重试。');
    }

    var dimColumn = dimension === 'unit' ? '机组' : (dimension === 'sys' ? '受热面' : '年份');
    var valueColumn = isMetric ? (spec.metric === 'hardness' ? '平均硬度(HB)' : '平均壁厚(mm)') : '';
    var tableColumns = valueColumn ? [dimColumn, '记录数', valueColumn] : [dimColumn, '记录数'];
    return {
      chart: { type: 'bar', categories: labels, series: [{ name: isMetric ? '均值' : '记录数', values: values }], yLabel: isMetric ? unitText : '条', ariaLabel: title },
      metrics: labels.map(function (label, index) {
        return { label: label, value: isMetric ? fixed(values[index], 2) + unitText : intText(values[index]) };
      }).slice(0, 4),
      insights: insights,
      table: {
        columns: tableColumns,
        rows: labels.map(function (label, index) {
          var row = {};
          row[dimColumn] = label;
          row['记录数'] = counts[index];
          if (valueColumn) row[valueColumn] = means[index] === null ? '' : fixed(means[index], 2);
          return row;
        })
      },
      sampleSize: rows.length,
      title: title
    };
  }

  function analyzeCorrelation(rows) {
    var pairs = [];
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].thickness !== null && rows[i].hardness !== null) pairs.push([rows[i].thickness, rows[i].hardness]);
    }
    if (pairs.length < 3) {
      return { empty: true, message: '同时有壁厚和硬度的记录只有 ' + pairs.length + ' 条，至少需要 3 条才能算相关性。' };
    }
    var r = pearson(pairs);
    var title = '壁厚与硬度相关性';
    var insights = [];
    if (r === null) {
      insights.push('数值没有变化（方差为 0），无法计算相关系数。');
    } else {
      insights.push('样本 ' + pairs.length + ' 对，皮尔逊相关系数 r = ' + fixed(r, 3) + '，属于' + correlationLabel(r) + '。');
      insights.push('|r| ' + fixed(Math.abs(r), 2) + ' 表示两者线性关联' + (Math.abs(r) >= 0.4 ? '较明显' : '偏弱') +
        '；相关不等于因果，还需结合材质、温度与运行工况判断。');
      if (r < -0.3) insights.push('呈负相关：壁厚越薄硬度偏低，可能是长期高温服役后的组织劣化信号，建议对低壁厚点补做金相。');
      if (r > 0.3) insights.push('呈正相关：壁厚较薄处硬度反而偏高，需留意表面硬化或测量位置差异。');
    }
    return {
      chart: {
        type: 'scatter',
        points: pairs.map(function (pair) { return { x: pair[0], y: pair[1] }; }),
        xLabel: '壁厚(mm)',
        yLabel: '硬度(HB)',
        ariaLabel: '壁厚与硬度散点图'
      },
      metrics: [
        { label: '样本对', value: intText(pairs.length) },
        { label: '相关系数 r', value: r === null ? '—' : fixed(r, 3) },
        { label: '相关强度', value: r === null ? '—' : correlationLabel(r) }
      ],
      insights: insights,
      table: detailTable(rows.filter(function (row) { return row.thickness !== null && row.hardness !== null; }), 200),
      sampleSize: pairs.length,
      title: title
    };
  }

  function analyzeOutlier(rows, spec) {
    var withThickness = rows.filter(function (row) { return row.thickness !== null; });
    if (withThickness.length < 3) {
      return { empty: true, message: '有壁厚数值的记录不足 3 条，无法识别异常。' };
    }
    var values = withThickness.map(function (row) { return row.thickness; }).sort(function (a, b) { return a - b; });
    var q1 = quantile(values, 0.25);
    var q3 = quantile(values, 0.75);
    var iqr = q3 - q1;
    var lower = q1 - 1.5 * iqr;
    var flagged = [];
    var lowRatio = 0;
    for (var i = 0; i < withThickness.length; i += 1) {
      var row = withThickness[i];
      var reasons = [];
      if (row.thickness < lower) reasons.push('低于整体下界 ' + fixed(lower, 2) + 'mm');
      if (row.thinning !== null && row.thinning >= 0.2) {
        reasons.push('减薄率 ' + pct(row.thinning, 1) + '（名义 ' + fixed(row.nominal, 2) + 'mm）');
        lowRatio += 1;
      }
      if (reasons.length) {
        flagged.push({ row: row, reasons: reasons });
      }
    }
    flagged.sort(function (a, b) {
      var av = a.row.thinning === null ? a.row.thickness : a.row.thinning;
      var bv = b.row.thinning === null ? b.row.thickness : b.row.thinning;
      return (b.row.thinning || 0) - (a.row.thinning || 0) || a.row.thickness - b.row.thickness;
    });
    var title = '壁厚异常识别';
    var chart = {
      type: 'scatter',
      points: withThickness.map(function (row, index) { return { x: index + 1, y: row.thickness }; }),
      yLabel: '壁厚(mm)',
      xLabel: '记录序号',
      threshold: { value: lower, label: 'IQR 下界 ' + fixed(lower, 2) },
      ariaLabel: '壁厚分布与异常下界'
    };
    var insights = [
      '壁厚整体 Q1=' + fixed(q1, 2) + 'mm、Q3=' + fixed(q3, 2) + 'mm，IQR 下界 ' + fixed(lower, 2) + 'mm；共检出 ' +
        flagged.length + ' 条异常记录（占 ' + pct(flagged.length / withThickness.length, 1) + '）。'
    ];
    if (lowRatio) insights.push('其中 ' + lowRatio + ' 条实测壁厚低于名义壁厚的 80%，属于需要优先复测/评估的对象。');
    if (flagged.length) {
      var worst = flagged[0].row;
      insights.push('最严重：' + worst.code + '（' + (worst.date || '日期缺失') + '）实测 ' + fixed(worst.thickness, 2) +
        'mm' + (worst.nominal ? '，名义 ' + fixed(worst.nominal, 2) + 'mm，减薄 ' + pct(worst.thinning, 1) : '') + '。');
    } else {
      insights.push('未发现越过 IQR 下界或减薄率 20% 的记录，壁厚分布相对均匀。');
    }
    return {
      chart: chart,
      metrics: [
        { label: '样本数', value: intText(withThickness.length) },
        { label: '异常记录', value: intText(flagged.length), tone: flagged.length ? 'warn' : 'ok' },
        { label: '名义壁厚缺失', value: intText(withThickness.filter(function (row) { return !row.nominal; }).length) },
        { label: '下界', value: fixed(lower, 2) + 'mm' }
      ],
      insights: insights,
      table: {
        columns: ['日期', '炉号', '管段编码', '厚度(mm)', '名义壁厚(mm)', '减薄率', '异常原因'],
        rows: flagged.slice(0, 100).map(function (item) {
          return {
            '日期': item.row.date || '—',
            '炉号': item.row.unit || '—',
            '管段编码': item.row.code,
            '厚度(mm)': fixed(item.row.thickness, 2),
            '名义壁厚(mm)': item.row.nominal ? fixed(item.row.nominal, 2) : '—',
            '减薄率': item.row.thinning === null ? '—' : pct(item.row.thinning, 1),
            '异常原因': item.reasons.join('；')
          };
        })
      },
      sampleSize: withThickness.length,
      title: title
    };
  }

  function analyzeProfile(rows, spec) {
    var code = spec.filters && spec.filters.code ? spec.filters.code : '';
    var targetRows = rows;
    if (code) {
      targetRows = rows.filter(function (row) { return String(row.code).indexOf(code) >= 0; });
    }
    var withThickness = targetRows.filter(function (row) { return row.thickness !== null && row.date; });
    if (!withThickness.length) {
      return { empty: true, message: '没有找到带日期和壁厚的记录，无法画单管剖面。可以先用「受热面记录数排行」定位可疑管段。' };
    }
    withThickness.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
    var targetCode = code || withThickness[0].code;
    var seriesRows = withThickness.filter(function (row) { return row.code === targetCode || String(row.code).indexOf(targetCode) === 0; });
    if (!seriesRows.length) seriesRows = withThickness;
    var nominal = null;
    for (var i = seriesRows.length - 1; i >= 0; i -= 1) {
      if (seriesRows[i].nominal) { nominal = seriesRows[i].nominal; break; }
    }
    var values = seriesRows.map(function (row) { return row.thickness; });
    var first = values[0];
    var last = values[values.length - 1];
    var years = 1;
    if (seriesRows.length > 1) {
      var d1 = new Date(seriesRows[0].date).getTime();
      var d2 = new Date(seriesRows[seriesRows.length - 1].date).getTime();
      if (isFinite(d1) && isFinite(d2) && d2 > d1) years = (d2 - d1) / (365.25 * 86400000);
    }
    var rate = years > 0 ? (first - last) / years : 0;
    var title = '管段剖面 · ' + targetCode;
    var threshold = nominal ? nominal * 0.8 : null;
    var insights = [
      '该管段共 ' + seriesRows.length + ' 次测厚记录，时间跨度 ' + seriesRows[0].date + ' ~ ' + seriesRows[seriesRows.length - 1].date + '。',
      '壁厚从 ' + fixed(first, 2) + 'mm 变为 ' + fixed(last, 2) + 'mm，累计' + (last >= first ? '增加 ' : '减少 ') +
        fixed(Math.abs(first - last), 2) + 'mm' + (years > 0
          ? (last >= first ? '，年均增厚约 ' : '，年均减薄约 ') + fixed(Math.abs(rate), 3) + 'mm/年'
          : '') + '。'
    ];
    if (nominal) {
      insights.push('名义壁厚 ' + fixed(nominal, 2) + 'mm，当前减薄率 ' + pct((nominal - last) / nominal, 1) +
        (last < threshold ? '，已低于 80% 阈值，建议安排复测或换管评估。' : '，仍在 80% 阈值之上。'));
    } else {
      insights.push('该管段没有可解析的名义壁厚（规格列未填写「Φ×壁厚」格式），无法计算减薄率，建议补全规格。');
    }
    return {
      chart: {
        type: 'line',
        categories: seriesRows.map(function (row) { return row.date; }),
        series: [{ name: '实测壁厚', values: values }],
        scale: 'auto',
        yLabel: 'mm',
        threshold: nominal ? { value: threshold, label: '80% 名义壁厚' } : null,
        ariaLabel: targetCode + ' 壁厚随时间变化'
      },
      metrics: [
        { label: '测厚次数', value: intText(seriesRows.length) },
        { label: '首次', value: fixed(first, 2) + 'mm' },
        { label: '最近', value: fixed(last, 2) + 'mm', tone: nominal && last < threshold ? 'warn' : '' },
        { label: last >= first ? '年均增厚' : '年均减薄', value: years > 0 ? fixed(Math.abs(rate), 3) + 'mm' : '—' }
      ],
      insights: insights,
      table: detailTable(seriesRows, 200),
      sampleSize: seriesRows.length,
      title: title
    };
  }

  function analyzeOverview(rows, spec, snapshot) {
    var snap = isObject(snapshot) ? snapshot : {};
    var events = toArray(snap.events).length;
    var replacements = toArray(snap.replacements).length;
    var warnings = toArray(snap.warnings).length;
    var overdue = toArray(snap.overdueRows).length;
    var codeSet = {};
    var typeCount = {};
    var thicknessValues = [];
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].code) codeSet[rows[i].code] = true;
      var type = rows[i].type || '未填写类型';
      typeCount[type] = (typeCount[type] || 0) + 1;
      if (rows[i].thickness !== null) thicknessValues.push(rows[i].thickness);
    }
    var types = Object.keys(typeCount).sort(function (a, b) { return typeCount[b] - typeCount[a]; });
    var avgThickness = thicknessValues.length ? mean(thicknessValues) : null;
    var lowCount = rows.filter(function (row) { return row.thinning !== null && row.thinning >= 0.2; }).length;
    var insights = [
      '当前 ' + intText(events) + ' 条寿命事件、' + intText(replacements) + ' 条更换记录，涉及 ' + Object.keys(codeSet).length + ' 个管段编码。',
      types.length ? '事件类型以「' + types[0] + '」为主（' + typeCount[types[0]] + ' 条，占 ' + pct(rows.length ? typeCount[types[0]] / rows.length : 0, 1) + '）。' : '暂无可统计的事件类型。',
      avgThickness !== null ? '平均壁厚 ' + fixed(avgThickness, 2) + 'mm，其中 ' + lowCount + ' 条记录减薄率已达 20% 以上。' : '暂无可用的壁厚数值。'
    ];
    if (overdue) insights.push('另有 ' + overdue + ' 条超期未检记录需要安排检修计划。');
    if (warnings) insights.push('看板累计 ' + warnings + ' 条预警，可到「预警中心」逐条闭环。');
    return {
      chart: {
        type: 'donut',
        categories: types.slice(0, 6),
        series: [{ name: '事件数', values: types.slice(0, 6).map(function (type) { return typeCount[type]; }) }],
        ariaLabel: '事件类型构成'
      },
      metrics: [
        { label: '寿命事件', value: intText(events) },
        { label: '涉及管段', value: intText(Object.keys(codeSet).length) },
        { label: '更换记录', value: intText(replacements) },
        { label: '平均壁厚', value: avgThickness === null ? '—' : fixed(avgThickness, 2) + 'mm' },
        { label: '超期未检', value: intText(overdue), tone: overdue ? 'danger' : '' },
        { label: '预警条数', value: intText(warnings), tone: warnings ? 'warn' : '' }
      ],
      insights: insights,
      table: {
        columns: ['事件类型', '记录数', '占比'],
        rows: types.map(function (type) {
          return { '事件类型': type, '记录数': typeCount[type], '占比': pct(rows.length ? typeCount[type] / rows.length : 0, 1) };
        })
      },
      sampleSize: rows.length,
      title: '数据综合画像'
    };
  }

  /* ============================================================
   * 7. 对外：runAnalysis
   * ============================================================ */

  function runAnalysis(spec, snapshot) {
    try {
      var s = isObject(spec) ? spec : {};
      var rows = collectRows(snapshot, s);
      if (!rows.length) {
        return {
          ok: false,
          kind: s.kind || 'overview',
          title: (KIND_META[s.kind] || KIND_META.overview).label,
          message: '当前筛选条件下没有可分析的数据。可以去掉机组/受热面条件，或先在「数据录入」页导入记录。'
        };
      }
      var partial = null;
      if (s.kind === 'trend') partial = analyzeTrend(rows, s, snapshot);
      else if (s.kind === 'ranking') partial = analyzeRanking(rows, s);
      else if (s.kind === 'compare') partial = analyzeCompare(rows, s, snapshot);
      else if (s.kind === 'correlation') partial = analyzeCorrelation(rows);
      else if (s.kind === 'outlier') partial = analyzeOutlier(rows, s);
      else if (s.kind === 'profile') partial = analyzeProfile(rows, s);
      else if (s.kind === 'distribution') partial = analyzeDistribution(rows, s);
      else partial = analyzeOverview(rows, s, snapshot);

      if (!partial || partial.empty) {
        return {
          ok: false,
          kind: s.kind || 'overview',
          title: (KIND_META[s.kind] || KIND_META.overview).label,
          message: (partial && partial.message) || '数据不足，暂时算不出结果。'
        };
      }
      var meta = KIND_META[s.kind] || KIND_META.overview;
      return {
        ok: true,
        kind: s.kind || 'overview',
        kindLabel: meta.label,
        title: partial.title || s.title || meta.label,
        description: s.description || '',
        metrics: toArray(partial.metrics),
        insights: toArray(partial.insights),
        chart: partial.chart || null,
        table: partial.table || { columns: [], rows: [] },
        sampleSize: partial.sampleSize || rows.length,
        spec: s
      };
    } catch (err) {
      return {
        ok: false,
        kind: (spec && spec.kind) || 'overview',
        title: '分析失败',
        message: '分析过程出现异常：' + ((err && err.message) || '未知错误')
      };
    }
  }

  /* ============================================================
   * 8. 对外：parseAnalysis
   * ============================================================ */

  var KIND_PATTERNS = [
    { kind: 'correlation', weight: 6, re: /相关性|相关系数|散点|线性关系|线性相关|是否相关|关系如何|有没有关系/ },
    { kind: 'correlation', weight: 4, re: /相关|关系/ },
    { kind: 'outlier', weight: 6, re: /异常值|离群|偏离|超标|减薄严重|壁厚不足|最危险|风险最高|异常记录|异常点/ },
    { kind: 'outlier', weight: 3, re: /异常|可疑/ },
    { kind: 'profile', weight: 6, re: /剖面|变化曲线|历史曲线|单管|这根管|该管段|生命周期曲线|测厚历程/ },
    { kind: 'trend', weight: 6, re: /趋势|走势|逐月|逐年|按月|按年|季度变化|年度变化|变化情况|演变|增长|下降趋势/ },
    { kind: 'trend', weight: 4, re: /变化|波动|同比|环比/ },
    { kind: 'ranking', weight: 6, re: /排行|排名|top\s*\d*|前\s*\d+\s*名|前\s*\d+\s*个|最多|最高|最低|最薄|最厚|倒序|排序/ },
    { kind: 'compare', weight: 6, re: /对比|比较|相比|差异|差距|vs|哪个.*(?:多|高|低|薄|厚)/ },
    { kind: 'distribution', weight: 6, re: /分布|直方图|区间|集中在|占比|构成|比例|结构/ },
    { kind: 'distribution', weight: 4, re: /各类型|按类型|按系统|按机组|按受热面/ },
    { kind: 'overview', weight: 5, re: /画像|整体分析|综合分析|全面分析|体检|概览分析|数据总览/ },
    { kind: 'overview', weight: 3, re: /分析|看一下|帮我看看/ }
  ];

  var CHART_HINT = [
    { re: /折线|曲线|line/i, type: 'line' },
    { re: /柱状|条形|bar/i, type: 'bar' },
    { re: /横向|排行条|hbar/i, type: 'hbar' },
    { re: /饼图|环形|环图|donut|占比图/i, type: 'donut' },
    { re: /散点|scatter/i, type: 'scatter' },
    { re: /直方图|histogram/i, type: 'bar' }
  ];

  function detectKind(rawText) {
    var text = normalizeLoose(rawText);
    var scores = {};
    for (var i = 0; i < KIND_PATTERNS.length; i += 1) {
      var rule = KIND_PATTERNS[i];
      if (rule.re.test(text)) scores[rule.kind] = (scores[rule.kind] || 0) + rule.weight;
    }
    var best = null;
    var bestScore = 0;
    for (var k = 0; k < KIND_ORDER.length; k += 1) {
      var kind = KIND_ORDER[k];
      var score = scores[kind] || 0;
      if (score > bestScore) { best = kind; bestScore = score; }
    }
    return best && bestScore >= 3 ? best : null;
  }

  function normalizeLoose(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/[\uFF01-\uFF5E]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
      .replace(/\u3000/g, ' ')
      .replace(/\s+/g, '')
      .toLowerCase();
  }

  function detectMetric(text) {
    if (/硬度|hb|布氏/.test(text)) return 'hardness';
    if (/壁厚|厚度|减薄|测厚/.test(text)) return 'thickness';
    if (/更换|换管|报废/.test(text)) return 'replacements';
    return 'count';
  }

  function detectDimension(text, kind, metric) {
    if (kind === 'trend' || kind === 'profile') {
      if (/按年|逐年|每年|年度|跨年/.test(text)) return 'year';
      if (/按季|季度/.test(text)) return 'quarter';
      return 'month';
    }
    if (/按年|逐年|每年|年度/.test(text)) return 'year';
    if (/按季|季度/.test(text)) return 'quarter';
    if (/按月|逐月|每月/.test(text)) return 'month';
    if (kind === 'distribution') {
      if (/机组|炉号|1号炉|2号炉/.test(text)) return 'unit';
      if (/受热面|系统|部件|水冷壁|过热器|再热器|省煤器|高过|高再|低过|低再|屏过|包墙|顶棚/.test(text)) return 'sys';
      if (/类型|测厚记录|金相|无损/.test(text)) return 'type';
      if (/部位|前墙|后墙|左墙|右墙|入口|出口/.test(text)) return 'zone';
      return metric === 'thickness' || metric === 'hardness' ? 'thicknessBin' : 'type';
    }
    if (kind === 'ranking') {
      if (/机组|炉号/.test(text)) return 'unit';
      if (/类型|测厚|金相|无损/.test(text)) return 'type';
      if (/管段|管码|管子/.test(text)) return 'code';
      return 'sys';
    }
    if (kind === 'compare') {
      if (/受热面|系统|水冷壁|过热器|再热器|省煤器|高过|高再/.test(text)) return 'sys';
      if (/去年|今年|年度|年份/.test(text)) return 'year';
      return 'unit';
    }
    return 'month';
  }

  function detectChartHint(text, kind) {
    for (var i = 0; i < CHART_HINT.length; i += 1) {
      if (CHART_HINT[i].re.test(text)) return CHART_HINT[i].type;
    }
    if (kind === 'trend' || kind === 'profile') return 'line';
    if (kind === 'ranking') return 'hbar';
    if (kind === 'distribution') return 'donut';
    if (kind === 'correlation' || kind === 'outlier') return 'scatter';
    return 'bar';
  }

  function detectLimit(text) {
    var match = text.match(/前\s*(\d+)|top\s*(\d+)/i);
    if (match) {
      var value = Number(match[1] || match[2]);
      if (value > 0) return clampInt(value, 3, 20);
    }
    return 8;
  }

  function buildTitle(spec) {
    var kind = spec.kind;
    var metricText = spec.metric === 'thickness' ? '壁厚' : (spec.metric === 'hardness' ? '硬度' : (spec.metric === 'replacements' ? '更换' : '记录数'));
    var dimText = spec.dimension === 'year' ? '年度' : (spec.dimension === 'quarter' ? '季度' : (spec.dimension === 'month' ? '月度' : ''));
    var scope = '';
    if (spec.filters && spec.filters.unit) scope = spec.filters.unit + ' 号机组 · ';
    if (spec.filters && spec.filters.sys) scope = scope + sysLabelOf(spec.filters.sys) + ' · ';
    if (kind === 'trend') return scope + metricText + dimText + '趋势';
    if (kind === 'distribution') return scope + (spec.dimension === 'thicknessBin' || spec.dimension === 'hardnessBin' ? metricText + '分布' : '构成分布');
    if (kind === 'ranking') return scope + metricText + '排行';
    if (kind === 'compare') return scope + '对比分析';
    if (kind === 'correlation') return scope + '壁厚与硬度相关性';
    if (kind === 'outlier') return scope + '壁厚异常识别';
    if (kind === 'profile') return scope + '单管剖面';
    return scope + '综合画像';
  }

  function parseAnalysis(message, context) {
    try {
      var raw = message === null || message === undefined ? '' : String(message).trim();
      if (!raw) return null;
      var text = normalizeLoose(raw);
      var kind = detectKind(raw);
      if (!kind) return null;

      var module = core();
      var query = module && typeof module.parseQuery === 'function'
        ? module.parseQuery(raw, context || {})
        : { dataset: 'unknown', filters: {}, description: '' };
      var filters = isObject(query.filters) ? query.filters : {};
      var metric = detectMetric(text);
      var dataset = 'events';
      if (metric === 'replacements' || query.dataset === 'replacements' || /更换记录|换管记录|报废记录/.test(text)) dataset = 'replacements';
      var dimension = detectDimension(text, kind, metric);
      var chartType = detectChartHint(raw, kind);
      var spec = {
        kind: kind,
        metric: metric,
        dimension: dimension,
        dataset: dataset,
        filters: filters,
        limit: detectLimit(raw),
        chartType: chartType,
        order: /最薄|最低|最小|倒序|从低到高|升序/.test(text) ? 'asc' : 'desc',
        description: query.description || '',
        confidence: 0.86
      };
      if (kind === 'distribution' && (metric === 'thickness' || metric === 'hardness')) {
        spec.dimension = metric === 'hardness' ? 'hardnessBin' : 'thicknessBin';
      }
      /* 按机组做对比/排行/分布时，机组条件必须放开，否则只会剩下一台机组 */
      if ((kind === 'compare' || kind === 'ranking' || kind === 'distribution') && spec.dimension === 'unit') {
        delete spec.filters.unit;
      }
      spec.title = buildTitle(spec);
      return spec;
    } catch (err) {
      return null;
    }
  }

  function describeSpec(spec) {
    if (!isObject(spec)) return '';
    var meta = KIND_META[spec.kind] || KIND_META.overview;
    var metricText = spec.metric === 'thickness' ? '壁厚' : (spec.metric === 'hardness' ? '硬度' : (spec.metric === 'replacements' ? '更换次数' : '记录数'));
    var dimText = {
      month: '按月', quarter: '按季度', year: '按年度', unit: '按机组', sys: '按受热面',
      zone: '按部位', type: '按事件类型', code: '按管段', thicknessBin: '按壁厚区间', hardnessBin: '按硬度区间'
    }[spec.dimension] || '';
    var scope = spec.filters && (spec.filters.unit || spec.filters.sys)
      ? '（' + [spec.filters.unit ? spec.filters.unit + ' 号机组' : '', spec.filters.sys ? sysLabelOf(spec.filters.sys) : ''].filter(Boolean).join('、') + '）'
      : '';
    if (spec.kind === 'overview') return '做一次综合画像' + scope;
    if (spec.kind === 'correlation') return '看壁厚与硬度的相关性' + scope;
    if (spec.kind === 'outlier') return '识别壁厚异常记录' + scope;
    if (spec.kind === 'profile') return '看单根管段的壁厚演化' + scope;
    return meta.label + '：' + dimText + metricText + scope;
  }

  /* ============================================================
   * 9. 大模型参与分析（可选）：证据包 / 提示词 / 结果校验
   * ------------------------------------------------------------
   * 安全边界：
   * 1. 只发送「聚合后的指标与序列」，绝不发送原始数据行；
   * 2. 模型返回的每条结论必须引用证据包里的数字，否则被过滤（防编造）；
   * 3. 模型只能建议分析口径（kind/metric/dimension/chartType），
   *    真正的计算仍由本地 runAnalysis 完成，模型无法直接改数据。
   * ============================================================ */

  var ALLOWED_METRICS = ['count', 'thickness', 'hardness', 'replacements'];
  var ALLOWED_DIMENSIONS = ['month', 'quarter', 'year', 'unit', 'sys', 'zone', 'type', 'code', 'thicknessBin', 'hardnessBin'];
  var ALLOWED_CHART_TYPES = ['line', 'bar', 'hbar', 'donut', 'scatter'];
  var MAX_EVIDENCE_POINTS = 24;
  var MAX_MODEL_INSIGHTS = 5;

  /* 把管码、证件号、手机号、邮箱从要外发的文本里抹掉 */
  function maskPii(value) {
    var text = String(value === null || value === undefined ? '' : value);
    text = text.replace(/[12]-[A-Z]{2,3}-[A-Z]{1,3}-\d{3}-\d{4}-[A-Z0-9]{3}(?:-R\d+)?/g, '[管码]');
    text = text.replace(/[0-9]{18}/g, '[证件号]');
    text = text.replace(/[0-9]{11}/g, '[手机号]');
    text = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}/g, '[邮箱]');
    return text;
  }

  function round2(value) {
    var n = num(value);
    if (n === null) return null;
    return Math.round(n * 100) / 100;
  }

  function subsample(list, max) {
    var arr = Array.isArray(list) ? list : [];
    if (arr.length <= max) return arr.slice();
    var step = (arr.length - 1) / (max - 1);
    var out = [];
    for (var i = 0; i < max; i += 1) out.push(arr[Math.round(i * step)]);
    return out;
  }

  /* 结论里出现的数字必须能在「指标 / 序列 / 规则基线」里找到，否则视为编造 */
  function collectEvidenceNumbers(payload, baseInsights) {
    var set = {};
    function addValue(value) {
      var n = num(value);
      if (n === null) return;
      [0, 1, 2].forEach(function (d) { set[n.toFixed(d)] = true; });
      set[String(Math.round(n))] = true;
      if (Math.abs(n) > 0 && Math.abs(n) < 1) {
        [0, 1].forEach(function (d) { set[(n * 100).toFixed(d)] = true; });
      }
    }
    toArray(payload.metrics).forEach(function (metric) { addValue(metric && metric.value); });
    toArray(payload.series).forEach(function (item) {
      toArray(item && item.values).forEach(addValue);
    });
    toArray(baseInsights).forEach(function (line) {
      String(line).replace(/-?\d+(?:\.\d+)?/g, function (token) { addValue(token); return token; });
    });
    addValue(payload.sampleSize);
    return set;
  }

  /* 证据包：只含聚合结果，不含任何原始行 */
  function buildEvidence(question, spec, result) {
    var payload = {
      question: maskPii(question).slice(0, 200),
      rule: {
        kind: spec.kind,
        metric: spec.metric,
        dimension: spec.dimension,
        chartType: spec.chartType,
        title: maskPii(spec.title)
      },
      scope: {
        unit: spec.filters && spec.filters.unit ? String(spec.filters.unit) : '',
        sys: spec.filters && spec.filters.sys ? maskPii(sysLabelOf(spec.filters.sys)) : '',
        dateFrom: (spec.filters && spec.filters.dateFrom) || '',
        dateTo: (spec.filters && spec.filters.dateTo) || '',
        sampleSize: result.sampleSize || 0
      },
      sampleSize: result.sampleSize || 0,
      metrics: toArray(result.metrics).slice(0, 8).map(function (metric) {
        return { label: maskPii(metric.label), value: maskPii(metric.value) };
      }),
      insights: toArray(result.insights).slice(0, 5).map(function (line) { return maskPii(line); }),
      series: [],
      allowed: {
        kinds: KIND_ORDER.slice(),
        metrics: ALLOWED_METRICS.slice(),
        dimensions: ALLOWED_DIMENSIONS.slice(),
        chartTypes: ALLOWED_CHART_TYPES.slice()
      }
    };
    var chart = result.chart;
    if (chart) {
      if (toArray(chart.points).length) {
        payload.points = toArray(chart.points).slice(0, 60).map(function (point) {
          return { x: round2(point.x), y: round2(point.y) };
        });
        payload.series.push({ name: maskPii(chart.yLabel || '指标'), values: payload.points.map(function (p) { return p.y; }) });
      } else if (toArray(chart.categories).length) {
        var categories = subsample(chart.categories, MAX_EVIDENCE_POINTS).map(function (item) { return maskPii(item); });
        payload.series = toArray(chart.series).slice(0, 3).map(function (item) {
          return {
            name: maskPii(item.name),
            values: subsample(toArray(item.values), MAX_EVIDENCE_POINTS).map(round2)
          };
        });
        payload.categories = categories;
      }
    }
    return { payload: payload, numbers: collectEvidenceNumbers(payload, result.insights) };
  }

  function buildAnalysisMessages(evidence) {
    var payload = evidence && evidence.payload ? evidence.payload : evidence;
    var system = [
      '你是锅炉炉管寿命与壁厚分析的诊断助手，服务对象是电厂金属监督工程师。',
      '只输出严格 JSON，不要 Markdown 代码块，不要任何解释性文字。',
      '输出结构：{"spec":{"kind":"...","metric":"...","dimension":"...","chartType":"..."},"title":"...","insights":["..."],"risk":"high|medium|low","advice":"..."}',
      '硬性规则：',
      '1) 只能使用用户消息 JSON 中出现的数字，严禁编造或外推任何数值；每条 insights 至少包含一个该 JSON 里出现过的数字。',
      '2) insights 给 3~5 条，中文，每条 20~60 字，必须说清「哪个对象、变化多少、影响什么」，不要写「建议持续关注」这类空话。',
      '3) 不要输出管段编码、人名或文件路径，用「该管段」「高壁厚组」等描述代替。',
      '4) 若规则引擎给出的 kind 已经合适，spec 可省略；只有确实更合适时才改口径，且取值必须来自 allowed 列表。',
      '5) risk 只在确有风险时给 high/medium，正常给 low；advice 一句话，可执行。',
      '6) 无法从数据得出结论时，insights 返回空数组，不要猜测。'
    ].join('');
    return [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(payload) }
    ];
  }

  function stripCodeFence(raw) {
    var text = String(raw === null || raw === undefined ? '' : raw).trim();
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();
    return text;
  }

  function isGrounded(line, numbers) {
    var hits = 0;
    String(line).replace(/-?\d+(?:\.\d+)?/g, function (token) {
      var n = num(token);
      if (n === null) return token;
      if (numbers[n.toFixed(0)] || numbers[n.toFixed(1)] || numbers[n.toFixed(2)] ||
        numbers[String(Math.round(n))] || numbers[(n * 100).toFixed(0)] || numbers[(n * 100).toFixed(1)]) hits += 1;
      return token;
    });
    return hits > 0;
  }

  function sanitizeSpecPatch(patch) {
    if (!isObject(patch)) return null;
    var out = {};
    if (KIND_META[patch.kind]) out.kind = patch.kind;
    if (ALLOWED_METRICS.indexOf(patch.metric) >= 0) out.metric = patch.metric;
    if (ALLOWED_DIMENSIONS.indexOf(patch.dimension) >= 0) out.dimension = patch.dimension;
    if (ALLOWED_CHART_TYPES.indexOf(patch.chartType) >= 0) out.chartType = patch.chartType;
    return Object.keys(out).length ? out : null;
  }

  /* 校验模型输出：解析、过滤无依据结论、白名单校验口径 */
  function parseModelAnalysis(rawText, evidence) {
    var numbers = evidence && evidence.numbers ? evidence.numbers : {};
    var jsonText = stripCodeFence(rawText);
    if (!jsonText) return { ok: false, reason: '模型返回为空' };
    var parsed = null;
    try { parsed = JSON.parse(jsonText); } catch (err) {
      var match = jsonText.match(/\{[\s\S]*\}/);
      if (match) { try { parsed = JSON.parse(match[0]); } catch (err2) { parsed = null; } }
    }
    if (!parsed || typeof parsed !== 'object') return { ok: false, reason: '模型返回内容不是有效 JSON' };

    var rawInsights = Array.isArray(parsed.insights) ? parsed.insights : [];
    var kept = [];
    var dropped = 0;
    for (var i = 0; i < rawInsights.length && kept.length < MAX_MODEL_INSIGHTS; i += 1) {
      var line = String(rawInsights[i] === null || rawInsights[i] === undefined ? '' : rawInsights[i])
        .replace(/\s+/g, ' ').trim();
      if (!line) continue;
      if (line.length > 180) line = line.slice(0, 180) + '…';
      if (!isGrounded(line, numbers)) { dropped += 1; continue; }
      kept.push(line);
    }
    var result = {
      ok: kept.length > 0,
      insights: kept,
      dropped: dropped,
      specPatch: sanitizeSpecPatch(parsed.spec),
      title: parsed.title ? String(parsed.title).replace(/\s+/g, ' ').trim().slice(0, 24) : '',
      risk: parsed.risk === 'high' || parsed.risk === 'medium' || parsed.risk === 'low' ? parsed.risk : '',
      advice: parsed.advice ? String(parsed.advice).replace(/\s+/g, ' ').trim().slice(0, 140) : ''
    };
    if (!result.ok) result.reason = dropped ? '模型给出的结论都没有引用给定向数据，已全部过滤' : '模型没有给出可用结论';
    return result;
  }

  function defaultChartFor(kind) {
    if (kind === 'trend' || kind === 'profile') return 'line';
    if (kind === 'ranking') return 'hbar';
    if (kind === 'distribution') return 'donut';
    if (kind === 'correlation' || kind === 'outlier') return 'scatter';
    return 'bar';
  }

  /* 把模型建议的口径合并进 spec（只动允许的字段，标题按新口径重算） */
  function mergeAnalysisSpec(spec, patch) {
    if (!isObject(patch) || !Object.keys(patch).length) return { spec: spec, changed: false };
    var next = {};
    Object.keys(spec).forEach(function (key) { next[key] = spec[key]; });
    next.kind = patch.kind || spec.kind;
    next.metric = patch.metric || spec.metric;
    next.dimension = patch.dimension || spec.dimension;
    next.chartType = patch.chartType || (patch.kind ? defaultChartFor(patch.kind) : spec.chartType);
    if (next.kind === 'distribution' && (next.metric === 'thickness' || next.metric === 'hardness')) {
      next.dimension = next.metric === 'hardness' ? 'hardnessBin' : 'thicknessBin';
    }
    next.title = buildTitle(next);
    var changed = next.kind !== spec.kind || next.metric !== spec.metric ||
      next.dimension !== spec.dimension || next.chartType !== spec.chartType;
    return { spec: next, changed: changed };
  }

  /* ============================================================
   * 9.5 模型输出的数值审计（页面报告用）
   * ------------------------------------------------------------
   * 与助手的「接地过滤」不同：报告是给人看的成文，不能整条删掉，
   * 因此这里只审计、不改写 —— 找出「本地证据里根本没有的数」并提示核对。
   * ============================================================ */

  var AUDIT_MIN_EVIDENCE_NUMBERS = 3;

  function collectNumbersFromText(source) {
    var set = {};
    var count = 0;
    String(source === null || source === undefined ? '' : source).replace(/-?\d+(?:\.\d+)?/g, function (token) {
      var n = num(token);
      if (n === null) return token;
      [0, 1, 2].forEach(function (d) { set[n.toFixed(d)] = true; });
      set[String(Math.round(n))] = true;
      if (Math.abs(n) > 0 && Math.abs(n) < 1) {
        [0, 1, 2].forEach(function (d) { set[(n * 100).toFixed(d)] = true; });
      }
      count += 1;
      return token;
    });
    return { set: set, count: count };
  }

  /* 年份不是「数据主张」，避免 2026 这类无意义告警 */
  function allowYears(set) {
    for (var year = 1900; year <= 2100; year += 1) set[String(year)] = true;
    return set;
  }

  /* 只有「带小数」或「带计量单位」的数字才算数据主张；
     建议里的「2 根」「12 根」这类数量不报，避免提示被习惯性忽略。 */
  var CLAIM_UNIT_RE = /^(?:mm|毫米|hb|%|％|℃|°c|mpa|kpa|t\/h|t·h|小时|分钟|个月|吨|kg|m3|m³|年)/i;

  function auditNumericClaims(reportText, evidenceText) {
    var evidence = collectNumbersFromText(evidenceText);
    if (evidence.count < AUDIT_MIN_EVIDENCE_NUMBERS) {
      return { ok: true, skipped: true, count: 0, examples: [], evidenceCount: evidence.count };
    }
    var allowed = allowYears(evidence.set);
    var flagged = [];
    var text = String(reportText === null || reportText === undefined ? '' : reportText);
    text.replace(/-?\d+(?:\.\d+)?/g, function (token, offset) {
      var n = num(token);
      if (n === null) return token;
      var tail = text.slice(offset + token.length, offset + token.length + 4).trim().toLowerCase();
      var isClaim = token.indexOf('.') >= 0 || CLAIM_UNIT_RE.test(tail);
      if (!isClaim) return token;
      var grounded = allowed[n.toFixed(0)] || allowed[n.toFixed(1)] || allowed[n.toFixed(2)] ||
        allowed[String(Math.round(n))] || allowed[(n * 100).toFixed(0)] || allowed[(n * 100).toFixed(1)];
      if (!grounded && flagged.indexOf(token) < 0) flagged.push(token);
      return token;
    });
    return {
      ok: flagged.length === 0,
      skipped: false,
      count: flagged.length,
      examples: flagged.slice(0, 5),
      evidenceCount: evidence.count
    };
  }

  /* ============================================================
   * 9. 对外：能力清单（帮助文案用）
   * ============================================================ */

  function capabilities() {
    return [
      { kind: 'trend', label: '趋势分析', example: '近两年壁厚趋势' },
      { kind: 'distribution', label: '分布分析', example: '各受热面事件数分布' },
      { kind: 'ranking', label: '排行分析', example: '受热面事件数排行' },
      { kind: 'compare', label: '对比分析', example: '1 号和 2 号炉壁厚对比' },
      { kind: 'correlation', label: '相关性分析', example: '壁厚和硬度相关性' },
      { kind: 'outlier', label: '异常识别', example: '壁厚异常记录' },
      { kind: 'profile', label: '单管剖面', example: '1-WW-FR-008-0003-000 壁厚变化曲线' },
      { kind: 'overview', label: '综合画像', example: '数据整体画像' }
    ];
  }

  var api = {
    version: VERSION,
    KINDS: Object.keys(KIND_META).map(function (key) {
      return { kind: key, label: KIND_META[key].label, hint: KIND_META[key].hint };
    }),
    parseAnalysis: parseAnalysis,
    runAnalysis: runAnalysis,
    chartSvg: chartSvg,
    describeSpec: describeSpec,
    capabilities: capabilities,
    buildEvidence: buildEvidence,
    buildAnalysisMessages: buildAnalysisMessages,
    parseModelAnalysis: parseModelAnalysis,
    mergeAnalysisSpec: mergeAnalysisSpec,
    isGrounded: isGrounded,
    maskPii: maskPii,
    auditNumericClaims: auditNumericClaims,
    collectNumbersFromText: collectNumbersFromText,
    parseNominalWall: parseNominalWall,
    pearson: pearson,
    correlationLabel: correlationLabel,
    niceStep: niceStep
  };

  global.BTAssistantAnalysis = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
