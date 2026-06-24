# Heat Surface Material Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the static heat-surface component library into a maintainable heat-surface material library with CSV import/export and stock-planning fields.

**Architecture:** Keep the existing single HTML file and vanilla JavaScript. Add a `MATERIAL_LIBRARY` default dataset, persist user-maintained material records in localStorage, render the material records as a categorized table, and add dedicated CSV template/export/import controls.

**Tech Stack:** Static HTML, vanilla JavaScript, browser LocalStorage, Node regression tests.

---

### Task 1: Regression Test

**Files:**
- Create: `tests/material-library.test.mjs`

- [ ] **Step 1: Write the failing test**

Create a Node assertion test that reads the desktop HTML and checks for `MATERIAL_LIBRARY`, `MATERIAL_LIBRARY_KEY`, material CSV functions, `renderMaterialLibrary`, stock fields, and representative default records.

- [ ] **Step 2: Run the test**

Run `node tests/material-library.test.mjs`.

Expected: FAIL before implementation.

### Task 2: Material Library UI And Data

**Files:**
- Modify: `C:/Users/DLX/Desktop/炉管全生命周期管理系统.html`

- [ ] **Step 1: Rename the library**

Change nav and section title from `受热面库/受热面部件库` to `受热面材料库`.

- [ ] **Step 2: Add material data**

Create `MATERIAL_LIBRARY` with fields `component`, `sys`, `position`, `shape`, `spec`, `diameter`, `wallThickness`, `material`, `inUseQty`, `stockNeedQty`, `lengthM`, `reserveLocation`, `screenCount`, and `remark`.

- [ ] **Step 3: Render table**

Replace `renderComponent` card output with a categorized table, summary cards, and CSV maintenance buttons.

- [ ] **Step 4: Add CSV maintenance**

Add `downloadMaterialCSVTemplate`, `exportMaterialCSV`, and `importMaterialCSV`, storing imported data in `localStorage` under `MATERIAL_LIBRARY_KEY`.

### Task 3: Verification

**Files:**
- Test: `tests/material-library.test.mjs`
- Test: existing regression tests

- [ ] **Step 1: Run tests**

Run:

```powershell
node tests/material-library.test.mjs
node tests/page-regression.test.mjs
node tests/llm-homepage-interface.test.mjs
node tests/ai-thickness-workflow.test.mjs
```

- [ ] **Step 2: Parse inline script**

Extract inline scripts from the desktop HTML and parse them with `new Function`.
