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
  'normalizeCodeDirection', 'normalizedTubeCode', 'dmDuplicateKey', 'tubePositionKey', 'sameTubeMeasurement',
  'isExactInspectionDate', 'tubeEvidenceEvents', 'currentTubeEvents', 'parseTubeCode',
  'matrixRowMatches', 'matchComponentFromCode', 'validateCodeAgainstMatrix', 'validateCodeAgainstRules',
  'extractThicknessData', 'getTubeProfileData', 'matrixExpandCodes', 'matrixRowCount',
  'getGeneratedTubeLedgerRows', 'tubeLocationText', 'isMaintenanceInspectionRecord',
  'collectTubeInspectionRecords', 'getInspectionAsOfDate', 'yearsSinceDate', 'classifyInspectionAging',
  'maintenanceOverdueAction', 'buildMaintenanceOverdueRows', 'robustLinearTrend',
  'assessPredictionQuality', 'collectAICompositeSignals', 'isRetiredTubeCode',
  'getBoilerFromCode', 'normalizeBoiler', 'eventBoiler', 'importLifecycleRows'
]) vm.runInContext(functionSource(name), ctx);
// 12回路分段基准 + 档案页规格材质摘要（getTubeProfileData 依赖）
vm.runInContext(app.slice(app.indexOf('const GGRQ_LOOP_BASELINE'), app.indexOf('function renderGGRQLoopBaseline')), ctx);

const q = '1G-GGRQ-GQ-L002-F004-Q';
const w = '1G-GGRQ-GQ-L002-F004-W';
const legacyW = '1G-GGRQ-GQ-L002-F004-W001';
const fieldBack = '1G-GGRQ-GQ-L001-B001-W';

// 解析与校验：字母尾即身份；历史数字尾兼容但归一到字母。
assert.equal(Core.validateTubeCode(w, matrix).valid, true);
const wCheck = Core.validateTubeCode(w, matrix);
assert.equal(wCheck.matched?.sys, 'GGRQ', 'F/B 管序即台账主口径，F004 直接命中矩阵行');
assert.notEqual(wCheck.fieldPosition, true, '正式回路位置不标为待核现场管位');
assert.equal(Core.validateTubeCode(legacyW, matrix).valid, true, '历史流水数字尾仍可解析');
assert.deepEqual(Core.canonicalTubeCode(fieldBack, matrix), { code: '1G-GGRQ-GQ-L001-F001-W', changed: true }, '弯头B写法归一入口段位：B001-W≙F001-W（同一弯头）');
assert.equal(Core.canonicalTubeCode('1G-GGRQ-GQ-R007-F012-W', matrix).code, '1G-GGRQ-GQ-L026-F012-W', '用户确认32屏：R007≙L026');
assert.equal(Core.canonicalTubeCode('1G-GZRQ-GQ-L001-B001-W', matrix).code, '1G-GZRQ-GQ-L001-F001-W', '高再B弯头归一同回路F底弯');
assert.equal(Core.canonicalTubeCode('1G-GZRQ-GQ-L001-B001-Q', matrix), null, '高再B出口直管不镜像为F入口');
assert.equal(Core.validateTubeCode('1G-GZRQ-GQ-L001-B007-Q', matrix).matched.sys, 'GZRQ');
for (const code of ['1G-GZRQ-GQ-L001-F008-Q', '1G-GZRQ-GQ-L001-B014-W', '1G-GZRQ-GQ-L001-D008-Q']) {
  assert.equal(Core.canonicalTubeCode(code, matrix), null, '高再旧腿号不得推测迁移');
  assert.equal(Core.validateTubeCode(code, matrix).matched, null);
}
assert.equal(Core.canonicalTubeCode('1G-GGRQ-GQ-L012-D003-Q', matrix), null, 'U/D 管序已废止：D 码不再换算');
assert.equal(Core.canonicalTubeCode('1G-GZRQ-GQ-L012-D003-Q', matrix), null, 'U/D 管序已废止：D 码不再换算');
assert.equal(Core.canonicalTubeCode('1G-GGRQ-GQ-L012-B003-Q', matrix), null, '回路行Q的B=出口段规范地址，不再跨镜像');
assert.equal(Core.canonicalTubeCode('1G-GGRQ-GQ-L012-F020-Q', matrix).code, '1G-GGRQ-GQ-L012-B005-Q', '旧腿号迁移：F020（炉后第5根）→出口段B005');
assert.equal(Core.canonicalTubeCode('1G-GGRQ-GQ-L012-F024-W', matrix).code, '1G-GGRQ-GQ-L012-F001-W', '旧腿号迁移：F024弯头→回路1底弯F001-W');
assert.equal(Core.canonicalTubeCode('1G-GGRQ-GQ-L012-B020-Q', matrix).code, '1G-GGRQ-GQ-L012-F005-Q', '旧腿号迁移：B020≙旧F005入口段→F005');
/* 11192 + 省煤器新口径（2026-11-08）：蛇形管 124排×3圈×2组(U/D)=744、吊挂管 56×2=112（原 124，+732） */
assert.equal(matrix.reduce((sum, row) => sum + ctx.matrixRowCount(row), 0), 11924);
assert.equal(ctx.parseTubeCode(w).partKind, 'W');
assert.equal(ctx.parseTubeCode(w).seq, null);
assert.equal(ctx.parseTubeCode(legacyW).seq, 1);
assert.equal(Core.validateTubeCode('1G-DPGRQ-GQ-L001-F001-F001-Q', matrix).valid, true, '大屏管序 F/B 为合法主口径');
assert.equal(Core.canonicalTubeCode('1G-DPGRQ-GQ-L001-B001-F007-Q', matrix).code, '1G-DPGRQ-GQ-L001-F004-F007-Q', '小屏号台账 F001–F004：炉后起算 B001≙F004');
assert.equal(Core.validateTubeCode('1G-DPGRQ-GQ-L001-L002-F001-Q', matrix).matched, null, '小屏号 L/R 旧写法不再命中矩阵');
assert.equal(Core.suggestSimilarCode('1G-GGRQ-GQ-L033-F004-W', [q]), null, 'W 不得建议成 Q');
const suggestion = Core.suggestSimilarCode('1G-GGRQ-GQ-L033-F004-W', [w]);
assert.ok(suggestion && suggestion.code.endsWith('-W'), '同部位建议保持 W 尾');

