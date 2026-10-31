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
  systemLifecycleData: () => ({}), findLifecycleEntry: () => null,
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
  'normalizeCodeDirection', 'normalizedTubeCode', 'tubePositionKey', 'sameTubeMeasurement',
  'isExactInspectionDate', 'tubeEvidenceEvents', 'currentTubeEvents', 'parseTubeCode',
  'matrixRowMatches', 'matchComponentFromCode', 'validateCodeAgainstMatrix', 'validateCodeAgainstRules',
  'extractThicknessData', 'getTubeProfileData', 'matrixExpandCodes', 'matrixRowCount',
  'getGeneratedTubeLedgerRows', 'tubeLocationText', 'isMaintenanceInspectionRecord',
  'collectTubeInspectionRecords', 'getInspectionAsOfDate', 'yearsSinceDate', 'classifyInspectionAging',
  'maintenanceOverdueAction', 'buildMaintenanceOverdueRows', 'robustLinearTrend',
  'assessPredictionQuality', 'collectAICompositeSignals', 'isRetiredTubeCode',
  'getBoilerFromCode', 'normalizeBoiler', 'eventBoiler', 'importLifecycleRows'
]) vm.runInContext(functionSource(name), ctx);

const q = '1G-GGRQ-GQ-L002-F004-Q';
const w = '1G-GGRQ-GQ-L002-F004-W';
const legacyW = '1G-GGRQ-GQ-L002-F004-W001';
const fieldBack = '1G-GGRQ-GQ-L001-B001-W';

// 解析与校验：字母尾即身份；历史数字尾兼容但归一到字母。
assert.equal(Core.validateTubeCode(w, matrix).valid, true);
assert.equal(Core.validateTubeCode(w, matrix).fieldPosition, true);
assert.equal(Core.validateTubeCode(w, matrix).matched, null);
assert.equal(Core.validateTubeCode(legacyW, matrix).valid, true, '历史流水数字尾仍可解析');
assert.deepEqual(Core.canonicalTubeCode(fieldBack, matrix), { code: '1G-GGRQ-GQ-L001-F024-W', changed: true }, '用户确认每屏24根：B001≙F024');
assert.equal(Core.canonicalTubeCode('1G-GGRQ-GQ-R007-F012-W', matrix).code, '1G-GGRQ-GQ-L026-F012-W', '用户确认32屏：R007≙L026');
assert.equal(Core.canonicalTubeCode('1G-GZRQ-GQ-L001-B001-W', matrix), null, '高再每屏根数未确认，不镜像');
assert.equal(Core.canonicalTubeCode('1G-GGRQ-GQ-L012-D003-Q', matrix).code, '1G-GGRQ-GQ-L012-U010-Q');
assert.equal(Core.canonicalTubeCode('1G-GZRQ-GQ-L012-D003-Q', matrix).code, '1G-GZRQ-GQ-L012-U005-Q');
assert.equal(matrix.reduce((sum, row) => sum + ctx.matrixRowCount(row), 0), 8519);
assert.equal(ctx.parseTubeCode(w).partKind, 'W');
assert.equal(ctx.parseTubeCode(w).seq, null);
assert.equal(ctx.parseTubeCode(legacyW).seq, 1);
assert.equal(Core.validateTubeCode('1G-DPGRQ-GQ-L001-L001-F001-Q', matrix).valid, false);
assert.equal(Core.suggestSimilarCode('1G-GGRQ-GQ-L033-F004-W', [q]), null, 'W 不得建议成 Q');
const suggestion = Core.suggestSimilarCode('1G-GGRQ-GQ-L033-F004-W', [w]);
assert.ok(suggestion && suggestion.code.endsWith('-W'), '同部位建议保持 W 尾');

// 同管证据聚合：Q 档案汇总 W 观察；台账/检修按管位聚合。
const event = (code, date, desc, extra = {}) => ({ code, date, desc, type: '无损检测', boiler: '1', ...extra });
ctx.userDB.events = [event(q, '2022-05-01', '测厚', { thickness: '7.2' }), event(w, '2026', '发现异物，割开检查为氧化皮')];
const profile = ctx.getTubeProfileData(legacyW);
assert.equal(profile.localEvents.length, 2, '历史数字尾与字母尾是同一部位');
assert.equal(profile.data.status, 'warn', '同管异常观察应提升档案状态');
assert.equal(ctx.collectAICompositeSignals(q).inspectionEvents.length, 2);
assert.equal(ctx.getGeneratedTubeLedgerRows('1').filter(row => ctx.tubePositionKey(row.code) === ctx.tubePositionKey(q)).length, 1);
assert.equal(ctx.buildMaintenanceOverdueRows(2026, '1').find(row => ctx.tubePositionKey(row.code) === ctx.tubePositionKey(q)).hasRecord, true);
assert.equal(ctx.yearsSinceDate('2022', 2026), 4);

