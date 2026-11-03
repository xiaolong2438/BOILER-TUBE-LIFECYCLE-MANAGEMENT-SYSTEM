/* 温度辅助证据：异步读取共享台账，不参与壁厚、寿命或风险分值计算。 */
(function (global) {
  'use strict';

  const cache = new Map();
  const pending = new Map();
  const TTL = 30000;
  const TYPES = { tube_wall: '炉管壁温', header_wall: '集箱壁温（区域代表）', steam: '汽温（辅助）', flue: '烟温（辅助）', other: '其他温度' };
  const CAUTION = '来自人工登记及已确认的区域映射，不是实时监控；集箱壁温、汽温不等于该管各位置的实测壁温。仅作劣化趋势辅助证据，不折算寿命、不调整减薄速率或更换预警。未登记不代表没有超温。';
  let generation = 0;
  let scheduled = false;

  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const core = () => global.BTOvertemperatureCore;
  const hours = ms => Number.isFinite(ms) ? (ms / 3600000).toLocaleString('zh-CN', { maximumFractionDigits: 3 }) + ' h' : '未统计';
  const degrees = value => Number.isFinite(value) ? Number(value.toFixed(2)) + ' ℃' : '未记录';
  const time = value => Number.isFinite(value) && core() ? core().formatTime(value) : '未登记';
  const canonical = code => typeof normalizedTubeCode === 'function' ? normalizedTubeCode(code) : String(code || '').trim().toUpperCase();

  function installedAt(code) {
    if (typeof userDB === 'undefined' || typeof tubePositionKey !== 'function' || !core()) return null;
    const position = tubePositionKey(code);
    const times = (userDB.replacements || [])
      .filter(row => tubePositionKey(row.oldCode) === position || tubePositionKey(row.newCode) === position)
      .map(row => /^\d{4}-\d{2}-\d{2}$/.test(String(row.date || '')) ? core().parseTime(row.date + 'T00:00:00') : null)
      .filter(value => Number.isFinite(value) && value <= Date.now());
    return times.length ? Math.max(...times) : null;
  }

  function identity(code) {
    const normalized = canonical(code);
    const boundary = installedAt(normalized);
    return { code: normalized, installedAt: boundary, key: normalized + '|' + (boundary ?? '') };
  }

  function failure(code, boundary, message) {
    return { code, installedAt: boundary, status: 'error', message, loadedAt: Date.now(), evidence: null };
  }

  async function load(rawCode, options = {}) {
    const id = identity(rawCode);
    const hit = cache.get(id.key);
    if (!options.force && hit && Date.now() - hit.loadedAt < TTL) return hit;
    if (pending.has(id.key)) return pending.get(id.key);
    const version = generation;
    const promise = (async () => {
      let result;
      if (!core() || !global.BTOvertemperature?.request) {
        result = failure(id.code, id.installedAt, '温度模块未加载，不能判定温度证据。');
      } else {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        try {
          const query = new URLSearchParams({ tubeCode: id.code });
          if (id.installedAt !== null) query.set('installedAt', String(id.installedAt));
          const payload = await global.BTOvertemperature.request('/summary?' + query, { signal: controller.signal });
          if (!payload?.tubeEvidence || !['available', 'unmapped', 'no-records'].includes(payload.tubeEvidence.status)) {
            throw new Error('共享接口未返回完整管段温度摘要，请检查服务版本。');
          }
          if (payload.tubeEvidence.errors?.length) throw new Error(payload.tubeEvidence.errors.join('；'));
          result = { code: id.code, installedAt: id.installedAt, status: payload.tubeEvidence.status, evidence: payload.tubeEvidence, serverTime: payload.serverTime, loadedAt: Date.now() };
        } catch (err) {
          result = failure(id.code, id.installedAt, err.name === 'AbortError' ? '读取温度证据超时；现有壁厚分析不受影响，请稍后刷新。' : (err.message || '读取共享温度证据失败。'));
        } finally {
          clearTimeout(timer);
        }
      }
      if (version === generation) cache.set(id.key, result);
      return result;
    })();
    pending.set(id.key, promise);
    try { return await promise; }
    finally { if (pending.get(id.key) === promise) pending.delete(id.key); }
  }

  function hasLimit(entry) {
    return (entry.configs || []).some(config => Number.isFinite(config.limitC) && String(config.limitBasis || '').trim());
  }

  function configText(config) {
    const limit = Number.isFinite(config.limitC) ? degrees(config.limitC) + '，依据：' + (config.limitBasis || '未填写') : '未配置限值，不能判定超温';
    return '版本 ' + config.revision + '，生效 ' + time(config.effectiveFrom) + '；限值 ' + limit + '；映射依据：' + (config.mappingBasis || '未填写');
  }

  function toText(result) {
    if (!result || result.status === 'error') return '温度辅助证据不可用：' + (result?.message || '尚未读取') + '\n' + CAUTION;
    const evidence = result.evidence;
    if (result.status === 'unmapped') return '尚无已确认的测点—编码区域映射，不能判定该管段温度暴露。\n' + CAUTION;
    const summary = evidence.summary;
    const area = evidence.areaSummary;
    const pointLines = (evidence.points || []).map(entry => {
      const item = entry.point;
      const s = entry.summary;
      const configLines = (entry.configs || []).map(configText).join(' / ');
      return '- ' + item.unit + '# ' + item.name + ' [' + item.tag + ']，' + (TYPES[item.measurementType] || '温度') +
        '；已登记记录 ' + s.recordCount + ' 条，' + (hasLimit(entry) ? '已确认区间并集 ' + hours(s.durationMs) : '未配置有依据的限值，超温时长不可判定') + '，未结束 ' + s.openCount + ' 条；' + configLines;
    });
    const scope = result.installedAt === null
      ? '当前管服役起点未登记，仅展示关联区域历史，不能视为当前这根管的累计服役暴露。'
      : '当前管统计起点：最近换管日 ' + time(result.installedAt) + '（现有换管记录为日精度，按该日北京时间零点裁剪）。';
    const lines = [
      '统计范围：截至本次读取的全部已登记历史；多个测点时长取时间并集，不相加。',
      scope,
      (evidence.points || []).some(entry => !hasLimit(entry)) ? '部分关联测点未配置有依据的限值，下面的时长仅是已确认区间，不代表全部测点可判定；缺限值不能解释为0超温。' : '',
      result.status === 'no-records' ? '有关联测点，但统计范围内没有有效登记记录；不能据此判为正常。' :
        (result.installedAt === null ? '关联区域' : '当前管服役期内关联区域') + '已确认超温时长 ' + hours(summary.durationMs) + '；归并超温段数 ' + summary.mergedCount + '；最长时长 ' + hours(summary.longestMs) + '；未结束事件 ' + summary.openCount + ' 条。',
      '关联区域全历史已确认时长：' + hours(area.durationMs) + '；最高登记温度（含瞬时观察）' + degrees(summary.peakC) + '；最大已登记超限幅度 ' + degrees(summary.maxExcessC) + '。',
      (summary.partialPeak || summary.partial) ? '部分区间被统计窗口或换管边界裁剪，其整段峰值不代表窗口内峰值；参考整段最高值 ' + degrees(summary.estimatedPeakC) + '。' : '',
      ...pointLines,
      CAUTION
    ];
    return lines.filter(Boolean).join('\n');
  }

  function bodyHTML(result) {
    if (!result) return '<p class="thermal-evidence-note" role="status">正在读取共享温度证据，不影响本地壁厚分析…</p>';
    if (result.status === 'error') return '<div class="alert alert-warn" role="status">' + esc(result.message) + '</div>';
    if (result.status === 'unmapped') return '<p class="thermal-evidence-note">尚无已确认的测点—编码区域映射。请在超温分析中配置受热面区域与依据；不能由测点序号推断管排。</p>';
    const evidence = result.evidence;
    const s = evidence.summary;
    const area = evidence.areaSummary;
    const title = result.installedAt === null ? '区域历史已登记超温' : '换管后已登记超温';
    const noRecords = result.status === 'no-records' || !s.recordCount;
    const withoutLimits = (evidence.points || []).filter(entry => !hasLimit(entry)).length;
    const allUnknown = withoutLimits > 0 && withoutLimits === (evidence.points || []).length;
    const metrics = [
      [title, noRecords ? '无有效登记' : allUnknown ? '限值未配，不可判定' : hours(s.durationMs)],
      ['归并超温段 / 未结束', noRecords ? '—' : s.mergedCount + ' / ' + s.openCount],
      ['最长已确认时长', noRecords ? '—' : hours(s.longestMs)],
      ['最高登记温度（含观察）', degrees(s.peakC)]
    ];
    const rows = (evidence.points || []).map(entry => '<tr><td>' + esc(entry.point.name) + '<small>' + esc(entry.point.unit + '# · ' + entry.point.tag) + '</small></td><td>' + esc(TYPES[entry.point.measurementType] || '其他温度') + '</td><td>' + (!hasLimit(entry) ? '限值未配置，不可判定' : entry.summary.recordCount ? esc(hours(entry.summary.durationMs)) : '无有效登记') + '</td><td>' + (entry.configs || []).map(config => '<div>' + esc(configText(config)) + '</div>').join('') + '</td></tr>').join('');
    const scope = result.installedAt === null
      ? '当前管服役起点未登记：下列时长属于关联区域历史，不能视为当前这根管的累计暴露。'
      : '按最近换管日 ' + time(result.installedAt) + ' 裁剪当前管统计（日精度）；区域全部历史并集 ' + hours(area.durationMs) + '。';
    return '<p class="thermal-evidence-note">' + esc(scope) + '</p>' +
      (withoutLimits ? '<p class="thermal-evidence-note">' + withoutLimits + ' 个关联测点缺少有依据的限值，不能将其解释为0超温；汇总仅包含已确认区间。</p>' : '') +
      (noRecords ? '<p class="thermal-evidence-note">已有关联测点，但统计范围内无有效登记，不能判为正常。</p>' : '') +
      '<div class="thermal-evidence-metrics">' + metrics.map(([label, value]) => '<div><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>').join('') + '</div>' +
      ((s.partialPeak || s.partial) ? '<p class="thermal-evidence-note">部分区间已裁剪；整段峰值 ' + esc(degrees(s.estimatedPeakC)) + ' 仅作参考，不代表所选窗口内峰值。</p>' : '') +
      '<div class="table-wrap thermal-evidence-table"><table><thead><tr><th>关联测点</th><th>测量类型</th><th>已登记时长</th><th>历史版本及依据</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="thermal-evidence-note">截至本次读取的已登记历史；各测点时长取并集而非相加。同步时间：' + esc(time(Number(result.serverTime))) + '</p>';
  }

  function cardContents(code, result) {
    return '<div class="thermal-evidence-heading"><h4>关联温度 / 超温辅助证据</h4><div><button type="button" class="btn btn-outline" data-thermal-action="refresh">刷新证据</button><button type="button" class="btn btn-outline" data-thermal-action="open" data-thermal-target="' + esc(code) + '">查看超温台账</button></div></div>' +
      bodyHTML(result) + '<p class="thermal-evidence-caution">' + esc(CAUTION) + '</p>';
  }

  function scheduleHydrate() {
    if (scheduled || !global.document) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; hydrate(); });
  }

  function profileHTML(rawCode) {
    const id = identity(rawCode);
    scheduleHydrate();
    return '<section class="thermal-evidence" data-thermal-code="' + esc(id.code) + '" aria-label="关联温度辅助证据">' + cardContents(id.code, null) + '</section>';
  }

  async function hydrate(options = {}) {
    if (!global.document) return;
    const cards = Array.from(document.querySelectorAll('[data-thermal-code]'));
    const version = generation;
    await Promise.all(cards.map(async card => {
      const code = card.dataset.thermalCode;
      const id = identity(code);
      if (!options.force && card.dataset.thermalKey === id.key && Date.now() - Number(card.dataset.thermalLoadedAt || 0) < TTL) return;
      if (options.force) card.innerHTML = cardContents(code, null);
      const result = await load(code, options);
      if (version !== generation || !card.isConnected || card.dataset.thermalCode !== code || identity(code).key !== id.key) return;
      card.innerHTML = cardContents(code, result);
      card.dataset.thermalKey = id.key;
      card.dataset.thermalLoadedAt = String(result.loadedAt);
    }));
  }

  async function attachAnalysis(data, options = {}) {
    const version = generation;
    const result = await load(data.target, options);
    if (version !== generation) return data;
    const text = toText(result);
    if (!Object.prototype.hasOwnProperty.call(data, 'thermalBaseReport')) data.thermalBaseReport = data.report || '';
    data.thermalEvidence = result;
    data.thermalText = text;
    data.report = data.thermalBaseReport + '\n\n【关联温度与超温辅助证据】\n' + text;
    if (data.compositeSignals) data.compositeSignals.thermalEvidence = result;
    if (global.document && global.__activeTubeAnalysis === data) {
      const report = document.getElementById('ai-report-text');
      if (report) report.textContent = data.report;
    }
    await hydrate();
    return data;
  }

  function invalidate() {
    generation += 1;
    cache.clear();
    pending.clear();
  }

  if (global.document) {
    document.addEventListener('click', event => {
      const button = event.target.closest?.('[data-thermal-action]');
      if (!button) return;
      if (button.dataset.thermalAction === 'open') global.BTOvertemperature?.openForTube(button.dataset.thermalTarget);
      else if (button.dataset.thermalAction === 'refresh') {
        invalidate();
        hydrate({ force: true });
        if (global.__activeTubeAnalysis) attachAnalysis(global.__activeTubeAnalysis, { force: true });
      }
    });
    global.addEventListener('bt-temperature-changed', () => {
      invalidate();
      hydrate({ force: true });
      if (global.__activeTubeAnalysis) {
        attachAnalysis(global.__activeTubeAnalysis, { force: true });
        const report = document.getElementById('ai-llm-report');
        if (report) report.textContent = '温度台账已更新，本地辅助证据已刷新。需重新使用综合分析入口才会更新远程专家分析；本次保存未发起大模型请求。';
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && document.querySelector('#view-tube-analysis.active')) {
        hydrate({ force: true });
        if (global.__activeTubeAnalysis) attachAnalysis(global.__activeTubeAnalysis, { force: true });
      }
    });
  }

  const api = { profileHTML, hydrate, load, attachAnalysis, installedAt, toText, bodyHTML, invalidate };
  global.BTTemperatureEvidence = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
