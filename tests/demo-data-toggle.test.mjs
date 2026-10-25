import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const js = readFileSync(resolve(here, "../assets/app/app-v7.9.js"), "utf8");
const html = readFileSync(resolve(here, "../炉管全生命周期管理系统.html"), "utf8");

// 三态演示数据开关：默认自动——无真实数据显示演示，真实数据到位自动隐藏；可强制开/关。
assert.match(js, /function demoDataPref\(\)/);
assert.match(js, /function hasRealTubeData\(\)/);
assert.match(js, /return !hasRealTubeData\(\); \/\* 自动：真实数据到位即隐藏演示 \*\//);
assert.match(js, /function systemLifecycleData\(\) \{ return demoDataEnabled\(\) \? LIFECYCLE_DATA : \{\}; \}/);
assert.match(js, /function toggleDemoData\(\)/);
assert.match(js, /const order = \['auto', 'on', 'off'\];/, "按钮按 自动→强制开→强制关 循环");
assert.match(js, /'blcms-demo-data'/, "偏好必须持久化");
assert.match(html, /id="demo-data-toggle" type="button" onclick="toggleDemoData\(\)"/);

// 顶栏紧凑胶囊按钮：标签精简，隐藏态用 is-hidden 类半透明表示。
assert.match(js, /btn\.textContent = pref === 'auto' \? '演示·自动' : \(pref === 'on' \? '演示·开' : '演示·关'\);/);
assert.match(js, /btn\.classList\.toggle\('is-hidden', !demoDataEnabled\(\)\);/);
assert.match(html, /class="topbar-demo-toggle" id="demo-data-toggle"/);

// 所有消费点走过滤访问器（保留 const 定义本身）。
assert.doesNotMatch(js, /(?<!const )(?<!\?)Object\.entries\(LIFECYCLE_DATA\)/);
assert.doesNotMatch(js, /(?<!const )LIFECYCLE_DATA\[code\]/);
assert.match(js, /Object\.entries\(systemLifecycleData\(\)\)/);

// 切换后重渲染受影响视图。
assert.match(js, /function refreshAfterDemoToggle\(\)/);

// 待处置任务：有预警时自动生成 Top3（含机组过滤），无预警且演示关闭时给空态。
assert.match(js, /function renderHeroTasks\(\)/);
assert.match(js, /const warnings = getDashboardScopedWarnings\(99\);/);
assert.match(js, /host\.querySelectorAll\('\[data-dashboard-boiler\]'\)\.forEach/);
assert.match(js, /暂无待处置任务/);
assert.match(js, /renderHeroTasks\(\);\s*\r?\n\}/, "renderDashboardWarnings 必须联动任务卡");

// 自动模式下首次出现真实数据 → 一次性提示（演示已被自动隐藏，可强制打开对照）。
assert.match(js, /function nudgeDemoToggleOnce\(\)/);
assert.match(js, /if\(demoDataPref\(\) !== 'auto' \|\| !hasRealTubeData\(\)\) return;/);
assert.match(js, /sessionStorage\.getItem\('blcms-demo-auto'\)/);
assert.match(js, /if\(typeof nudgeDemoToggleOnce === 'function'\) nudgeDemoToggleOnce\(\);/);

console.log("ok - demo data auto-hides once real data exists; three-state toggle with auto top-3 hero tasks");
