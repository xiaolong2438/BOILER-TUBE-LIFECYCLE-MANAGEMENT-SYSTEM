import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { strict as assert } from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, "../炉管全生命周期管理系统.html"), "utf8");
const externalCss = (() => { try { return readFileSync(resolve(here, "../assets/app/app-v8.0.css"), "utf8"); } catch { return ""; } })();
const externalJs = (() => { try { return readFileSync(resolve(here, "../assets/app/app-v7.9.js"), "utf8"); } catch { return ""; } })();
const styleSource = html + externalCss;
const scriptSource = html + externalJs;

assert.match(html, /class="dashboard-command-center"/);
assert.match(html, /class="command-column command-left"/);
assert.match(html, /class="command-core"/);
assert.match(html, /class="command-column command-right"/);
assert.match(html, />待处置任务</);
assert.match(html, />最新风险信号</);
assert.doesNotMatch(html, />风险处置</);
assert.doesNotMatch(html, />最新预警</);
assert.match(html, /id="dashboardHealthRing"/);
assert.match(html, /id="dashboardTrendChart"/);
assert.match(html, /id="dashboardSurfaceList"/);
assert.match(html, /id="dashboard-warning-list"/);
assert.doesNotMatch(html, /id="dashboardCoreLeftMetrics"/);
assert.doesNotMatch(scriptSource, /const left = document\.getElementById\('dashboardCoreLeftMetrics'\)/);
assert.match(styleSource, /\.health-ring\s*\{[^}]*grid-column:\s*2;/s);
assert.match(styleSource, /#dashboardCoreRightMetrics\s*\{[^}]*grid-column:\s*3;/s);
assert.match(html, /class="dashboard-status-band"/);
assert.match(scriptSource, /renderDashboardHealthCore\(trendStats\)/);
assert.match(scriptSource, /getDashboardScopedWarnings\(8\)/);
assert.match(html + scriptSource, /class="command-warning/);
assert.match(styleSource, /\.command-warning:hover\s*\{[^}]*border-top-color:[^}]*background:[^}]*box-shadow:/s);
assert.match(styleSource, /\.command-warning:focus-visible\s*\{[^}]*outline:/s);
assert.match(styleSource, /#dashboard-warning-list\s*\{[^}]*height:\s*145px;[^}]*overflow-y:\s*scroll;[^}]*scrollbar-gutter:\s*stable/s);
assert.match(styleSource, /\.hero-task-list\s*\{[^}]*height:\s*\d+px;[^}]*overflow-y:\s*scroll;[^}]*scrollbar-gutter:\s*stable/s);
for (const id of ["dashboardHealthRing", "dashboardTrendChart", "dashboardSurfaceList", "dashboard-warning-list"]) {
  assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `${id} must be unique`);
}
assert.match(styleSource, /@media \(max-width: 1100px\)[\s\S]*\.dashboard-command-center/);
assert.match(styleSource, /@media \(max-width: 700px\)[\s\S]*\.health-core-grid/);
assert.doesNotMatch(html, /先定位高风险受热面/);
assert.doesNotMatch(html, /首页聚焦设备专工最需要的四件事/);

// 待处置任务/风险信号：管编码 + 短结果（完整明细悬停可见）
assert.match(externalJs, /function shortEventResult\(event\)/);
assert.match(externalJs, /short: shortEventResult\(event\)/);
assert.match(externalJs, /<div class="title">\$\{escapeHTML\(item\.code\)\}<\/div><div class="meta">\$\{escapeHTML\(item\.short \|\| item\.text\)\}<\/div>/, "任务卡标题=编码、摘要=短结果");
assert.match(externalJs, /title="打开管段档案 \$\{escapeHTML\(item\.code\)\} · \$\{escapeHTML\(item\.text\)\}"/, "完整明细保留在悬停提示");
assert.match(externalJs, /<strong>\$\{escapeHTML\(item\.code\)\}<\/strong><span>\$\{escapeHTML\(item\.short \|\| item\.text\)\}<\/span>/, "风险信号列表同用短结果");

// 行为验证：shortEventResult 自包含，可独立执行
import vm from "node:vm";
const shortCtx = vm.createContext({});
vm.runInContext(externalJs.slice(externalJs.indexOf("function shortEventResult"), externalJs.indexOf("function collectDashboardWarnings")), shortCtx);
const shortOf = event => vm.runInContext(`shortEventResult(${JSON.stringify(event)})`, shortCtx);
assert.equal(shortOf({ code: '1G-GGRQ-GQ-L025-F002-W', type: '无损检测', desc: '批次：2026年1号机C修；结果：发现异物，割开检查为氧化皮；结果性质：异常观察' }), '弯头氧化皮', '氧化皮优先于异物，部位取编码尾字母');
assert.equal(shortOf({ code: '1G-GGRQ-GQ-L002-F002-W001', type: '无损检测', desc: '发现异物' }), '弯头异物', '历史数字尾同样识别部位');
assert.equal(shortOf({ code: '1G-GZRQ-GQ-L001-F001-Q', type: '测厚', desc: '测厚', thickness: '3.1' }), '管子测厚 3.1mm');
assert.equal(shortOf({ code: '1G-GGRQ-GQ-L001-F001-W', type: '射线', desc: '合格' }), '弯头射线');

console.log("ok - dashboard command center structure");
