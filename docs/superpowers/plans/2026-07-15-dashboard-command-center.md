# Boiler Dashboard Command Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将主页改造成三栏锅炉炉管生产指挥中心，以中央综合健康环图为视觉核心，并保留现有机组切换、风险预警、检修趋势和部件下钻能力。

**Architecture:** 保持现有单文件 HTML/CSS/JavaScript 架构，不引入第三方图表库。新主页通过现有 `dashboardUnit`、`getDashboardTrendStats()`、`collectDashboardWarnings()` 和 `getDashboardSurfaceHealth()` 取数；CSS 负责三栏和环图外观，JavaScript 只负责更新数值、颜色和交互状态。

**Tech Stack:** HTML5、CSS Grid、CSS conic-gradient、原生 JavaScript、Node.js assertions

---

## File Structure

- Modify: `炉管全生命周期管理系统.html` - 三栏主页结构、环图样式、数据同步和响应式规则。
- Create: `tests/dashboard-command-center.test.mjs` - 主页结构、关键 ID、禁用文案和数据刷新调用的回归检查。

### Task 1: Add Dashboard Structure Regression Test

**Files:**
- Create: `tests/dashboard-command-center.test.mjs`
- Test: `tests/dashboard-command-center.test.mjs`

- [ ] **Step 1: Write the failing structural test**

```javascript
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
assert.match(html, /class="dashboard-status-band"/);
assert.match(html, /renderDashboardHealthCore\(trendStats\)/);
assert.doesNotMatch(html, /先定位高风险受热面/);
assert.doesNotMatch(html, /首页聚焦设备专工最需要的四件事/);

console.log("ok - dashboard command center structure");
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node tests/dashboard-command-center.test.mjs`

Expected: FAIL on missing `dashboard-command-center` or `dashboardHealthRing`.

- [ ] **Step 3: Commit the failing test**

```powershell
git add -- tests/dashboard-command-center.test.mjs
git commit -m "test: define dashboard command center structure"
```

### Task 2: Replace the Existing Hero with the Three-Column Command Center

**Files:**
- Modify: `炉管全生命周期管理系统.html:257`
- Modify: `炉管全生命周期管理系统.html:490`
- Test: `tests/dashboard-command-center.test.mjs`

- [ ] **Step 1: Add the three-column CSS layout**

Replace the current `.dashboard-hero`, `.trend-shell`, `.trend-main`, and `.trend-side` layout rules with:

```css
.dashboard-command-center {
  display: grid;
  grid-template-columns: minmax(250px, 0.78fr) minmax(460px, 1.44fr) minmax(270px, 0.78fr);
  gap: 14px;
  align-items: stretch;
  margin-bottom: 16px;
}
.command-column,
.command-core {
  min-width: 0;
  border: 1px solid rgba(72, 202, 228, 0.16);
  border-radius: 8px;
  background: rgba(0, 10, 22, 0.78);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.025);
}
.command-column { padding: 14px; }
.command-core { padding: 16px; display: grid; gap: 14px; }
.command-section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
  color: #f4fbff;
  font-size: 13px;
  font-weight: 700;
}
.command-metric-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.command-metric { padding: 11px; border: 1px solid rgba(72,202,228,0.1); border-radius: 6px; background: rgba(0,8,18,0.5); }
.command-metric .value { margin-top: 6px; font-size: 24px; font-weight: 800; }
.dashboard-status-band { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; border: 1px solid rgba(72,202,228,0.14); border-radius: 8px; overflow: hidden; }
.dashboard-status-item { padding: 11px 13px; background: rgba(0,8,18,0.68); }
```

- [ ] **Step 2: Replace the dashboard markup with the locked structure**

Use this exact ownership layout while retaining existing task, warning, and action content:

