/* AI 数据助手端到端冒烟：在真实浏览器里跑一遍面板与数据链路。 */
window.runAssistantTests = async function () {
  const results = [];
  const startedAt = Date.now();
  const diagnostics = {};
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function test(name, body) {
    try { await body(); results.push({ name: name, passed: true }); }
    catch (error) { results.push({ name: name, passed: false, error: String((error && error.stack) || error) }); }
  }
  async function until(fn, timeout) {
    const start = Date.now();
    while (Date.now() - start < (timeout || 4000)) {
      if (fn()) return true;
      await wait(60);
    }
    return false;
  }
  const messagesText = () => {
    const el = document.getElementById('assistantMessages');
    return el ? String(el.innerText || el.textContent || '') : '';
  };

  /* ================= T3：多图端到端 / 对抗式复核 工具 ================= */

  /* 系统模板表头（与 tests/assistant-browser-runtime.js 既有 CSV 用例一致） */
  const TABLE_HEADERS = ['数据分类', '炉号', '日期', '管段编码', '规格', '材质', '厚度(mm)', '硬度(HB)', '事件类型/更换原因', '关联新管码', '详细描述/结论'];

  /* 用 canvas 现场画一张真实 PNG（Image 可解码），再包成 .png 的 File */
  function drawingToPngFile(name, lines, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width || 900;
    canvas.height = height || 320;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#111111';
    ctx.font = '20px sans-serif';
    (lines || []).forEach((line, index) => ctx.fillText(String(line), 16, 40 + index * 30));
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], name, { type: 'image/png' });
  }

  /* 打桩视觉模型：串行探测（maxInflight）、调用次数、消息形状 */
  function stubVisionLLM(replies) {
    const original = window.callVisionLLM;
    const state = { calls: 0, inflight: 0, maxInflight: 0, messages: [] };
    window.callVisionLLM = function (messages, maxTokens) {
      state.calls += 1;
      state.inflight += 1;
      state.maxInflight = Math.max(state.maxInflight, state.inflight);
      state.messages.push(messages);
      const index = Math.min(state.calls - 1, replies.length - 1);
      const reply = typeof replies[index] === 'function' ? replies[index]() : replies[index];
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          state.inflight -= 1;
          if (reply instanceof Error) reject(reply); else resolve(reply);
        }, 5);
      });
    };
    return {
      state: state,
      restore: function () { window.callVisionLLM = original; }
    };
  }

  /* 打开视觉识别所需的模型配置（localStorage.boiler_llm_config），返回还原函数 */
  function enableVisionConfig() {
    const previous = window.localStorage.getItem('boiler_llm_config');
    window.localStorage.setItem('boiler_llm_config', JSON.stringify({
      provider: 'custom',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 't3-test-key',
      model: 't3-test-model',
      temperature: 0.2,
      models: ['t3-test-model']
    }));
    return function () {
      if (previous === null) window.localStorage.removeItem('boiler_llm_config');
      else window.localStorage.setItem('boiler_llm_config', previous);
    };
  }

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = (event) => resolve(event && event.target ? event.target.result : '');
      reader.onerror = () => reject(new Error('FileReader 读取失败'));
      reader.readAsDataURL(file);
    });
  }

  function decodeImage(dataUrl) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image 解码失败'));
      img.src = dataUrl;
    });
  }

  /* 取消息流里最后一张操作卡上的按钮 */
  function lastActionButton(actionId) {
    const buttons = document.querySelectorAll('[data-action-id="' + actionId + '"]');
    return buttons.length ? buttons[buttons.length - 1] : null;
  }

  await test('assistant launcher and panel are mounted', async () => {
    const ok = await until(() => window.BTAssistant && document.getElementById('assistantLauncher') && document.getElementById('assistantPanel'));
    assert(ok, 'launcher or panel not mounted');
    assert(typeof window.BTAssistant.open === 'function', 'facade missing open()');
  });

  await test('panel opens and help reply renders', async () => {
    window.BTAssistant.open();
    assert(window.BTAssistant.isOpen(), 'panel should be open');
    window.BTAssistant.send('帮助');
    const ok = await until(() => messagesText().indexOf('锅炉炉管数据助手') >= 0);
    assert(ok, 'help reply missing: ' + messagesText().slice(0, 200));
  });

  await test('stats intent renders metric card', async () => {
    window.BTAssistant.send('现在数据质量怎么样');
    const ok = await until(() => messagesText().indexOf('数据质量概览') >= 0);
    assert(ok, 'stats card missing');
  });

  await test('upload clean CSV -> cleaning report -> import -> undo', async () => {
    const csv = [
      '数据分类,炉号,日期,管段编码,规格,材质,厚度(mm),硬度(HB),事件类型/更换原因,关联新管码,详细描述/结论',
      '事件,1,2025-01-10,1-WW-FR-009-0007-000,Φ63.5×7.5,SA-210C,7.05,183,测厚,,AI 冒烟测厚记录',
      '事件,2,2025-02-11,2-HSH-E-013-0006-W01,Φ51×8,SA-213T91,6.85,205,测厚,,AI 冒烟测厚记录二'
    ].join(String.fromCharCode(10));
    const file = new File([csv], 'assistant-smoke.csv', { type: 'text/csv' });
    window.BTAssistant.handleFile(file);
    const cleaned = await until(() => messagesText().indexOf('清洗报告') >= 0);
    assert(cleaned, 'cleaning report missing');
    const before = userDB.events.length;
    const importButton = document.querySelector('[data-action-id="import-confirm"]');
    assert(importButton, 'import confirm button missing');
    importButton.click();
    const imported = await until(() => userDB.events.length > before);
    assert(imported, 'import did not write records');
    const undoButton = document.querySelector('[data-action-id="undo-last-import"]');
    assert(undoButton, 'undo button missing');
    undoButton.click();
    const undone = await until(() => userDB.events.length === before);
    assert(undone, 'undo did not restore records');
  });

  await test('analysis intent renders a chart card', async () => {
    const before = userDB.events.length;
    const csv = [
      '数据分类,炉号,日期,管段编码,规格,材质,厚度(mm),硬度(HB),事件类型/更换原因,关联新管码,详细描述/结论',
      '事件,1,2025-06-10,1-WW-FR-009-0007-000,Φ63.5×7.5,SA-210C,7.12,183,测厚,,AI 分析冒烟一',
      '事件,1,2025-09-12,1-WW-FR-009-0007-000,Φ63.5×7.5,SA-210C,6.94,188,测厚,,AI 分析冒烟二',
      '事件,1,2026-01-08,1-WW-FR-009-0007-000,Φ63.5×7.5,SA-210C,6.71,192,测厚,,AI 分析冒烟三'
    ].join(String.fromCharCode(10));
    const cardsBefore = document.querySelectorAll('[data-action-id="import-confirm"]').length;
    window.BTAssistant.handleFile(new File([csv], 'assistant-analysis-smoke.csv', { type: 'text/csv' }));
    await until(() => document.querySelectorAll('[data-action-id="import-confirm"]').length > cardsBefore);
    const importButtons = document.querySelectorAll('[data-action-id="import-confirm"]');
    const importButton = importButtons[importButtons.length - 1];
    assert(importButton, 'import confirm button missing for analysis smoke');
    importButton.click();
    const imported = await until(() => userDB.events.length > before);
    assert(imported, 'analysis smoke data not imported');

    window.BTAssistant.send('近两年壁厚趋势');
    const ok = await until(() => document.querySelector('.assistant-analysis svg'));
    assert(ok, 'analysis chart card missing: ' + messagesText().slice(-200));
    assert(document.querySelector('[data-action-id="export-analysis"]'), 'export analysis action missing');

    const undoButtons = document.querySelectorAll('[data-action-id="undo-last-import"]');
    const undoButton = undoButtons[undoButtons.length - 1];
    if (undoButton) {
      undoButton.click();
      await until(() => userDB.events.length === before);
    }
  });

  /* ---------- T3 探针 1：canvas 生成的 PNG 在真实浏览器里可读可解码 ---------- */

  await test('T3 probe: canvas PNG is readable and decodable', async () => {
    const file = drawingToPngFile('t3-probe.png', ['T3 探针']);
    assert(file instanceof File, 'File 构造失败');
    diagnostics.pngFileBytes = file.size;
    const dataUrl = await readFileAsDataUrl(file);
    assert(dataUrl.indexOf('data:image/png;base64,') === 0, 'PNG dataURL 前缀异常：' + dataUrl.slice(0, 40));
    const img = await decodeImage(dataUrl);
    assert(img.naturalWidth > 0 && img.naturalHeight > 0, 'Image 未解码出尺寸');
    diagnostics.pngDecoded = img.naturalWidth + 'x' + img.naturalHeight;
  });

  /* ---------- T3 探针 2：单张图片走既有 handleFile 链路（清洗→导入→撤销） ---------- */

  await test('T3 probe: single image via handleFile reaches cleaning and import', async () => {
    const restoreConfig = enableVisionConfig();
    const stub = stubVisionLLM([JSON.stringify({
      headers: TABLE_HEADERS,
      rows: [['事件', '1', '2025-03-01', '1-WW-FR-009-0007-000', 'Φ63.5×7.5', 'SA-210C', '7.02', '181', '测厚', '', 'T3 单图探针']],
      notes: 'T3 单图探针备注'
    })]);
    try {
      const before = userDB.events.length;
      const cardsBefore = document.querySelectorAll('[data-action-id="import-confirm"]').length;
      window.BTAssistant.handleFile(drawingToPngFile('t3-single.png', ['T3 单图探针']));
      /* 注意：不能用「文本里出现过清洗报告」判断，历史用例的卡片会残留，必须数新卡片 */
      const cleaned = await until(() => document.querySelectorAll('[data-action-id="import-confirm"]').length > cardsBefore, 4000);
      diagnostics.cleaningTail = messagesText().slice(-260);
      assert(cleaned, '未出现新的清洗报告卡片：' + messagesText().slice(-260));
      const importButton = lastActionButton('import-confirm');
      assert(importButton, '缺少确认导入按钮');
      importButton.click();
      const imported = await until(() => userDB.events.length > before, 4000);
      assert(imported, '导入未写入 userDB.events');
      diagnostics.singleImageImportedDelta = userDB.events.length - before;
      const undoButton = lastActionButton('undo-last-import');
      assert(undoButton, '缺少撤销按钮');
      undoButton.click();
      const undone = await until(() => userDB.events.length === before, 4000);
      assert(undone, '撤销未恢复记录');
      assert(stub.state.calls === 1, '视觉模型调用次数应为 1，实际 ' + stub.state.calls);
      assert(JSON.stringify(stub.state.messages[0]).indexOf('image_url') >= 0, '视觉消息缺少 image_url');
      diagnostics.visionMaxInflight = stub.state.maxInflight;
    } finally {
      stub.restore();
      restoreConfig();
    }
  });

  /* ---------- T3 探针 3：真实浏览器里能否模拟多文件选择（DataTransfer） ---------- */

  await test('T3 probe: multi-file selection can be simulated with DataTransfer', async () => {
    const input = document.getElementById('assistantFile');
    assert(input, '缺少文件输入 #assistantFile');
    diagnostics.fileInputMultiple = input.hasAttribute('multiple');
    diagnostics.fileInputAccept = input.getAttribute('accept');
    let transfer = null;
    try { transfer = new DataTransfer(); } catch (err) { transfer = null; }
    assert(transfer, 'DataTransfer 不可构造，无法模拟真实多选');
    transfer.items.add(drawingToPngFile('t3-dt-a.png', ['A']));
    transfer.items.add(drawingToPngFile('t3-dt-b.png', ['B']));
    input.files = transfer.files;
    assert(input.files.length === 2, 'input.files 赋值失败，实际 ' + input.files.length);
    try { input.value = ''; } catch (err) { /* 清空失败不影响 */ }
  });

  /* ---------- T3：清洗卡片读取（只取最后一张，历史用例的卡片会残留，不能用文本命中判断） ---------- */

  function lastCleaningCard() {
    const cards = document.querySelectorAll('.assistant-cleaning');
    return cards.length ? cards[cards.length - 1] : null;
  }
  function countCleaningCards() { return document.querySelectorAll('.assistant-cleaning').length; }
  function cleaningCardInfo(card) {
    const sub = card.querySelector('.assistant-card-sub');
    const metrics = {};
    card.querySelectorAll('.assistant-metric').forEach((item) => {
      const key = item.querySelector('.assistant-metric-k');
      const value = item.querySelector('.assistant-metric-v');
      if (key && value) metrics[String(key.textContent).trim()] = String(value.textContent).trim();
    });
    return { subtitle: sub ? String(sub.textContent).trim() : '', dataset: card.getAttribute('data-dataset'), metrics: metrics };
  }

  /* 图片文件池：一次生成、多处复用，避免反复 canvas 编码拖长虚拟时钟 */
  const pngPool = [];
  function poolPng(index) {
    if (!pngPool[index]) pngPool[index] = drawingToPngFile('t3-batch-' + (index + 1) + '.png', ['T3 批量第 ' + (index + 1) + ' 张'], 480, 180);
    return pngPool[index];
  }
  function poolPngs(count) {
    const list = [];
    for (let i = 0; i < count; i += 1) list.push(poolPng(i));
    return list;
  }

  /* 三行设计已按清洗规则校准：炉号必须与管段编码首段一致（否则报「炉号与管段编码不一致」错误行） */
  const ROW_A = ['事件', '1', '2025-03-01', '1-WW-FR-009-0007-000', 'Φ63.5×7.5', 'SA-210C', '7.02', '181', '测厚', '', 'T3 批量A'];
  const ROW_B = ['事件', '2', '2025-03-02', '2-HSH-E-013-0006-W01', 'Φ51×8', 'SA-213T91', '6.85', '205', '测厚', '', 'T3 批量B'];
  const ROW_C = ['事件', '2', '2025-03-03', '2-HSH-E-013-0006-W02', 'Φ60×6', 'SA-210C', '6.51', '170', '测厚', '', 'T3 批量C'];
  function replyFor(rows, notes) {
    return JSON.stringify({ headers: TABLE_HEADERS, rows: rows, notes: notes === undefined ? 'T3 识别备注' : notes });
  }

  /* 诊断助手：钩住真实清洗函数，记录每次调用的输入行与报告（用完必须还原） */
  function hookCleanRows(sink) {
    const core = window.BTAssistantCore;
    const original = core && core.cleanRows;
    if (!original) return function () {};
    core.cleanRows = function (input) {
      const out = original.call(core, input);
      try {
        sink.push({
          inputRows: ((input && input.rows) || []).map((row) => row.join('~')),
          units: input && input.units,
          matrixCount: input && input.matrixRows ? input.matrixRows.length : null,
          summary: out.report.summary,
          checks: out.report.checks.map((c) => ({ id: c.id, sev: c.severity, rows: c.rows }))
        });
      } catch (err) { sink.push({ error: String(err && err.message) }); }
      return out;
    };
    return function () { core.cleanRows = original; };
  }

  /* ================= T3 验收 1：多张图片 → 提炼 → 清洗 → 导入 → 撤销 ================= */

  await test('T3 batch: real multi-image selection -> cleaning -> import -> undo', async () => {
    const docs = window.BTAssistantDocs;
    assert(docs && typeof docs.imagesToRows === 'function', 'T1 契约未实现：BTAssistantDocs.imagesToRows 缺失');
    assert(typeof window.BTAssistant.handleFiles === 'function', 'T2 契约未实现：BTAssistant.handleFiles 缺失');
    const input = document.getElementById('assistantFile');
    assert(input && input.hasAttribute('multiple'), 'T2 契约未实现：文件输入缺少 multiple 属性');

    const restoreConfig = enableVisionConfig();
    /* 第 2 张图故意与第 1 张图重叠一行 ROW_B，用于验证「合并阶段必须去重」 */
    const stub = stubVisionLLM([replyFor([ROW_A, ROW_B], '第一张识别备注'), replyFor([ROW_B, ROW_C], '第二张识别备注')]);
    const cleanCalls = [];
    const restoreClean = hookCleanRows(cleanCalls);
    diagnostics.batchCleanCalls = cleanCalls;
    try {
      const before = userDB.events.length;
      const textBefore = messagesText();
      const cardsBefore = countCleaningCards();

      /* 走真实 UI 路径：DataTransfer 造真 FileList，派发 change */
      const transfer = new DataTransfer();
      transfer.items.add(poolPng(0));
      transfer.items.add(poolPng(1));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      /* 契约：选择后必须清空 input.value，否则同一批文件无法再次选择 */
      assert(input.value === '', '选择后未清空文件输入，同一批文件将无法再次选择，实际 value=' + JSON.stringify(input.value));

      const ok = await until(() => countCleaningCards() > cardsBefore, 3000);
      assert(ok, '多选后未出现清洗报告卡片：' + messagesText().slice(-260));
      const info = cleaningCardInfo(lastCleaningCard());
      diagnostics.batchCard = info;
      diagnostics.batchCardText = String(lastCleaningCard().innerText || lastCleaningCard().textContent || '');
      const tail = messagesText().slice(textBefore.length);

      assert(stub.state.calls === 2, '视觉模型应被调用 2 次，实际 ' + stub.state.calls);
      assert(stub.state.maxInflight === 1, '批量识别必须串行（并发峰值应为 1），实际 ' + stub.state.maxInflight);
      stub.state.messages.forEach((messages, index) => {
        assert(JSON.stringify(messages).indexOf('image_url') >= 0, '第 ' + (index + 1) + ' 次视觉消息缺少 image_url');
      });
      assert(info.subtitle.indexOf('批量图片(2张).png') >= 0, '批量文件名不符合契约，实际：' + info.subtitle);
      assert(info.subtitle.indexOf('图片识别(2张)') >= 0, '批量 sheetName 不符合契约，实际：' + info.subtitle);
      assert(info.metrics['数据行'] === '3', '两张图合并去重后应为 3 行数据，实际 ' + info.metrics['数据行']);
      assert(info.metrics['错误行'] === '0', '不应出现错误行，实际 ' + info.metrics['错误行']);
      assert(info.metrics['重复丢弃'] === '0', '合并阶段就应去重，清洗不应再丢重复行，实际 ' + info.metrics['重复丢弃']);
      assert(tail.indexOf('正在识别第') >= 0, '缺少「正在识别第 i/n 张图片」阶段反馈');
      assert(tail.indexOf('识别备注') >= 0, '识别备注未展示给用户');

      /* 清洗采用「干净行直接导入 + 有警告行留卡片待确认」：卡片上的「可导入」是待确认行数，
         两者相加必须等于合并去重后的 3 行。该不变量与台账矩阵内容无关，故稳定可靠。 */
      const afterRecognize = userDB.events.length;
      const autoImported = afterRecognize - before;
      const pendingRows = Number(info.metrics['可导入']);
      diagnostics.batchAutoImported = autoImported;
      diagnostics.batchPending = pendingRows;
      assert(Number.isFinite(pendingRows), '卡片「可导入」不是数字：' + info.metrics['可导入']);
      assert(autoImported + pendingRows === 3,
        '自动导入 ' + autoImported + ' 行 + 待确认 ' + pendingRows + ' 行应等于合并后的 3 行，卡片指标 ' + JSON.stringify(info.metrics));
      if (autoImported > 0) {
        assert(tail.indexOf('已直接导入') >= 0, '自动导入应给出「已直接导入」提示，实际：' + tail.slice(-200));
      }

      const importButton = lastActionButton('import-confirm');
      if (pendingRows > 0) {
        assert(importButton, '仍有 ' + pendingRows + ' 行待确认，却缺少确认导入按钮');
        importButton.click();
        const imported = await until(() => userDB.events.length > afterRecognize, 3000);
        assert(imported, '确认导入未写入 userDB.events');
      }
      diagnostics.batchTotalAdded = userDB.events.length - before;
      assert(userDB.events.length - before === 3, '合并后的 3 行应全部写入台账，实际 ' + (userDB.events.length - before));

      const undoButton = lastActionButton('undo-last-import');
      assert(undoButton, '批量导入缺少撤销按钮');
      const beforeUndo = userDB.events.length;
      undoButton.click();
      const undone = await until(() => userDB.events.length < beforeUndo, 3000);
      assert(undone, '撤销未回滚最近一次导入');
      diagnostics.batchAfterUndo = userDB.events.length - before;
      assert(stub.state.calls === 2, '整条链路不应重复调用视觉模型，实际 ' + stub.state.calls);
    } finally {
      restoreClean();
      stub.restore();
      restoreConfig();
    }
  });

  /* ================= T3 边界 A：入口分流（空 / 单张 / 超限 / 混合） ================= */

  await test('T3 boundary: file entry routing (empty / single / over-limit / mixed)', async () => {
    assert(typeof window.BTAssistant.handleFiles === 'function', 'T2 契约未实现：BTAssistant.handleFiles 缺失');
    const restoreConfig = enableVisionConfig();
    const stub = stubVisionLLM([replyFor([ROW_A])]);
    try {
      /* 1) 空列表：不提示、不置忙、无任何副作用 */
      const cardsBefore = countCleaningCards();
      const textBefore = messagesText();
      const emptyResult = window.BTAssistant.handleFiles([]);
      await wait(120);
      assert(emptyResult === undefined || emptyResult === null, '空列表不应返回结果，实际 ' + String(emptyResult));
      assert(countCleaningCards() === cardsBefore, '空列表不应产生清洗卡片');
      assert(messagesText() === textBefore, '空列表不应产生任何消息');
      assert(stub.state.calls === 0, '空列表不应调用视觉模型');

      /* 2) 单张图片：转调 handleFile，保留原文件名、不走批量命名 */
      const cardsBeforeSingle = countCleaningCards();
      window.BTAssistant.handleFiles([poolPng(2)]);
      const singleOk = await until(() => countCleaningCards() > cardsBeforeSingle, 2500);
      assert(singleOk, '单张图片未出现清洗卡片：' + messagesText().slice(-200));
      const singleInfo = cleaningCardInfo(lastCleaningCard());
      diagnostics.singleViaHandleFiles = singleInfo;
      assert(singleInfo.subtitle.indexOf('t3-batch-3.png') >= 0, '单张图片应保留原文件名，实际：' + singleInfo.subtitle);
      assert(singleInfo.subtitle.indexOf('批量图片') < 0, '单张图片不应走批量命名，实际：' + singleInfo.subtitle);
      assert(stub.state.calls === 1, '单张图片应只调用视觉模型 1 次，实际 ' + stub.state.calls);

      /* 3) 9 张图片：超过上限 8，中文提示且不进清洗、不调用模型 */
      const cardsBeforeNine = countCleaningCards();
      const textBeforeNine = messagesText();
      const callsBeforeNine = stub.state.calls;
      window.BTAssistant.handleFiles(poolPngs(9));
      await wait(150);
      const nineTail = messagesText().slice(textBeforeNine.length);
      diagnostics.overLimitReply = nineTail.slice(0, 120);
      assert(countCleaningCards() === cardsBeforeNine, '超过 8 张不应进入清洗');
      assert(stub.state.calls === callsBeforeNine, '超过 8 张不应调用视觉模型');
      assert(/最多|上限/.test(nineTail) && /8/.test(nineTail), '超过 8 张应给出中文上限提示，实际：' + nineTail);

      /* 4) 混合类型：中文提示且不进清洗 */
      const cardsBeforeMixed = countCleaningCards();
      const textBeforeMixed = messagesText();
      const callsBeforeMixed = stub.state.calls;
      window.BTAssistant.handleFiles([poolPng(0), new File(['a,b' + String.fromCharCode(10) + '1,2'], 't3-mixed.csv', { type: 'text/csv' })]);
      await wait(150);
      const mixedTail = messagesText().slice(textBeforeMixed.length);
      assert(countCleaningCards() === cardsBeforeMixed, '混合类型不应进入清洗');
      assert(stub.state.calls === callsBeforeMixed, '混合类型不应调用视觉模型');
      assert(mixedTail.indexOf('请一次只上传同一类型文件；多张图片可以一起选择') >= 0, '混合类型缺少契约提示语，实际：' + mixedTail);
    } finally {
      stub.restore();
      restoreConfig();
    }
  });

  /* ================= T3 边界 B：模型异常（坏 JSON 重试 / 全部失败 / 超限） ================= */

  await test('T3 boundary: model failures (bad JSON retry / all-fail reject / maxFiles)', async () => {
    const docs = window.BTAssistantDocs;
    assert(docs && typeof docs.imagesToRows === 'function', 'T1 契约未实现：imagesToRows 缺失');
    assert(docs.version === 'v2', 'T1 契约未实现：BTAssistantDocs.version 应为 v2，实际 ' + docs.version);
    const restoreConfig = enableVisionConfig();

    /* 1) 第一次坏 JSON、第二次合法 → 恰好重试 1 次并成功 */
    let stub = stubVisionLLM(['这不是 JSON，模型跑偏了', replyFor([ROW_A])]);
    try {
      const parsed = await docs.imagesToRows([poolPng(0)]);
      assert(stub.state.calls === 2, '坏 JSON 应恰好重试 1 次（共 2 次调用），实际 ' + stub.state.calls);
      assert(JSON.stringify(stub.state.messages[1]).indexOf('这不是 JSON') >= 0, '修复请求应回传原始输出片段');
      assert(Array.isArray(parsed.rows) && parsed.rows.length === 2, '重试成功后应得到表头 + 1 行，实际 ' + ((parsed.rows || []).length));
    } finally { stub.restore(); }

    /* 2) 全部失败 → reject，且错误信息含首条失败原因 */
    stub = stubVisionLLM([new Error('第一张识别失败'), new Error('第二张识别失败')]);
    let rejected = null;
    try { await docs.imagesToRows([poolPng(0), poolPng(1)]); }
    catch (err) { rejected = err; }
    finally { stub.restore(); }
    assert(rejected, '两张都失败时必须 reject');
    assert(String(rejected.message).indexOf('第一张识别失败') >= 0, 'reject 信息应含首条失败原因，实际：' + rejected.message);

    /* 3) 默认上限 8 张 → reject，且不发起任何模型调用 */
    stub = stubVisionLLM([replyFor([ROW_A])]);
    let overLimit = null;
    try { await docs.imagesToRows(poolPngs(9)); }
    catch (err) { overLimit = err; }
    finally { stub.restore(); }
    assert(overLimit, '超过默认上限 8 张时必须 reject');
    assert(/最多|上限/.test(String(overLimit.message)), '超限错误信息应为中文提示，实际：' + overLimit.message);
    assert(stub.state.calls === 0, '超限不应发起任何视觉模型调用，实际 ' + stub.state.calls);
  });

  /* ================= T3 边界 C：规范化 / 合并 / 不确定单元格 ================= */

  await test('T3 boundary: normalization, merge and uncertain handling', async () => {
    const docs = window.BTAssistantDocs;
    assert(docs && typeof docs.normalizeCell === 'function' && typeof docs.normalizeGrid === 'function' && typeof docs.mergeGrids === 'function',
      'T1 契约未实现：normalizeCell / normalizeGrid / mergeGrids 缺失');

    /* 1) normalizeCell：一次跑完全部规则，汇总失败项而不是首个就中断 */
    const cases = [
      ['2024年1月5日', '日期', '2024-01-05'],
      ['2024.1.5', '日期', '2024-01-05'],
      ['2024/1/5', '日期', '2024-01-05'],
      ['20240105', '日期', '2024-01-05'],
      ['6.5mm', '厚度(mm)', '6.5'],
      ['１８３HB', '硬度(HB)', '183'],
      ['１-ＷＷ-ＦＲ-００９', '管段编码', '1-WW-FR-009'],
      ['1-ww-fr-009', '管段编码', '1-ww-fr-009'],
      ['1-WW\u200b-FR', '管段编码', '1-WW-FR'],
      ['  看不清  ', '日期', '看不清'],
      ['  SA-210C  ', '材质', 'SA-210C']
    ];
    const cellFailures = [];
    cases.forEach((item) => {
      let actual;
      try { actual = docs.normalizeCell(item[0], item[1]); }
      catch (err) { actual = 'THROW: ' + err.message; }
      if (actual !== item[2]) cellFailures.push(item[1] + ' 「' + item[0] + '」→ ' + actual + '（期望 ' + item[2] + '）');
    });
    assert(!cellFailures.length, 'normalizeCell 不符合契约：' + cellFailures.join('；'));

    /* 2) normalizeGrid：不得修改入参、必须幂等 */
    const grid = [['日期', '厚度(mm)', '管段编码'], ['2024年1月5日', '6.5mm', ' 1-WW FR ']];
    const gridSnapshot = JSON.stringify(grid);
    const once = docs.normalizeGrid(grid);
    assert(JSON.stringify(grid) === gridSnapshot, 'normalizeGrid 不得修改入参，实际变成 ' + JSON.stringify(grid));
    const twice = docs.normalizeGrid(once);
    assert(JSON.stringify(once) === JSON.stringify(twice), 'normalizeGrid 应幂等：一次 ' + JSON.stringify(once) + '，两次 ' + JSON.stringify(twice));
    assert(once[1][0] === '2024-01-05' && once[1][1] === '6.5' && once[1][2] === '1-WWFR', 'normalizeGrid 未处理数据行：' + JSON.stringify(once[1]));

    /* 3) mergeGrids：表头并集保序 + 缺失列补空 */
    const unioned = docs.mergeGrids([
      [['数据分类', '炉号', '日期'], ['事件', '1', '2025-03-01']],
      [['日期', '炉号', '数据分类', '材质'], ['2025-03-02', '2', '事件', 'SA-213T91']]
    ]);
    assert(JSON.stringify(unioned.rows[0]) === JSON.stringify(['数据分类', '炉号', '日期', '材质']),
      '表头并集应保持首次出现顺序，实际 ' + JSON.stringify(unioned.rows[0]));
    assert(unioned.rows.length === 3, '并集合并后应为表头 + 2 行，实际 ' + unioned.rows.length);
    const unionData = unioned.rows.slice(1).map((row) => row.join('|'));
    assert(unionData.indexOf('事件|1|2025-03-01|') >= 0, '第一张图缺失的新列应补空字符串，实际 ' + JSON.stringify(unionData));
    assert(unionData.indexOf('事件|2|2025-03-02|SA-213T91') >= 0, '第二张图应按并集重排，实际 ' + JSON.stringify(unionData));

    /* 4) mergeGrids：重复数据行去重 */
    const deduped = docs.mergeGrids([
      [['数据分类', '炉号', '日期'], ['事件', '1', '2025-03-01'], ['事件', '2', '2025-03-02']],
      [['数据分类', '炉号', '日期'], ['事件', '2', '2025-03-02'], ['事件', '3', '2025-03-03']]
    ]);
    assert(deduped.rows.length === 4, '重复数据行应被去重（期望表头 + 3 行 = 4），实际 ' + deduped.rows.length + '：' + JSON.stringify(deduped.rows));

    /* 5) uncertain 非法/越界 → 安全忽略 */
    const restoreConfig = enableVisionConfig();
    let stub = stubVisionLLM([JSON.stringify({
      headers: TABLE_HEADERS, rows: [ROW_A.slice(), ROW_B.slice()], notes: '非法坐标用例',
      uncertain: [[999, 999], [-1, 0], ['x', 'y'], null, 7]
    })]);
    try {
      const parsed = await docs.imagesToRows([poolPng(0)]);
      assert(parsed.rows.length === 3, '非法 uncertain 不应影响行数，实际 ' + parsed.rows.length);
      assert(parsed.rows[1][0] === ROW_A[0] && parsed.rows[2][0] === ROW_B[0],
        '非法 uncertain 不应清空任何单元格，实际 ' + JSON.stringify(parsed.rows.slice(1)));
      assert(String(parsed.notes).indexOf('不确定') < 0, '非法 uncertain 不应产生不确定备注，实际：' + parsed.notes);
    } finally { stub.restore(); }

    /* 6) uncertain 合法命中 → 置空并写进 notes */
    stub = stubVisionLLM([JSON.stringify({
      headers: TABLE_HEADERS, rows: [ROW_A.slice(), ROW_B.slice()], notes: '合法坐标用例', uncertain: [[0, 0]]
    })]);
    try {
      const parsed = await docs.imagesToRows([poolPng(0)]);
      assert(parsed.rows[1][0] === '', '合法 uncertain 命中位置应置空，实际 ' + JSON.stringify(parsed.rows[1][0]));
      assert(parsed.rows[1][1] === ROW_A[1], '合法 uncertain 不应影响同行其它单元格，实际 ' + JSON.stringify(parsed.rows[1][1]));
      assert(String(parsed.notes).indexOf('1 个单元格识别不确定已置空') >= 0, 'notes 应追加不确定单元格提示，实际：' + parsed.notes);
    } finally { stub.restore(); restoreConfig(); }
  });

  await test('maintenance log records and renders operations', async () => {
    assert(window.BTMaintenanceLog, 'BTMaintenanceLog missing');
    const logged = await until(() => window.BTMaintenanceLog.stats().total > 0);
    assert(logged, 'no maintenance log entries after import/undo');
    window.switchView('maintainlog');
    const rendered = await until(() => document.querySelectorAll('#mlog-body tr[data-log-id]').length > 0);
    assert(rendered, 'maintenance log rows not rendered');
    assert(document.querySelector('[data-log-toggle]'), 'detail toggle missing');
    const stats = window.BTMaintenanceLog.stats();
    assert(stats.byAction.import >= 1, 'import action should be logged');
  });

  await test('page remains error-free', async () => {
    assert(!window.__testErrors.length, JSON.stringify(window.__testErrors));
  });

  diagnostics.virtualClockMs = Date.now() - startedAt;
  diagnostics.contracts = {
    docsVersion: window.BTAssistantDocs && window.BTAssistantDocs.version,
    hasImagesToRows: Boolean(window.BTAssistantDocs && typeof window.BTAssistantDocs.imagesToRows === 'function'),
    hasHandleFiles: Boolean(window.BTAssistant && typeof window.BTAssistant.handleFiles === 'function')
  };

  return { passed: results.every((item) => item.passed), results: results, errors: window.__testErrors, diagnostics: diagnostics };
};
