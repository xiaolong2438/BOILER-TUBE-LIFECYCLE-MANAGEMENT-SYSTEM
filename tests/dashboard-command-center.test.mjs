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

console.log("ok - dashboard command center structure");