```html
<div class="dashboard-command-center">
  <aside class="command-column command-left">
    <div class="command-section-title"><span>风险处置</span><span id="dashboard-left-unit">全厂</span></div>
    <div class="command-metric-grid">
      <div class="command-metric danger"><div>严重风险</div><div class="value" id="dashboard-high-risk-count">0</div></div>
      <div class="command-metric warn"><div>预警关注</div><div class="value" id="dashboard-warn-risk-count">0</div></div>
    </div>
    <div class="hero-task-list">现有 P1、P2、P3 任务条目</div>
    <div class="ops-actions">现有三个快捷入口按钮</div>
  </aside>

  <section class="command-core">
    <div class="command-core-head">
      <div class="unit-switch" id="dashboard-unit-switch">现有三个机组切换按钮</div>
      <div class="command-live"><span class="dot"></span>在线 <span id="dashboard-update-time">--:--</span></div>
    </div>
    <div class="health-core-grid">
      <div class="health-side-metrics" id="dashboardCoreLeftMetrics"></div>
      <div class="health-ring" id="dashboardHealthRing" style="--health-value:0">
        <div class="health-ring-inner">
          <strong id="dashboard-overall-health">0%</strong>
          <span>综合健康度</span>
        </div>
      </div>
      <div class="health-side-metrics" id="dashboardCoreRightMetrics"></div>
    </div>
    <div class="trend-chart-wrap"><svg id="dashboardTrendChart" viewBox="0 0 520 174" preserveAspectRatio="none"></svg></div>
  </section>

  <aside class="command-column command-right">
    <div class="command-section-title"><span>受热面健康排名</span><span id="dashboard-current-unit">全厂</span></div>
    <div class="trend-surface-list" id="dashboardSurfaceList"></div>
    <div class="command-section-title command-warning-title"><span>最新预警</span></div>
    <div id="dashboard-warning-list"></div>
  </aside>
</div>

<div class="dashboard-status-band">
  <div class="dashboard-status-item"><span>生命周期闭环率</span><strong>83%</strong></div>
  <div class="dashboard-status-item"><span>台账覆盖</span><strong id="dashboard-ledger-count">0</strong></div>
  <div class="dashboard-status-item"><span>检测完整率</span><strong>78%</strong></div>
  <div class="dashboard-status-item"><span>下次检修节点</span><strong>2027 A修</strong></div>
</div>
```

- [ ] **Step 3: Remove duplicated dashboard sections**

Delete the old standalone `.risk-card-grid`, the old `.dashboard-main-grid`, and any duplicate task or warning card that now belongs inside the three columns. Keep only one `dashboard-high-risk-count`, `dashboard-warn-risk-count`, `dashboardTrendChart`, `dashboardSurfaceList`, and `dashboard-warning-list` ID.

- [ ] **Step 4: Run the structure test**

Run: `node tests/dashboard-command-center.test.mjs`

Expected: FAIL only on `renderDashboardHealthCore(trendStats)` because the renderer is not implemented yet.

- [ ] **Step 5: Commit the layout**

```powershell
git add -- 炉管全生命周期管理系统.html tests/dashboard-command-center.test.mjs
git commit -m "feat: add dashboard command center layout"
```

### Task 3: Implement the Central Health Ring and Data Synchronization

**Files:**
- Modify: `炉管全生命周期管理系统.html:1666`
- Modify: `炉管全生命周期管理系统.html:1787`
- Test: `tests/dashboard-command-center.test.mjs`

- [ ] **Step 1: Add the health-ring CSS**

