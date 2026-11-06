import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';

const app = readFileSync(new URL('../assets/app/app-v7.9.js', import.meta.url), 'utf8');
function dataset(tubes = 100, samples = 6) {
  const events = [];
  for (let tube = 1; tube <= tubes; tube++) {
    const code = `${tube % 2 + 1}G-SLB-WB-F000-R${String(tube).padStart(3, '0')}-Q`;
    for (let sample = 0; sample < samples; sample++) events.push({
      code, boiler: String(tube % 2 + 1), date: `${2020 + sample}-04-15`, type: '测厚',
      desc: '壁厚复查', thickness: String(7.5 - sample * 0.85), spec: 'Φ63.5×7.5',
      material: 'SA-210C', ts: tube * samples + sample
    });
  }
  // Deliberately unsorted, deterministic input for identical before/after runs.
  events.sort((a, b) => (a.ts * 7919 % 104729) - (b.ts * 7919 % 104729));
  return { events, replacements: [] };
}
function harness(db = dataset()) {
  const storage = new Map([['boiler_user_db', JSON.stringify(db)], ['blcms-demo-data', 'off']]);
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, value: '', dataset: {}, style: {}, innerHTML: '', textContent: '', hidden: false,
      classList: { contains: () => false, toggle() {}, remove() {}, add() {} },
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, setAttribute() {}
    });
    return elements.get(id);
  };
  for (const id of ['clock', 'dm-table-body', 'dm-type-search', 'dm-select-all', 'dm-pager-summary', 'dm-page-label', 'dm-page-size']) element(id);
  let active = 'datamgr';
  const ctx = vm.createContext({
    console, URLSearchParams, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    location: { protocol: 'file:', hash: '', search: '' }, window: {},
    document: {
      getElementById: id => elements.get(id) || null, querySelectorAll: () => [], addEventListener() {},
      querySelector: query => query === '.view.active' ? { id: `view-${active}` } : null
    },
    alert() {}, confirm: () => true
  });
  vm.runInContext(app.slice(0, app.indexOf('// ========== INIT ==========')), ctx);
  // Benchmark scope: real application history/material/warning/task/snapshot/table APIs;
  // generated ledger is held to these same synthetic positions (no fixed plant ledger cost).
  const ledger = [...new Set(db.events.map(e => e.code))].map(code => ({ code, boiler: code[0], sys: 'SLB' }));
  ctx.getGeneratedTubeLedgerRows = (unit = 'all') => ledger.filter(row => unit === 'all' || row.boiler === unit);
  ctx.refreshView = () => {};
  return { ctx, storage, elements, element, run: code => vm.runInContext(code, ctx), activate: view => { active = view; } };
}
function countCalls(h, name) {
  const original = h.ctx[name];
  let count = 0;
  h.ctx[name] = (...args) => { count++; return original(...args); };
  return { get count() { return count; }, reset() { count = 0; } };
}
function median(values) { return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]; }
function profile() {
  for (const tubes of [100, 200]) {
    const h = harness(dataset(tubes));
    const measure = fn => { const start = performance.now(); fn(); return performance.now() - start; };
    const dashboard = () => {
      h.ctx.getDashboardScopedWarnings(8);
      h.ctx.collectDashboardTasks(4);
      h.ctx.getDashboardScopedWarnings(100);
      h.ctx.collectAssistantSnapshot();
    };
    const cold = [], warm = [], tableCold = [], interactions = [];
    for (let round = 0; round < 3; round++) {
      h.ctx.invalidateTubeViews();
      cold.push(measure(dashboard));
      warm.push(measure(dashboard));
      tableCold.push(measure(() => h.ctx.renderDMTable()));
      interactions.push(measure(() => {
        h.ctx.dmSetSelected(6, true); h.ctx.dmGoPage(1); h.ctx.setDmPageSize(100);
      }));
    }
    console.log(JSON.stringify({ tubes, events: tubes * 6, medianMs: {
      dashboardCold: +median(cold).toFixed(3), dashboardRepeat: +median(warm).toFixed(3),
      tableCold: +median(tableCold).toFixed(3), tableThreeInteractions: +median(interactions).toFixed(3)
    } }));
  }
}

async function check(name, fn) { await fn(); console.log(`ok - ${name}`); }

