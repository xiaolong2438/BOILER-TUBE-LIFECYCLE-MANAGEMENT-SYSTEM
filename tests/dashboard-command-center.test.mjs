import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { strict as assert } from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, "../炉管全生命周期管理系统.html"), "utf8");

assert.match(html, /class="dashboard-command-center"/);
assert.match(html, /class="command-column command-left"/);
assert.match(html, /class="command-core"/);
assert.match(html, /class="command-column command-right"/);
assert.match(html, /id="dashboardHealthRing"/);
assert.match(html, /id="dashboardTrendChart"/);
assert.match(html, /id="dashboardSurfaceList"/);
assert.match(html, /id="dashboard-warning-list"/);
assert.doesNotMatch(html, /id="dashboardCoreLeftMetrics"/);
assert.doesNotMatch(html, /const left = document\.getElementById\('dashboardCoreLeftMetrics'\)/);
assert.match(html, /\.health-ring\s*\{[^}]*grid-column:\s*2;/s);
assert.match(html, /#dashboardCoreRightMetrics\s*\{[^}]*grid-column:\s*3;/s);
assert.match(html, /class="dashboard-status-band"/);
assert.match(html, /renderDashboardHealthCore\(trendStats\)/);
assert.match(html, /getDashboardScopedWarnings\(8\)/);
assert.match(html, /class="command-warning/);
assert.match(html, /\.command-warning:hover\s*\{[^}]*border-top-color:[^}]*background:[^}]*box-shadow:/s);
assert.match(html, /\.command-warning:focus-visible\s*\{[^}]*outline:/s);
assert.match(html, /#dashboard-warning-list\s*\{[^}]*height:\s*145px;[^}]*overflow-y:\s*scroll;[^}]*scrollbar-gutter:\s*stable/s);
for (const id of ["dashboardHealthRing", "dashboardTrendChart", "dashboardSurfaceList", "dashboard-warning-list"]) {
  assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `${id} must be unique`);
}
assert.match(html, /@media \(max-width: 1100px\)[\s\S]*\.dashboard-command-center/);
assert.match(html, /@media \(max-width: 700px\)[\s\S]*\.health-core-grid/);
assert.doesNotMatch(html, /先定位高风险受热面/);
assert.doesNotMatch(html, /首页聚焦设备专工最需要的四件事/);

console.log("ok - dashboard command center structure");
