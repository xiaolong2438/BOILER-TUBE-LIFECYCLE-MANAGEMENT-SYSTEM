import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import vm from 'node:vm';

const app = readFileSync(new URL('../assets/app/app-v7.9.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../炉管全生命周期管理系统.html', import.meta.url), 'utf8');
function functionSource(name) {
  const start = app.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} exists`);
  const rest = app.slice(start);
  const firstLine = rest.split('\n')[0].trimEnd();
  if (firstLine.endsWith('}')) return firstLine;
  const end = /^}/m.exec(rest);
  assert.ok(end, `${name} has a closing brace`);
  return rest.slice(0, end.index + 1);
}
const lifecycleStart = app.indexOf('const viewLifecycle =');
const lifecycleEnd = app.indexOf('/* ---------- 超温分析模块', lifecycleStart);
assert.ok(lifecycleStart >= 0 && lifecycleEnd > lifecycleStart);
const lifecycleSource = app.slice(lifecycleStart, lifecycleEnd);
const initSource = app.slice(app.indexOf('// ========== INIT =========='));
const viewIds = ['dashboard', 'generator', 'components', 'headers', 'inventory', 'datamgr', 'drawings', 'maintenance-plan', 'tube-analysis', 'overtemperature', 'maintainlog', 'diagram'];
const renderNames = ['animateCounters', 'buildBarChart', 'renderDashboardWarnings', 'syncDashboardSnapshot', 'runLLMVisualAnalysis', 'populateCodeGeneratorOptions', 'genCode', 'renderComponent', 'renderHeaders', 'renderMatrix', 'renderDataManagerTables', 'renderDesignDrawings', 'renderMaintenancePlan', 'updateLifecycleDropdown', 'populateAIThicknessTargets', 'loadLifecycle'];
const rendersFor = {
  dashboard: ['animateCounters', 'buildBarChart', 'renderDashboardWarnings', 'syncDashboardSnapshot', 'runLLMVisualAnalysis'],
  generator: ['populateCodeGeneratorOptions', 'genCode'], components: ['renderComponent'], headers: ['renderHeaders'],
  inventory: ['renderMatrix'], datamgr: ['renderDataManagerTables'], drawings: ['renderDesignDrawings'],
  'maintenance-plan': ['renderMaintenancePlan'], 'tube-analysis': ['updateLifecycleDropdown', 'populateAIThicknessTargets']
};
function element(id, active = false) {
  const classes = new Set(active ? ['active'] : []);
  const listeners = new Map();
  return {
    id, dataset: {}, style: {}, listeners, textContent: '',
    classList: {
      contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name),
      toggle(name, force = !classes.has(name)) { if (force) classes.add(name); else classes.delete(name); }
    },
    addEventListener(type, fn) { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list); },
    dispatch(type, event = {}) { for (const fn of listeners.get(type) || []) fn(event); },
    scrollIntoView() {}, focus() {}, querySelector() { return { textContent: id }; }
  };
}
// Model native select replacement: innerHTML resets selection, value accepts only existing options.
function select(id) {
  const el = element(id);
  let markup = '', selected = '', options = [];
  Object.defineProperties(el, {
    innerHTML: { get: () => markup, set(value) { markup = value; options = [...value.matchAll(/<option value="([^"]*)"/g)].map(m => m[1]); selected = options[0] || ''; } },
    value: { get: () => selected, set(value) { selected = options.includes(value) ? value : ''; } }
  });
  return el;
}
function sandbox(hash = '') {
  const calls = [];
  const views = viewIds.map(id => element(`view-${id}`, id === 'dashboard'));
  const nav = viewIds.map(id => Object.assign(element(`nav-${id}`, id === 'dashboard'), { dataset: { view: id } }));
  const tabs = ['ww', 'hsh'].map(id => Object.assign(element(`tab-${id}`, id === 'ww'), { dataset: { comp: id } }));
  const elements = new Map([...views, ...nav, ...tabs].map(el => [el.id, el]));
  elements.set('topbar-title', element('topbar-title'));
  const storage = new Map();
  const ctx = vm.createContext({
    console, userDB: { events: [], replacements: [] }, escapeHTML: value => String(value),
    location: { hash }, history: { replaceState(_state, _title, value) { ctx.location.hash = value; } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    document: {
      body: element('body'), getElementById: id => elements.get(id) || null,
      querySelectorAll: query => ({ '.view': views, '.nav-btn': nav, '.comp-tab': tabs }[query] || []),
      querySelector(query) {
        if (query === '.view.active') return views.find(v => v.classList.contains('active')) || null;
        if (query === '.comp-tab.active') return tabs.find(t => t.classList.contains('active')) || null;
        const id = query.match(/^\.nav-btn\[data-view="([^"]+)"\]$/)?.[1];
        return nav.find(n => n.dataset.view === id) || null;
      }
    },
    window: { scrollY: 0, BTLazy: { idle() { calls.push(['idle']); } } }
  });
  for (const name of [...renderNames, 'loadLLMConfigToForm', 'loadAuthSession', 'bootstrapCloudStorage', 'refreshLLMServerStatus', 'applyDemoDataToggle', 'activateOvertemperatureView', 'activateTemperatureEvidence']) {
    ctx[name] = (...args) => calls.push([name, ...args]);
  }
  vm.runInContext(lifecycleSource + '\n' + functionSource('initNav'), ctx);
  return { ctx, calls, elements, nav, tabs, storage, state: id => vm.runInContext(`viewLifecycle[${JSON.stringify(id)}]`, ctx) };
}
const renderCalls = h => h.calls.filter(([name]) => renderNames.includes(name)).map(([name]) => name);
const count = (h, name) => h.calls.filter(([called]) => called === name).length;
async function check(name, fn) { await fn(); console.log(`ok - ${name}`); }

await check('INIT initializes only the default or hash-selected page, with invalid hashes falling back', () => {
  assert.match(html, /id="view-dashboard"[^>]*class="view active"|class="view active"[^>]*id="view-dashboard"/);
  for (const [hash, target] of [['', 'dashboard'], ['#view-missing', 'dashboard'], ...Object.keys(rendersFor).map(id => [`#view-${id}`, id])]) {
    const h = sandbox(hash);
    vm.runInContext(initSource, h.ctx);
    assert.equal(h.ctx.activeViewId(), target, hash);
    assert.deepEqual(renderCalls(h), rendersFor[target], `only ${target} renders at startup`);
    assert.equal(h.ctx.location.hash, hash, 'initial navigation does not rewrite the hash');
    assert.equal(count(h, 'loadAuthSession'), 1);
    assert.equal(count(h, 'bootstrapCloudStorage'), 1);
    assert.equal(count(h, 'idle'), 1);
    for (const id of Object.keys(rendersFor)) assert.equal(Boolean(h.state(id).initialized), id === target, id);
  }
});