if (process.argv.includes('--profile')) profile();
else {
  await check('startup is on demand and assistant readiness still defers hidden dashboard work', () => {
    const h = harness();
    let idle = 0;
    h.ctx.window.BTLazy = { idle: () => idle++ };
    for (const name of ['loadLLMConfigToForm', 'initNav', 'loadAuthSession', 'bootstrapCloudStorage', 'refreshLLMServerStatus', 'applyDemoDataToggle']) h.ctx[name] = () => {};
    vm.runInContext(app.slice(app.indexOf('// ========== INIT ==========')), h.ctx);
    assert.equal(idle, 0);
    const box = h.element('llm-viz-view');
    let ready, analysis = 0;
    h.ctx.window.BTLazy = { isReady: () => false, onReady: (_group, fn) => { ready = fn; } };
    h.activate('dashboard'); h.ctx.runLLMVisualAnalysis();
    assert.equal(typeof ready, 'function');
    const placeholder = box.innerHTML;
    h.ctx.window.BTAssistantAnalysis = { parseAnalysis: () => ({}), runAnalysis: () => { analysis++; return { ok: false }; } };
    h.activate('datamgr'); ready();
    assert.equal(analysis, 0); assert.equal(box.innerHTML, placeholder);
    assert.equal(h.run('viewLifecycle.dashboard.dirty'), true);
    h.activate('dashboard'); h.ctx.runLLMVisualAnalysis();
    assert.equal(analysis, 1);
  });

  await check('assistant launcher loads only on click, retries failure and opens the panel', async () => {
    const h = harness();
    const launcher = h.element('assistant-lazy-launcher');
    let loads = 0, opens = 0;
    h.ctx.showToast = () => {};
    h.ctx.window.BTLazy = { ensure: async group => {
      assert.equal(group, 'assistant'); loads++;
      if(loads === 1) throw new Error('temporary network failure');
      h.ctx.window.BTAssistant = { open: () => { opens++; } };
    } };
    assert.equal(loads, 0);
    await h.ctx.openAssistantOnDemand();
    assert.equal(launcher.disabled, false);
    assert.equal(launcher.hidden, false);
    await h.ctx.openAssistantOnDemand();
    assert.equal(loads, 2);
    assert.equal(opens, 1);
    assert.equal(launcher.hidden, true);
  });

  await check('history index scales linearly and warning/snapshot calls reuse expensive work', () => {
    const operations = [];
    for (const tubes of [100, 200]) {
      const h = harness(dataset(tubes));
      const positions = countCalls(h, 'tubePositionKey');
      const materials = countCalls(h, 'getMaterialLibrary');
      const inspections = countCalls(h, 'collectTubeInspectionRecords');
      const theory = countCalls(h, 'resolveMaterialTheoryThickness');
      const warnings = h.ctx.collectDashboardWarnings({ limit: 500 });
      assert.ok(warnings.length > 0);
      h.ctx.collectDashboardTasks(4); h.ctx.collectAssistantSnapshot();
      assert.equal(materials.count, 1, 'material rows resolved once in a revision');
      assert.equal(inspections.count, 1, 'tasks and assistant reuse identical all-unit/year overdue rows');
      operations.push(positions.count);
      positions.reset(); theory.reset(); inspections.reset();
      h.ctx.getDashboardScopedWarnings(8); h.ctx.getDashboardScopedWarnings(100);
      const snapshot = h.ctx.collectAssistantSnapshot(); h.ctx.collectDashboardTasks(4);
      assert.equal(positions.count, 0); assert.equal(theory.count, 0); assert.equal(inspections.count, 0);
      assert.equal(snapshot.events.length, tubes * 6);
      assert.equal(h.ctx.collectDashboardWarnings({ limit: 1 }).length, 1, 'caller limits never poison complete warning cache');
      const code = h.run('userDB.events[0].code');
      const history = h.ctx.extractThicknessData(code, { includeSystem: false });
      history[0].val = -1; history.pop();
      assert.equal(h.ctx.extractThicknessData(code, { includeSystem: false }).length, 6);
      assert.ok(h.ctx.extractThicknessData(code, { includeSystem: false })[0].val > 0, 'history callers cannot corrupt cache');
    }
    assert.ok(operations[1] <= operations[0] * 2.1, `position operations scale linearly: ${operations}`);
  });

  await check('table filters/sort/type options rebuild once and selection spans the full result', () => {
    const h = harness(dataset(30));
    const dates = countCalls(h, 'dmInspectionTimestamp');
    const filters = countCalls(h, 'dmDateInScope');
    const types = countCalls(h, 'dmTypeOptions');
    h.ctx.renderDMTable();
    assert.equal(dates.count, 180, 'date key computed once per matched row');
    assert.equal(filters.count, 180); assert.equal(types.count, 1);
    const expected = h.run('JSON.stringify([...userDB.events].sort(dmCompareByInspectionDateDesc).map(r => Number(r.ts)))');
    assert.equal(h.run('JSON.stringify(dmFilteredTs)'), expected);
    dates.reset(); filters.reset(); types.reset();
    h.ctx.dmSetSelected(6, true); h.ctx.dmGoPage(1); h.ctx.setDmPageSize(100);
    assert.equal(dates.count, 0); assert.equal(filters.count, 0); assert.equal(types.count, 0);
    h.ctx.dmToggleAll(true);
    assert.equal(h.run('dmSelectedTs.size'), 180, 'select all includes off-page rows');
    assert.equal(h.elements.get('dm-select-all').checked, true);
    h.ctx.dmInvertSelection(); assert.equal(h.run('dmSelectedTs.size'), 0);
    h.element('dm-code-search').value = 'R001-';
    h.ctx.renderDMTable();
    assert.equal(h.run('dmTotalRows'), 6); assert.equal(h.run('dmPage'), 1);
    assert.equal(dates.count, 6); assert.equal(filters.count, 180);
    h.ctx.dmToggleAll(true); assert.equal(h.run('dmSelectedTs.size'), 6);
    h.element('dm-date-from').value = '2023-01-01';
    h.ctx.renderDMTable(); assert.equal(h.run('dmTotalRows'), 3); assert.equal(h.run('dmSelectedTs.size'), 3);
    h.ctx.getDmSysFilter = () => ['SMQ']; h.ctx.renderDMTable(); assert.equal(h.run('dmTotalRows'), 0);
    h.ctx.getDmSysFilter = () => []; h.element('dm-code-search').value = ''; h.element('dm-date-from').value = '';
    h.elements.get('dm-type-search').value = '无损检测'; h.ctx.renderDMTable(); assert.equal(h.run('dmTotalRows'), 0);
    h.storage.set('boiler_dm_type_filter', ''); h.elements.get('dm-type-search').value = ''; h.ctx.getBatchBoilerFilter = () => '1'; h.ctx.renderDMTable();
    assert.equal(h.run('dmTotalRows'), 90);
  });

  await check('cached sorting preserves missing/partial/invalid dates, ties, and colliding timestamps', () => {
    const db = dataset(1);
    const dates = ['', 'bad', '2026', '2026/2', '2026.2.3', '2026-13-01', '2026-02-03', '2026-02-03'];
    db.events = dates.map((date, i) => ({ ...db.events[0], date, ts: i < 2 ? 1 : i }));
    const h = harness(db);
    const expected = h.run('JSON.stringify([...userDB.events].sort(dmCompareByInspectionDateDesc).map(r => r.date + "#" + r.ts))');
    h.ctx.renderDMTable();
    assert.equal(h.run('JSON.stringify(dmResultCache.rows.map(r => r.date + "#" + r.ts))'), expected);
    h.ctx.dmToggleAll(true); assert.equal(h.elements.get('dm-select-all').checked, true, 'duplicate ts count as all corresponding rows');
  });

  await check('saveDB invalidates in-place assistant edits before active refresh, including date/code/metadata', () => {
    const h = harness(dataset(2));
    const code = h.run('userDB.events[0].code');
    h.ctx.window.__tubePipeTypes = { [code]: 'straight' };
    h.ctx.renderDMTable(); h.ctx.collectDashboardWarnings({ limit: 500 });
    h.ctx.extractThicknessData(code, { includeSystem: false });
    const dates = countCalls(h, 'dmInspectionTimestamp');
    h.ctx.refreshView = () => h.ctx.renderDMTable();
    const ts = h.run(`userDB.events.filter(e => e.code === ${JSON.stringify(code)}).sort((a,b) => b.date.localeCompare(a.date))[0].ts`);
    assert.equal(h.ctx.updateEventRecord(ts, 'thickness', '2.1').ok, true);
    assert.equal(dates.count, 12, 'active render observes new revision immediately');
    assert.match(h.elements.get('dm-table-body').innerHTML, /2\.1/);
    assert.ok(h.ctx.extractThicknessData(code, { includeSystem: false }).some(point => point.val === 2.1));
    assert.ok(h.ctx.collectDashboardWarnings({ limit: 500 }).some(row => row.text.includes('2.1mm')));
    h.ctx.updateEventRecord(ts, 'date', '2026-03-14');
    assert.equal(h.run('dmResultCache.rows[0].date'), '2026-03-14');
    const nextCode = '1G-SLB-WB-F000-R003-Q';
    h.ctx.updateEventRecord(ts, 'code', nextCode);
    assert.equal(h.ctx.tubeEvidenceEvents(nextCode).length, 1);
    assert.equal(h.ctx.tubeEvidenceEvents(code).length, 5);
    h.ctx.updateEventRecord(ts, 'spec', 'Φ51×6');
    assert.equal(h.ctx.resolveMaterialTheoryThickness(nextCode, 'straight').meta.spec, 'Φ51×6');
    h.ctx.deleteEvent(ts);
    assert.equal(h.ctx.tubeEvidenceEvents(nextCode).length, 0); assert.equal(h.run('dmTotalRows'), 11);
  });

  await check('manual in-place edits and material threshold saves change cached conclusions', () => {
    const h = harness(dataset(1));
    const code = h.run('userDB.events[0].code');
    const ts = h.run('userDB.events[0].ts');
    h.ctx.window.__tubePipeTypes = { [code]: 'straight' };
    h.ctx.collectDashboardWarnings({ limit: 500 }); h.ctx.renderDMTable();
    for (const [id, value] of Object.entries({
      'de-boiler': code[0], 'de-code': code, 'de-spec': 'Φ63.5×7.5', 'de-material': 'SA-210C',
      'de-thickness': '2.6', 'de-hardness': '', 'de-type': '测厚', 'de-date': '2026-06-12', 'de-desc': '新壁厚复测'
    })) h.element(id).value = value;
    h.ctx.saveEventEdit(ts); h.ctx.renderDMTable();
    assert.equal(h.run('dmResultCache.rows[0].desc'), '新壁厚复测');
    assert.equal(h.ctx.extractThicknessData(code, { includeSystem: false }).at(-1).val, 2.6);
    assert.ok(h.ctx.collectDashboardWarnings({ limit: 500 }).some(row => row.text.includes('2.6mm')));
    const before = h.ctx.resolveMaterialTheoryThickness(code, 'straight').threshold;
    assert.ok(before > 0);
    const originalLibrary = h.ctx.getMaterialLibrary;
    h.ctx.getMaterialLibrary = () => originalLibrary().map(row => ({ ...row, straight: 1 }));
    h.ctx.saveMaterialLibrary([], { silent: true });
    assert.equal(h.ctx.resolveMaterialTheoryThickness(code, 'straight').threshold, 1);
    assert.ok(h.ctx.collectDashboardWarnings({ limit: 500 }).every(row => row.source !== '材料库理论厚度判定'));
  });

  await check('replacement add/edit/delete boundaries and part identities invalidate cached histories', () => {
    const q = '1G-GGRQ-GQ-L002-F004-Q', w = q.replace(/Q$/, 'W');
    const h = harness({ events: [
      { code: q, date: '2020-01-01', thickness: '6', type: '测厚', ts: 1 },
      { code: w, date: '2020-01-01', thickness: '2', type: '测厚', ts: 2 },
      { code: q, date: '2025-01-01', thickness: '7', type: '测厚', ts: 3 }
    ], replacements: [] });
    assert.deepEqual(Array.from(h.ctx.extractThicknessData(q, { includeSystem: false }), p => p.val), [6, 7]);
    h.run(`userDB.replacements.push({oldCode:${JSON.stringify(q)},newCode:${JSON.stringify(q)},date:'2024-01-01',ts:9}); saveDB()`);
    assert.deepEqual(Array.from(h.ctx.extractThicknessData(q, { includeSystem: false }), p => p.val), [7]);
    assert.equal(h.ctx.extractThicknessData(w, { includeSystem: false }).length, 0, 'position boundary covers both parts');
    h.run("userDB.replacements[0].date = '2026-01-01'; saveDB()");
    assert.equal(h.ctx.extractThicknessData(q, { includeSystem: false }).length, 0);
    h.ctx.deleteReplacement(9);
    assert.equal(h.ctx.extractThicknessData(q, { includeSystem: false }).length, 2);
  });

  await check('import update, demo toggle, material edits, unit/year/clock, and lazy canonicalization renew caches', () => {
    const h = harness(dataset(2));
    const revision = () => h.ctx.getTubeDataCache().revision;
    h.ctx.renderDMTable(); const first = revision();
    const imported = [[...h.run('EVENT_CSV_COLUMNS'), '来源ID'], ['事件', '1', '2026-04-15', '1G-SLB-WB-F000-R003-Q', 'Φ63.5×7.5', 'SA-210C', '2.5', '', '测厚', '', '壁厚复测', 'cache-source-1']];
    h.ctx.importLifecycleRows(imported); h.ctx.renderDMTable();
    assert.ok(revision() > first); assert.equal(h.run('dmTotalRows'), 13);
    const insertedTs = h.run('userDB.events.find(e => e.sourceId === "cache-source-1").ts');
    const beforeUpdate = revision();
    h.ctx.extractThicknessData('1G-SLB-WB-F000-R003-Q', { includeSystem: false });
    imported[1][6] = '2.2';
    const updated = h.ctx.importLifecycleRows(imported); h.ctx.renderDMTable();
    assert.equal(updated.updatedEvents, 1); assert.equal(h.run('dmTotalRows'), 13);
    assert.equal(h.run('userDB.events.find(e => e.sourceId === "cache-source-1").ts'), insertedTs);
    assert.ok(revision() > beforeUpdate);
    assert.equal(h.ctx.extractThicknessData('1G-SLB-WB-F000-R003-Q', { includeSystem: false })[0].val, 2.2);
    const beforeDemo = revision(); h.storage.set('blcms-demo-data', 'on'); h.ctx.refreshAfterDemoToggle();
    assert.ok(revision() > beforeDemo);
    assert.ok(h.ctx.collectDashboardWarnings({ limit: 500 }).some(row => row.source === '系统寿命数据'));
    h.storage.set('blcms-demo-data', 'off'); h.ctx.refreshAfterDemoToggle();
    assert.ok(h.ctx.collectDashboardWarnings({ limit: 500 }).every(row => row.source !== '系统寿命数据'));
    const beforeMaterial = revision(); h.ctx.saveMaterialLibrary([], { silent: true }); assert.ok(revision() > beforeMaterial);
    const inspections = countCalls(h, 'collectTubeInspectionRecords');
    h.ctx.collectDashboardTasks(4); const firstInspections = inspections.count;
    h.ctx.collectDashboardTasks(4); assert.equal(inspections.count, firstInspections);
    h.run("dashboardUnit = '1'"); h.ctx.collectDashboardTasks(4); assert.equal(inspections.count, firstInspections + 1);
    assert.ok(h.ctx.getDashboardScopedWarnings(100).every(row => row.code.startsWith('1G-')));
    h.element('maintenanceCycleStart').value = '2040'; h.ctx.collectDashboardTasks(4); assert.equal(inspections.count, firstInspections + 2);
    h.run("const NativeDate = Date; Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : ['2041-01-01T12:00:00Z'])); } }");
    h.element('maintenanceCycleStart').value = ''; h.ctx.collectDashboardTasks(4); assert.equal(inspections.count, firstInspections + 3);
    const beforeType = revision(); h.ctx.window.__tubePipeTypes = { '1G-SLB-WB-F000-R003-Q': 'bend' }; assert.ok(revision() > beforeType);
    const beforeCore = revision(); h.ctx.window.BTAssistantCore = { canonicalTubeCode: code => ({ code }) }; assert.ok(revision() > beforeCore);
  });

  await check('cloud replacement invalidates before active render and identical cloud data stays cached', async () => {
    const h = harness(dataset(2));
    h.ctx.renderDMTable(); const initial = h.ctx.getTubeDataCache().revision;
    h.ctx.cloudStorageEnabled = () => true;
    h.ctx.showToast = () => {};
    h.ctx.refreshView = () => h.ctx.renderDMTable();
    const remote = dataset(3);
    h.ctx.cloudStorageRequest = async key => key === 'boiler_user_db' ? { found: true, value: remote, updatedAt: '2099-01-01T00:00:00Z' } : null;
    await h.ctx.bootstrapCloudStorage();
    assert.ok(h.ctx.getTubeDataCache().revision > initial); assert.equal(h.run('dmTotalRows'), 18);
    const revision = h.ctx.getTubeDataCache().revision;
    await h.ctx.bootstrapCloudStorage(); assert.equal(h.ctx.getTubeDataCache().revision, revision);
    const body = h.elements.get('dm-table-body').innerHTML;
    h.activate('dashboard'); h.run('userDB.events[0].date = "2098-01-01"; saveDB()');
    assert.equal(h.elements.get('dm-table-body').innerHTML, body, 'hidden tables defer rendering');
    h.activate('datamgr'); h.ctx.renderDMTable(); assert.match(h.elements.get('dm-table-body').innerHTML, /2098-01-01/);
  });
}