// 同管证据聚合：Q 档案汇总 W 观察；台账/检修按管位聚合。
const event = (code, date, desc, extra = {}) => ({ code, date, desc, type: '无损检测', boiler: '1', ...extra });
ctx.userDB.events = [event(q, '2022-05-01', '测厚', { thickness: '7.2' }), event(w, '2026', '发现异物，割开检查为氧化皮')];
const profile = ctx.getTubeProfileData(legacyW);
assert.equal(profile.localEvents.length, 2, '历史数字尾与字母尾是同一部位');
assert.equal(profile.data.status, 'warn', '同管异常观察应提升档案状态');
const priorEvents = ctx.userDB.events;
ctx.userDB.events = [
  event(w, '2026-04', '方法：射线；结果：合格', { sourceId: '源记录A', batch: '2026年C修' }),
  event(legacyW, '2026-04', '方法：射线；结果：合格', { sourceId: '源记录B', batch: '2026年C修' })
];
const folded = ctx.getTubeProfileData(w);
assert.equal(folded.localEvents.length, 2, '原始证据不删除');
assert.equal(folded.timeline.length, 1, '同日期同编码同检查与结果只显示一个时间线节点');
assert.match(folded.timeline[0].d, /关联 2 条来源/);
assert.match(folded.timeline[0].d, /源记录A[\s\S]*源记录B/, '折叠后可展开核对两条来源');
ctx.userDB.events.push(
  event(w, '2026-04', '方法：射线；结果：不合格', { sourceId: '源记录C' }),
  event(w, '2026-04', '方法：射线；结果：合格', { sourceId: '源记录D', thickness: '6.8' })
);
assert.equal(ctx.getTubeProfileData(w).timeline.length, 3, '不同结果或测厚值不折叠');
ctx.userDB.events = priorEvents;
assert.ok(profile.data.spec.startsWith('回路4 底弯段 Φ51×8 SA-213TP304H'), '档案页规格材质按12回路基准显示确定值，不再整库罗列');
// 高过Q直管按回路基准显示所在腿沿流程分段链（多种规格按顺序全部列出，邻底弯段打标）
ctx.userDB.events.push(event('1G-GGRQ-GQ-L025-F002-Q', '2026-04', '测厚', { thickness: '7.4' }));
assert.ok(ctx.getTubeProfileData('1G-GGRQ-GQ-L025-F002-Q').data.spec.startsWith('回路2 入口段 F002（顶入口→底弯）：Φ51×9 12Cr1MoVG → Φ51×9 SA-213T91【底弯前】'), '入口段Q列出底弯前全部直管段');
ctx.userDB.events.push(event('1G-GGRQ-GQ-L025-F023-Q', '2026-04', '测厚', { thickness: '7.6' }));
assert.ok(ctx.getTubeProfileData('1G-GGRQ-GQ-L025-F023-Q').data.spec.startsWith('回路2 出口段 B002（底弯→顶出口）：Φ51×11 SA-213T91【底弯后】 → Φ51×11 SA-213T22'), '旧出口段码F023迁移为B002并列出口段链');
assert.ok(ctx.getTubeProfileData('1G-GGRQ-GQ-L025-B002-Q').data.spec.startsWith('回路2 出口段 B002'), 'B向编码即出口段规范地址');
assert.ok(ctx.tubeSpecMaterialSummary('1G-GGRQ-GQ-L030-F008-Q', []).includes('Φ51×9 12Cr1MoVG【底弯前】'), '回路8-11入口段整根与底弯同材质');
ctx.userDB.events.push(event('1G-GGRQ-GQ-L025-F002-Q', '2026-05', '测厚', { thickness: '7.1', spec: 'Φ51×9', material: '12Cr1MoVG' }));
assert.ok(!ctx.getTubeProfileData('1G-GGRQ-GQ-L025-F002-Q').data.spec.includes('；检测记录'), '记录规格命中分段链时不重复附注');
ctx.userDB.events.push(event('1G-GGRQ-GQ-L025-F002-Q', '2026-06', '测厚', { thickness: '7.0', spec: 'Φ51×11', material: 'SA-213T22' }));
assert.ok(ctx.getTubeProfileData('1G-GGRQ-GQ-L025-F002-Q').data.spec.includes('；检测记录：Φ51×11 SA-213T22'), '记录规格不在直管链时附检测记录');
// 高过回路绑定：回路k = 入口段F00k-Q + 底弯F00k-W + 出口段B00k-Q（F001↔B001 … F012↔B012），档案页三段互跳
const bind1 = ctx.ggrqLoopBinding('1G-GGRQ-GQ-L025-F001-Q');
assert.equal(bind1.loop, 1);
assert.equal(bind1.frontCode, '1G-GGRQ-GQ-L025-F001-Q');
assert.equal(bind1.bendCode, '1G-GGRQ-GQ-L025-F001-W');
assert.equal(bind1.rearCode, '1G-GGRQ-GQ-L025-B001-Q');
assert.equal(bind1.current.front, true, 'F001-Q 是回路1入口段');
assert.equal(bind1.current.bend, false);
assert.equal(bind1.current.rear, false);
assert.equal(ctx.ggrqLoopBinding('1G-GGRQ-GQ-L025-B001-Q').current.rear, true, 'B001-Q 是回路1出口段');
assert.equal(ctx.ggrqLoopBinding('1G-GGRQ-GQ-L025-B001-Q').frontCode, '1G-GGRQ-GQ-L025-F001-Q', '出口段绑定入口段F001');
assert.equal(ctx.ggrqLoopBinding('1G-GGRQ-GQ-L025-F013-Q').loop, 12, 'F013 是回路12入口段');
assert.equal(ctx.ggrqLoopBinding('1G-GGRQ-GQ-L025-F012-Q').rearCode, '1G-GGRQ-GQ-L025-B012-Q', 'F012 绑定出口段B012');
assert.equal(ctx.ggrqLoopBinding('1G-GGRQ-GQ-L025-F001-W').current.bend, true, 'W 即底弯件本身');
assert.equal(ctx.ggrqLoopBinding('1G-GGRQ-GQ-L025-B003-W').bendCode, '1G-GGRQ-GQ-L025-F003-W', '弯头B写法归一入口段位');
assert.equal(ctx.ggrqLoopBinding('1G-GGRQ-GQ-L025-B024-Q').frontCode, '1G-GGRQ-GQ-L025-F001-Q', '旧腿号B024迁移为入口段F001');
assert.equal(ctx.ggrqLoopBinding('1G-SLB-WB-F000-R025-Q'), null, '非悬挂屏不做回路绑定');
assert.match(app, /回路\$\{loopBind\.loop\} 绑定/, '档案页接入回路绑定条');
// 后屏过热器：编号数回路（F001–F013 入口段 / B001–B013 出口段），13回路；旧腿号F014–F026自动迁移
const hbind1 = ctx.ggrqLoopBinding('1G-HPGRQ-GQ-L010-F001-Q');
assert.equal(hbind1.loop, 1, '后屏外圈为回路1');
assert.equal(hbind1.rearCode, '1G-HPGRQ-GQ-L010-B001-Q', 'F001 绑定出口段B001');
assert.equal(ctx.ggrqLoopBinding('1G-HPGRQ-GQ-L010-B001-Q').current.rear, true, 'B001-Q 是回路1出口段');
assert.equal(ctx.ggrqLoopBinding('1G-HPGRQ-GQ-L010-F013-Q').loop, 13, 'F013 是回路13（包扎管）入口段');
assert.equal(ctx.ggrqLoopBinding('1G-HPGRQ-GQ-L010-B013-Q').frontCode, '1G-HPGRQ-GQ-L010-F013-Q', 'B013 绑定入口段F013');
assert.equal(ctx.ggrqLoopBinding('1G-HPGRQ-GQ-L010-F013-W').current.bend, true, '后屏底弯同样记入口段位');
assert.equal(ctx.ggrqLoopBinding('1G-HPGRQ-GQ-L010-F026-Q').rearCode, '1G-HPGRQ-GQ-L010-B001-Q', '旧腿号F026迁移为出口段B001');
const gzbind = ctx.ggrqLoopBinding('1G-GZRQ-GQ-L032-F001-Q');
assert.equal(gzbind.rearCode, '1G-GZRQ-GQ-L032-B001-Q', '高再入口绑定同回路出口');
assert.equal(ctx.ggrqLoopBinding('1G-GZRQ-GQ-L032-B001-Q').current.rear, true);
assert.equal(ctx.ggrqLoopBinding('1G-GZRQ-GQ-L032-B001-W').bendCode, '1G-GZRQ-GQ-L032-F001-W');
// 全大屏过热器：每片4小屏×14回路；外三圈（回路1-3）与最内圈（回路14，夹持管外套）下段+底弯T91，中间整根12Cr1MoVG
const dbind = ctx.ggrqLoopBinding('1G-DPGRQ-GQ-L001-F002-F003-Q');
assert.equal(dbind.loop, 3, '大屏绑定在小屏内：片1小屏2回路3');
assert.equal(dbind.rearCode, '1G-DPGRQ-GQ-L001-F002-B003-Q', '出口段B003 同片同小屏');
ctx.userDB.events.push(event('1G-DPGRQ-GQ-L001-F002-F001-Q', '2026-04', '测厚', { thickness: '6.4' }));
assert.ok(ctx.getTubeProfileData('1G-DPGRQ-GQ-L001-F002-F001-Q').data.spec.startsWith('回路1 入口段 F001（顶入口→底弯）：Φ51×7 12Cr1MoVG → Φ51×7 SA-213T91【底弯前】'), '大屏外圈入口段链（12Cr1MoVG→T91）');
ctx.userDB.events.push(event('1G-DPGRQ-GQ-L001-F002-F008-Q', '2026-04', '测厚', { thickness: '6.6' }));
assert.ok(ctx.getTubeProfileData('1G-DPGRQ-GQ-L001-F002-F008-Q').data.spec.includes('Φ51×7 12Cr1MoVG【底弯前】'), '大屏中间回路整根12Cr1MoVG');
ctx.userDB.events.push(event('1G-DPGRQ-GQ-L001-F002-F014-Q', '2026-04', '测厚', { thickness: '6.5' }));
assert.ok(ctx.getTubeProfileData('1G-DPGRQ-GQ-L001-F002-F014-Q').data.spec.startsWith('回路14 入口段 F014（顶入口→底弯）：Φ51×7 12Cr1MoVG → Φ51×7 SA-213T91【底弯前】'), '最内圈（夹持管外套）分段链');
// 后屏规格材质链：外圈Φ60、回路2-3/13底弯TP347H、回路4-6底弯T91、回路7-12整根12Cr1MoVG
ctx.userDB.events.push(event('1G-HPGRQ-GQ-L010-F001-Q', '2026-04', '测厚', { thickness: '7.8' }));
assert.ok(ctx.getTubeProfileData('1G-HPGRQ-GQ-L010-F001-Q').data.spec.startsWith('回路1 入口段 F001（顶入口→底弯）：Φ60×8 12Cr1MoVG → Φ60×8 SA-213T91【底弯前】'), '后屏外圈入口段分段链');
ctx.userDB.events.push(event('1G-HPGRQ-GQ-L010-F002-W', '2026-04', '测厚', { thickness: '7.2' }));
assert.ok(ctx.getTubeProfileData('1G-HPGRQ-GQ-L010-F002-W').data.spec.startsWith('回路2 底弯段 Φ54×8.5 SA-213TP347H'), '后屏回路2底弯TP347H');
ctx.userDB.events.push(event('1G-HPGRQ-GQ-L010-F004-W', '2026-04', '测厚', { thickness: '7.3' }));
assert.ok(ctx.getTubeProfileData('1G-HPGRQ-GQ-L010-F004-W').data.spec.startsWith('回路4 底弯段 Φ54×8.5 SA-213T91'), '后屏回路4-6底弯T91');
ctx.userDB.events.push(event('1G-HPGRQ-GQ-L010-F009-Q', '2026-04', '测厚', { thickness: '7.0' }));
assert.ok(ctx.getTubeProfileData('1G-HPGRQ-GQ-L010-F009-Q').data.spec.includes('Φ54×8.5 12Cr1MoVG【底弯前】'), '后屏回路7-12整根12Cr1MoVG');
ctx.userDB.events.push(event('1G-HPGRQ-GQ-L010-F013-Q', '2026-04', '测厚', { thickness: '7.5' }));
assert.ok(ctx.getTubeProfileData('1G-HPGRQ-GQ-L010-F013-Q').data.spec.startsWith('回路13 入口段 F013（顶入口→底弯）：Φ54×8.5 12Cr1MoVG → Φ54×8.5 SA-213T91【底弯前】'), '包扎管入口段分段链');
assert.equal(ctx.tubeSpecMaterialSummary('1G-HPGRQ-GQ-L010-F013-W', []).startsWith('回路13 底弯段 Φ54×9 SA-213TP347H'), true, '包扎管底弯为Φ54×9 TP347H');
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
assert.equal(ctx.userDB.events.find(e => e.sourceId === '2026!R39#001').code, '1G-GGRQ-GQ-L001-F001-W', '弯头B写法归一入口段位F001-W');
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
      if (manifest.rule_version === 'film-records-physical-codes-v10') return `../data-cleaning/${name}`;
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
// v10：包内编码直接按统一回路编号口径出码——无R屏号残留、无旧腿号F013–F024。
assert.ok(actual.slice(1).every(r => /-GQ-L\d{3}-[FB]\d{3}-[QW]$/.test(r[3])), '屏号规范L、管位为入口段F/出口段B且无旧腿号');
assert.ok(actual.slice(1).every(r => !/-F01[3-9]|-F02[0-4]/.test(r[3])), '旧腿号F013–F024已按回路号迁移');
ctx.userDB = { events: [], replacements: [] };
const imported = ctx.importLifecycleRows(actual);
assert.equal(imported.importedEvents, 464);
assert.equal(imported.normalizedCount, 0, 'v10包内已完成屏号镜像与旧腿号迁移，导入无需再归一');
const normalizedSample = ctx.userDB.events.find(e => e.sourceId === '2022年1号机A修!R4#001');
assert.ok(normalizedSample && normalizedSample.code === '1G-GGRQ-GQ-L001-F001-W', 'A侧R001按确认镜像落L032前的规范屏号；实际：' + (normalizedSample && normalizedSample.code));
assert.equal(ctx.importLifecycleRows(actual).skippedDuplicates, 464);
assert.equal(new Set(ctx.userDB.events.map(e => e.ts)).size, 464);
assert.equal(new Set(ctx.userDB.events.map(e => e.sourceId)).size, 464);
assert.equal(ctx.userDB.events.filter(e => e.code.endsWith('-F024-W')).length, 0, '旧腿号F024全部迁移');
assert.equal(ctx.userDB.events.filter(e => /-F001-W$/.test(e.code)).length, 96, '回路1底弯全厂96条（高过80：2022/2021各8+2026双侧64；高再16）');
assert.equal(ctx.userDB.events.filter(e => e.code === '1G-GGRQ-GQ-L001-F001-W').length, 3, 'L001屏回路1底弯3条：2026炉前+炉后双侧+2022复检（来源ID幂等不合并）');
assert.equal(ctx.userDB.events.filter(e => e.code.includes('-B0')).length, 0, '包内弯头记录全部归一到入口段位F00k-W');
const l027 = ctx.userDB.events.find(e => e.code === '1G-GGRQ-GQ-L027-F001-W');
assert.equal(l027.result_nature ?? '合格', '合格');
assert.ok(l027, '用户确认的第27屏已按L027导入');
assert.ok(ctx.userDB.events.every(e => !e.desc || !/来源ID|批次：|依据/.test(e.desc)), 'v9：发布包描述列只含检测内容，溯源与依据留专属列/审计');