```css
.health-core-grid { display: grid; grid-template-columns: minmax(110px, 0.7fr) minmax(220px, 1fr) minmax(110px, 0.7fr); gap: 14px; align-items: center; }
.health-ring {
  width: min(300px, 100%);
  aspect-ratio: 1;
  margin: 0 auto;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background:
    radial-gradient(circle at center, #001122 0 47%, transparent 48%),
    conic-gradient(var(--health-color, #00d4ff) calc(var(--health-value) * 1%), rgba(0,212,255,0.1) 0);
  box-shadow: inset 0 0 0 10px rgba(0,6,15,0.86), 0 0 28px rgba(0,212,255,0.12);
}
.health-ring-inner { width: 56%; aspect-ratio: 1; border-radius: 50%; display: grid; place-content: center; text-align: center; border: 1px solid rgba(72,202,228,0.2); background: rgba(0,6,15,0.94); }
.health-ring-inner strong { font-size: 42px; color: #fff; }
.health-ring-inner span { margin-top: 6px; color: var(--text-dim); font-size: 12px; }
.health-side-metrics { display: grid; gap: 10px; }
.health-side-metric { padding: 10px; border-left: 2px solid var(--metric-color, var(--accent)); background: rgba(0,8,18,0.48); }
.health-side-metric strong { display: block; margin-top: 4px; font-size: 22px; color: var(--metric-color, #fff); }
```

- [ ] **Step 2: Add the core renderer**

```javascript
function renderDashboardHealthCore(stats) {
  const ring = document.getElementById('dashboardHealthRing');
  const value = document.getElementById('dashboard-overall-health');
  const left = document.getElementById('dashboardCoreLeftMetrics');
  const right = document.getElementById('dashboardCoreRightMetrics');
  if(!ring || !value || !left || !right) return;

  const health = Math.max(0, Math.min(100, Number(stats.current) || 0));
  const tone = health < 60 ? 'var(--danger)' : health < 75 ? 'var(--warn)' : 'var(--ok)';
  ring.style.setProperty('--health-value', health);
  ring.style.setProperty('--health-color', tone);
  value.textContent = `${health}%`;

  left.innerHTML = `
    <div class="health-side-metric" style="--metric-color:var(--danger)"><span>严重风险</span><strong>${stats.highCount}</strong></div>
    <div class="health-side-metric" style="--metric-color:var(--warn)"><span>预警关注</span><strong>${stats.mediumCount}</strong></div>`;
  right.innerHTML = `
    <div class="health-side-metric" style="--metric-color:${stats.delta >= 0 ? 'var(--ok)' : 'var(--danger)'}"><span>较上次检修</span><strong>${stats.delta >= 0 ? '+' : ''}${stats.delta}%</strong></div>
    <div class="health-side-metric" style="--metric-color:var(--ok)"><span>闭环率</span><strong>83%</strong></div>`;
}
```

- [ ] **Step 3: Wire the renderer into `syncDashboardSnapshot()`**

Immediately after `const trendStats = getDashboardTrendStats(warnings);`, retain the existing count updates and add:

```javascript
renderDashboardHealthCore(trendStats);
const leftUnit = document.getElementById('dashboard-left-unit');
if(leftUnit) leftUnit.textContent = unitLabel;
```

Keep the existing calls:

```javascript
buildDashboardTrendChart(trendStats);
renderDashboardSurfaceList();
```

- [ ] **Step 4: Run the regression test**

Run: `node tests/dashboard-command-center.test.mjs`

Expected: PASS and print `ok - dashboard command center structure`.

- [ ] **Step 5: Commit the renderer**

```powershell
git add -- 炉管全生命周期管理系统.html tests/dashboard-command-center.test.mjs
git commit -m "feat: render dashboard health core"
```

### Task 4: Tighten Warnings, Ranking, and Responsive Behavior

**Files:**
- Modify: `炉管全生命周期管理系统.html:1773`
- Modify: `炉管全生命周期管理系统.html:1835`
- Modify: `炉管全生命周期管理系统.html:347`
- Test: `tests/dashboard-command-center.test.mjs`

- [ ] **Step 1: Limit the right-column ranking and warnings**

Keep `renderDashboardSurfaceList()` sorted from low to high and limit it to five items. Change the right-column warning call to three items by updating the renderer to use:

```javascript
const warnings = getDashboardScopedWarnings(3);
```

Render the compact warning markup without explanatory paragraphs:

