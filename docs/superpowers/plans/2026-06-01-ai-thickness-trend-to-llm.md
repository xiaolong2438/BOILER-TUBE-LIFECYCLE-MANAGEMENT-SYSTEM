# AI Thickness Trend To LLM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AI trend page analyze only tubes with thickness-reduction data, render the trend forecast first, then hand the forecast context to the existing deep LLM analysis.

**Architecture:** Keep the single-file HTML architecture. Add small script helpers for thickness candidate discovery, linear forecast generation, prompt assembly, and LLM handoff, then wire them into existing save/init and button flows.

**Tech Stack:** Static HTML, vanilla JavaScript, Node regression tests using `node:assert`.

---

### Task 1: Regression Tests

**Files:**
- Create: `tests/ai-thickness-workflow.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const htmlPath = "C:/Users/DLX/Desktop/炉管全生命周期管理系统.html";
const html = readFileSync(htmlPath, "utf8");

assert.match(html, /function populateAIThicknessTargets\s*\(/);
assert.match(html, /function predictThicknessTrendFromHistory\s*\(/);
assert.match(html, /async function runDeepAIAnalysisFromTrend\s*\(/);
assert.match(html, /<select id="ai-target"><\/select>/);
assert.match(html, /extractThicknessData\(code\)\.length >= 2/);
assert.match(html, /populateAIThicknessTargets\(\)/);
assert.match(html, /await runDeepAIAnalysisFromTrend\(data\)/);
assert.match(html, /测厚历史/);
assert.match(html, /趋势预测结果/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/ai-thickness-workflow.test.mjs`

Expected: FAIL because the helper functions and empty AI target select do not exist yet.

### Task 2: AI Page Data Wiring

**Files:**
- Modify: `C:/Users/DLX/Desktop/炉管全生命周期管理系统.html`

- [ ] **Step 1: Replace static AI target options**

Change `<select id="ai-target">...</select>` to an empty `<select id="ai-target"></select>` and update the button text to `先预测趋势并深度AI分析`.

- [ ] **Step 2: Add helper functions**

Add `collectAIThicknessTargets()`, `populateAIThicknessTargets()`, `predictThicknessTrendFromHistory()`, `buildTrendAnalysisPrompt()`, and `runDeepAIAnalysisFromTrend()` near the existing AI functions.

- [ ] **Step 3: Wire refresh points**

Call `populateAIThicknessTargets()` from `saveDB()` and from the init block after `updateLifecycleDropdown()`.

- [ ] **Step 4: Update AI execution**

Change `runAIAnalysis()` so it rejects empty targets, predicts from `extractThicknessData(target)`, renders chart metrics, then awaits `runDeepAIAnalysisFromTrend(data)`.

- [ ] **Step 5: Run tests**

Run:

```powershell
node tests/ai-thickness-workflow.test.mjs
node tests/page-regression.test.mjs
node tests/llm-homepage-interface.test.mjs
```

Expected: all pass.