// 测量序列按部位拆分，且只用完整日期；年份记录不参与趋势。
ctx.userDB.events.push(event(w, '2025-05-01', '测厚', { thickness: '3.1', hardness: '250' }));
ctx.userDB.events.push(event(q, '2026', '测厚年份不完整', { thickness: '6.8', hardness: '210' }));
assert.equal(ctx.extractThicknessData(q).length, 1, 'Q 趋势不含 W 测点，也不含年份日期');
assert.equal(ctx.extractThicknessData(w).length, 1, 'W 趋势保留自己的带日期测点');
assert.equal(ctx.collectAICompositeSignals(q).hardnessHistory.length, 0);

// 更换边界：投运日期之前的证据属于旧管，不进当前测量序列；时间线仍完整保留。
ctx.userDB.replacements = [{ oldCode: q, newCode: q, date: '2025-06-01', reason: '爆管更换' }];
assert.equal(ctx.getTubeProfileData(q).localEvents.length, 4, '时间线保留更换前全部历史');
assert.equal(ctx.extractThicknessData(q).length, 0, '更换后无带日期测点');
assert.equal(ctx.collectAICompositeSignals(q).hardnessHistory.length, 0);
ctx.userDB.events.push(event(q, '2025-06-05', '测厚', { thickness: '7.0', hardness: '205' }));
assert.equal(ctx.extractThicknessData(q).length, 1, '投运后的测点计入当前管序列');

// 导入管线：字母尾落库、历史数字尾归一、同码跨年不去重、来源ID与去重键唯一。
ctx.userDB = { events: [], replacements: [] };
const headers = ['数据分类', '炉号', '日期', '管段编码', '规格', '材质', '厚度(mm)', '硬度(HB)', '事件类型/更换原因', '关联新管码', '详细描述/结论', '来源ID', '日期精度'];
const row = (code, date, desc, sourceId) => ['事件', '1', date, code, '', '', '', '', '无损检测', '', desc, sourceId, '年'];
const first = ctx.importLifecycleRows([headers, row(legacyW, '2026', '结果：合格', '2026!R4#001')]);
assert.equal(first.importedEvents, 1);
assert.equal(ctx.userDB.events[0].code, w, '导入时历史数字尾归一为字母尾');
assert.equal(ctx.userDB.events[0].date, '2026');
assert.equal(ctx.importLifecycleRows([headers, row(w, '2026', '结果：合格', '2026!R4#001')]).skippedDuplicates, 1, '同码同内容去重');
const again = ctx.importLifecycleRows([headers, row(w, '2022', '结果：合格', '2022!R1#001')]);
assert.equal(again.importedEvents, 1, '同码不同年份是历史复检，不去重');
assert.equal(ctx.importLifecycleRows([headers, row(fieldBack, '2026', '结果：合格', '2026!R39#001')]).importedEvents, 1);
assert.equal(ctx.userDB.events.find(e => e.sourceId === '2026!R39#001').code, '1G-GGRQ-GQ-L001-F024-W', 'B001按确认几何归一为F024');
assert.equal(new Set(ctx.userDB.events.map(e => e.ts)).size, ctx.userDB.events.length);
const clean = Core.cleanRows({ rows: [headers, row(w, '2026', '结果：合格', '')], matrixRows: matrix, datasetType: 'events' });
assert.equal(clean.report.summary.errorCount, 0);
assert.equal(clean.cleanRows[1][2], '2026', '年份日期按原样保留，不虚构月日');
assert.equal(clean.cleanRows[1][3], w);