```javascript
box.innerHTML = warnings.map(item => `<button class="command-warning ${warningClass(item.level)}" onclick="openTubeProfile('${escapeHTML(item.code)}')"><strong>${escapeHTML(item.code)}</strong><span>${escapeHTML(item.text)}</span></button>`).join('');
```

- [ ] **Step 2: Add compact warning and responsive CSS**

```css
.command-warning { width: 100%; display: grid; gap: 4px; margin-bottom: 8px; padding: 9px 10px; border: 1px solid rgba(72,202,228,0.1); border-left-width: 3px; border-radius: 6px; background: rgba(0,8,18,0.48); color: inherit; text-align: left; cursor: pointer; }
.command-warning strong { font-size: 11px; }
.command-warning span { color: var(--text-dim); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 1100px) {
  .dashboard-command-center { grid-template-columns: 1fr; }
  .command-core { order: 1; }
  .command-left { order: 2; }
  .command-right { order: 3; }
}
@media (max-width: 700px) {
  .command-metric-grid, .dashboard-status-band { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .health-core-grid { grid-template-columns: 1fr; }
  .health-side-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .health-ring { width: min(250px, 86vw); }
  .hero-task-item { grid-template-columns: 42px 1fr; }
  .hero-task-item .mini-link { grid-column: 2; justify-self: start; }
}
```

- [ ] **Step 3: Extend the structural test for uniqueness and responsive rules**

```javascript
for (const id of ["dashboardHealthRing", "dashboardTrendChart", "dashboardSurfaceList", "dashboard-warning-list"]) {
  assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `${id} must be unique`);
}
assert.match(html, /@media \(max-width: 1100px\)[\s\S]*\.dashboard-command-center/);
assert.match(html, /@media \(max-width: 700px\)[\s\S]*\.health-core-grid/);
```

- [ ] **Step 4: Run focused tests and script syntax check**

Run:

```powershell
node tests/dashboard-command-center.test.mjs
$tmp = Join-Path $env:TEMP 'boiler-dashboard-check.html'
$html = Get-Content -Raw -LiteralPath '炉管全生命周期管理系统.html'
Set-Content -LiteralPath $tmp -Value $html -Encoding utf8
node -e "const fs=require('fs');const h=fs.readFileSync(process.argv[1],'utf8');const m=h.match(/<script>([\s\S]*)<\/script>\s*<\/body>/i);new Function(m[1]);console.log('SCRIPT_OK')" $tmp
```

Expected: dashboard test PASS and `SCRIPT_OK`.

- [ ] **Step 5: Commit the responsive and warning polish**

```powershell
git add -- 炉管全生命周期管理系统.html tests/dashboard-command-center.test.mjs
git commit -m "style: polish dashboard command center"
```

### Task 5: Local Visual Verification

**Files:**
- Verify: `炉管全生命周期管理系统.html`

- [ ] **Step 1: Open the local file and inspect desktop layout**

Open `file:///C:/Users/DLX/Documents/BOILER-TUBE%20LIFECYCLE%20SYSTEM/%E7%82%89%E7%AE%A1%E5%85%A8%E7%94%9F%E5%91%BD%E5%91%A8%E6%9C%9F%E7%AE%A1%E7%90%86%E7%B3%BB%E7%BB%9F.html` at 1600x900.

Expected: three columns are visible, the center ring is the visual focus, no column contains a large empty region, and the next page section is visible below the first viewport.

- [ ] **Step 2: Verify interactions**

Click 全厂、1#机组、2#机组 and confirm the ring, trend, ranking, warning counts, task visibility, and unit labels update together. Click one task, one ranking row, and one warning row and confirm each opens the existing detail view.

- [ ] **Step 3: Inspect mobile layout**

Resize to 390x844.

Expected: center column appears first, no text overlaps the ring, metrics use two columns, and all action buttons remain visible.

- [ ] **Step 4: Final verification**

Run:

```powershell
node tests/dashboard-command-center.test.mjs
git diff --check
```

Expected: PASS with no whitespace errors.

