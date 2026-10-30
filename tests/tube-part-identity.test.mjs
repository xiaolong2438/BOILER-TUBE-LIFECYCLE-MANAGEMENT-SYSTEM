import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import vm from 'node:vm';

const app = readFileSync(new URL('../assets/app/app-v7.9.js', import.meta.url), 'utf8');
const coreSource = readFileSync(new URL('../assets/app/assistant-core-v1.js', import.meta.url), 'utf8');
const moduleStub = { exports: {} };
new Function('window', 'module', coreSource)({}, moduleStub);
const Core = moduleStub.exports;
const matrixText = app.slice(app.indexOf('const matrix = ['), app.indexOf('\nconst CODE_SYSTEMS'));
const matrix = vm.runInNewContext(matrixText + '; matrix');

// Read complete top-level function declarations without approximating their behaviour.
function functionSource(name) {
  const start = app.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  const match = /^}/m.exec(app.slice(start));
  assert.ok(match, name + ' must be multiline');
  return app.slice(start, start + match.index + 1);
}
const ctx = vm.createContext({
  window: { BTAssistantCore: Core }, matrix, console,
  userDB: { events: [], replacements: [] },
  inRange: (n, range) => n >= range[0] && n <= range[1],
  systemLifecycleData: () => ({}),
  positiveThickness: value => Number(value) > 0 ? Number(value) : null,
  getCodeBoiler: code => String(code)[0],
  getCodeSystem: code => String(code).split('-')[1],
  CODE_SYSTEMS: [{ sys: 'GGRQ', label: '高温过热器', comps: ['GQ'] }],
  getSysLabel: () => '高温过热器', COMPONENT_LABELS: { GQ: '管屏' },
  escapeHTML: value => String(value), pad: (n, width) => String(n).padStart(width, '0'),
  MAINTENANCE_PHYSICAL_CHECK_RE: /射线|检查|无损|测厚|检修/,
  maintenanceSystemPriority: () => 1, maintenanceFocusForSurface: () => '复查',
  hardnessPriorHint: () => '', saveDB: () => {}, mlog: () => {},
  Date, Set, Map
});
for (const name of [
  'normalizeCodeDirection', 'normalizedTubeCode', 'tubePositionKey', 'tubeVersionKey',
  'sameTubeMeasurement', 'isExactInspectionDate', 'tubeEvidenceEvents', 'parseTubeCode',
  'matrixRowMatches', 'matchComponentFromCode', 'validateCodeAgainstMatrix', 'validateCodeAgainstRules',
  'extractThicknessData', 'getTubeProfileData', 'matrixExpandCodes', 'matrixRowCount',
  'getGeneratedTubeLedgerRows', 'tubeLocationText', 'isMaintenanceInspectionRecord',
  'collectTubeInspectionRecords', 'getInspectionAsOfDate', 'yearsSinceDate', 'classifyInspectionAging',
  'maintenanceOverdueAction', 'buildMaintenanceOverdueRows', 'robustLinearTrend',
  'assessPredictionQuality', 'collectAICompositeSignals', 'isRetiredTubeCode',
  'getBoilerFromCode', 'normalizeBoiler', 'eventBoiler', 'importLifecycleRows'
]) vm.runInContext(functionSource(name), ctx);

const q = '1G-GGRQ-GQ-L002-F004-Q001';
const w = '1G-GGRQ-GQ-L002-F004-W001';
const fieldBack = '1G-GGRQ-GQ-L001-B001-W123';
assert.equal(Core.validateTubeCode(w, matrix).valid, true);
assert.equal(Core.validateTubeCode(w, matrix).fieldPosition, true);
assert.equal(Core.validateTubeCode(w, matrix).matched, null);
assert.equal(Core.canonicalTubeCode(fieldBack, matrix), null, 'unknown F/B total must not turn B001 into F024');
assert.equal(Core.canonicalTubeCode('1G-GGRQ-GQ-L012-D003-Q001', matrix).code, '1G-GGRQ-GQ-L012-U010-Q001');
assert.equal(Core.canonicalTubeCode('1G-GZRQ-GQ-L012-D003-Q001', matrix).code, '1G-GZRQ-GQ-L012-U005-Q001');
assert.equal(matrix.reduce((sum, row) => sum + ctx.matrixRowCount(row), 0), 8519);
assert.equal(ctx.parseTubeCode(w).partKind, 'W');
assert.equal(ctx.parseTubeCode('1G-DPGRQ-GQ-L001-L001-F001-Q001'), null);
assert.equal(Core.validateTubeCode('1G-DPGRQ-GQ-L001-L001-F001-Q001', matrix).valid, false);
assert.equal(Core.suggestSimilarCode('1G-GGRQ-GQ-L033-F004-W057', [q]), null, 'W must never suggest Q');
const suggestion = Core.suggestSimilarCode('1G-GGRQ-GQ-L033-F004-W057', [w]);
assert.ok(suggestion && suggestion.code.endsWith('-W057'), 'suggestions preserve the target part and sequence');

