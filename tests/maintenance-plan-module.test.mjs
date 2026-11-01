import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// v6.7 起样式与脚本拆分为外部文件，改为合并检索 HTML + JS + CSS
const readFileOrEmpty = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const html = [
  readFileOrEmpty(resolve(here, "../\u7089\u7ba1\u5168\u751f\u547d\u5468\u671f\u7ba1\u7406\u7cfb\u7edf.html")),
  readFileOrEmpty(resolve(here, "../assets/app/app-v7.9.js")),
  readFileOrEmpty(resolve(here, "../assets/app/app-v8.0.css"))
].join("\n");
const matrixStart = html.indexOf("const matrix = [");
const matrixEnd = html.indexOf("\nconst CODE_SYSTEMS", matrixStart);
assert.ok(matrixStart > -1 && matrixEnd > matrixStart, "full inventory matrix should be found");
const matrixBlock = html.slice(matrixStart, matrixEnd);

assert.match(html, /data-view="maintenance-plan"/, "maintenance module nav entry should exist");
assert.match(html, /id="view-maintenance-plan"/, "maintenance module view should exist");
assert.match(html, /检修模块/, "maintenance module should use the requested Chinese title");

assert.match(html, /const MAINTENANCE_CYCLE_YEARS\s*=\s*6/, "maintenance cycle should be 6 years");
assert.match(html, /const MAINTENANCE_OUTAGE_INTERVAL_YEARS\s*=\s*2/, "shutdown interval should be every 2 years");
assert.match(html, /const MAINTENANCE_OUTAGE_COUNT\s*=\s*3/, "6-year cycle should contain 3 outages");
assert.match(html, /MAINTENANCE_OUTAGE_PATTERN[\s\S]*A修[\s\S]*C修[\s\S]*C修/, "maintenance cycle should follow A/C/C");
assert.match(html, /durationDays:\s*50/, "A outage should be 50 days");
assert.match(html, /durationDays:\s*30/, "C outage should be 30 days");
assert.match(html, /workloadShare:\s*50/, "A outage should carry 50% workload");
assert.match(html, /workloadShare:\s*25/, "C outages should carry 25% workload");

assert.match(html, /割管取样/, "plan should include cut-tube sampling");
assert.match(html, /射线/, "plan should include radiographic inspection");
assert.match(html, /测厚/, "plan should include thickness measurement");
assert.match(html, /硬度/, "plan should include hardness testing");
assert.match(html, /防磨防爆检查/, "plan should include anti-wear and anti-blast inspection");
assert.match(matrixBlock, /sys:'HPGRQ'[^}]*spec:'[^']*×/, "ISH full inventory spec should include wall thickness");
assert.match(matrixBlock, /sys:'GGRQ'[^}]*spec:'[^']*×/, "HSH full inventory spec should include wall thickness");

assert.match(html, /function buildMaintenanceOutagePlan\s*\(/, "maintenance plan builder should exist");
assert.match(html, /function renderMaintenancePlan\s*\(/, "maintenance plan renderer should exist");

/* 机组检修基线（业主 2026-10 确认）：2号机 2021-11 A修→2023/2025 C修→2027-04 计划A修；
   1号机 2022-10 A修→2024-04/2026-04 C修→2028-04 计划A修。写死年份不得再漂移。 */
assert.match(html, /const MAINTENANCE_UNIT_BASELINES\s*=/, "per-unit maintenance baseline should exist");
assert.match(html, /'2':\s*\{\s*historyLabels:\s*\['2021A修',\s*'2023C修',\s*'2025C修'\],\s*nextA:\s*'2027年4月',\s*cycleStartYear:\s*2025/, "unit 2 baseline should match the confirmed schedule");
assert.match(html, /'1':\s*\{\s*historyLabels:\s*\['2022A修',\s*'2024C修',\s*'2026C修'\],\s*nextA:\s*'2028年4月',\s*cycleStartYear:\s*2026/, "unit 1 baseline should match the confirmed schedule");
assert.doesNotMatch(html, /'2019A修'|'2020A修'|'2021C修', '2023A修'|'2022C修', '2024A修'/, "outdated hardcoded overhaul labels should be removed");
assert.match(html, /2027年4月 A修/, "next overhaul should carry the confirmed April 2027 month");
assert.match(html, /单炉视图锁定机组真实检修基线|单炉视图按机组基线排程/, "single-boiler plan should pin to the unit baseline");
assert.match(html, /function getMaintenanceLedgerSurfaces\s*\(/, "maintenance plan should aggregate full inventory ledger surfaces");
assert.match(html, /function collectMaintenanceHistorySignals\s*\(/, "maintenance plan should collect historical inspection signals");
assert.match(html, /function getLatestMaintenanceContext\s*\(/, "maintenance plan should use the latest maintenance context");
assert.match(html, /function buildAntiWearExpansionRecommendation\s*\(/, "maintenance plan should recommend anti-wear expansion ranges");
assert.match(html, /function splitSurfacesByWorkload\s*\(/, "maintenance plan should split surfaces by A/C/C workload ratio");
assert.match(html, /function exportMaintenancePlanCSV\s*\(/, "maintenance plan should export a CSV checklist");
assert.match(html, /EVENT_CSV_COLUMNS\.join/, "maintenance CSV should reuse the data-entry CSV headers");
assert.match(html, /userDB\.events/, "maintenance optimization should use local historical inspection records");
assert.match(html, /LIFECYCLE_DATA/, "maintenance optimization should consider system lifecycle sample records");
assert.match(html, /historyScore/, "maintenance plan should score heat surfaces from historical data");
assert.match(html, /\.sort[\s\S]*historyScore/, "higher historical risk should be prioritized earlier in the plan");
assert.match(html, /matrix\.forEach|matrix\.map/, "maintenance plan should derive workload from the full inventory matrix");
assert.match(html, /ledgerCount/, "maintenance plan should carry full-inventory tube counts into planning");
assert.match(html, /targetWorkload|workloadTotal/, "A/C/C split should use ledger workload totals");
assert.match(html, /workloadShare/, "coverage should be distributed by A/C/C workload share");
assert.match(html, /最近一次检修|最近检修/, "maintenance UI should explain the latest-maintenance basis");
assert.match(html, /重点补充|扩大检查范围/, "maintenance UI should show anti-wear supplemental and expanded inspection scope");
assert.match(html, /导出CSV清单/, "maintenance UI should provide a CSV export button");
assert.match(html, /现场结果|责任人|完成日期|备注/, "exported checklist should include fill-in fields");
assert.match(html, /计划项|受热面|重点补充\/扩大检查范围/, "exported checklist should carry maintenance plan detail in the data-entry description column");
assert.match(html, /renderMaintenancePlan\(\)/, "maintenance plan should render during initialization");

console.log("ok - 6-year maintenance module plan is wired");