// 同来源ID重导：内容一致幂等跳过；描述等有变化原位更新、不产生重复（v9换包迁移口径）
const eventsBeforeUpdate = ctx.userDB.events.length;
const mutated = actual.map((cells, idx) => (idx === 1 ? cells.map((c, i) => (i === 10 ? '方法：射线；结果：合格（换包后瘦身描述）' : c)) : cells));
const reimported = ctx.importLifecycleRows(mutated);
assert.equal(reimported.updatedEvents, 1, '同来源ID且内容有变化→原位更新');
assert.equal(reimported.skippedDuplicates, 463, '其余463条同内容幂等跳过');
assert.equal(ctx.userDB.events.length, eventsBeforeUpdate, '更新不新增记录');
assert.ok(ctx.userDB.events.some(e => e.desc === '方法：射线；结果：合格（换包后瘦身描述）'), '描述已刷新');
assert.equal(ctx.userDB.events.filter(e => e.code === '1G-GGRQ-GQ-L024-F001-W').length, 2, 'L024回路1底弯：双侧拍摄各留一条（来源ID幂等不合并）');
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
const ledgerRowForW = ctx.getGeneratedTubeLedgerRows('1').filter(row => ctx.tubePositionKey(row.code) === ctx.tubePositionKey(w));
assert.equal(ledgerRowForW.length, 1, '台账按管位聚合：Q 生成行与 W 事件同管一行（Q/W 同管合并）');
assert.equal(ledgerRowForW[0].code, '1G-GGRQ-GQ-L002-F004-Q', 'F/B 管序为台账展开口径');
assert.ok(ctx.getTubeProfileData(w).localEvents.some(e => e.code === w), 'W 弯头事件挂档案不丢失');
const actualClean = Core.cleanRows({ rows: actual, matrixRows: matrix, datasetType: 'events' });
assert.equal(actualClean.report.summary.errorCount, 0);
assert.equal(actualClean.report.summary.cleanRows, 464);
assert.match(app, /id="f-part-kind"/);
assert.match(app, /val\('f-part-kind'\) === 'W'/);
assert.doesNotMatch(app, /id="f-seq"/, '生成器不再输出流水号输入');
console.log('ok - letter-only physical codes, part-aware evidence, replacement boundaries, legacy normalization, 464-record package');