const event = (code, date, desc, extra = {}) => ({ code, date, desc, type: '无损检测', boiler: '1', ...extra });
ctx.userDB.events = [event(q, '2022-05-01', '测厚', { thickness: '7.2' }), event(w, '2026', '发现异物，割开检查为氧化皮')];
const profile = ctx.getTubeProfileData(q);
assert.equal(profile.localEvents.length, 2, 'Q profile includes W observations');
assert.equal(profile.data.status, 'warn');
assert.equal(ctx.collectAICompositeSignals(q).inspectionEvents.length, 2);
assert.equal(ctx.getGeneratedTubeLedgerRows('1').filter(row => ctx.tubePositionKey(row.code) === ctx.tubePositionKey(q)).length, 1);
assert.equal(ctx.buildMaintenanceOverdueRows(2026, '1').find(row => row.code === q).hasRecord, true);
assert.equal(ctx.yearsSinceDate('2022', 2026), 4);
ctx.userDB.events.push(event(w, '2025-05-01', '测厚', { thickness: '3.1', hardness: '250' }));
ctx.userDB.events.push(event(q, '2026', '测厚年份不完整', { thickness: '6.8', hardness: '210' }));
assert.equal(ctx.extractThicknessData(q).length, 1, 'Q trend excludes W points and year-only dates');
assert.equal(ctx.extractThicknessData(w).length, 1, 'W trend retains its own dated measurement');
assert.equal(ctx.collectAICompositeSignals(q).hardnessHistory.length, 0);
ctx.userDB.events.push(event('1G-GGRQ-GQ-L002-F004-W123', '2024', '年度复检'));
assert.equal(ctx.getTubeProfileData(q).localEvents.length, 5, 'checklist sequence is not a physical position');
ctx.userDB.replacements = [{ oldCode: q, newCode: q.replace('001', '002'), date: '2025-12-01' }];
assert.equal(ctx.isRetiredTubeCode(w, new Set([q])), true);
assert.equal(ctx.isRetiredTubeCode(q.replace('Q001', 'Q002'), new Set([q])), false);
assert.equal(ctx.getTubeProfileData(q.replace('Q001', 'Q002')).localEvents.length, 0, 'replacement versions must not inherit old adverse evidence as current measurements');

ctx.userDB = { events: [], replacements: [] };
const headers = ['数据分类', '炉号', '日期', '管段编码', '规格', '材质', '厚度(mm)', '硬度(HB)', '事件类型/更换原因', '关联新管码', '详细描述/结论', '来源ID', '日期精度'];
const rows = [headers, ['事件', '1', '2026', fieldBack, '', '', '', '', '无损检测', '', '结果：合格；日期精度=年', '2026!R39#001', '年']];
const first = ctx.importLifecycleRows(rows);
assert.equal(first.importedEvents, 1);
assert.equal(ctx.userDB.events[0].code, fieldBack);
assert.equal(ctx.userDB.events[0].date, '2026');
assert.equal(ctx.userDB.events[0].sourceId, '2026!R39#001');
assert.equal(ctx.importLifecycleRows(rows).skippedDuplicates, 1);
const clean = Core.cleanRows({ rows, fileName: '事件.csv', matrixRows: matrix, datasetType: 'events' });
assert.equal(clean.report.summary.errorCount, 0);
assert.equal(clean.report.summary.warningCount, 0);
assert.equal(clean.cleanRows[1][2], '2026', 'year-only data is accepted without an invented January 1');
assert.equal(clean.cleanRows[1][3], fieldBack);
assert.match(app, /id="f-part-kind"/);
assert.match(app, /val\('f-part-kind'\) === 'W'/);
// Exercise the real checked-in package through both cleaning and import paths.
const packageManifest = JSON.parse(readFileSync(new URL('../data-cleaning/verified/manifest.json', import.meta.url), 'utf8'));
const csvText = readFileSync(new URL('../data-cleaning/verified/导入_全部批次.csv', import.meta.url), 'utf8').replace(/^\uFEFF/, '');
function csvGrid(text) {
  const result = []; let row = [], cell = '', quoted = false;
  for(let i = 0; i < text.length; i++) {
    const c = text[i];
    if(c === '"') { if(quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if(!quoted && c === ',') { row.push(cell); cell = ''; }
    else if(!quoted && (c === '\n' || c === '\r')) {
      if(c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); if(row.some(Boolean)) result.push(row); row = []; cell = '';
    } else cell += c;
  }
  if(cell || row.length) { row.push(cell); result.push(row); }
  return result;
}
const actual = csvGrid(csvText);
assert.equal(actual.length - 1, packageManifest.statistics.import_count);
ctx.userDB = { events: [], replacements: [] };
const imported = ctx.importLifecycleRows(actual);
assert.equal(imported.importedEvents, 463);
assert.equal(imported.normalizedCount, 0, 'unconfirmed F/B numbering must remain unchanged');
assert.equal(ctx.importLifecycleRows(actual).skippedDuplicates, 463);
assert.equal(new Set(ctx.userDB.events.map(e => e.ts)).size, 463, 'edit/delete timestamp IDs are unique');
assert.equal(new Set(ctx.userDB.events.map(e => e.sourceId)).size, 463);
assert.ok(ctx.userDB.events.every(e => /^\d{4}$/.test(e.date)));
assert.equal(ctx.userDB.events.filter(e => e.inspectionResult === '发现异物，割开检查为氧化皮').length, 5);
for(const e of ctx.userDB.events.filter(e => e.inspectionResult === '发现异物，割开检查为氧化皮')) {
  assert.equal(ctx.getTubeProfileData(e.code.replace(/-W(\d+)$/, '-Q$1')).data.status, 'warn');
}
const actualClean = Core.cleanRows({ rows: actual, matrixRows: matrix, datasetType: 'events' });
assert.equal(actualClean.report.summary.errorCount, 0);
assert.equal(actualClean.report.summary.cleanRows, 463);
console.log('ok - Q/W position evidence, separate measurement series, conservative F/B geometry, legacy U/D, 463-record real package and repeat imports');