await check('generator populates options before generating and repeated navigation never rebinds controls', () => {
  const h = sandbox();
  for (const id of ['f-system', 'f-comp']) h.elements.set(id, select(id));
  Object.assign(h.ctx, {
    CODE_SYSTEMS: [{ sys: 'SMQ', label: '水冷壁', comps: ['GQ', 'W'] }], COMPONENT_LABELS: {},
    renderGeneratorFields() { h.calls.push(['fields']); },
    genCode() {
      assert.equal(h.elements.get('f-system').value, 'SMQ');
      assert.equal(h.elements.get('f-comp').value, 'GQ');
      h.calls.push(['genCode']);
    }
  });
  vm.runInContext(functionSource('populateCodeGeneratorOptions'), h.ctx);
  h.ctx.initNav();
  h.calls.length = 0;
  h.nav.find(n => n.dataset.view === 'generator').dispatch('click');
  assert.deepEqual(h.calls.map(([name]) => name), ['fields', 'genCode']);
  for (let i = 0; i < 3; i++) { h.ctx.switchView('dashboard'); h.ctx.switchView('generator'); }
  assert.equal(count(h, 'genCode'), 1);
  for (const id of ['f-system', 'f-comp']) assert.equal(h.elements.get(id).listeners.get('change').length, 1, id);
  assert.ok(h.nav.every(n => n.listeners.get('click').length === 1 && n.listeners.get('keydown').length === 1));
  h.elements.get('f-system').dispatch('change');
  assert.equal(count(h, 'fields'), 2, 'one change executes one binding');
});