// 真实发布包端到端：464 条全量导入、重复导入全跳过、编码全部字母尾且带来源ID。
// WPS 可能短暂占用 verified/，这里按规则版本解析包目录，两个位置内容一致。
function resolvePackageDir() {
  for (const name of ['verified', 'verified-physical']) {
    try {
      const manifest = JSON.parse(readFileSync(new URL(`../data-cleaning/${name}/manifest.json`, import.meta.url), 'utf8'));
      if (manifest.rule_version === 'film-records-physical-codes-v8') return `../data-cleaning/${name}`;
    } catch { /* 目录未发布，尝试下一个 */ }
  }
  throw new Error('找不到字母尾物理编码规则的数据包');
}
const packageDir = resolvePackageDir();
const packageManifest = JSON.parse(readFileSync(new URL(`${packageDir}/manifest.json`, import.meta.url), 'utf8'));
const csvText = readFileSync(new URL(`${packageDir}/导入_全部批次.csv`, import.meta.url), 'utf8').replace(/^\uFEFF/, '');
function csvGrid(text) {
  const result = []; let rowCells = [], cell = '', quoted = false;
  for(let i = 0; i < text.length; i++) {
    const c = text[i];
    if(c === '"') { if(quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if(!quoted && c === ',') { rowCells.push(cell); cell = ''; }
    else if(!quoted && (c === '\n' || c === '\r')) {
      if(c === '\r' && text[i + 1] === '\n') i++;
      rowCells.push(cell); if(rowCells.some(Boolean)) result.push(rowCells); rowCells = []; cell = '';
    } else cell += c;
  }
  if(cell || rowCells.length) { rowCells.push(cell); result.push(rowCells); }
  return result;
}
const actual = csvGrid(csvText);
assert.equal(actual.length - 1, packageManifest.statistics.import_count);
assert.equal(actual.length - 1, 464, '第27屏确认修正后全量464条');
assert.ok(actual.slice(1).every(r => /-[QW]$/.test(r[3])), '发布包编码必须全部为字母尾');
ctx.userDB = { events: [], replacements: [] };
const imported = ctx.importLifecycleRows(actual);
assert.equal(imported.importedEvents, 464);
assert.equal(imported.normalizedCount, 152, 'A侧R屏号按确认的L↔R镜像归一为规范方向（F管位保持现场计数不变）');
const normalizedSample = ctx.userDB.events.find(e => e.sourceId === '2022年1号机A修!R4#001');
assert.ok(normalizedSample && normalizedSample.code === '1G-GGRQ-GQ-L001-F001-W', 'A侧R001按确认镜像落L032前的规范屏号；实际：' + (normalizedSample && normalizedSample.code));
assert.equal(ctx.importLifecycleRows(actual).skippedDuplicates, 464);
assert.equal(new Set(ctx.userDB.events.map(e => e.ts)).size, 464);
assert.equal(new Set(ctx.userDB.events.map(e => e.sourceId)).size, 464);
assert.equal(ctx.userDB.events.filter(e => e.code.endsWith('-F024-W')).length, 32, '炉后第1根按确认几何落F024');
assert.equal(ctx.userDB.events.filter(e => e.code.includes('-B0')).length, 0, '镜像后不保留B编码');
const l027 = ctx.userDB.events.find(e => e.code === '1G-GGRQ-GQ-L027-F001-W');
assert.equal(l027.result_nature ?? '合格', '合格');
assert.ok(l027, '用户确认的第27屏已按L027导入');
assert.equal(ctx.userDB.events.filter(e => e.code === '1G-GGRQ-GQ-L024-F001-W').length, 1, '第29行L024保留，不重复');
const row38 = ctx.userDB.events.find(e => e.code === '1G-GGRQ-GQ-L013-F002-W');
assert.equal(row38.spec, 'Φ51×8', '图纸148M211-0确认304H规格为Φ51×8');
assert.equal(row38.material, 'SA-213TP304H');
const f004 = ctx.userDB.events.find(e => e.code === '1G-GGRQ-GQ-L002-F004-W');
assert.equal(f004.material, 'SA-213TP304H', '区带映射：F004=炉后第21弯头→304H');
assert.equal(f004.spec, 'Φ51×8');
const g2022 = ctx.userDB.events.find(e => e.code === '1G-GGRQ-GQ-L001-F001-W');
assert.equal(g2022.material, 'SA-213TP347H', '2022前12根区带：F001→TP347H');
assert.equal(g2022.spec, 'Φ54×7.5');
const z2021 = ctx.userDB.events.find(e => e.code === '2G-GZRQ-GQ-L001-F001-W');
assert.equal(z2021.material, 'SA-213TP304H', '2021高再前7根区带：F001→TP304H');
assert.equal(z2021.spec, 'Φ60×4');
assert.equal(ctx.userDB.events.every(e => e.material), true, '确认区带后材质无留空');
assert.equal(f004.material.split('-').pop() !== undefined && ['SA-213TP347H','SA-213TP304H','T91','12CrMoVG'].includes(f004.material), true);
assert.ok(ctx.userDB.events.every(e => /^\d{4}-\d{2}$/.test(e.date)), '日期为年月精度');
assert.equal(ctx.userDB.events.filter(e => e.inspectionResult === '发现异物，割开检查为氧化皮').length, 5);
for(const e of ctx.userDB.events.filter(e => e.inspectionResult === '发现异物，割开检查为氧化皮')) {
  assert.equal(ctx.getTubeProfileData(e.code.replace(/-W$/, '-Q')).data.status, 'warn');
}
assert.equal(ctx.getGeneratedTubeLedgerRows('1').filter(row => row.code === '1G-GGRQ-GQ-L002-F004-W').length, 1, '台账按字母尾物理编码展开');
const actualClean = Core.cleanRows({ rows: actual, matrixRows: matrix, datasetType: 'events' });
assert.equal(actualClean.report.summary.errorCount, 0);
assert.equal(actualClean.report.summary.cleanRows, 464);
assert.match(app, /id="f-part-kind"/);
assert.match(app, /val\('f-part-kind'\) === 'W'/);
assert.doesNotMatch(app, /id="f-seq"/, '生成器不再输出流水号输入');
console.log('ok - letter-only physical codes, part-aware evidence, replacement boundaries, legacy normalization, 464-record package');
