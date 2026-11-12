import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import vm from "node:vm";

/**
 * 旧系统码兼容：后屏过热器由 HPGRQ 统一为 PSGRQ 后，
 * 历史管码仍应能解析、检索与脱敏，保存时统一归一为新码。
 */
const app = readFileSync(new URL("../assets/app/app-v7.9.js", import.meta.url), "utf8");
const coreSource = readFileSync(new URL("../assets/app/assistant-core-v1.js", import.meta.url), "utf8");
const analysisSource = readFileSync(new URL("../assets/app/assistant-analysis-v1.js", import.meta.url), "utf8");
const otCoreSource = readFileSync(new URL("../assets/app/overtemperature-core-v1.js", import.meta.url), "utf8");
const otUiSource = readFileSync(new URL("../assets/app/overtemperature-v1.js", import.meta.url), "utf8");
const otImportSource = readFileSync(new URL("../assets/app/overtemperature-import-v1.js", import.meta.url), "utf8");

const sandbox = { console };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(coreSource, sandbox);
vm.runInContext(analysisSource, sandbox);
vm.runInContext(otCoreSource, sandbox);
const Core = sandbox.BTAssistantCore;
const A = sandbox.BTAssistantAnalysis;
const OT = sandbox.BTOvertemperatureCore;

const legacy = "1G-HPGRQ-GQ-L010-F001-Q";
const current = "1G-PSGRQ-GQ-L010-F001-Q";

/* ---------- 领域层：归一、解析、检索、标签 ---------- */
assert.equal(Core.normalizeCode(legacy), current, "旧码经 normalizeCode 应归一为新码");
assert.equal(Core.normalizeCode("2g-hpgrq-gq-l001-b002-w"), "2G-PSGRQ-GQ-L001-B002-W", "别名归一不区分大小写");
assert.deepEqual(Array.from(Core.extractTubeCodes("记录 " + legacy)), [current], "文本中的旧码应被提取为新码");
assert.deepEqual(Array.from(Core.extractSystems("查看 " + legacy)), ["PSGRQ"], "只写旧系统码也应识别为后屏过热器");
assert.equal(Core.sysLabel("HPGRQ"), "后屏过热器（PSGRQ）", "旧系统码的展示名应映射到新码");

/* ---------- 主应用：解析与管位身份 ---------- */
const matrixText = app.slice(app.indexOf("const matrix = ["), app.indexOf("\nconst CODE_SYSTEMS"));
const matrix = vm.runInNewContext(matrixText + "; matrix");
const checked = Core.validateTubeCode(legacy, matrix);
assert.equal(checked.valid, true, "旧码格式应仍然有效");
assert.equal(checked.code, current, "校验结果应返回归一后的新码");
assert.equal(checked.parts.sys, "PSGRQ", "解析出的系统码应为 PSGRQ");
assert.equal(checked.matched && checked.matched.sys, "PSGRQ", "旧码应命中新矩阵行");

function functionSource(name) {
  const start = app.indexOf("function " + name + "(");
  assert.ok(start >= 0, name);
  const match = /^}/m.exec(app.slice(start));
  assert.ok(match, name + " must be multiline");
  return app.slice(start, start + match.index + 1);
}
const ctx = vm.createContext({ window: { BTAssistantCore: Core }, matrix, console, Date, Set, Map });
for (const name of ["canonicalizeSystemAliases", "normalizeCodeDirection", "normalizedTubeCode", "parseTubeCode", "tubePositionKey"]) {
  vm.runInContext(functionSource(name), ctx);
}
assert.equal(ctx.normalizedTubeCode(legacy), current, "保存路径应把旧码归一为新码");
assert.equal(ctx.parseTubeCode(legacy).sys, "PSGRQ", "主应用解析器应接受旧码");
assert.equal(ctx.tubePositionKey(legacy), ctx.tubePositionKey(current), "新旧码必须指向同一管位身份");

/* ---------- 超温模块：旧区域配置应校验通过并归一 ---------- */
const legacyRegion = {
  sys: "HPGRQ", comp: "GQ", wall: null, spaces: null,
  posFrom: null, posTo: null, pos2From: null, pos2To: null,
  tubeFrom: null, tubeTo: null, dirs: null, parts: null,
  corners: null, layers: null, nozzles: null
};
const regionCheck = OT.validateRegion(legacyRegion, OT.MATRIX);
assert.equal(regionCheck.ok, true, "旧系统码区域应通过校验");
assert.equal(regionCheck.value.sys, "PSGRQ", "区域校验后应归一为新系统码");
assert.equal(OT.matchesRegion(current, legacyRegion, "1", OT.MATRIX), true, "旧区域应能命中新码管段");

/* ---------- 外发脱敏：旧码不能漏掉 ---------- */
const masked = A.maskPii(legacy + " 联系电话 13800138000");
assert.ok(!masked.includes(legacy), "旧码也必须被脱敏");
assert.ok(masked.includes("[管码]"));

/* ---------- 静态防线：别名层与正则分支仍在 ---------- */
assert.match(coreSource, /LEGACY_SYSTEM_ALIASES/);
assert.match(coreSource, /PSGRQ\|HPGRQ/);
assert.match(app, /SYSTEM_CODE_ALIASES/);
assert.match(analysisSource, /PSGRQ\|HPGRQ/);
assert.match(otCoreSource, /SYSTEM_ALIASES = \{ HPGRQ: 'PSGRQ' \}/);
assert.match(otUiSource, /SYSTEM_ALIASES = \{ HPGRQ: 'PSGRQ' \}/);
assert.match(otImportSource, /SYSTEM_ALIASES = \{ HPGRQ: 'PSGRQ' \}/);

console.log("ok - legacy HPGRQ tube codes are accepted and normalized to PSGRQ");