await check('hidden invalidations coalesce until return while active data views refresh immediately', () => {
  const h = sandbox();
  h.ctx.initNav();
  h.ctx.switchView('datamgr');
  h.calls.length = 0;
  assert.equal(h.ctx.deferViewRender('dashboard'), true);
  assert.equal(h.ctx.deferViewRender('datamgr'), false);
  h.ctx.refreshView('dashboard');
  assert.deepEqual(renderCalls(h), []);
  h.ctx.invalidateTubeViews();
  h.ctx.invalidateTubeViews();
  assert.deepEqual(renderCalls(h), ['renderDataManagerTables', 'renderDataManagerTables']);
  for (const id of ['dashboard', 'tube-analysis', 'maintenance-plan', 'components']) assert.equal(h.state(id).dirty, true, id);
  h.ctx.switchView('dashboard');
  assert.equal(count(h, 'renderDashboardWarnings'), 1);
  assert.equal(count(h, 'animateCounters'), 0, 'dashboard mounts only once');
  h.ctx.switchView('datamgr'); h.ctx.switchView('dashboard');
  assert.equal(count(h, 'renderDashboardWarnings'), 1, 'clean revisits do not redraw');
  h.ctx.switchView('missing');
  assert.equal(h.ctx.activeViewId(), 'dashboard', 'invalid navigation leaves current view intact');
  assert.equal(h.ctx.location.hash, '#view-dashboard');
});

await check('failed refresh remains dirty and retry succeeds without repeating initialization', () => {
  const h = sandbox();
  let attempts = 0;
  h.ctx.renderDashboardWarnings = () => { if (++attempts === 1) throw new Error('render failed'); };
  assert.throws(() => h.ctx.initNav(), /render failed/);
  assert.equal(h.state('dashboard').dirty, true);
  assert.equal(h.state('dashboard').rendering, false);
  h.ctx.refreshView('dashboard');
  assert.equal(attempts, 2);
  assert.equal(h.state('dashboard').dirty, false);
  assert.equal(count(h, 'animateCounters'), 1);
  h.ctx.refreshView('dashboard');
  assert.equal(attempts, 2);
});

await check('refresh reentrancy is suppressed and failed first initialization can retry', () => {
  const h = sandbox('#view-generator');
  let attempts = 0;
  h.ctx.populateCodeGeneratorOptions = () => { if (++attempts === 1) throw new Error('init failed'); };
  assert.throws(() => h.ctx.initNav(), /init failed/);
  assert.equal(Boolean(h.state('generator').initialized), false);
  h.ctx.refreshView('generator');
  assert.equal(attempts, 2);
  assert.equal(count(h, 'genCode'), 1);
  h.ctx.renderDashboardWarnings = () => { h.calls.push(['warning']); h.ctx.refreshView('dashboard'); };
  h.ctx.switchView('dashboard');
  assert.equal(count(h, 'warning'), 1);
});

