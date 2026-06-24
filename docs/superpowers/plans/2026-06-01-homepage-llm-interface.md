# Homepage LLM Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dashboard panel for calling OpenAI-compatible large language model APIs for boiler-tube deep analysis.

**Architecture:** Keep the app as one static HTML file. Add small, named JavaScript helpers for config persistence, request construction, fetch execution, and result rendering.

**Tech Stack:** HTML, CSS, vanilla JavaScript, Node `assert` regression test.

---

### Task 1: Regression Test

**Files:**
- Create: `tests/llm-homepage-interface.test.mjs`

- [ ] **Step 1: Write a failing test**

Create a Node test that reads `C:/Users/DLX/Desktop/炉管全生命周期管理系统.html` and asserts the presence of the dashboard LLM panel, `boiler_llm_config` localStorage persistence, `runLLMAnalysis`, `buildLLMMessages`, and `/chat/completions` fetch behavior.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/llm-homepage-interface.test.mjs`

Expected: assertion failure because the page does not yet contain the LLM panel.

### Task 2: Homepage UI

**Files:**
- Modify: `C:/Users/DLX/Desktop/炉管全生命周期管理系统.html`

- [ ] **Step 1: Add CSS**

Add compact styles for `.llm-panel`, `.llm-result`, `.llm-actions`, `.llm-status`, and responsive behavior using the existing form and card primitives.

- [ ] **Step 2: Add dashboard card**

Insert a dashboard card after the existing warning/AI entry card. The card includes provider preset, Base URL, API Key, model, temperature, prompt textarea, save/test/analyze/clear buttons, status text, and result output.

### Task 3: JavaScript Behavior

**Files:**
- Modify: `C:/Users/DLX/Desktop/炉管全生命周期管理系统.html`

- [ ] **Step 1: Add constants and config helpers**

Add `LLM_CONFIG_KEY`, `LLM_PROVIDER_PRESETS`, `getLLMConfig`, `saveLLMConfig`, `loadLLMConfigToForm`, and `applyLLMProviderPreset`.

- [ ] **Step 2: Add context and request helpers**

Add `buildLLMContext`, `buildLLMMessages`, `normalizeLLMBaseUrl`, and `extractLLMResponseText`.

- [ ] **Step 3: Add execution helpers**

Add `runLLMAnalysis`, `testLLMConnection`, `setLLMStatus`, `renderLLMResult`, and `clearLLMResult`.

- [ ] **Step 4: Initialize**

Call `loadLLMConfigToForm()` in the init block after the dashboard dependencies are ready.

### Task 4: Verification

**Files:**
- Test: `tests/llm-homepage-interface.test.mjs`

- [ ] **Step 1: Run regression test**

Run: `node tests/llm-homepage-interface.test.mjs`

Expected: all checks print `ok`.

- [ ] **Step 2: Browser check**

Open `file:///C:/Users/DLX/Desktop/炉管全生命周期管理系统.html` in the in-app browser and confirm the dashboard shows the new LLM card without obvious layout overlap.
