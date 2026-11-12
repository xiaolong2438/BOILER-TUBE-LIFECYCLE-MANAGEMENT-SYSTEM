/* 人工超温登记 UI。独立挂载 #ot-app；只将服务端确认的数据计入共享统计。 */
(function (window, document) {
  'use strict';
  const BASE = '/api/temperature';
  const DRAFT_KEY = 'bt_overtemperature_ui_draft_v1';
  const PAGE_SIZE = 50;
  const TYPES = { tube_wall: '管壁温度', header_wall: '集箱壁温', steam: '蒸汽温度', flue: '烟气温度', other: '其他测量' };
  const SYSTEMS = { SLB: '水冷壁', DPGRQ: '全大屏过热器', PSGRQ: '后屏过热器', GGRQ: '高温过热器', GZRQ: '高温再热器', DGRQ: '低温过热器', DZRQ: '低温再热器', SMQ: '省煤器' };
  /* 历史系统码别名：后屏过热器由 HPGRQ 统一为 PSGRQ；旧草稿/旧配置读取时归一。 */
  const SYSTEM_ALIASES = { HPGRQ: 'PSGRQ' };
  function canonicalSys(value) {
    const sys = String(value || '').trim().toUpperCase();
    return SYSTEM_ALIASES[sys] || sys;
  }
  function systemLabel(sys) { return SYSTEMS[canonicalSys(sys)] || sys; }
  function normalizeSystemFields(entity) {
    if (!entity || typeof entity !== 'object') return entity;
    if (entity.sys) entity.sys = canonicalSys(entity.sys);
    if (entity.system) entity.system = canonicalSys(entity.system);
    if (Array.isArray(entity.regions)) entity.regions.forEach(region => { if (region && region.sys) region.sys = canonicalSys(region.sys); });
    return entity;
  }
  function normalizeDraft(draft) {
    if (!draft || typeof draft !== 'object') return draft;
    normalizeSystemFields(draft.data);
    normalizeSystemFields(draft.point);
    normalizeSystemFields(draft.original);
    if (draft.data && draft.data.point) normalizeSystemFields(draft.data.point);
    return draft;
  }
  const REGION_KEYS = ['sys', 'comp', 'wall', 'spaces', 'posFrom', 'posTo', 'pos2From', 'pos2To', 'tubeFrom', 'tubeTo', 'dirs', 'parts', 'corners', 'layers', 'nozzles'];
  const NUM_KEYS = ['posFrom', 'posTo', 'pos2From', 'pos2To', 'tubeFrom', 'tubeTo'];
  const ARRAY_KEYS = ['spaces', 'dirs', 'parts', 'corners', 'layers', 'nozzles'];
  const S = { root: null, tab: 'analysis', filters: { unit: '', sys: '', pointId: '', q: '', from: '', to: '' }, tubeCode: '', points: new Map(), configs: new Map(), records: new Map(), options: new Set(), optionCursor: null, optionsLoaded: false, optionTotal: null, summary: null, list: null, page: 0, cursor: '', stack: [], next: null, total: null, busy: false, saving: false, epoch: 0, serverTime: null, syncedAt: null, error: '', notice: '', draft: null, storedDraft: null, storageWarning: '', formErrors: [], conflict: null, preview: null, history: null, historyEpoch: 0, allPointsLoaded: false, import: null };
  let refreshFlight = null;
  let optionsFlight = null;
  let importLoad = null;
  const core = () => window.BTOvertemperatureCore;
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const clone = value => JSON.parse(JSON.stringify(value));
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const unique = values => Array.from(new Set(values));
  const checked = value => value ? ' checked' : '';
  const selected = (a, b) => String(a) === String(b) ? ' selected' : '';
  const blank = value => value === '' || value == null;
  function uid() { return window.crypto && typeof window.crypto.randomUUID === 'function' ? window.crypto.randomUUID() : 'ot-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
  function now() { return finite(S.serverTime) && finite(S.syncedAt) ? S.serverTime + (Date.now() - S.syncedAt) : Date.now(); }
  function time(value) { return core() && !blank(value) ? core().formatTime(value) || '时间无效' : '—'; }
  function dateValue(value) { const text = core() && finite(value) ? core().toInputTime(value) : ''; return text ? text.slice(0, 10) : ''; }
  function dateEpoch(value) { const raw = String(value == null ? '' : value).trim(); return raw && core() ? core().parseTime(raw + 'T00:00:00') : null; }
  function formatDuration(value) {
    if (!finite(value) || value < 0) return '—';
    if (value === 0) return '0 分钟';
    const seconds = Math.floor(value / 1000);
    if (seconds < 60) return seconds + ' 秒';
    const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
    return (hours ? hours.toLocaleString('zh-CN') + ' 小时 ' : '') + minutes + ' 分钟';
  }
  function degrees(value) { return finite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' ℃' : '—'; }
  function count(value) { return finite(value) ? value.toLocaleString('zh-CN') : '—'; }
  function action(label, name, id, cls) { return '<button type="button" class="btn ' + (cls || 'btn-secondary') + '" data-action="' + name + '"' + (id == null ? '' : ' data-id="' + esc(id) + '"') + '>' + esc(label) + '</button>'; }
  function option(value, label, current) { return '<option value="' + esc(value) + '"' + selected(value, current) + '>' + esc(label) + '</option>'; }
  function badge(text, tone) { return '<span class="ot-badge ot-' + (tone || 'muted') + '">' + esc(text) + '</span>'; }
  function errorText(error) {
    if (Array.isArray(error)) return error.map(errorText).join('；');
    if (error && typeof error === 'object') return error.message || error.error || JSON.stringify(error);
    return String(error || '未知错误');
  }
  function fail(message) { const e = new Error(message); e.status = 0; return e; }
  async function request(path, options) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('..')) throw fail('请求路径必须为温度模块内的相对路径');
    const input = options || {};
    const headers = Object.assign({ Accept: 'application/json' }, input.headers || {});
    let body = input.body;
    if (body != null && typeof body !== 'string') { body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const controller = typeof window.AbortController === 'function' ? new window.AbortController() : null;
    const timer = controller ? window.setTimeout(() => controller.abort(), 25000) : null;
    try {
      const response = await window.fetch(BASE + path, Object.assign({}, input, { body, headers, credentials: 'same-origin', cache: 'no-store', signal: input.signal || (controller && controller.signal) || undefined }));
      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : null; } catch (_) { const e = fail('服务端未返回有效 JSON，请检查接口部署或登录状态'); e.status = response.status; throw e; }
      if (!response.ok) {
        const message = response.status === 401 ? '登录已失效，请重新登录后重试；本地草稿仍保留' : response.status === 403 ? '当前账号无操作权限，请联系管理员；本地草稿仍保留' : response.status === 409 ? '远端版本已变化，未覆盖任何数据。请对照远端版本后处理。' : errorText(data && (data.message || data.error || data.errors)) || '请求失败';
        const e = new Error(message + '（HTTP ' + response.status + '）'); e.status = response.status; e.details = data; throw e;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('接口响应不完整，无法确认共享结果；请保留草稿重试');
      if (finite(data.serverTime)) { S.serverTime = data.serverTime; S.syncedAt = Date.now(); }
      return data;
    } catch (e) {
      if (e.status === undefined) { const network = fail(e.name === 'AbortError' ? '请求超时，共享结果未确认；保留草稿后可用同一请求重试' : '无法连接共享服务，请检查网络后重试；草稿尚未共享'); network.details = { cause: e.message }; throw network; }
      throw e;
    } finally { if (timer != null) window.clearTimeout(timer); }
  }
  function query(values) { const params = new URLSearchParams(); Object.entries(values).forEach(([key, value]) => { if (value !== '' && value != null) params.set(key, String(value)); }); return '?' + params.toString(); }
  function configsFor(id) { return Array.from(S.configs.values()).filter(c => c.pointId === id); }
  function accept(data) {
    (data.points || []).forEach(p => { if (p && p.id) S.points.set(p.id, normalizeSystemFields(p)); });
    (data.configs || []).forEach(c => { if (c && c.id) S.configs.set(c.id, normalizeSystemFields(c)); });
  }
  function knownPoints() { return Array.from(S.points.values()).sort((a, b) => (a.unit + a.name).localeCompare(b.unit + b.name, 'zh-CN')); }
  function pointOptions(current, unit, activeOnly) {
    return option('', '请选择已登记测点', current) + knownPoints().filter(p => (!unit || p.unit === unit) && (!activeOnly || p.active !== false || p.id === current)).map(p => option(p.id, p.unit + '# · ' + p.name + ' · ' + p.tag + (p.active === false ? '（停用）' : ''), current)).join('');
  }
  function matrix() { return core() && Array.isArray(core().MATRIX) ? core().MATRIX : []; }
  function systemOptions(value) { return option('', '全部受热面', value) + unique(matrix().map(r => r.sys)).map(sys => option(sys, systemLabel(sys), value)).join(''); }
  function field(label, html, help) { return '<label class="form-group ot-field"><span>' + esc(label) + '</span>' + html + (help ? '<small>' + esc(help) + '</small>' : '') + '</label>'; }
  function input(name, value, type, attrs) { return '<input name="' + esc(name) + '" type="' + (type || 'text') + '" value="' + esc(value) + '" ' + (attrs || '') + '>'; }
  function textarea(name, value, attrs) { return '<textarea name="' + esc(name) + '" rows="3" ' + (attrs || '') + '>' + esc(value) + '</textarea>'; }
  function currentConfig(point, at) { return core().resolveConfig(configsFor(point.id), point.id, at == null ? now() : at); }
  function pointState(point, summary, configs) {
    const c = core().resolveConfig(configs || configsFor(point.id), point.id, now());
    const labels = [];
    if (point.active === false) labels.push(badge('已停用'));
    if (!c || !c.mappingConfirmed || !c.regions || !c.regions.length || !String(c.mappingBasis || '').trim()) labels.push(badge('待映射', 'warn'));
    if (!c || !finite(c.limitC) || !String(c.limitBasis || '').trim()) labels.push(badge('未配有效限值', 'warn'));
    if (!summary || !finite(summary.recordCount)) labels.push(badge('记录状态未载入'));
    else if (!summary.recordCount) labels.push(badge('无记录', 'muted'));
    else if (summary.durationMs > 0) labels.push(badge('有核定超温区间', 'danger'));
    else labels.push(badge('有记录 · 不代表正常', 'muted'));
    if (summary && summary.openCount) labels.push(badge('有未结束区间', 'warn'));
    return labels.join(' ');
  }
  function readStoredDraft() {
    try { const raw = window.localStorage.getItem(DRAFT_KEY); if (!raw) return; const d = JSON.parse(raw); if (!d || d.version !== 1 || !['point', 'editPoint', 'config', 'record', 'void'].includes(d.type) || !d.data) throw new Error('草稿格式不兼容'); S.storedDraft = normalizeDraft(d); }
    catch (_) { S.storageWarning = '本地草稿不可读取。新输入仍可提交，但请自行保留内容。'; }
  }
  function persist() {
    if (!S.draft) return;
    try { window.localStorage.setItem(DRAFT_KEY, JSON.stringify(S.draft)); S.storedDraft = clone(S.draft); }
    catch (_) { S.storageWarning = '浏览器未允许保存草稿或空间不足；离开前请自行保留输入。'; }
    renderDraftStatus();
  }
  function clearDraft() {
    S.draft = null; S.storedDraft = null;
    try { window.localStorage.removeItem(DRAFT_KEY); } catch (_) { S.storageWarning = '无法清除旧的本地草稿，请勿重复恢复已成功提交的草稿。'; }
    S.formErrors = []; S.conflict = null; S.preview = null;
    renderForm(); renderDraftStatus();
  }
  function renderDraftStatus() {
    const el = S.root && S.root.querySelector('#ot-draft-status');
    if (!el) return;
    el.innerHTML = (S.storageWarning ? '<span class="ot-warning">' + esc(S.storageWarning) + '</span> ' : '') + (S.draft ? '<span>仅本机草稿 · 未计入共享统计</span>' : S.storedDraft ? '<span>有未共享的本机草稿</span> ' + action('恢复草稿', 'restore') + ' ' + action('丢弃草稿', 'discard') : '');
  }
  function init() {
    const root = document && document.getElementById('ot-app');
    if (!root) return false;
    if (S.root === root) return true;
    S.root = root;
    root.innerHTML = '<div class="ot-shell"><header class="ot-header"><div><div class="ot-eyebrow">设备温度 · 人工核定</div><h2>超温分析</h2><p>多人共享台账与温度记录；手工登记，不是实时 DCS 监视。</p></div><div class="ot-actions">' + action('刷新共享数据', 'refresh', null, 'btn-primary') + '</div></header><div id="ot-sync" class="ot-sync" role="status" aria-live="polite"></div><div id="ot-draft-status" class="ot-draft-status" role="status"></div><div id="ot-filters"></div><div class="ot-tabs" role="tablist" aria-label="超温子页">' + ['analysis', 'points', 'records'].map((tab, i) => '<button type="button" role="tab" id="ot-tab-' + tab + '" data-action="tab" data-id="' + tab + '" aria-controls="ot-content" aria-selected="' + (tab === S.tab) + '">' + ['累计分析', '测点台账', '温度记录'][i] + '</button>').join('') + '</div><div id="ot-toolbar" class="ot-toolbar"></div><div id="ot-composer"></div><div id="ot-content" role="tabpanel" aria-labelledby="ot-tab-analysis"></div><aside id="ot-history" aria-label="操作历史"></aside></div>';
    root.addEventListener('click', onClick); root.addEventListener('input', onInput); root.addEventListener('change', onChange); root.addEventListener('submit', onSubmit);
    root.addEventListener('keydown', event => { if (event.target.getAttribute('role') !== 'tab' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const tabs = ['analysis', 'points', 'records']; let i = tabs.indexOf(S.tab); i = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (i + (event.key === 'ArrowRight' ? 1 : 2)) % 3; selectTab(tabs[i]); root.querySelector('#ot-tab-' + tabs[i]).focus(); });
    root.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = event.target.closest && event.target.closest('[data-action][role="button"]');
      if (!target) return;
      event.preventDefault();
      target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    readStoredDraft(); renderFilters(); renderToolbar(); renderDraftStatus(); renderSync(); renderContent();
    return true;
  }
  function active() { const view = document.getElementById('view-overtemperature'); return !!view && view.classList.contains('active'); }
  function renderSync() {
    if (!S.root) return;
    const missing = !core();
    S.root.querySelector('#ot-sync').innerHTML = missing ? '<div class="ot-alert" role="alert">核心校验模块未加载。请确认 assistant-core → overtemperature-core → overtemperature 的加载顺序后重载页面。' + action('重新检查', 'refresh') + '</div>' : (S.error ? '<div class="ot-alert" role="alert">' + esc(S.error) + ' ' + action('重试读取', 'refresh') + '<small>读取失败的数据不作为当前共享结果；本机草稿不参与统计。</small></div>' : '') + '<span class="ot-sync-dot' + (S.busy ? ' ot-loading' : '') + '"></span><span>' + (S.busy ? '正在读取共享服务…' : S.syncedAt ? '最近服务端响应：' + esc(time(S.serverTime)) : '进入本页后读取共享数据') + '</span>' + (S.notice ? '<p class="ot-notice">' + esc(S.notice) + '</p>' : '');
    S.root.setAttribute('aria-busy', String(S.busy));
  }
  function renderFilters() {
    if (!S.root) return;
    const f = S.filters;
    S.root.querySelector('#ot-filters').innerHTML = '<form id="ot-filter-form" class="ot-panel ot-filter-form"><div class="ot-unit-switch" role="group" aria-label="机组筛选">' + [['', '全厂'], ['1', '1# 机组'], ['2', '2# 机组']].map(([v, label]) => '<button type="button" class="btn" data-action="unit" data-id="' + v + '" aria-pressed="' + (f.unit === v) + '">' + label + '</button>').join('') + '</div><div class="ot-filter-grid">' + field('受热面', '<select name="sys">' + systemOptions(f.sys) + '</select>') + field('测点', '<select name="pointId">' + option('', '全部测点', '') + pointOptions(f.pointId, f.unit).replace(option('', '请选择已登记测点', f.pointId), '') + '</select>') + field('搜索名称 / 编号 / 位置', input('q', f.q, 'search', 'maxlength="200" placeholder="输入关键词后查询"')) + field('开始时间（北京时间）', input('from', f.from, 'datetime-local', 'step="1"')) + field('结束时间（北京时间）', input('to', f.to, 'datetime-local', 'step="1"')) + '<div class="ot-filter-buttons"><button class="btn btn-primary" type="submit">应用筛选</button>' + action('重置', 'reset') + '</div></div><div class="ot-help">时间范围按北京时间 UTC+08:00 解读，与电脑时区无关；留空表示不限制。测点单选用于累计分析与记录。<span id="ot-option-status"></span></div>' + (S.tubeCode ? '<div class="ot-tube-filter">累计分析附加管段条件：<code>' + esc(S.tubeCode) + '</code> ' + action('取消管段条件', 'clearTube') + '<small>此条件仅用于累计摘要；台账与记录仍按上方筛选。</small></div>' : '') + '</form>';
    renderOptionStatus();
  }
  function renderOptionStatus() {
    const el = S.root && S.root.querySelector('#ot-option-status');
    if (!el) return;
    el.innerHTML = S.optionsLoaded ? ' 测点选项已分页加载 ' + S.options.size + (finite(S.optionTotal) ? ' / ' + S.optionTotal : '') + ' 个。' + (S.optionCursor ? action('加载更多测点选项', 'moreOptions') : '') + ' 服务端统计不会因选项分页截断。' : ' 测点选项尚未读取。';
  }
  function renderToolbar() {
    if (!S.root) return;
    S.root.querySelectorAll('[role="tab"]').forEach(el => el.setAttribute('aria-selected', String(el.dataset.id === S.tab)));
    S.root.querySelector('#ot-content').setAttribute('aria-labelledby', 'ot-tab-' + S.tab);
    const actions = S.tab === 'points'
      ? action('新增测点 / 批量建点', 'newPoint') + action('导入测点台账', 'importPoints') + action('登记温度', 'newRecord', null, 'btn-primary')
      : action('登记温度', 'newRecord') + action('导入月度报表', 'importReport', null, 'btn-primary');
    S.root.querySelector('#ot-toolbar').innerHTML = '<div><strong>' + ({ analysis: '已核定区间累计', points: '测点台账', records: '人工温度记录' })[S.tab] + '</strong><small>' + ({ analysis: '先有依据，再做归属；未知状态绝不标为正常。', points: '机组与测量类型创建后不可变；区域和限值使用不可变版本。', records: '时点观察不累计；未结束区间不推算时长。' })[S.tab] + '</small></div><div class="ot-actions">' + actions + '</div>';
  }
  function filterQuery(f = S.filters) {
    const from = f.from ? core().parseTime(f.from) : null, to = f.to ? core().parseTime(f.to) : null;
    if (f.from && from === null || f.to && to === null) throw fail('筛选时间无效，请输入完整的北京时间');
    if (from != null && to != null && from >= to) throw fail('结束时间必须晚于开始时间');
    return { unit: f.unit, sys: f.sys, pointId: f.pointId, q: f.q.trim(), from, to };
  }
  async function loadOptions(more) {
    const data = await request('/points' + query({ limit: PAGE_SIZE, cursor: more ? S.optionCursor : '' }));
    if (!Array.isArray(data.items)) throw fail('测点接口缺少 items，无法加载选项');
    accept(data);
    if (!more) S.options.clear();
    data.items.forEach(p => { S.points.set(p.id, p); S.options.add(p.id); });
    S.optionCursor = data.nextCursor || null; S.optionTotal = data.total; S.optionsLoaded = true;
  }
  function refresh(options) {
    if (!init() || !active()) return Promise.resolve();
    if (!core()) { renderSync(); return Promise.resolve(); }
    const snapshot = { filters: Object.assign({}, S.filters), tubeCode: S.tubeCode, tab: S.tab, cursor: S.cursor };
    const key = JSON.stringify(snapshot);
    if (!options?.force && refreshFlight && refreshFlight.key === key) return refreshFlight.promise;
    const flight = { key, promise: null };
    refreshFlight = flight;
    // Publish the promise before starting requests so concurrent entry points share it.
    flight.promise = Promise.resolve().then(() => performRefresh(snapshot, flight.epoch)).finally(() => {
      if (refreshFlight === flight) refreshFlight = null;
    });
    // Supersede older work immediately, including work queued in the same turn.
    flight.epoch = ++S.epoch;
    return flight.promise;
  }
  async function performRefresh(snapshot, epoch) {
    if (epoch !== S.epoch) return;
    const tab = snapshot.tab, cursor = snapshot.cursor, tubeCode = snapshot.tubeCode;
    S.busy = true; S.error = ''; renderSync();
    try {
      const q = filterQuery(snapshot.filters);
      if (!S.optionsLoaded && !optionsFlight) optionsFlight = loadOptions(false).finally(() => { optionsFlight = null; });
      const [data] = await Promise.all([request('/summary' + query(Object.assign({}, q, { tubeCode }))), optionsFlight]);
      if (epoch !== S.epoch) return;
      if (!data.summary || !Array.isArray(data.byPoint)) throw fail('统计接口缺少 summary / byPoint，未显示未确认的数据');
      if (tubeCode) {
        if (!data.tubeEvidence || data.tubeEvidence.errors?.length) throw fail((data.tubeEvidence?.errors || ['管段摘要未返回，不能使用全厂统计替代']).join('；'));
        data.summary = data.tubeEvidence.summary;
        data.byPoint = data.tubeEvidence.points;
      }
      S.summary = data;
      data.byPoint.forEach(row => { if (row.point) S.points.set(row.point.id, row.point); (row.configs || []).forEach(c => S.configs.set(c.id, c)); });
      if (tab === 'points') {
        const list = await request('/points' + query({ unit: q.unit, sys: q.sys, q: q.q, cursor, limit: PAGE_SIZE }));
        if (epoch !== S.epoch) return;
        if (!Array.isArray(list.items)) throw fail('测点列表响应不完整');
        accept(list); list.items.forEach(p => S.points.set(p.id, p)); S.list = list;
      } else if (tab === 'records') {
        let ids = q.pointId, list;
        if (q.q) {
          // records 不支持 q：以不带 tubeCode 的服务端筛选结果确定 pointId，绝不以选项缓存截断记录。
          const searchData = tubeCode ? await request('/summary' + query(q)) : data;
          if (epoch !== S.epoch) return;
          const matching = searchData.byPoint.map(row => row.point.id).filter(id => !ids || id === ids);
          if (matching.length > 100) throw fail('关键词匹配超过 100 个测点，请缩小搜索或选择单个测点后查看记录');
          if (!matching.length) list = { items: [], total: 0, nextCursor: null };
          else { ids = matching.join(','); list = await request('/records' + query({ unit: q.unit, sys: q.sys, pointId: ids, from: q.from, to: q.to, cursor, limit: PAGE_SIZE, includeVoid: 'true' })); }
        } else list = await request('/records' + query({ unit: q.unit, sys: q.sys, pointId: ids, from: q.from, to: q.to, cursor, limit: PAGE_SIZE, includeVoid: 'true' }));
        if (epoch !== S.epoch) return;
        if (!Array.isArray(list.items)) throw fail('记录列表响应不完整');
        S.list = list;
        accept(list); list.items.forEach(r => S.records.set(r.id, r));
      }
      S.next = S.tab === 'analysis' ? null : S.list.nextCursor || null; S.total = S.tab === 'analysis' ? data.byPoint.length : S.list.total;
      renderFilters(); renderContent();
      if (S.draft && S.draft.type === 'record') renderRecordContext();
    } catch (e) { if (epoch !== S.epoch) return; S.error = e.message; S.summary = null; S.list = null; renderContent(); }
    finally { if (epoch === S.epoch) { S.busy = false; renderSync(); renderContent(); } }
  }
  function resetPage() { S.cursor = ''; S.page = 0; S.stack = []; S.next = null; S.list = null; }
  function selectTab(tab) { if (!['analysis', 'points', 'records'].includes(tab) || tab === S.tab) return; if (S.import) { S.import = null; renderForm(); } S.tab = tab; resetPage(); renderToolbar(); renderContent(); refresh(); }
  function summaryRow(id) { return S.summary && S.summary.byPoint.find(row => row.point && row.point.id === id); }
  function empty(message, label, name) { return '<div class="ot-empty"><strong>' + esc(message) + '</strong><p>这里只展示真实登记的数据，不生成示例测点、限值或映射。</p>' + (label ? action(label, name, null, 'btn-primary') : '') + '</div>'; }
  function pager(total, next) { return '<div class="ot-pager"><span>第 ' + (S.page + 1) + ' 页' + (finite(total) ? ' · 共 ' + count(total) + ' 条' : '') + ' · 每页 ' + PAGE_SIZE + ' 条</span><div><button type="button" class="btn" data-action="prev"' + (S.page === 0 || S.busy ? ' disabled' : '') + '>上一页</button><button type="button" class="btn" data-action="next"' + (!next || S.busy ? ' disabled' : '') + '>下一页</button></div></div>'; }
  function table(headers, rows) { return '<div class="table-wrap ot-table-wrap"><table class="ot-table"><thead><tr>' + headers.map(h => '<th scope="col">' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>'; }
  function pointCell(p) { return '<strong>' + esc(p.name) + '</strong><small>' + esc(p.unit) + '# · ' + esc(p.tag) + '</small>'; }
  function pointButtons(p) { return '<div class="ot-row-actions">' + action('登记', 'pointRecord', p.id) + action('配置区域/限值', 'config', p.id) + action('编辑', 'editPoint', p.id) + action('历史', 'historyPoint', p.id) + '</div>'; }
  const BEIJING_OFFSET_MS = 480 * 60000;
  function pad2(value) { return String(value).padStart(2, '0'); }
  function beijingDate(ms) { return new Date(ms + BEIJING_OFFSET_MS); }
  function monthKeyOf(ms) { const d = beijingDate(ms); return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1); }
  function monthStartOf(key) { const parts = key.split('-').map(Number); return Date.UTC(parts[0], parts[1] - 1, 1) - BEIJING_OFFSET_MS; }
  function nextMonthKey(key) { const parts = key.split('-').map(Number); const d = new Date(Date.UTC(parts[0], parts[1], 1)); return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1); }
  function yearKeyOf(ms) { return monthKeyOf(ms).slice(0, 4); }
  function yearStartOf(key) { return Date.UTC(Number(key), 0, 1) - BEIJING_OFFSET_MS; }
  function nextYearKey(key) { return String(Number(key) + 1); }
  function compactDuration(ms) {
    if (!finite(ms) || ms <= 0) return '0';
    const minutes = ms / 60000;
    if (minutes < 1) return Math.round(ms / 1000) + '秒';
    if (minutes < 60) return (minutes < 10 ? minutes.toFixed(1).replace(/\.0$/, '') : String(Math.round(minutes))) + '分';
    return (minutes / 60).toFixed(1).replace(/\.0$/, '') + '时';
  }
  function clockDuration(ms) {
    if (!finite(ms) || ms <= 0) return '0';
    const total = Math.round(ms / 1000), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), seconds = total % 60;
    return (hours ? hours + ':' + pad2(minutes) : String(minutes)) + ':' + pad2(seconds);
  }
  const POINT_COLORS = ['#33d6ff', '#4ade80', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c', '#22d3ee', '#f87171'];
  function heatmapBuckets(intervals) {
    const cells = Array.from({ length: 7 }, () => Array(24).fill(0));
    (intervals || []).forEach(interval => {
      if (!finite(interval.startAt) || !finite(interval.endAt) || interval.endAt <= interval.startAt) return;
      let cursor = interval.startAt, guard = 0;
      while (cursor < interval.endAt && guard < 10000) {
        const hourStart = Math.floor((cursor + BEIJING_OFFSET_MS) / 3600000) * 3600000 - BEIJING_OFFSET_MS;
        const next = Math.min(interval.endAt, hourStart + 3600000);
        const d = new Date(hourStart + BEIJING_OFFSET_MS);
        cells[(d.getUTCDay() + 6) % 7][d.getUTCHours()] += next - cursor;
        cursor = next; guard += 1;
      }
    });
    return cells;
  }
  function renderMonthlyPointTrend(rows) {
    const matrix = monthPointMatrix(rows, 12);
    if (!matrix.months.length || !matrix.items.length) return '<figure class="ot-chart"><figcaption>月份 × 测点累计趋势</figcaption><p class="ot-viz-empty">当前筛选窗口没有已核定的超温区间。</p></figure>';
    const points = matrix.items.slice(0, 8);
    const colorOf = item => POINT_COLORS[matrix.items.indexOf(item) % POINT_COLORS.length];
    const width = 820, height = 250, left = 58, right = 16, top = 24, bottom = 44;
    const plotW = width - left - right, plotH = height - top - bottom;
    const max = Math.max(1, ...points.reduce((all, item) => all.concat(item.cells.map(cell => cell.ms)), []));
    const step = plotW / matrix.months.length;
    const groupW = Math.min(58, step * 0.78), barW = Math.max(3, groupW / points.length - 2);
    let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="按测点和月份分别统计的超温累计时长，不同测点不合并">';
    for (let i = 0; i <= 3; i += 1) {
      const y = top + plotH * i / 3;
      svg += '<line x1="' + left + '" y1="' + y.toFixed(1) + '" x2="' + (width - right) + '" y2="' + y.toFixed(1) + '" class="ot-grid-line"/>';
      svg += '<text x="' + (left - 8) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" class="ot-axis">' + esc(compactDuration(max * (1 - i / 3))) + '</text>';
    }
    matrix.months.forEach((month, monthIndex) => {
      const groupX = left + step * monthIndex + (step - groupW) / 2;
      const label = month.slice(0, 4) + '-' + month.slice(5);
      points.forEach((item, pointIndex) => {
        const ms = item.cells[monthIndex].ms;
        if (!ms) return;
        const h = ms / max * plotH;
        const x = groupX + pointIndex * (barW + 2);
        const y = top + plotH - h;
        svg += '<g class="ot-bar-row" data-action="focusMonthPoint" data-id="' + esc(item.point.id) + '" data-month="' + esc(month) + '" role="button" tabindex="0" aria-label="' + esc(item.point.name + '，' + label + '，' + clockDuration(ms)) + '"><title>' + esc(item.point.name + ' · ' + label + '：' + clockDuration(ms)) + '</title>' +
          '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + Math.max(h, 1).toFixed(1) + '" rx="2" style="fill:' + colorOf(item) + ';opacity:.9"/>' +
          '</g>';
      });
      const showYear = monthIndex === 0 || month.slice(5) === '01';
      svg += '<text x="' + (groupX + groupW / 2).toFixed(1) + '" y="' + (height - bottom + 16) + '" text-anchor="middle" class="ot-axis">' + esc(showYear ? month.slice(2) : month.slice(5) + '月') + '</text>';
    });
    svg += '</svg>';
    const legend = '<div class="ot-point-legend">' + points.map(item => '<button type="button" class="ot-legend-item" data-action="focusPoint" data-id="' + esc(item.point.id) + '"><i style="background:' + colorOf(item) + '"></i><span>' + esc(item.point.name) + '<small>' + esc(item.point.unit + '# · ' + item.point.tag + ' · 跨月累计 ' + clockDuration(item.totalMs)) + '</small></span></button>').join('') + '</div>';
    return '<figure class="ot-chart ot-point-trend"><figcaption>月份 × 测点累计趋势 <small>每月每个测点一根独立柱；同一测点跨月累加，不同测点不合并</small></figcaption>' + svg + legend +
      (points.length < matrix.items.length ? '<p class="ot-chart-tip">趋势图仅显示累计前 8 个测点；完整点位见上方矩阵。</p>' : '') +
      (matrix.truncated ? '<p class="ot-chart-tip">仅显示最近 12 个月。</p>' : '') + '</figure>';
  }
  function renderHeatmap(intervals) {
    if (!(intervals || []).length) return '<figure class="ot-chart"><figcaption>时段分布</figcaption><p class="ot-viz-empty">当前筛选窗口没有已核定的超温区间。</p></figure>';
    const cells = heatmapBuckets(intervals);
    const max = Math.max(1, ...cells.flat());
    const cw = 24, ch = 24, left = 38, top = 22, right = 6, bottom = 36;
    const width = left + 24 * cw + right, height = top + 7 * ch + bottom;
    const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="按星期和小时统计的超温累计时长热力图">';
    for (let h = 0; h < 24; h += 3) svg += '<text x="' + (left + h * cw + cw / 2) + '" y="12" text-anchor="middle" class="ot-axis">' + pad2(h) + '</text>';
    names.forEach((name, day) => {
      const y = top + day * ch;
      svg += '<text x="' + (left - 8) + '" y="' + (y + 16) + '" text-anchor="end" class="ot-axis">' + name + '</text>';
      for (let h = 0; h < 24; h += 1) {
        const ms = cells[day][h], ratio = ms / max;
        const style = ms ? 'fill:var(--accent);fill-opacity:' + (0.14 + 0.76 * ratio).toFixed(2) + ';opacity:1' : 'fill:var(--line);fill-opacity:.35;opacity:1';
        svg += '<rect x="' + (left + h * cw + 1) + '" y="' + (y + 1) + '" width="' + (cw - 2) + '" height="' + (ch - 2) + '" rx="3" style="' + style + '"><title>' + esc(name + ' ' + pad2(h) + ':00–' + pad2(h + 1) + ':00 · ' + (ms ? formatDuration(ms) : '无已核定区间')) + '</title></rect>';
      }
    });
    svg += '</svg>';
    return '<figure class="ot-chart ot-heatmap"><figcaption>时段分布 <small>全部测点时间并集，仅看时段参考，不进入点位累计</small></figcaption><div class="ot-heat-scroll">' + svg + '</div><div class="ot-heat-legend"><span>低</span><i style="background:var(--surface-sunken)"></i><i style="background:var(--accent);opacity:.3"></i><i style="background:var(--accent);opacity:.6"></i><i style="background:var(--accent)"></i><span>高</span></div></figure>';
  }
  function monthPointMatrix(rows, limit) {
    const list = (rows || []).filter(row => row && row.point);
    const bounds = [];
    list.forEach(row => {
      ((row.summary && row.summary.intervals) || []).forEach(interval => {
        if (finite(interval.startAt) && finite(interval.endAt) && interval.endAt > interval.startAt) bounds.push(monthKeyOf(interval.startAt), monthKeyOf(interval.endAt - 1));
      });
    });
    if (!bounds.length) return { months: [], items: [], truncated: false };
    const first = bounds.reduce((min, key) => key < min ? key : min);
    const last = bounds.reduce((max, key) => key > max ? key : max);
    const all = []; let key = first, guard = 0;
    while (key <= last && guard < 240) { all.push(key); key = nextMonthKey(key); guard += 1; }
    const truncated = all.length > limit;
    const months = truncated ? all.slice(-limit) : all;
    const items = list.map(row => {
      const intervals = ((row.summary && row.summary.intervals) || []).filter(interval => finite(interval.startAt) && finite(interval.endAt) && interval.endAt > interval.startAt);
      const cells = months.map(month => {
        const start = monthStartOf(month), end = monthStartOf(nextMonthKey(month));
        return { key: month, ms: intervals.reduce((sum, interval) => sum + Math.max(0, Math.min(end, interval.endAt) - Math.max(start, interval.startAt)), 0) };
      });
      return { point: row.point, cells: cells, totalMs: cells.reduce((sum, cell) => sum + cell.ms, 0) };
    }).filter(item => item.totalMs > 0).sort((a, b) => b.totalMs - a.totalMs || String(a.point.name).localeCompare(String(b.point.name), 'zh-CN'));
    return { months: months, items: items, truncated: truncated };
  }
  function renderMonthPointMatrix(rows) {
    const matrix = monthPointMatrix(rows, 12);
    if (!matrix.months.length || !matrix.items.length) return '<figure class="ot-chart"><figcaption>月份 × 测点累计</figcaption><p class="ot-viz-empty">当前筛选窗口没有已核定的超温区间。</p></figure>';
    const head = ['测点', '管屏（检修确认）'].concat(matrix.months.map(month => month.slice(0, 4) + '-' + month.slice(5))).concat(['该点跨月累计']);
    const peak = Math.max(1, ...matrix.items.reduce((all, item) => all.concat(item.cells.map(cell => cell.ms)), []));
    const body = matrix.items.map(item => {
      const p = item.point;
      const cells = item.cells.map(cell => cell.ms
        ? '<td class="ot-matrix-hit"><button type="button" class="ot-matrix-cell ot-matrix-l' + Math.max(1, Math.min(4, Math.ceil(cell.ms / peak * 4))) + '" data-action="focusMonthPoint" data-id="' + esc(p.id) + '" data-month="' + esc(cell.key) + '" title="' + esc(p.name + ' · ' + cell.key + '：' + clockDuration(cell.ms) + '（' + formatDuration(cell.ms) + '）') + '">' + esc(clockDuration(cell.ms)) + '</button></td>'
        : '<td class="ot-matrix-zero">—</td>').join('');
      return '<tr><td>' + pointCell(p) + '</td><td>' + (p.panel ? esc(p.panel) : badge('待确认', 'warn')) + '</td>' + cells + '<td class="ot-matrix-total">' + esc(clockDuration(item.totalMs)) + '</td></tr>';
    }).join('');
    return '<figure class="ot-chart ot-month-matrix"><figcaption>月份 × 测点累计 <small>单元格为该测点当月经区间并集后的超温时长；点击查看该月该测点明细</small></figcaption>' +
      '<div class="ot-matrix-scroll"><table class="ot-matrix"><thead><tr>' + head.map(label => '<th scope="col">' + esc(label) + '</th>').join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<p class="ot-chart-tip">月度合计为所示月份之和；同一测点不同时间全部相加，不同测点分行显示，不合并。管屏留空表示待机组检修时确认。</p>' + (matrix.truncated ? '<p class="ot-chart-tip">仅显示最近 12 个月。</p>' : '') + '</figure>';
  }
  function yearPointMatrix(rows, limit) {
    const list = (rows || []).filter(row => row && row.point);
    const bounds = [];
    list.forEach(row => {
      ((row.summary && row.summary.intervals) || []).forEach(interval => {
        if (finite(interval.startAt) && finite(interval.endAt) && interval.endAt > interval.startAt) bounds.push(yearKeyOf(interval.startAt), yearKeyOf(interval.endAt - 1));
      });
    });
    if (!bounds.length) return { years: [], items: [], truncated: false };
    const first = Number(bounds.reduce((min, key) => key < min ? key : min));
    const last = Number(bounds.reduce((max, key) => key > max ? key : max));
    const all = []; let guard = 0;
    for (let year = first; year <= last && guard < 500; year += 1, guard += 1) all.push(String(year));
    const truncated = all.length > limit;
    const years = truncated ? all.slice(-limit) : all;
    const items = list.map(row => {
      const intervals = ((row.summary && row.summary.intervals) || []).filter(interval => finite(interval.startAt) && finite(interval.endAt) && interval.endAt > interval.startAt);
      const cells = years.map(year => {
        let ms = 0;
        for (let month = 0; month < 12; month += 1) {
          const start = Date.UTC(Number(year), month, 1) - BEIJING_OFFSET_MS;
          const end = Date.UTC(Number(year), month + 1, 1) - BEIJING_OFFSET_MS;
          ms += intervals.reduce((sum, interval) => sum + Math.max(0, Math.min(end, interval.endAt) - Math.max(start, interval.startAt)), 0);
        }
        return { key: year, ms: ms };
      });
      return { point: row.point, cells: cells, totalMs: cells.reduce((sum, cell) => sum + cell.ms, 0) };
    }).filter(item => item.totalMs > 0).sort((a, b) => b.totalMs - a.totalMs || String(a.point.name).localeCompare(String(b.point.name), 'zh-CN'));
    return { years: years, items: items, truncated: truncated };
  }
  function renderYearPointMatrix(rows) {
    const matrix = yearPointMatrix(rows, 5);
    if (!matrix.years.length || !matrix.items.length) return '<figure class="ot-chart"><figcaption>年度 × 测点累计</figcaption><p class="ot-viz-empty">当前筛选窗口没有已核定的超温区间。</p></figure>';
    const head = ['测点', '管屏（检修确认）'].concat(matrix.years.map(year => year + ' 年')).concat(['该点合计']);
    const peak = Math.max(1, ...matrix.items.reduce((all, item) => all.concat(item.cells.map(cell => cell.ms)), []));
    const body = matrix.items.map(item => {
      const p = item.point;
      const cells = item.cells.map(cell => cell.ms
        ? '<td class="ot-matrix-hit"><button type="button" class="ot-matrix-cell ot-matrix-l' + Math.max(1, Math.min(4, Math.ceil(cell.ms / peak * 4))) + '" data-action="focusYearPoint" data-id="' + esc(p.id) + '" data-year="' + esc(cell.key) + '" title="' + esc(p.name + ' · ' + cell.key + ' 年：' + clockDuration(cell.ms) + '（' + formatDuration(cell.ms) + '）') + '">' + esc(clockDuration(cell.ms)) + '</button></td>'
        : '<td class="ot-matrix-zero">—</td>').join('');
      return '<tr><td>' + pointCell(p) + '</td><td>' + (p.panel ? esc(p.panel) : badge('待确认', 'warn')) + '</td>' + cells + '<td class="ot-matrix-total">' + esc(clockDuration(item.totalMs)) + '</td></tr>';
    }).join('');
    return '<figure class="ot-chart ot-year-matrix"><figcaption>年度 × 测点累计 <small>先按月累加，再把同一测点的各月合计汇入所属年度；点击查看该年度该测点明细</small></figcaption>' +
      '<div class="ot-matrix-scroll"><table class="ot-matrix"><thead><tr>' + head.map(label => '<th scope="col">' + esc(label) + '</th>').join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<p class="ot-chart-tip">年度累计 = 该测点该年度各月累计之和；不同测点分行显示，不合并。管屏留空表示待机组检修时确认。</p>' + (matrix.truncated ? '<p class="ot-chart-tip">仅显示最近 5 个年度。</p>' : '') + '</figure>';
  }
  function bandColumns() {
    const policy = core() && core().BAND_POLICY;
    const edges = policy && Array.isArray(policy.edgesC) && policy.edgesC.length ? policy.edgesC : [5, 10, 20];
    return edges.map((edge, index) => ({ key: 'b' + index, label: (index ? edges[index - 1] : 0) + '～<' + edge + '℃' })).concat([{ key: 'b' + edges.length, label: '≥' + edges[edges.length - 1] + '℃' }]);
  }
  function lifetimeBasisText(lifetime) {
    if (!lifetime) return '未载入';
    if (lifetime.basis === 'commissioned') return dateValue(lifetime.fromAt) + ' 投产';
    if (lifetime.basis === 'earliest_record') return dateValue(lifetime.fromAt) + ' 最早记录（未登记投产日期）';
    return '无起算依据';
  }
  function lifetimeMatrix(rows) {
    return (rows || []).filter(row => row && row.point && row.lifetime).map(row => {
      const byKey = {};
      (row.lifetime.bands || []).forEach(band => { byKey[band.key] = band; });
      return { point: row.point, lifetime: row.lifetime, bands: byKey };
    }).filter(item => item.lifetime.recordCount > 0 || item.lifetime.bandDurationMs > 0).sort((a, b) => b.lifetime.durationMs - a.lifetime.durationMs || String(a.point.tag).localeCompare(String(b.point.tag), 'zh-CN'));
  }
  function renderLifetimeMatrix(rows) {
    const columns = bandColumns(), items = lifetimeMatrix(rows);
    if (!items.length) return '<figure class="ot-chart ot-life-matrix"><figcaption>投产以来超温累计</figcaption><p class="ot-viz-empty">当前筛选范围内没有可用于投产以来累计的已登记记录。</p></figure>';
    const head = ['测点（精确点位）', '管屏（检修确认）'].concat(columns.map(column => column.label)).concat(['投产以来累计', '证据']);
    const body = items.map(item => {
      const p = item.point, l = item.lifetime;
      const cells = columns.map(column => {
        const band = item.bands[column.key], ms = band && finite(band.ms) ? band.ms : 0;
        const level = band && band.fromC >= 10 ? ' ot-band-danger' : band && band.fromC >= 5 ? ' ot-band-warn' : '';
        return '<td class="ot-band-cell' + level + '">' + (ms ? esc(clockDuration(ms)) : '<span class="ot-matrix-zero">—</span>') + '</td>';
      }).join('');
      const evidence = count(l.intervalRecordCount) + ' 区间' + (l.openCount ? ' · ' + count(l.openCount) + ' 未结束' : '') + '<small>' + (l.lastEvidenceAt != null ? '最近 ' + esc(time(l.lastEvidenceAt)) : '无有效证据') + '</small>';
      return '<tr><td>' + pointCell(p) + '<small>起算：' + esc(lifetimeBasisText(l)) + (l.beforeStartRecordCount ? ' · 起点前 ' + count(l.beforeStartRecordCount) + ' 条未计入' : '') + '</small></td><td>' + (p.panel ? esc(p.panel) : badge('待确认', 'warn')) + '</td>' + cells + '<td class="ot-matrix-total">' + esc(clockDuration(l.durationMs)) + '</td><td>' + evidence + '</td></tr>';
    }).join('');
    return '<figure class="ot-chart ot-life-matrix"><figcaption>投产以来 × 超限分档累计 <small>按“机组 + DCS Tag 完全一致”的单个测点归集，跨月跨年持续累加</small></figcaption><div class="ot-matrix-scroll"><table class="ot-matrix"><thead><tr>' + head.map(label => '<th scope="col">' + esc(label) + '</th>').join('') + '</tr></thead><tbody>' + body + '</tbody></table></div><p class="ot-chart-tip">分档依据为每条已核定区间的最高温度相对当时有效限值的超限幅度；重叠时段只计一次并归入最高档，因此四档之和等于投产以来累计。名称或描述相同但 DCS Tag 不同的点位不合并。</p></figure>';
  }
  function renderChart(rows) {
    const values = rows.filter(row => row.summary && row.summary.durationMs > 0).sort((a, b) => b.summary.durationMs - a.summary.durationMs).slice(0, 10);
    if (!values.length) return '<figure class="ot-chart"><figcaption>测点超温排行</figcaption><p class="ot-viz-empty">尚无已结束且核定的超温区间可绘图。</p></figure>';
    const width = 820, top = 30, rowH = 46, left = 210, barW = 330;
    const max = Math.max(...values.map(row => row.summary.durationMs), 1);
    let svg = '<svg viewBox="0 0 ' + width + ' ' + (top + values.length * rowH + 8) + '" role="img" aria-label="各测点已核定超温累计时长排行">';
    values.forEach((row, i) => {
      const p = row.point, s = row.summary, y = top + i * rowH;
      const w = Math.max(2, s.durationMs / max * barW);
      svg += '<g class="ot-bar-row' + (i === 0 ? ' ot-bar-top' : '') + '" data-action="focusPoint" data-id="' + esc(p.id) + '" role="button" tabindex="0" aria-label="' + esc(p.name + '，' + formatDuration(s.durationMs) + '，' + s.recordCount + ' 条记录') + '"><title>' + esc(p.name + '：' + formatDuration(s.durationMs) + ' · ' + s.recordCount + ' 条 · 峰值 ' + degrees(s.peakC)) + '</title>' +
        '<text x="0" y="' + (y + 15) + '" class="ot-bar-label">' + esc('#' + (i + 1) + ' ' + String(p.name).slice(0, 14)) + '</text>' +
        '<text x="0" y="' + (y + 30) + '" class="ot-axis">' + esc(p.unit + '# · ' + p.tag) + '</text>' +
        '<rect x="' + left + '" y="' + (y + 2) + '" width="' + w.toFixed(1) + '" height="22" rx="5"/>' +
        '<text x="' + (left + w + 8).toFixed(1) + '" y="' + (y + 18) + '" class="ot-bar-value">' + esc(formatDuration(s.durationMs)) + '</text>' +
        '<text x="' + (width - 4) + '" y="' + (y + 18) + '" text-anchor="end" class="ot-axis">' + esc(s.recordCount + ' 条 · 峰值 ' + degrees(s.peakC)) + '</text></g>';
    });
    svg += '</svg>';
    return '<figure class="ot-chart"><figcaption>测点超温排行 · 前 ' + values.length + ' 项 <small>各点分别去重；点击条形筛选该测点</small></figcaption>' + svg + '</figure>';
  }
  function renderAnalysis() {
    if (!S.summary) return empty(S.error ? '共享累计尚未读取成功' : '尚未读取共享累计');
    const data = S.summary, s = data.summary, rows = data.byPoint;
    const hasLimits = rows.some(row => (row.configs || []).some(c => finite(c.limitC) && String(c.limitBasis || '').trim()));
    const evidenceRows = rows.filter(row => row.summary && row.summary.durationMs > 0);
    const monthly = monthPointMatrix(rows, 240), annual = yearPointMatrix(rows, 240), lifetimeRows = lifetimeMatrix(rows);
    const maxPointMs = annual.items.reduce((max, item) => Math.max(max, ...item.cells.map(cell => cell.ms)), 0);
    const maxLifetimeMs = lifetimeRows.reduce((max, item) => Math.max(max, item.lifetime.durationMs), 0);
    const missingCommission = lifetimeRows.filter(item => item.lifetime.basis === 'earliest_record').length;
    const beforeStart = lifetimeRows.reduce((sum, item) => sum + (item.lifetime.beforeStartRecordCount || 0), 0);
    const maxPointText = !s.recordCount ? '无有效登记' : !hasLimits ? '限值未配' : maxPointMs ? formatDuration(maxPointMs) : '无有效登记';
    const cards = [['超温点位', count(evidenceRows.length), '每个测点单独累计；同一测点不同时间都相加'], ['单点最长年累计', maxPointText, '取各测点单个年度的合计最大值，不合并不同测点'], ['单点投产以来最长', maxLifetimeMs ? formatDuration(maxLifetimeMs) : '无有效登记', '按精确点位分别累计，不同测点不相加'], ['涉及月份', count(monthly.months.length), '跨 ' + count(annual.years.length) + ' 个年度；按测点出现超温的自然月统计'], ['有效人工记录', count(s.recordCount), '时点 ' + count(s.observationCount) + ' / 区间 ' + count(s.intervalRecordCount) + ' · 未结束 ' + count(s.openCount)], ['窗口内确定峰值', degrees(s.peakC), s.peakIncludesObservations ? '含人工时点观察，不据此推算时长' : '完整覆盖记录提供的峰值'], ['最大确定超限', degrees(s.maxExcessC), '使用各记录生效时的有据限值']];
    let html = '<div class="ot-stats">' + cards.map(([label, value, help]) => '<article class="ot-stat ot-panel"><h3>' + esc(label) + '</h3><strong>' + esc(value) + '</strong><small>' + esc(help) + '</small></article>').join('') + '</div>';
    if (s.partialPeak || s.partial || s.peakFromClippedInterval || finite(s.estimatedPeakC)) html += '<div class="ot-caution">部分区间被筛选边界裁剪。原完整区间峰值参考：' + esc(degrees(s.estimatedPeakC)) + '；它不是本窗口确定峰值，不用于声称窗口最大超限。</div>';
    const activePoints = rows.filter(row => row.summary && row.summary.recordCount > 0).length;
    html += '<p class="ot-help">测点 ' + rows.length + ' 个 · 有超温证据 ' + count(activePoints) + ' 个 · 待确认映射 ' + rows.filter(row => { const c = core().resolveConfig(row.configs || [], row.point.id, now()); return !c || !c.mappingConfirmed; }).length + ' 个 · 最新记录 ' + esc(time(s.latestAt)) + '。手工登记未覆盖的时间不能解释为未超温。</p>';
    if (S.tubeCode) html += '<p class="ot-caution">管段条件仅用于本页累计摘要，按记录引用的历史映射匹配；此处为区域历史，当前管换管后统计请查看管段档案。台账与记录页仍按上方筛选，不冒充本管独占记录。</p>';
    if (s.excludedIntervalCount) html += '<p class="ot-warning">有 ' + esc(s.excludedIntervalCount) + ' 条区间未纳入累计，请检查核定状态和版本依据。</p>';
    if (!rows.length) return html + empty('当前筛选条件下没有已登记测点或关联记录', '新增测点', 'newPoint');
    html += '<p class="ot-help">累计口径：测点身份以“机组 + DCS Tag”完全一致为准；同一测点的不同时间区间先按时间并集累加，形成月度合计；同一测点的各月合计再按年度累加，投产以来累计再跨年度持续累加且不受上方时间筛选限制。不同测点即使名称或描述相同也独立统计，不合并。</p>';
    html += '<section class="ot-panel ot-viz-card ot-matrix-card">' + renderYearPointMatrix(rows) + '</section>';
    html += '<section class="ot-panel ot-viz-card ot-matrix-card">' + renderMonthPointMatrix(rows) + '</section>';
    html += '<p class="ot-help">规范口径：DL/T 654-2022《火电机组寿命评估技术导则》和 GB/T 30580-2022《电站锅炉主要承压部件寿命评估技术导则》采用线性损伤累积、Larson-Miller 参数等专业方法评定寿命，需材料、金属壁温、应力与运行小时等输入。下方超限幅度分档是筛查模板，不是规范强制阈值，也不能折算成寿命损耗或剩余寿命。</p>';
    html += '<section class="ot-panel ot-viz-card ot-matrix-card">' + renderLifetimeMatrix(rows) + '</section>';
    if (missingCommission) html += '<p class="ot-caution">' + count(missingCommission) + ' 个测点未登记投产日期，投产以来累计暂从各自最早登记记录起算，是偏小的下限值；补填投产日期后需按新起点复核。</p>';
    if (beforeStart) html += '<p class="ot-warning">有 ' + count(beforeStart) + ' 条记录早于投产以来累计的起算日期，已整条排除；请核对投产日期或记录日期。</p>';
    html += '<div class="ot-viz-grid"><section class="ot-panel ot-viz-card">' + renderMonthlyPointTrend(rows) + '</section><section class="ot-panel ot-viz-card">' + renderHeatmap(s.intervals) + '</section></div>';
    html += '<section class="ot-panel">' + renderChart(rows.slice()) + '</section>';
    const pageRows = rows.slice(S.page * PAGE_SIZE, (S.page + 1) * PAGE_SIZE);
    html += table(['测点', '证据状态', '窗口内累计', '投产以来累计', '最长连续', '确定峰值 / 超限', '记录 / 未结束', '最近记录', '操作'], pageRows.map(row => { const p = row.point, sum = row.summary || {}, life = row.lifetime || null; const limitKnown = (row.configs || []).some(c => finite(c.limitC) && String(c.limitBasis || '').trim()); return '<tr><td>' + pointCell(p) + '</td><td>' + pointState(p, sum, row.configs) + '</td><td>' + esc(!sum.recordCount ? '无有效登记' : !limitKnown ? '限值未配，不可判定' : formatDuration(sum.durationMs)) + '</td><td>' + (life && life.recordCount ? esc(clockDuration(life.durationMs)) + '<small>' + esc(lifetimeBasisText(life)) + '</small>' : '—') + '</td><td>' + esc(!sum.recordCount || !limitKnown ? '—' : formatDuration(sum.longestMs)) + '</td><td>' + esc(degrees(sum.peakC)) + '<small>超限 ' + esc(degrees(sum.maxExcessC)) + '</small>' + (sum.partialPeak ? badge('有裁剪区间', 'warn') : '') + '</td><td>' + count(sum.recordCount) + ' / ' + count(sum.openCount) + '</td><td>' + esc(time(sum.latestAt)) + '</td><td>' + pointButtons(p) + '</td></tr>'; }));
    return html + pager(rows.length, (S.page + 1) * PAGE_SIZE < rows.length);
  }
  function renderPoints() {
    if (!S.list || !S.list.items.length) return empty(S.error ? '共享测点尚未读取成功' : '当前筛选条件下没有测点', '新增测点 / 批量建点', 'newPoint');
    return table(['测点', '测量类型 / 位置', '管屏（检修确认）', '投产日期', '当前配置', '证据状态', '修订 / 更新时间', '操作'], S.list.items.map(p => { const c = currentConfig(p), row = summaryRow(p.id); return '<tr><td>' + pointCell(p) + '</td><td>' + esc(TYPES[p.measurementType] || p.measurementType) + '<small>' + esc(p.location || '位置待填写') + '</small></td><td>' + (p.panel ? esc(p.panel) : badge('待确认', 'warn')) + '</td><td>' + (finite(p.commissionedAt) ? esc(dateValue(p.commissionedAt)) : badge('未登记', 'warn')) + '</td><td>' + (c ? '版本 ' + esc(c.revision) + ' · ' + esc(degrees(c.limitC)) + '<small>自 ' + esc(time(c.effectiveFrom)) + '</small>' : '尚无已生效配置') + '</td><td>' + pointState(p, row && row.summary) + '</td><td>r' + esc(p.revision) + '<small>' + esc(time(p.updatedAt)) + '</small></td><td>' + pointButtons(p) + '</td></tr>'; })) + pager(S.total, S.next);
  }
  function renderRecords() {
    if (!S.list || !S.list.items.length) return empty(S.error ? '共享记录尚未读取成功' : '当前筛选条件下没有温度记录', '登记真实温度', 'newRecord');
    return '<p class="ot-help">包含作废记录以保留痕迹；作废记录不参与累计。当前页不是全部数据，使用分页查看。</p>' + table(['测点 / 类型', '时点或区间（北京时间）', '温度 / 版本限值', '核定状态', '依据 / 备注', '修订 / 操作'], S.list.items.map(r => { const p = S.points.get(r.pointId), c = S.configs.get(r.configId); return '<tr' + (r.status === 'void' ? ' class="ot-void-row"' : '') + '><td>' + (p ? pointCell(p) : esc(r.pointId)) + '<small>' + (r.kind === 'observation' ? '时点观察 · 不累计' : '人工超温区间') + '</small></td><td>' + esc(time(r.startAt)) + (r.kind === 'interval' ? '<small>至 ' + (r.endAt == null ? '未结束（不累计）' : esc(time(r.endAt))) + '</small>' : '') + '</td><td>' + esc(degrees(r.temperatureC)) + '<small>限值 ' + esc(degrees(c && c.limitC)) + ' / v' + esc(c ? c.revision : '?') + '</small></td><td>' + (r.status === 'void' ? badge('已作废', 'warn') : r.kind === 'observation' ? badge('观察 · 不累计') : r.endAt == null ? badge('未结束 · 不累计', 'warn') : r.verified ? badge('人工核定', 'danger') : badge('未核定 · 不累计', 'warn')) + '</td><td class="ot-note-cell">' + esc(r.note || '—') + '</td><td>r' + esc(r.revision) + '<div class="ot-row-actions">' + (r.status !== 'void' ? action('更正', 'editRecord', r.id) + action('作废', 'void', r.id) : '') + action('历史', 'historyRecord', r.id) + '</div></td></tr>'; })) + pager(S.total, S.next);
  }
  function renderContent() { if (S.root) S.root.querySelector('#ot-content').innerHTML = !core() ? empty('等待核心校验模块') : S.tab === 'analysis' ? renderAnalysis() : S.tab === 'points' ? renderPoints() : renderRecords(); }
  function blankRegion(sys, comp) { const r = {}; REGION_KEYS.forEach(k => { r[k] = null; }); r.sys = sys || ''; r.comp = comp || ''; return r; }
  function openDraft(type, entity) {
    if (!core()) { renderSync(); return; }
    if (S.saving) return;
    if (S.import) S.import = null;
    if ((S.draft || S.storedDraft) && !window.confirm('将替换当前未共享草稿。是否继续？')) return;
    const d = { version: 1, type, entityId: uid(), data: {}, point: null, original: null, pending: null };
    if (type === 'point') d.data = { mode: 'single', unit: S.filters.unit, tag: '', name: '', measurementType: 'tube_wall', location: '', panel: '', commissionedAt: '', namePrefix: '', seqStart: '', seqEnd: '' };
    if (type === 'editPoint') { d.point = clone(entity); d.data = { name: entity.name, location: entity.location || '', panel: entity.panel || '', commissionedAt: dateValue(entity.commissionedAt), active: entity.active !== false, reason: '' }; }
    if (type === 'config') { d.point = clone(entity); d.data = { effectiveFrom: '', limitC: '', limitBasis: '', mappingConfirmed: false, mappingBasis: '', regions: [], reason: '', confirmBasis: false }; }
    if (type === 'record' || type === 'void') {
      const record = entity && entity.kind ? entity : null;
      const point = record ? S.points.get(record.pointId) : entity && entity.id ? entity : S.points.get(S.filters.pointId);
      d.point = point ? clone(point) : null; d.original = record ? clone(record) : null;
      d.data = { pointId: record ? record.pointId : point ? point.id : '', kind: record ? record.kind : 'observation', startAt: record ? core().toInputTime(record.startAt) : '', endAt: record && record.endAt != null ? core().toInputTime(record.endAt) : '', temperatureC: record ? String(record.temperatureC) : '', verified: record ? record.verified : false, note: record ? record.note : '', reason: '' };
    }
    S.draft = d; S.formErrors = []; S.conflict = null; S.preview = null; persist(); renderForm();
    const el = S.root.querySelector('#ot-composer'); if (el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const first = el.querySelector('input:not([disabled]),select:not([disabled]),textarea'); if (first) first.focus({ preventScroll: true });
  }
  function renderPointForm(d) {
    const v = d.data;
    if (d.type === 'editPoint') return '<p class="ot-help">' + esc(d.point.unit) + '# · ' + esc(d.point.tag) + ' · ' + esc(TYPES[d.point.measurementType]) + '（机组和测量类型不可改；已有配置后 DCS Tag 作为终身身份不可改）</p><div class="ot-form-grid">' + field('名称', input('name', v.name, 'text', 'required maxlength="120"')) + field('位置', input('location', v.location, 'text', 'maxlength="240"')) + field('管屏（可空）', input('panel', v.panel, 'text', 'maxlength="100" placeholder="检修时现场确认后补填"')) + field('投产日期（可空）', input('commissionedAt', v.commissionedAt, 'date'), '用于“投产以来”累计；留空则从最早登记记录起算并标注。') + '</div><label class="ot-check"><input name="active" type="checkbox"' + checked(v.active) + '>启用测点（停用保留全部记录与历史）</label>' + field('编辑原因（必填）', textarea('reason', v.reason, 'required maxlength="1000"'));
    return '<div class="ot-form-grid">' + field('创建方式', '<select name="mode">' + option('single', '单个测点', v.mode) + option('batch', '按名称序号批量创建', v.mode) + '</select>') + field('机组（必选单机组）', '<select name="unit" required>' + option('', '请选择机组', v.unit) + option('1', '1# 机组', v.unit) + option('2', '2# 机组', v.unit) + '</select>') + field('测量类型（创建后不可改）', '<select name="measurementType">' + Object.keys(TYPES).map(key => option(key, TYPES[key], v.measurementType)).join('') + '</select>') + (v.mode === 'batch' ? field('名称前缀', input('namePrefix', v.namePrefix, 'text', 'required maxlength="110" placeholder="如：低过出口集箱"')) + field('开始序号', input('seqStart', v.seqStart, 'number', 'required min="1" step="1"')) + field('结束序号', input('seqEnd', v.seqEnd, 'number', 'required min="1" step="1"')) : field('名称', input('name', v.name, 'text', 'required maxlength="120"')) + field('编号 / DCS Tag', input('tag', v.tag, 'text', 'maxlength="120"'), '可空；由服务端产生内部编号，不猜测 DCS Tag。')) + field('位置', input('location', v.location, 'text', 'maxlength="240"')) + (v.mode === 'batch' ? '' : field('管屏（可空）', input('panel', v.panel, 'text', 'maxlength="100" placeholder="暂不确定可留空，检修时补填"')) + field('投产日期（可空）', input('commissionedAt', v.commissionedAt, 'date'), '用于“投产以来”累计；留空则从最早登记记录起算并标注。')) + '</div><div class="ot-caution">' + (v.mode === 'batch' ? '批量最多 100 个，使用名称前缀 + 序号；编号由服务端生成，投产日期请在逐点编辑中补填。' : '') + '创建只登记测点，不自动建立真实区域、映射、限值或温度数值。保存后可逐点配置区域/限值；管屏可留空，待机组检修时现场确认。</div>';
  }
  function rangeValues(pair) { if (!pair) return []; return Array.from({ length: pair[1] - pair[0] + 1 }, (_, i) => pair[0] + i); }
  function regionField(index, key, label, html, help) { return field(label, html.replace('<select', '<select data-region="' + index + '" data-key="' + key + '"').replace('<input', '<input data-region="' + index + '" data-key="' + key + '"'), help); }
  function regionMulti(index, key, label, values, value) {
    return regionField(index, key, label, '<select multiple size="3" aria-label="' + esc(label) + '">' + '<option value=""' + (value === null ? ' selected' : '') + '>全部（null）</option>' + values.map(v => '<option value="' + esc(v) + '"' + (Array.isArray(value) && value.map(String).includes(String(v)) ? ' selected' : '') + '>' + esc(v) + '</option>').join('') + '</select>', '选“全部”则忽略其他选项；可 Ctrl / Command 多选。');
  }
  function renderRegion(r, index) {
    const all = matrix(), candidates = all.filter(row => row.sys === r.sys && row.comp === r.comp), rows = candidates.filter(row => !r.wall || row.pos === r.wall);
    const has = key => rows.some(row => !!row[key]);
    let html = '<fieldset class="ot-region"><legend>区域 ' + (index + 1) + '</legend><div class="ot-region-actions">' + action('删除本区域', 'removeRegion', index) + (r.sys ? action('查看受热面图纸', 'drawings', r.sys) : '') + '</div><div class="ot-form-grid">';
    html += regionField(index, 'sys', '系统 / 受热面', '<select required>' + option('', '请选择系统', r.sys) + unique(all.map(row => row.sys)).map(sys => option(sys, systemLabel(sys) + ' · ' + sys, r.sys)).join('') + '</select>');
    html += regionField(index, 'comp', '矩阵部件', '<select required>' + option('', '请选择矩阵支持的部件', r.comp) + unique(all.filter(row => row.sys === r.sys).map(row => row.comp)).map(comp => { const row = all.find(row => row.sys === r.sys && row.comp === comp); return option(comp, comp + ' · ' + row.name.replace(/[-（].*/, ''), r.comp); }).join('') + '</select>');
    if (candidates.some(row => row.pos)) html += regionField(index, 'wall', '墙位', '<select>' + option('', '全部墙位（null）', r.wall || '') + candidates.filter(row => row.pos).map(row => option(row.pos, row.name + ' · ' + row.pos, r.wall)).join('') + '</select>');
    if (has('spaces')) html += regionMulti(index, 'spaces', '空间集合', unique(rows.flatMap(row => rangeValues(row.spaces))), r.spaces);
    [['pMax', 'posFrom', 'posTo', '排 / 屏'], ['p2Max', 'pos2From', 'pos2To', '小屏'], ['tMax', 'tubeFrom', 'tubeTo', '管 / 回路']].forEach(([maxKey, from, to, title]) => { if (!has(maxKey)) return; const max = Math.min(...rows.filter(row => row[maxKey]).map(row => row[maxKey])); const direction = maxKey === 'pMax' ? (rows[0].posLetters || [])[0] : maxKey === 'p2Max' ? (rows[0].pos2Letters || [])[0] : ''; html += regionField(index, from, title + '开始' + (direction ? '（规范 ' + direction + '）' : ''), input('', r[from], 'number', 'step="1" min="1" max="' + max + '" placeholder="全部"'), '留空为全部下界；支持 1–' + max); html += regionField(index, to, title + '结束', input('', r[to], 'number', 'step="1" min="1" max="' + max + '" placeholder="全部"'), '留空为全部上界'); });
    if (has('dirs')) html += regionMulti(index, 'dirs', '规范方向（不是现场反向编号）', unique(rows.flatMap(row => row.dirs ? row.loopPairing ? row.dirs : row.dirs.slice(0, 1) : [])), r.dirs);
    if (rows.length) html += regionMulti(index, 'parts', '部位：Q 管子 / W 弯头', ['Q', 'W'], r.parts);
    if (has('corners')) html += regionMulti(index, 'corners', '燃烧器角', unique(rows.flatMap(row => rangeValues(row.corners))), r.corners);
    if (has('layers')) html += regionMulti(index, 'layers', '燃烧器层', unique(rows.flatMap(row => row.layers || [])), r.layers);
    if (has('nozzles')) html += regionMulti(index, 'nozzles', '燃烧器喷口', unique(rows.flatMap(row => rangeValues(row.nozzles))), r.nozzles);
    html += '</div><p class="ot-help">仅矩阵已确认范围可选。null 明确表示全部；排/屏按规范方向编号，非悬挂反向先换算；悬挂 F/B 分腿、W 归 F。现场待核范围不能当作已确认映射。</p></fieldset>';
    return html;
  }
  function renderConfigForm(d) {
    const v = d.data;
    return '<p><strong>' + esc(d.point.unit + '# · ' + d.point.name) + '</strong> · 本次新增不可变版本，旧版本保留。</p><div class="ot-form-grid">' + field('实际生效时间（北京时间，必填）', input('effectiveFrom', v.effectiveFrom, 'datetime-local', 'required step="1"'), '补历史记录需选择此前有依据的真实生效时间；不默认回填，不可跨越已登记记录。') + field('温度限值 ℃（可空）', input('limitC', v.limitC, 'number', 'step="any" placeholder="未配置，不代表 0"')) + field('限值依据（有值时必填）', textarea('limitBasis', v.limitBasis, 'maxlength="2000" placeholder="技术文件 / 页码 / 批准记录等"')) + field('映射依据（确认映射时必填）', textarea('mappingBasis', v.mappingBasis, 'maxlength="2000" placeholder="图纸编号、测点清单、现场核实依据等"')) + '</div><label class="ot-check"><input type="checkbox" name="mappingConfirmed"' + checked(v.mappingConfirmed) + '>已依据资料确认测点与以下区域对应（默认不确认）</label><div id="ot-regions">' + v.regions.map(renderRegion).join('') + '</div><div class="ot-actions">' + action('添加结构化区域', 'addRegion') + action('校验并预览命中范围', 'previewRegions', null, 'btn-primary') + '</div><div id="ot-region-preview" class="ot-region-preview"></div>' + field('新增版本原因（必填）', textarea('reason', v.reason, 'required maxlength="1000"')) + '<label class="ot-check"><input type="checkbox" name="confirmBasis"' + checked(v.confirmBasis) + '>保存前已核对生效时间、区域预览与限值 / 映射依据，不凭名称推断。</label><p class="ot-help">本机预检之外，服务端会以完整历史再次校验跨版本边界；历史记录不会被静默重分配。</p>';
  }
  function renderRecordForm(d) {
    const v = d.data;
    if (d.type === 'void') return '<div class="ot-caution">作废而不删除，记录及所有修订仍可审计。' + esc(time(d.original.startAt)) + ' · ' + esc(degrees(d.original.temperatureC)) + '</div>' + field('作废原因（必填）', textarea('reason', v.reason, 'required maxlength="1000"'));
    return '<div class="ot-form-grid">' + field('已登记测点', '<select name="pointId" required' + (d.original ? ' disabled' : '') + '>' + pointOptions(v.pointId, '', !d.original) + '</select>', '未列出的测点可在筛选区继续加载选项；停用点不能新增记录。') + field('记录类型', '<select name="kind">' + option('observation', '时点观察（不累计）', v.kind) + option('interval', '人工核定超温区间', v.kind) + '</select>') + field(v.kind === 'observation' ? '观察时点（北京时间）' : '区间开始（北京时间）', input('startAt', v.startAt, 'datetime-local', 'required step="1"')) + (v.kind === 'interval' ? field('区间结束（北京时间，可空）', input('endAt', v.endAt, 'datetime-local', 'step="1"'), '未结束只登记状态，不累计持续时长。') : '') + field(v.kind === 'observation' ? '观察温度 ℃' : '区间最高温度 ℃', input('temperatureC', v.temperatureC, 'number', 'required step="any"')) + '</div><div id="ot-record-context" class="ot-caution"></div>' + (v.kind === 'interval' ? '<label class="ot-check"><input type="checkbox" name="verified"' + checked(v.verified) + '>整个区间均经人工核定超温，而不只是记录了一个峰值（已结束区间必选）</label>' : '<p class="ot-help">观察只证明该时点的温度，不据此推算任何超温时长。</p>') + field(v.kind === 'interval' ? '核定依据 / 备注（区间必填）' : '备注', textarea('note', v.note, (v.kind === 'interval' ? 'required ' : '') + 'maxlength="4000"')) + (d.original ? field('更正原因（必填）', textarea('reason', v.reason, 'required maxlength="1000"')) : '');
  }
  /* ---------- 导入：基础测点台账 / 月度超温报表 ---------- */
  function importCore() { return window.BTOvertemperatureImport; }
  function delimiterFor(text) {
    const first = String(text || '').split(/\r?\n/, 1)[0] || '';
    return (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : ',';
  }
  function parseDelimited(text) {
    const source = String(text || '').replace(/^\uFEFF/, ''), delimiter = delimiterFor(source);
    const rows = []; let row = [], cell = '', quoted = false;
    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i];
      if (quoted) {
        if (ch === '"') { if (source[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false; }
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delimiter) { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); if (row.some(value => String(value).trim() !== '')) rows.push(row); row = []; cell = ''; }
      else if (ch !== '\r') cell += ch;
    }
    row.push(cell);
    if (row.some(value => String(value).trim() !== '')) rows.push(row);
    return rows;
  }
  async function matrixFromFile(file) {
    const name = String(file && file.name || '').toLowerCase();
    if (/\.csv$/.test(name)) {
      const buffer = await file.arrayBuffer();
      let content = new window.TextDecoder('utf-8').decode(buffer);
      if (content.includes('\uFFFD')) {
        try { content = new window.TextDecoder('gbk').decode(buffer); } catch (_) { /* 保留 UTF-8 结果 */ }
      }
      return parseDelimited(content);
    }
    if (!window.BTLazy) throw fail('表格解析组件未加载，请刷新页面');
    await window.BTLazy.ensure('xlsx');
    if (!window.XLSX) throw fail('表格解析组件未加载，请刷新页面');
    const workbook = window.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw fail('文件中没有可读取的工作表');
    return window.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  }
  async function ensureAllPoints() {
    if (S.allPointsLoaded) return;
    let cursor = '';
    do {
      const data = await request('/points' + query({ limit: 100, cursor }));
      if (!Array.isArray(data.items)) throw fail('测点接口响应不完整，无法建立导入匹配');
      accept(data);
      data.items.forEach(p => { S.points.set(p.id, p); S.options.add(p.id); });
      cursor = data.nextCursor || '';
    } while (cursor);
    S.allPointsLoaded = true; S.optionsLoaded = true; S.optionTotal = S.points.size;
  }
  async function loadExistingFingerprints(items) {
    const valid = items.filter(item => Number.isSafeInteger(item.startAt) && Number.isSafeInteger(item.endAt));
    if (!valid.length) return new Set();
    const from = Math.min(...valid.map(item => item.startAt));
    const to = Math.max(...valid.map(item => item.endAt)) + 1;
    const fingerprints = new Set();
    const units = unique(valid.map(item => item.unit).filter(unit => unit === '1' || unit === '2'));
    for (const unit of units) {
      let cursor = '';
      do {
        const data = await request('/records' + query({ unit, from, to, limit: 100, cursor, includeVoid: 'true' }));
        (data.items || []).forEach(record => {
          if (record.kind === 'interval' && record.endAt != null) fingerprints.add([record.pointId, record.startAt, record.endAt, 'interval'].join('|'));
        });
        cursor = data.nextCursor || '';
      } while (cursor);
    }
    return fingerprints;
  }
  async function ensureImportCore() {
    if (importCore()) return importCore();
    if (!window.BTLazy) throw fail('导入模块尚未加载，请刷新页面后重试。');
    if (!importLoad) importLoad = window.BTLazy.ensure('overtemperature-import').finally(() => { importLoad = null; });
    await importLoad;
    if (!importCore()) throw fail('导入模块尚未加载，请刷新页面后重试。');
    return importCore();
  }
  async function startImport(kind) {
    if (!core() || S.saving) return;
    if (S.draft && !window.confirm('导入会替换当前未共享草稿。是否继续？')) return;
    const draft = S.draft, tab = S.tab;
    await ensureImportCore();
    if (S.saving || S.draft !== draft || S.tab !== tab || !active()) return;
    S.draft = null;
    S.import = { kind: kind, fileName: '', rows: null, summary: null, confirmed: false, busy: false, error: '', result: null, progress: null };
    renderForm();
    const el = S.root.querySelector('#ot-composer'); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function importStatus(status) {
    if (status === 'duplicate') return badge('跳过', 'muted');
    if (status === 'error') return badge('需处理', 'danger');
    return '<span class="ot-badge">可导入</span>';
  }
  function importMessages(row) { return (row.messages || []).join('；'); }
  function renderImportPreview(imp) {
    const s = imp.summary || { ok: 0, duplicate: 0, error: 0, total: 0 };
    const autoRows = (imp.rows || []).filter(row => row.willCreate).length;
    const cards = [['可导入', count(s.ok), '写入共享台账'], ['跳过', count(s.duplicate), '已存在或文件内重复'], ['需处理', count(s.error), '未匹配 / 缺配置 / 数据无效']];
    if (imp.kind === 'report' && autoRows) cards.splice(1, 0, ['自动建点', count(autoRows), '未登记点位；管屏留空待确认']);
    let html = '<div class="ot-stats">' + cards.map(([label, value, help]) => '<article class="ot-stat ot-panel"><h3>' + esc(label) + '</h3><strong>' + esc(value) + '</strong><small>' + esc(help) + '</small></article>').join('') + '</div>';
    html += '<p class="ot-help">文件来源：' + esc(imp.fileName || '粘贴内容') + ' · 共 ' + count(s.total) + ' 行；下表仅显示前 50 行。</p>';
    if (s.ok > 0) html += '<label class="ot-check"><input type="checkbox" id="ot-import-confirm"' + checked(imp.confirmed) + '>' + (autoRows ? '已核对文件来源和点位；未登记点位将按报表自动建点（管屏留空，待检修确认），确认写入共享台账' : '已核对文件来源、点位匹配和限值，确认写入共享台账') + '</label>';
    html += '<div class="ot-actions">' + (s.ok > 0 ? '<button class="btn btn-primary" type="button" data-action="runImport"' + (imp.busy ? ' disabled' : '') + '>开始导入 ' + count(s.ok) + ' 条</button>' : '') + action('取消导入', 'closeImport') + '</div>';
    if (imp.progress) html += '<p class="ot-help" role="status">正在写入 ' + count(imp.progress.done) + ' / ' + count(imp.progress.total) + ' 条…</p>';
    const rows = (imp.rows || []).slice(0, 50);
    if (imp.kind === 'points') {
      return html + table(['状态', '行', '机组', 'DCS Tag', '测点名称', '类型', '投产日期', '限值 / 管屏', '说明'], rows.map(row => '<tr><td>' + importStatus(row.status) + '</td><td>' + esc(row.item.row) + '</td><td>' + esc(row.item.unit) + '#</td><td>' + esc(row.item.tag) + '</td><td>' + esc(row.item.name) + '</td><td>' + esc(TYPES[row.item.measurementType] || row.item.measurementType) + '</td><td>' + esc(finite(row.item.commissionedAt) ? dateValue(row.item.commissionedAt) : '—') + '</td><td>' + esc(degrees(row.item.limitC)) + '<small>' + esc(row.item.panel || '管屏待确认') + '</small></td><td>' + esc(importMessages(row)) + '</td></tr>'));
    }
    return html + table(['状态', '行', '点位', '开始', '结束', '最值', '限值 / 管屏', '说明'], rows.map(row => '<tr><td>' + (row.willCreate ? badge('自动建点', 'warn') : importStatus(row.status)) + '</td><td>' + esc(row.item.row) + '</td><td>' + esc(row.item.tag) + '<small>' + esc(row.item.name) + '</small></td><td>' + esc(time(row.item.startAt)) + '</td><td>' + esc(time(row.item.endAt)) + '</td><td>' + esc(degrees(row.item.temperatureC)) + '</td><td>' + esc(degrees(row.item.limitC)) + '<small>' + (row.willCreate ? '管屏待确认' : '已登记测点') + '</small></td><td>' + esc(importMessages(row) || (row.willCreate ? '未登记点位，导入时自动建点' : '')) + '</td></tr>'));
  }
  function renderImportResult(imp) {
    const r = imp.result;
    let html = '<div class="ot-alert"><strong>导入完成</strong> 已导入 ' + count(r.created) + ' 条；跳过 ' + count(r.skipped) + ' 条；失败 ' + count((r.failed || []).length) + ' 条。' + (r.createdPoints ? ' 自动建点 ' + count(r.createdPoints) + ' 个（管屏留空，待检修确认）。' : '') + '</div>';
    if (r.failed && r.failed.length) html += '<div class="ot-alert"><ul>' + r.failed.map(item => '<li>行 ' + esc(item.row || '—') + '：' + esc(item.message) + '</li>').join('') + '</ul></div>';
    return html + '<div class="ot-actions">' + action('关闭导入', 'closeImport') + action('刷新共享数据', 'refresh') + '</div>';
  }
  function renderImport() {
    const host = S.root && S.root.querySelector('#ot-composer'), imp = S.import;
    if (!host) return;
    if (!imp) { if (!S.draft) host.innerHTML = ''; return; }
    const isPoints = imp.kind === 'points';
    const title = isPoints ? '导入基础测点台账' : '导入月度超温报表';
    let html = '<section class="ot-panel ot-composer" aria-label="' + title + '"><div class="ot-section-head"><h3>' + title + '</h3>' + action('关闭导入', 'closeImport') + '</div>';
    html += '<p class="ot-help">' + (isPoints
      ? '支持 CSV / XLS / XLSX。按“机组 + DCS Tag”建点；已有 Tag 跳过，不覆盖；限值写入新配置（基线生效时间 2000-01-01），映射保持待确认。'
      : '支持 DCS 月报 .xls / .xlsx / CSV。按“点位”匹配已登记测点；未登记点位自动建点（管屏留空，待检修确认），预览确认后才写入，相同区间自动跳过。') + '</p>';
    if (!imp.rows && !imp.result) {
      html += '<div class="ot-form-grid">' + field('选择文件', '<input id="ot-import-file" type="file" accept=".csv,.xls,.xlsx"' + (imp.busy ? ' disabled' : '') + '>', isPoints ? '列：机组、DCS Tag、测点名称、测量类型、安装位置、温度限值(℃)、限值依据' : '列：点位、描述、限值、最值、开始时间、结束时间、总时长(秒)') + field('或粘贴 CSV', '<textarea id="ot-import-text" rows="6" placeholder="' + esc(isPoints ? '机组,DCS Tag,测点名称,测量类型,安装位置,温度限值(℃),限值依据' : '点位,描述,限值,最值,开始时间,结束时间,总时长(秒)') + '"></textarea>') + '</div>';
      html += '<div class="ot-actions">' + action('解析粘贴内容', 'parseImportText', null, 'btn-primary') + (imp.busy ? '<span class="ot-help" role="status">正在读取文件…</span>' : '') + '</div>';
    } else if (imp.result) {
      html += renderImportResult(imp);
    } else {
      html += renderImportPreview(imp);
    }
    if (imp.error) html += '<div class="ot-alert">' + esc(imp.error) + '</div>';
    host.innerHTML = html + '</section>';
  }
  async function buildImportPreview(matrix, fileName) {
    const imp = S.import;
    if (!imp) throw fail('导入模块不可用，请刷新页面');
    const api = await ensureImportCore();
    await ensureAllPoints();
    if (imp.kind === 'points') {
      const parsed = api.normalizePointMatrix(matrix, core().parseTime);
      const existing = new Set(knownPoints().map(p => p.unit + '|' + String(p.tag || '').toUpperCase()));
      const evaluated = api.evaluatePoints(parsed.items, existing);
      imp.rows = evaluated.rows; imp.summary = evaluated.summary;
    } else {
      const parsed = api.normalizeReportMatrix(matrix, core().parseTime);
      const existing = await loadExistingFingerprints(parsed.items);
      const pointsByTag = {};
      knownPoints().forEach(p => { pointsByTag[p.unit + '|' + String(p.tag || '').toUpperCase()] = p; });
      const evaluated = api.evaluateReport(parsed.items, { core: core(), now: now(), pointsByTag, configsFor, existing, autoCreate: true });
      imp.rows = evaluated.rows; imp.summary = evaluated.summary;
    }
    imp.fileName = fileName || '粘贴内容';
    imp.confirmed = false; imp.progress = null; imp.error = '';
  }
  async function loadImportFile(file) {
    const imp = S.import; if (!imp || !file) return;
    imp.busy = true; imp.error = ''; imp.result = null; renderForm();
    try { await buildImportPreview(await matrixFromFile(file), file.name); }
    catch (e) { imp.error = e.message || String(e); }
    finally { imp.busy = false; renderForm(); }
  }
  async function parseImportText() {
    const imp = S.import; if (!imp) return;
    const el = S.root.querySelector('#ot-import-text');
    const raw = el ? el.value : '';
    if (!String(raw).trim()) { imp.error = '请先粘贴 CSV 内容，或选择文件'; renderForm(); return; }
    imp.busy = true; imp.error = ''; imp.result = null; renderForm();
    try { await buildImportPreview(parseDelimited(raw), '粘贴内容'); }
    catch (e) { imp.error = e.message || String(e); }
    finally { imp.busy = false; renderForm(); }
  }
  async function importPoints(imp, summary) {
    const api = importCore(), items = imp.rows.filter(row => row.importable).map(row => row.item);
    let created = 0; const failed = [];
    for (let offset = 0; offset < items.length; offset += 100) {
      const chunk = items.slice(offset, offset + 100);
      const points = chunk.map(item => {
        const point = { unit: item.unit, tag: item.tag, name: item.name, measurementType: item.measurementType, location: item.location, panel: item.panel || '', active: item.active };
        if (item.commissionedAt !== null && item.commissionedAt !== undefined) point.commissionedAt = item.commissionedAt;
        if (item.limitC !== null) point.config = { effectiveFrom: core().parseTime('2000-01-01T00:00:00'), regions: [], mappingConfirmed: false, mappingBasis: '', limitC: item.limitC, limitBasis: item.limitBasis };
        return point;
      });
      const body = { points: points, reason: '导入基础温度测点台账：' + (imp.fileName || '文件') };
      const requestId = api.stableId('imp', [JSON.stringify(body)]);
      try {
        const result = await request('/points', { method: 'POST', body: Object.assign({ requestId }, body) });
        created += (result.items || []).length;
      } catch (e) {
        failed.push({ row: chunk.map(item => item.row).join(','), message: e.message });
      }
    }
    return { created, skipped: summary.duplicate, failed };
  }
  async function importRecords(imp, summary) {
    const api = importCore(), rows = imp.rows.filter(row => row.importable);
    let created = 0, skipped = summary.duplicate, createdPoints = 0; const failed = [];
    const createGroups = new Map();
    rows.filter(row => row.willCreate).forEach(row => {
      const key = row.item.unit + '|' + String(row.item.tag || '').toUpperCase();
      if (!createGroups.has(key)) createGroups.set(key, { item: row.item, point: row.draftPoint, rows: [] });
      createGroups.get(key).rows.push(row);
    });
    if (createGroups.size) {
      const groups = Array.from(createGroups.values());
      imp.progress = { done: 0, total: groups.length, phase: '自动建点' };
      for (let offset = 0; offset < groups.length; offset += 100) {
        const chunk = groups.slice(offset, offset + 100);
        const points = chunk.map(group => ({
          unit: group.point.unit, tag: group.point.tag, name: group.point.name,
          measurementType: group.point.measurementType, location: '', panel: '', active: true,
          config: {
            effectiveFrom: core().parseTime('2000-01-01T00:00:00'), regions: [], mappingConfirmed: false, mappingBasis: '',
            limitC: group.item.limitC, limitBasis: '月度超温报表限值（待定值单复核）'
          }
        }));
        const body = { points: points, reason: '导入月度超温报表自动建点（管屏留空待确认）：' + (imp.fileName || '文件') };
        const requestId = api.stableId('imp', [JSON.stringify(body)]);
        try {
          const result = await request('/points', { method: 'POST', body: Object.assign({ requestId }, body) });
          const pointsByTag = new Map((result.items || []).map(point => [point.unit + '|' + String(point.tag || '').toUpperCase(), point]));
          const configsByPoint = new Map((result.configs || []).map(config => [config.pointId, config]));
          chunk.forEach(group => {
            const key = group.item.unit + '|' + String(group.item.tag || '').toUpperCase();
            const point = pointsByTag.get(key), config = point ? configsByPoint.get(point.id) : null;
            if (!point || !config) {
              group.rows.forEach(row => { row.importable = false; failed.push({ row: row.item.row, message: '自动建点响应缺少测点或限值配置' }); });
              return;
            }
            createdPoints += 1;
            group.rows.forEach(row => { row.point = point; row.config = config; });
          });
        } catch (e) {
          chunk.forEach(group => group.rows.forEach(row => { row.importable = false; failed.push({ row: row.item.row, message: '自动建点失败：' + e.message }); }));
        }
      }
    }
    imp.progress = { done: 0, total: rows.length, phase: '写入记录' };
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row.importable || !row.point || !row.config) continue;
      const record = api.recordFrom(row.item, row.point, row.config, imp.fileName);
      const body = { record: record };
      const requestId = api.stableId('imp', [JSON.stringify(body)]);
      try {
        const result = await request('/records', { method: 'POST', body: Object.assign({ requestId }, body) });
        if (result.item) S.records.set(result.item.id, result.item);
        created += 1;
      } catch (e) {
        if (e.status === 409 && (!e.details || e.details.code === 'RECORD_EXISTS')) skipped += 1;
        else failed.push({ row: row.item.row, message: e.message });
      }
      imp.progress.done = i + 1;
      if (i % 5 === 4) renderForm();
    }
    return { created, skipped, createdPoints, failed };
  }
  async function runImport() {
    const imp = S.import;
    if (!imp || !imp.rows || imp.busy) return;
    if (!imp.confirmed) { imp.error = '请先勾选“已核对文件来源和点位”'; renderForm(); return; }
    if (!imp.summary || imp.summary.ok < 1) { imp.error = '没有可导入的数据'; renderForm(); return; }
    const summary = imp.summary;
    imp.busy = true; imp.error = ''; renderForm();
    try {
      imp.result = imp.kind === 'points' ? await importPoints(imp, summary) : await importRecords(imp, summary);
      imp.rows = null; imp.summary = null; imp.confirmed = false; imp.progress = null;
      S.allPointsLoaded = false; S.optionsLoaded = false;
      window.dispatchEvent(new window.CustomEvent('bt-temperature-changed', { detail: { entity: 'import', kind: imp.kind } }));
      resetPage();
      await refresh({ force: true });
    } catch (e) {
      imp.error = e.message || String(e);
    } finally {
      imp.busy = false; renderForm(); renderSync();
    }
  }
  function renderForm() {
    if (!S.root) return;
    if (S.import) { renderImport(); return; }
    const host = S.root.querySelector('#ot-composer'), d = S.draft;
    if (!d) { host.innerHTML = ''; return; }
    const title = { point: '登记测点', editPoint: '编辑测点', config: '新增配置版本', record: d.original ? '更正温度记录' : '登记温度记录', void: '作废记录（保留历史）' }[d.type];
    host.innerHTML = '<section class="ot-panel ot-composer" aria-label="' + title + '"><div class="ot-section-head"><h3>' + title + '</h3>' + action('收起并保留草稿', 'closeDraft') + '</div><div id="ot-form-errors" role="alert"></div><form id="ot-entry-form" novalidate><fieldset class="ot-form-body" data-form-body' + (S.saving ? ' disabled' : '') + '>' + (d.type === 'point' || d.type === 'editPoint' ? renderPointForm(d) : d.type === 'config' ? renderConfigForm(d) : renderRecordForm(d)) + '<div class="ot-form-footer"><button class="btn btn-primary" type="submit">' + (S.saving ? '正在提交共享服务…' : d.type === 'void' ? '提交作废并留痕' : '保存到共享服务') + '</button>' + action('丢弃草稿', 'discard') + '<small>只有服务端确认成功后才清草稿、刷新统计。</small></div></fieldset></form></section>';
    renderFormErrors(); if (d.type === 'config') renderPreview(); if (d.type === 'record') renderRecordContext();
  }
  function renderFormErrors() {
    const el = S.root && S.root.querySelector('#ot-form-errors'); if (!el) return;
    el.innerHTML = (S.formErrors.length ? '<div class="ot-alert"><strong>尚未保存到共享服务</strong><ul>' + S.formErrors.map(e => '<li>' + esc(errorText(e)) + '</li>').join('') + '</ul></div>' : '') + (S.conflict ? '<details class="ot-conflict" open><summary>远端当前版本（本地表单未覆盖）</summary><pre>' + esc(JSON.stringify(S.conflict, null, 2)) + '</pre><p>不得盲目重试覆盖；先读取远端，重新核对原因与内容，再保存新修订。</p>' + action('显式读取远端版本', 'loadRemote') + '</details>' : '');
  }
  function buildRecord(d) {
    const v = d.data, startAt = core().parseTime(v.startAt), c = core().resolveConfig(configsFor(v.pointId), v.pointId, startAt);
    return { id: d.original ? d.original.id : d.entityId, pointId: v.pointId, configId: c ? c.id : '', kind: v.kind, startAt, endAt: v.kind === 'interval' && v.endAt ? core().parseTime(v.endAt) : null, temperatureC: blank(v.temperatureC) ? null : Number(v.temperatureC), verified: v.kind === 'interval' && v.verified === true, note: String(v.note || '').trim(), status: 'active', revision: d.original ? d.original.revision + 1 : 1 };
  }
  function renderRecordContext() {
    const el = S.root && S.root.querySelector('#ot-record-context'), d = S.draft;
    if (!el || !d || d.type !== 'record') return;
    const r = buildRecord(d), point = S.points.get(r.pointId) || d.point, c = r.configId && S.configs.get(r.configId);
    if (!point || r.startAt === null) { el.textContent = '选择测点并填写真实时点 / 开始时间后，按当时生效的配置自动选版本。'; return; }
    if (!c) { el.innerHTML = '该开始时间没有唯一有效配置。请先配置真实生效时间，不能以当前限值追溯替代。 ' + action('查看测点配置历史', 'historyPoint', point.id); return; }
    const end = typeof core().getConfigEffectiveTo === 'function' ? core().getConfigEffectiveTo(c, configsFor(point.id)) : null;
    const validation = core().validateRecord(r, point, configsFor(point.id), now());
    el.innerHTML = '<strong>采用版本 v' + esc(c.revision) + '</strong> · 限值 ' + esc(degrees(c.limitC)) + '<small>生效 ' + esc(time(c.effectiveFrom)) + (end == null ? ' 起，暂无下一版本' : ' 至 ' + esc(time(end)) + '（不含）') + '</small><small>限值依据：' + esc(c.limitBasis || '未配置') + '</small><small>映射：' + (c.mappingConfirmed ? '已确认 · ' + esc(c.mappingBasis) : '待确认，不作为管段已映射证据') + '；区域 ' + esc((c.regions || []).length) + ' 条</small>' + (validation.ok ? '' : '<ul>' + validation.errors.map(e => '<li>' + esc(errorText(e)) + '</li>').join('') + '</ul>');
  }
  function regionValue(r) {
    const result = clone(r); NUM_KEYS.forEach(key => { result[key] = blank(result[key]) ? null : Number(result[key]); });
    ARRAY_KEYS.forEach(key => { if (result[key] == null) result[key] = null; });
    return result;
  }
  function previewRegions(d) {
    const entries = [], set = new Set(), errors = [], values = [];
    (d.data.regions || []).forEach((raw, i) => {
      const valid = core().validateRegion(regionValue(raw), matrix());
      if (!valid.ok) { errors.push('区域 ' + (i + 1) + '：' + valid.errors.map(errorText).join('；')); entries.push({ errors: valid.errors }); return; }
      const expanded = core().expandRegion(valid.value, d.point.unit, matrix(), 100000);
      if (expanded.codes.length !== expanded.count) errors.push('区域 ' + (i + 1) + ' 过大，无法完整去重；请缩小范围');
      expanded.codes.forEach(code => set.add(code)); values.push(valid.value); entries.push({ count: expanded.count, codes: expanded.codes.slice(0, 12) });
    });
    return { ok: !errors.length, errors, values, entries, count: set.size, codes: Array.from(set).slice(0, 20) };
  }
  function codeLinks(codes) { return '<div class="ot-code-list">' + codes.map(code => '<button type="button" class="ot-code" data-action="tube" data-id="' + esc(code) + '">' + esc(code) + '</button>').join('') + '</div>'; }
  function renderPreview() {
    const el = S.root && S.root.querySelector('#ot-region-preview'); if (!el) return;
    const p = S.preview;
    el.innerHTML = !p ? '<p class="ot-help">新增或修改区域后，请重新预览再确认依据。未添加区域时为待映射。</p>' : p.entries.map((entry, i) => '<div><strong>区域 ' + (i + 1) + '：' + (entry.errors ? '校验未通过' : count(entry.count) + ' 个规范码') + '</strong>' + (entry.errors ? '<p class="ot-warning">' + esc(entry.errors.map(errorText).join('；')) + '</p>' : codeLinks(entry.codes)) + '</div>').join('') + '<div class="ot-preview-total"><strong>' + (p.ok ? '所有区域去重总命中：' + count(p.count) : '尚不能确认总命中数量') + '</strong><small>按规范管子 / 弯头身份统计，不包含未确认现场位置；仅展示前若干码。</small>' + codeLinks(p.codes) + '</div>';
  }
  function changed() { if (S.draft) { S.draft.pending = null; S.formErrors = []; S.conflict = null; persist(); renderFormErrors(); } }
  function captureInput(target, isChange) {
    if (!S.draft || S.saving || !target.closest('#ot-entry-form')) return;
    const d = S.draft, v = d.data;
    if (target.dataset.region !== undefined) {
      const index = Number(target.dataset.region), key = target.dataset.key, r = v.regions[index]; if (!r || !REGION_KEYS.includes(key)) return;
      let value = target.value;
      if (ARRAY_KEYS.includes(key)) { const values = Array.from(target.selectedOptions).map(o => o.value); value = !values.length || values.includes('') ? null : values.map(value => ['spaces', 'corners', 'nozzles'].includes(key) ? Number(value) : value); }
      else if (key === 'wall') value = value || null;
      r[key] = value;
      if (key === 'sys') v.regions[index] = blankRegion(value, '');
      if (key === 'comp') v.regions[index] = blankRegion(r.sys, value);
      if (key === 'wall') r.dirs = null;
      v.confirmBasis = false; S.preview = null; changed();
      if (isChange && ['sys', 'comp', 'wall'].includes(key)) renderForm(); else { const ack = S.root.querySelector('[name="confirmBasis"]'); if (ack) ack.checked = false; renderPreview(); }
      return;
    }
    const name = target.name; if (!name || !Object.prototype.hasOwnProperty.call(v, name)) return;
    v[name] = target.type === 'checkbox' ? target.checked : target.value;
    if (d.type === 'config' && name !== 'confirmBasis' && name !== 'reason') { v.confirmBasis = false; const ack = S.root.querySelector('[name="confirmBasis"]'); if (ack) ack.checked = false; }
    if (d.type === 'record' && name === 'pointId') d.point = S.points.has(v.pointId) ? clone(S.points.get(v.pointId)) : null;
    changed();
    if (isChange && (name === 'mode' || name === 'kind')) renderForm(); else if (d.type === 'record') renderRecordContext();
  }
  function onInput(event) { if (event.target.tagName === 'SELECT' || event.target.type === 'checkbox') return; captureInput(event.target, false); }
  function onChange(event) {
    if (event.target.id === 'ot-import-file') {
      const file = event.target.files && event.target.files[0];
      if (file) loadImportFile(file);
      return;
    }
    if (event.target.id === 'ot-import-confirm') {
      if (S.import) S.import.confirmed = event.target.checked;
      return;
    }
    captureInput(event.target, true);
  }
  function buildSubmission(d) {
    const v = d.data, errors = [];
    if (d.type === 'point') {
      if (!['1', '2'].includes(v.unit)) errors.push('机组必须选择 1# 或 2#，不能选全厂');
      if (!Object.prototype.hasOwnProperty.call(TYPES, v.measurementType)) errors.push('请选择有效测量类型');
      let names = [];
      const commissionedAt = blank(v.commissionedAt) ? null : dateEpoch(v.commissionedAt);
      if (!blank(v.commissionedAt) && commissionedAt === null) errors.push('投产日期无效，请使用公历日期');
      else if (commissionedAt !== null && commissionedAt > now()) errors.push('投产日期不能填写未来时间');
      if (v.mode === 'batch') {
        const start = Number(v.seqStart), end = Number(v.seqEnd);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start + 1 > 100) errors.push('批量起止必须为正整数，结束不早于开始，单次最多 100 个');
        if (!String(v.namePrefix).trim()) errors.push('批量名称前缀不能为空');
        if (!errors.length) names = Array.from({ length: end - start + 1 }, (_, i) => v.namePrefix.trim() + (start + i));
      } else { if (!String(v.name).trim()) errors.push('名称不能为空'); names = [String(v.name).trim()]; }
      if (errors.length) return { errors };
      return { method: 'POST', path: '/points', body: { points: names.map(name => Object.assign({ unit: v.unit, name, tag: v.mode === 'batch' ? '' : String(v.tag || '').trim(), measurementType: v.measurementType, location: String(v.location || '').trim(), panel: v.mode === 'batch' ? '' : String(v.panel || '').trim(), active: true }, v.mode !== 'batch' && commissionedAt !== null ? { commissionedAt } : {})) } };
    }
    if (d.type === 'editPoint') {
      if (!String(v.name).trim()) errors.push('名称不能为空'); if (!String(v.reason).trim()) errors.push('编辑原因不能为空');
      const commissionedAt = blank(v.commissionedAt) ? null : dateEpoch(v.commissionedAt);
      if (!blank(v.commissionedAt) && commissionedAt === null) errors.push('投产日期无效，请使用公历日期');
      else if (commissionedAt !== null && commissionedAt > now()) errors.push('投产日期不能填写未来时间');
      return errors.length ? { errors } : { method: 'PUT', path: '/points/' + encodeURIComponent(d.point.id), body: { revision: d.point.revision, name: v.name.trim(), location: v.location.trim(), panel: String(v.panel || '').trim(), commissionedAt, active: v.active, reason: v.reason.trim() } };
    }
    if (d.type === 'config') {
      const p = previewRegions(d); S.preview = p;
      if (!p.ok) errors.push(...p.errors);
      if (!v.confirmBasis) errors.push('请先核对区域预览、生效时间及依据，并勾选保存前确认');
      if (!String(v.reason).trim()) errors.push('新增版本原因不能为空');
      const at = core().parseTime(v.effectiveFrom); if (at !== null && at > now()) errors.push('生效时间不能填写未来时间，请选择已有依据的实际生效时间');
      const existing = configsFor(d.point.id);
      const config = { id: d.entityId, pointId: d.point.id, revision: existing.reduce((n, c) => Math.max(n, c.revision || 0), 0) + 1, effectiveFrom: at, limitC: blank(v.limitC) ? null : Number(v.limitC), limitBasis: String(v.limitBasis || '').trim(), mappingConfirmed: v.mappingConfirmed === true, mappingBasis: String(v.mappingBasis || '').trim(), regions: p.values };
      const valid = core().validateConfig(config, d.point, existing, Array.from(S.records.values()).filter(r => r.pointId === d.point.id));
      if (!valid.ok) errors.push(...valid.errors);
      if (errors.length) return { errors };
      const payload = Object.assign({}, valid.value); delete payload.id; delete payload.pointId; delete payload.revision;
      return { method: 'POST', path: '/points/' + encodeURIComponent(d.point.id) + '/configs', body: { revision: d.point.revision, config: payload, reason: v.reason.trim() } };
    }
    if (d.type === 'void') {
      if (!String(v.reason).trim()) return { errors: ['作废原因不能为空'] };
      return { method: 'PUT', path: '/records/' + encodeURIComponent(d.original.id), body: { revision: d.original.revision, record: { status: 'void' }, reason: v.reason.trim() } };
    }
    const r = buildRecord(d), point = S.points.get(r.pointId) || d.point;
    if (!point) errors.push('请先选择已登记测点');
    if (point && point.active === false && !d.original) errors.push('停用测点不能新增记录，请先确认是否需要重新启用');
    if (v.endAt && r.kind === 'interval' && core().parseTime(v.endAt) === null) errors.push('结束时间无效');
    if (r.kind === 'interval' && !r.note) errors.push('超温区间必须填写核定依据 / 备注');
    if (d.original && !String(v.reason).trim()) errors.push('更正原因不能为空');
    const valid = core().validateRecord(r, point, configsFor(r.pointId), now());
    if (!valid.ok) errors.push(...valid.errors);
    if (errors.length) return { errors: unique(errors.map(errorText)) };
    const record = Object.assign({}, valid.value); delete record.id; delete record.revision;
    return { method: d.original ? 'PUT' : 'POST', path: d.original ? '/records/' + encodeURIComponent(d.original.id) : '/records', body: d.original ? { revision: d.original.revision, record, reason: v.reason.trim() } : { record } };
  }
  async function save() {
    if (!S.draft || S.saving) return;
    const d = S.draft; let sub;
    try { sub = buildSubmission(d); } catch (e) { S.formErrors = ['校验失败：' + e.message]; renderFormErrors(); return; }
    if (sub.errors) { S.formErrors = sub.errors; renderFormErrors(); renderPreview(); return; }
    const fingerprint = JSON.stringify([sub.method, sub.path, sub.body]);
    if (!d.pending || d.pending.fingerprint !== fingerprint) d.pending = { fingerprint, requestId: uid() };
    persist(); S.saving = true; S.formErrors = []; renderForm();
    try {
      const result = await request(sub.path, { method: sub.method, body: Object.assign({ requestId: d.pending.requestId }, sub.body) });
      if (d.type === 'point' ? !Array.isArray(result.items) || !result.items.length : !result.item || !result.item.id) throw fail('响应未包含保存结果，暂不能确认共享；请保留草稿重试同一请求');
      accept(result);
      if (d.type === 'point') {
        result.items.forEach(p => { S.points.set(p.id, p); S.options.add(p.id); });
        S.optionsLoaded = false;
      }
      else if (d.type === 'editPoint' || d.type === 'config') S.points.set(result.item.id, result.item);
      else S.records.set(result.item.id, result.item);
      if (result.config) S.configs.set(result.config.id, result.config);
      S.notice = d.type === 'point' ? '服务端已确认登记 ' + result.items.length + ' 个测点；尚未自动配置映射或限值，请在台账点“配置区域/限值”。' : '服务端已确认保存，变更已共享并留痕。';
      S.saving = false; clearDraft(); resetPage();
      if (d.type === 'point') { S.tab = 'points'; S.filters = { unit: '', sys: '', pointId: '', q: '', from: '', to: '' }; renderToolbar(); }
      window.dispatchEvent(new window.CustomEvent('bt-temperature-changed', { detail: { entity: d.type, id: result.item && result.item.id, requestId: d.pending.requestId } }));
      await refresh({ force: true });
    } catch (e) {
      S.formErrors = [e.message];
      if (e.details && Array.isArray(e.details.errors)) S.formErrors.push(...e.details.errors);
      if (e.status === 409) S.conflict = e.details || { message: e.message };
      persist();
    } finally { S.saving = false; renderForm(); renderSync(); }
  }
  async function freshPoint(id) {
    const known = S.points.get(id) || (S.draft && S.draft.point);
    if (!known) throw fail('测点尚未载入，请刷新台账后重新打开');
    let cursor = '';
    do { const data = await request('/points' + query({ q: known.tag || known.name, limit: PAGE_SIZE, cursor })); accept(data); data.items.forEach(p => S.points.set(p.id, p)); const p = data.items.find(p => p.id === id); if (p) return p; cursor = data.nextCursor || ''; } while (cursor);
    throw fail('无法在共享服务找到该测点，保留草稿并联系管理员');
  }
  async function loadRemote() {
    const d = S.draft; if (!d || !S.conflict || !window.confirm('显式读取远端版本：测点/记录编辑将替换本地输入；配置草稿保留但更新版本并要求重新确认。继续？')) return;
    try {
      if (d.type === 'config' || d.type === 'editPoint') { const p = await freshPoint(d.point.id); d.point = clone(p); if (d.type === 'editPoint') d.data = { name: p.name, location: p.location || '', panel: p.panel || '', active: p.active !== false, reason: '' }; else d.data.confirmBasis = false; }
      else if (d.original) {
        const remote = S.conflict.current || S.conflict.currentRecord || S.conflict.details && S.conflict.details.current;
        if (!remote || remote.id !== d.original.id || !remote.kind) throw fail('冲突响应未包含完整远端记录，请收起草稿并在记录列表刷新查看');
        if (remote.status === 'void') throw fail('远端记录已作废，不能重新激活或覆盖；请保留草稿并重新登记有据记录');
        d.original = clone(remote); d.data = { pointId: remote.pointId, kind: remote.kind, startAt: core().toInputTime(remote.startAt), endAt: remote.endAt == null ? '' : core().toInputTime(remote.endAt), temperatureC: String(remote.temperatureC), verified: remote.verified, note: remote.note || '', reason: '' };
        await freshPoint(remote.pointId);
      } else throw fail('请收起草稿，刷新台账后核对可能重复的登记');
      changed(); S.notice = '已显式载入远端版本，尚未提交任何覆盖；请重新核对后保存。'; renderForm(); renderSync();
    } catch (e) { S.formErrors = [e.message]; renderFormErrors(); }
  }
  async function showHistory(id, point, more) {
    const epoch = ++S.historyEpoch;
    if (!more) S.history = { id, point, items: [], next: null, busy: true, error: '' }; else S.history.busy = true;
    renderHistory();
    try { const data = await request('/history' + query({ entityId: id, cursor: more && S.history.next, limit: PAGE_SIZE })); if (epoch !== S.historyEpoch) return; if (!Array.isArray(data.items)) throw fail('历史接口响应不完整'); S.history.items.push(...data.items); S.history.next = data.nextCursor || null; S.history.total = data.total; S.history.error = ''; }
    catch (e) { if (epoch === S.historyEpoch) S.history.error = e.message; }
    finally { if (epoch === S.historyEpoch && S.history) { S.history.busy = false; renderHistory(); } }
  }
  function renderHistory() {
    const el = S.root && S.root.querySelector('#ot-history'); if (!el) return; const h = S.history;
    if (!h) { el.innerHTML = ''; return; }
    const versions = h.point ? configsFor(h.id).sort((a, b) => b.revision - a.revision) : [];
    el.innerHTML = '<section class="ot-panel ot-history-panel"><div class="ot-section-head"><h3>操作历史 / 不可变配置</h3>' + action('关闭历史', 'closeHistory') + '</div><p class="ot-help">实体：' + esc(h.id) + ' · 操作者与时间均来自共享服务。</p>' + versions.map(c => '<details><summary>配置 v' + esc(c.revision) + ' · ' + esc(time(c.effectiveFrom)) + ' · 限值 ' + esc(degrees(c.limitC)) + '</summary><pre>' + esc(JSON.stringify(c, null, 2)) + '</pre></details>').join('') + (h.error ? '<div class="ot-alert">' + esc(h.error) + action('重试历史', 'retryHistory') + '</div>' : '') + (h.busy ? '<p role="status">正在读取审计历史…</p>' : '') + (!h.items.length && !h.busy && !h.error ? '<p>暂无操作历史。</p>' : '') + h.items.map(entry => '<details class="ot-audit-entry"><summary>' + esc(time(entry.at)) + ' · ' + esc(typeof entry.actor === 'object' ? JSON.stringify(entry.actor) : entry.actor || '未提供操作者') + ' · ' + esc(entry.reason || entry.action || '创建') + '</summary><div class="ot-audit-diff"><div><strong>变更前</strong><pre>' + esc(JSON.stringify(entry.before == null ? null : entry.before, null, 2)) + '</pre></div><div><strong>变更后</strong><pre>' + esc(JSON.stringify(entry.after == null ? null : entry.after, null, 2)) + '</pre></div></div></details>').join('') + (h.next && !h.busy ? action('继续加载历史', 'moreHistory') : '') + '</section>';
  }
  function onSubmit(event) {
    if (event.target.id === 'ot-entry-form') { event.preventDefault(); save(); }
    if (event.target.id === 'ot-filter-form') { event.preventDefault(); const form = event.target; ['sys', 'pointId', 'q', 'from', 'to'].forEach(key => { S.filters[key] = form.elements.namedItem(key).value; }); resetPage(); refresh(); }
  }
  async function onClick(event) {
    const button = event.target.closest('[data-action]'); if (!button || !S.root.contains(button) || button.disabled) return;
    const name = button.dataset.action, id = button.dataset.id;
    if (S.saving && !['tube', 'drawings'].includes(name)) return;
    if (S.import && S.import.busy && !['closeImport'].includes(name)) return;
    try {
      if (name === 'refresh') { if (!core()) { renderSync(); return; } renderFilters(); await refresh({ force: true }); }
      else if (name === 'tab') selectTab(id);
      else if (name === 'unit') { S.filters.unit = id; S.filters.pointId = ''; resetPage(); renderFilters(); await refresh(); }
      else if (name === 'focusPoint') { if (!id) return; S.filters.pointId = id; resetPage(); renderFilters(); await refresh(); }
      else if (name === 'focusMonthPoint') {
        const month = button.dataset.month;
        if (!id || !/^\d{4}-\d{2}$/.test(String(month || ''))) return;
        S.filters.pointId = id;
        S.filters.from = core().toInputTime(monthStartOf(month));
        S.filters.to = core().toInputTime(monthStartOf(nextMonthKey(month)));
        resetPage(); renderFilters(); await refresh();
      }
      else if (name === 'focusYearPoint') {
        const year = button.dataset.year;
        if (!id || !/^\d{4}$/.test(String(year || ''))) return;
        S.filters.pointId = id;
        S.filters.from = core().toInputTime(yearStartOf(year));
        S.filters.to = core().toInputTime(yearStartOf(nextYearKey(year)));
        resetPage(); renderFilters(); await refresh();
      }
      else if (name === 'reset') { S.filters = { unit: '', sys: '', pointId: '', q: '', from: '', to: '' }; S.tubeCode = ''; resetPage(); renderFilters(); await refresh(); }
      else if (name === 'clearTube') { S.tubeCode = ''; resetPage(); renderFilters(); await refresh(); }
      else if (name === 'moreOptions') { if (!S.optionCursor) return; button.disabled = true; await loadOptions(true); renderFilters(); if (S.draft && S.draft.type === 'record') renderForm(); }
      else if (name === 'next' || name === 'prev') {
        if (S.tab === 'analysis') { const total = S.summary ? S.summary.byPoint.length : 0; S.page = Math.max(0, Math.min(Math.ceil(total / PAGE_SIZE) - 1, S.page + (name === 'next' ? 1 : -1))); renderContent(); }
        else { if (name === 'next' && S.next) { S.stack.push(S.cursor); S.cursor = S.next; S.page += 1; } else if (name === 'prev' && S.stack.length) { S.cursor = S.stack.pop(); S.page -= 1; } await refresh(); }
      }
      else if (name === 'newPoint') openDraft('point');
      else if (name === 'importPoints') await startImport('points');
      else if (name === 'importReport') await startImport('report');
      else if (name === 'parseImportText') await parseImportText();
      else if (name === 'runImport') await runImport();
      else if (name === 'closeImport') { if (S.import && S.import.busy) return; S.import = null; renderForm(); }
      else if (name === 'newRecord') openDraft('record');
      else if (name === 'pointRecord') openDraft('record', S.points.get(id));
      else if (name === 'config' || name === 'editPoint') { const p = S.points.get(id); if (!p) throw fail('测点未载入，请刷新'); openDraft(name, p); }
      else if (name === 'editRecord' || name === 'void') { const r = S.records.get(id); if (!r) throw fail('记录未载入，请刷新'); openDraft(name === 'void' ? 'void' : 'record', r); }
      else if (name === 'closeDraft') { persist(); S.draft = null; renderForm(); renderDraftStatus(); }
      else if (name === 'discard') { if (window.confirm('丢弃本机未共享草稿？共享台账和记录不会受影响。')) clearDraft(); }
      else if (name === 'restore') { if (S.storedDraft) { S.draft = normalizeDraft(clone(S.storedDraft)); S.preview = null; S.formErrors = []; S.conflict = null; if (S.draft.point && !S.points.has(S.draft.point.id)) S.points.set(S.draft.point.id, S.draft.point); renderForm(); renderDraftStatus(); } }
      else if (name === 'addRegion') { if (S.draft.data.regions.length >= 24) throw fail('单次配置最多编辑 24 条区域，请合并有据范围'); S.draft.data.regions.push(blankRegion()); S.draft.data.confirmBasis = false; S.preview = null; changed(); renderForm(); }
      else if (name === 'removeRegion') { S.draft.data.regions.splice(Number(id), 1); S.draft.data.confirmBasis = false; S.preview = null; changed(); renderForm(); }
      else if (name === 'previewRegions') { S.preview = previewRegions(S.draft); renderPreview(); }
      else if (name === 'loadRemote') await loadRemote();
      else if (name === 'historyPoint' || name === 'historyRecord') await showHistory(id, name === 'historyPoint', false);
      else if (name === 'moreHistory') await showHistory(S.history.id, S.history.point, true);
      else if (name === 'retryHistory') await showHistory(S.history.id, S.history.point, false);
      else if (name === 'closeHistory') { S.historyEpoch += 1; S.history = null; renderHistory(); }
      else if (name === 'tube') { if (typeof window.openTubeProfile !== 'function') throw fail('管段档案入口尚未接入，请联系管理员'); window.openTubeProfile(id); }
      else if (name === 'drawings') { if (typeof window.openDrawingsForSys !== 'function') throw fail('图纸入口尚未接入，请联系管理员'); window.openDrawingsForSys(id); }
    } catch (e) { if (S.draft) { S.formErrors = [e.message]; renderFormErrors(); } else { S.error = e.message; renderSync(); } }
  }
  function openForTube(code) {
    if (typeof code !== 'string' || !code.trim()) return;
    S.tubeCode = code.trim(); S.filters = { unit: '', sys: '', pointId: '', q: '', from: '', to: '' }; S.tab = 'analysis'; resetPage();
    init(); renderFilters(); renderToolbar();
    if (typeof window.switchView === 'function') window.switchView('overtemperature');
    else { S.error = '页面切换入口尚未接入，请从导航进入“超温分析”'; renderSync(); }
    if (active()) refresh();
  }
  window.BTOvertemperature = { init, refresh, request, openForTube, formatDuration, monthPointMatrix, yearPointMatrix, lifetimeMatrix };
  function start() {
    init();
    // The bundle entry point refreshes after evidence wiring finishes. Static
    // integrations still initialize themselves when no group is loading.
    if (window.BTLazy?.onReady && !window.BTLazy.isReady('overtemperature')) {
      window.BTLazy.onReady('overtemperature', () => { if (active() && !S.summary && !S.error) refresh(); });
    } else if (active()) refresh();
  }
  if (document) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
    document.addEventListener('visibilitychange', () => { if (!document.hidden && active() && !S.saving) refresh(); });
  }
})(window, document);