function prepareCloud(h) {
  h.storage.set('boiler_user_db', JSON.stringify(h.ctx.userDB));
  h.storage.set('boiler_material_library', JSON.stringify([{ material: 'T91' }]));
  const pending = new Map();
  h.ctx.cloudStorageEnabled = () => true;
  h.ctx.cloudStorageRequest = key => new Promise(resolve => pending.set(key, resolve));
  h.ctx.queueCloudStorageSave = (...args) => h.calls.push(['upload', ...args]);
  h.ctx.showToast = (...args) => h.calls.push(['toast', ...args]);
  vm.runInContext("const LOCAL_DB_AT_KEY = 'boiler_user_db_local_at'; const DB_BACKUP_KEY = 'boiler_user_db_backup'; const MATERIAL_BACKUP_KEY = 'boiler_material_library_backup';\n" + ['safeParseJson', 'parseCloudTime', 'bootstrapCloudStorage'].map(functionSource).join('\n'), h.ctx);
  return (db = h.ctx.userDB, materials = [{ material: 'T91' }]) => {
    pending.get('boiler_user_db')({ found: true, value: db, updatedAt: '2026-11-05T00:00:00Z' });
    pending.get('boiler_material_library')({ found: true, value: materials });
  };
}
await check('identical cloud content does not dirty or redraw initialized pages', async () => {
  const h = sandbox(); h.ctx.initNav();
  const resolveCloud = prepareCloud(h);
  h.calls.length = 0;
  const loaded = h.ctx.bootstrapCloudStorage(); resolveCloud(); await loaded;
  assert.deepEqual(renderCalls(h), []);
  assert.equal(h.state('dashboard').dirty, false);
  h.ctx.switchView('datamgr'); h.ctx.switchView('dashboard');
  assert.equal(count(h, 'renderDashboardWarnings'), 0);
});
await check('DB or material cloud changes refresh the page active at completion and defer hidden pages', async () => {
  for (const kind of ['db', 'materials']) {
    const h = sandbox(); h.ctx.initNav();
    const resolveCloud = prepareCloud(h);
    const loaded = h.ctx.bootstrapCloudStorage();
    h.ctx.switchView('datamgr'); h.calls.length = 0;
    const db = kind === 'db' ? { events: [{ code: 'REMOTE' }], replacements: [] } : h.ctx.userDB;
    const materials = [{ material: kind === 'materials' ? 'T92' : 'T91' }];
    resolveCloud(db, materials); await loaded;
    assert.deepEqual(renderCalls(h), ['renderDataManagerTables'], kind);
    assert.equal(h.state('dashboard').dirty, true);
    assert.equal(h.ctx.userDB.events.length, kind === 'db' ? 1 : 0);
    assert.deepEqual(JSON.parse(h.storage.get('boiler_material_library')), materials);
    h.ctx.switchView('dashboard');
    assert.equal(count(h, 'renderDashboardWarnings'), 1);
    assert.equal(count(h, 'animateCounters'), 0);
  }
});

await check('material refresh and revisits retain the selected material tab', () => {
  const h = sandbox('#view-components'); h.ctx.initNav();
  const binding = app.split('\n').find(line => line.startsWith("document.querySelectorAll('.comp-tab').forEach"));
  assert.ok(binding, 'material tab click binding exists');
  vm.runInContext(binding, h.ctx);
  h.tabs[1].dispatch('click'); h.calls.length = 0;
  h.ctx.invalidateTubeViews();
  assert.deepEqual(h.calls, [['renderComponent', 'hsh']]);
  h.ctx.switchView('dashboard'); h.ctx.invalidateTubeViews(); h.ctx.switchView('components');
  assert.deepEqual(h.calls.filter(([name]) => name === 'renderComponent'), [['renderComponent', 'hsh'], ['renderComponent', 'hsh']]);
  assert.equal(h.tabs[1].classList.contains('active'), true);
});

await check('lifecycle and AI dropdowns preserve available selections across invalidation and lazy refresh', () => {
  const h = sandbox('#view-tube-analysis');
  for (const id of ['lcSelect', 'ai-target']) h.elements.set(id, select(id));
  let codes = ['A', 'B'];
  h.ctx.userDB.events = codes.map(code => ({ code }));
  h.ctx.collectAIThicknessTargets = () => codes.map(code => ({ code, label: code, points: 2 }));
  vm.runInContext(['updateLifecycleDropdown', 'populateAIThicknessTargets'].map(functionSource).join('\n'), h.ctx);
  h.ctx.initNav();
  for (const id of ['lcSelect', 'ai-target']) h.elements.get(id).value = 'B';
  codes = ['C', 'A', 'B']; h.ctx.userDB.events = codes.map(code => ({ code }));
  h.ctx.invalidateTubeViews();
  for (const id of ['lcSelect', 'ai-target']) assert.equal(h.elements.get(id).value, 'B', id);
  h.ctx.switchView('dashboard');
  codes = ['B', 'D']; h.ctx.userDB.events = codes.map(code => ({ code }));
  h.ctx.updateLifecycleDropdown(); h.ctx.populateAIThicknessTargets();
  assert.doesNotMatch(h.elements.get('ai-target').innerHTML, /value="D"/, 'hidden controls remain untouched');
  h.ctx.switchView('tube-analysis');
  for (const id of ['lcSelect', 'ai-target']) assert.equal(h.elements.get(id).value, 'B', id);
  codes = ['D']; h.ctx.userDB.events = codes.map(code => ({ code })); h.ctx.invalidateTubeViews();
  assert.equal(h.elements.get('lcSelect').value, '', 'removed lifecycle target is cleared');
  assert.equal(h.elements.get('ai-target').value, 'D', 'removed AI target falls back to a valid option');
});

await check('tube refresh updates existing profiles and local predictions without automatic model analysis', () => {
  const h = sandbox('#view-tube-analysis');
  for (const id of ['searchResult', 'lcContent']) {
    const host = element(id);
    host.querySelector = () => ({ textContent: 'TUBE-B 当前档案' });
    h.elements.set(id, host);
  }
  h.elements.set('ai-llm-report', element('ai-llm-report'));
  h.ctx.window.__activeTubeAnalysis = { target: 'TUBE-B', stale: true };
  h.ctx.buildTubeProfileHTML = (code, options) => `${code}:${options.context}:updated`;
  h.ctx.extractThicknessData = (code, options) => {
    assert.equal(code, 'TUBE-B'); assert.equal(options.includeSystem, false); return [7, 6];
  };
  h.ctx.selectedTubePipeType = () => 'straight';
  h.ctx.predictThicknessTrendFromHistory = (target, history, type) => {
    assert.deepEqual(history, [7, 6]); assert.equal(type, 'straight'); return { target, refreshed: true };
  };
  h.ctx.renderAIResults = data => h.calls.push(['prediction', data.target]);
  h.ctx.loadLifecycle = h.ctx.runDeepAIAnalysisFromTrend = () => { assert.fail('refresh must not launch remote analysis'); };
  h.ctx.initNav();
  assert.equal(h.elements.get('searchResult').innerHTML, 'TUBE-B:search:updated');
  assert.equal(h.elements.get('lcContent').innerHTML, 'TUBE-B:lifecycle:updated');
  assert.equal(h.ctx.window.__activeTubeAnalysis.refreshed, true);
  assert.equal(count(h, 'prediction'), 1);
  assert.match(h.elements.get('ai-llm-report').textContent, /本地预测已重新计算/);
});

await check('assistant readiness after leaving dashboard defers analysis until dashboard returns', async () => {
  const h = sandbox();
  h.elements.set('llm-viz-view', Object.assign(element('llm-viz-view'), { innerHTML: '' }));
  let ready, snapshots = 0, analyses = 0, subscriptions = 0;
  h.ctx.window.BTLazy = {
    isReady: () => false,
    onReady(group, fn) { assert.equal(group, 'assistant'); subscriptions++; ready = fn; }
  };
  h.ctx.collectAssistantSnapshot = () => { snapshots++; return { events: [] }; };
  vm.runInContext('let pendingLLMVizRerun = false; let lastLLMVisualInsights = [];\n' + functionSource('runLLMVisualAnalysis'), h.ctx);
  h.ctx.initNav(); h.ctx.runLLMVisualAnalysis();
  assert.equal(subscriptions, 1, 'pending analysis subscribes once');
  const placeholder = h.elements.get('llm-viz-view').innerHTML;
  h.ctx.switchView('datamgr');
  h.ctx.window.BTAssistantAnalysis = {
    parseAnalysis: () => ({}), runAnalysis() { analyses++; return { ok: false }; }
  };
  await Promise.resolve().then(ready);
  assert.equal(analyses, 0); assert.equal(snapshots, 0);
  assert.equal(h.elements.get('llm-viz-view').innerHTML, placeholder);
  assert.equal(h.state('dashboard').dirty, true);
  h.ctx.switchView('dashboard');
  assert.equal(analyses, 1); assert.equal(snapshots, 1);
  assert.notEqual(h.elements.get('llm-viz-view').innerHTML, placeholder);
});
