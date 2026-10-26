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

  /* ================= T3 多轮对话：附件条 / 图片追问 / 指代切换 / 重复导入保护 ================= */

  /* —— 附件条的只读读取（只看用户可见状态，不依赖任何内部状态） —— */
  function attachmentBarEl() { return document.getElementById('assistantAttachments'); }
  function attachmentChips() {
    const bar = attachmentBarEl();
    if (!bar || !bar.querySelectorAll) return [];
    return Array.prototype.slice.call(bar.querySelectorAll('.assistant-attachment-chip'));
  }
  function attachmentBarHidden() {
    const bar = attachmentBarEl();
    return !bar || bar.hidden === true;
  }
  function attachmentChipName(chip) {
    if (!chip) return '';
    const label = chip.querySelector ? chip.querySelector('.assistant-attachment-label') : null;
    return String((label ? label.textContent : chip.textContent) || '').trim();
  }
  function attachmentChipNames() { return attachmentChips().map(attachmentChipName); }
  function currentAttachmentChip() {
    const chips = attachmentChips();
    for (let i = 0; i < chips.length; i += 1) {
      if (chips[i].classList && chips[i].classList.contains('is-current')) return chips[i];
    }
    return null;
  }
  /* 门面 listAttachments 的紧凑视图（记录里含 rows，禁止直接序列化进报告） */
  function attachmentMetaList() {
    const api = window.BTAssistant;
    if (!api || typeof api.listAttachments !== 'function') return null;
    const list = api.listAttachments();
    if (!Array.isArray(list)) return null;
    return list.map((raw) => {
      const item = raw || {};
      return {
        id: String(item.id || ''), seq: Number(item.seq) || 0, name: String(item.name || ''),
        kind: String(item.kind || ''), rowCount: Number(item.rowCount) || 0,
        importedAt: String(item.importedAt || ''), hasDataUrl: Boolean(item.hasDataUrl),
        restored: Boolean(item.restored), current: Boolean(item.current)
      };
    });
  }
  function assistantBusy() {
    const typing = document.getElementById('assistantTyping');
    const panel = document.getElementById('assistantPanel');
    if (typing && typing.hidden === false) return true;
    return Boolean(panel && panel.getAttribute('aria-busy') === 'true');
  }
  async function waitAssistantIdle(timeout) { return until(() => !assistantBusy(), timeout || 6000); }
  /* 与既有 stubVisionLLM 同语义，额外记录 maxTokens（多轮用例要断言追问的 token 上限） */
  function stubVisionMulti(replies) {
    const original = window.callVisionLLM;
    const state = { calls: 0, inflight: 0, maxInflight: 0, messages: [], maxTokens: [] };
    window.callVisionLLM = function (messages, maxTokens) {
      state.calls += 1;
      state.inflight += 1;
      state.maxInflight = Math.max(state.maxInflight, state.inflight);
      state.messages.push(messages);
      state.maxTokens.push(maxTokens);
      const index = Math.min(state.calls - 1, replies.length - 1);
      const reply = typeof replies[index] === 'function' ? replies[index]() : replies[index];
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          state.inflight -= 1;
          if (reply instanceof Error) reject(reply); else resolve(reply);
        }, 5);
      });
    };
    return { state: state, restore: function () { window.callVisionLLM = original; } };
  }
  /* 打桩意图模型：等价于「意图模型接口不可达」，多轮用例不依赖真实网络，
     同时可以证明「图片追问优先于意图模型」这条契约。 */
  function stubIntentLlm() {
    const original = window.callAssistantChatCompletions;
    const state = { calls: 0 };
    window.callAssistantChatCompletions = function () {
      state.calls += 1;
      return Promise.reject(new Error('T3 多轮用例：意图模型不可达'));
    };
    return { state: state, restore: function () { window.callAssistantChatCompletions = original; } };
  }
  /* 临时移除模型配置（验证「未配置模型时追问图片」边界） */
  function withoutVisionConfig() {
    const previous = window.localStorage.getItem('boiler_llm_config');
    window.localStorage.removeItem('boiler_llm_config');
    return function () {
      if (previous === null) window.localStorage.removeItem('boiler_llm_config');
      else window.localStorage.setItem('boiler_llm_config', previous);
    };
  }
  /* 视觉消息末条的 image_url（契约：user.content = [text, image_url]） */
  function visionImageUrl(messages) {
    if (!Array.isArray(messages) || !messages.length) return '';
    const last = messages[messages.length - 1];
    if (!last || !Array.isArray(last.content)) return '';
    for (let i = 0; i < last.content.length; i += 1) {
      const part = last.content[i];
      if (part && part.type === 'image_url' && part.image_url) return String(part.image_url.url || '');
    }
    return '';
  }
  function urlTag(url) { return String(url || '').slice(0, 24); }
  /* 多轮用例之间共享的最小状态 */
  const multiTurn = { recognitionUrls: [], conversationIdBeforeNewChat: '' };

  /* ---------- 多轮 1：上传 2 张图 → 附件条 2 项，current = 最后一张 ---------- */

  await test('T3 multi-turn: two batch images register an attachment bar with current = last', async () => {
    assert(window.BTAssistantAttachments && typeof window.BTAssistantAttachments.createRegistry === 'function',
      'T1 契约未实现：window.BTAssistantAttachments 缺失');
    assert(typeof window.BTAssistant.listAttachments === 'function', 'T2 契约未实现：BTAssistant.listAttachments 缺失');
    assert(typeof window.BTAssistant.askAboutImage === 'function', 'T2 契约未实现：BTAssistant.askAboutImage 缺失');

    const newChat = document.getElementById('assistantNewChat');
    assert(newChat, '缺少新建会话按钮 #assistantNewChat');
    newChat.click();
    await wait(50);
    assert(attachmentChips().length === 0, '新会话未清空附件条：' + JSON.stringify(attachmentChipNames()));

    const restoreConfig = enableVisionConfig();
    const vision = stubVisionMulti([replyFor([ROW_A]), replyFor([ROW_B])]);
    try {
      const cardsBefore = countCleaningCards();
      const idle = await waitAssistantIdle(4000);
      assert(idle, '上传前助手一直处于忙碌状态');
      const pending = window.BTAssistant.handleFiles([poolPng(0), poolPng(1)]);
      if (pending && typeof pending.then === 'function') await pending;

      const ready = await until(() => attachmentChips().length === 2 && countCleaningCards() > cardsBefore, 4000);
      const meta = attachmentMetaList();
      diagnostics.mtBatch = { chips: attachmentChipNames(), meta: meta };
      assert(ready, '两张图上传后应出现 2 项附件与清洗卡片：' + JSON.stringify(diagnostics.mtBatch));
      assert(!attachmentBarHidden(), '有附件时附件条不应保持 hidden');
      assert(vision.state.calls === 2 && vision.state.maxInflight === 1,
        '两张图应串行识别 2 次，实际 ' + vision.state.calls + ' 次 / 并发峰值 ' + vision.state.maxInflight);
      multiTurn.recognitionUrls = [visionImageUrl(vision.state.messages[0]), visionImageUrl(vision.state.messages[1])];
      assert(multiTurn.recognitionUrls[0].indexOf('data:image/') === 0 && multiTurn.recognitionUrls[1].indexOf('data:image/') === 0,
        '识别请求应携带原图 dataURL：' + JSON.stringify(multiTurn.recognitionUrls.map(urlTag)));
      assert(multiTurn.recognitionUrls[0] !== multiTurn.recognitionUrls[1], '两张图的原图不应相同');
      assert(meta && meta.length === 2, 'listAttachments 应返回 2 条：' + JSON.stringify(meta));
      assert(meta[0].name === 't3-batch-1.png' && meta[1].name === 't3-batch-2.png', '附件名称应与图片一致：' + JSON.stringify(meta));
      assert(meta[0].kind === 'image' && meta[1].kind === 'image', '附件类型应为 image：' + JSON.stringify(meta));
      assert(meta[1].current === true && meta[0].current === false, 'current 应落在最后一张：' + JSON.stringify(meta));
      assert(meta.every((item) => item.hasDataUrl), '图片附件应保留原图 dataUrl：' + JSON.stringify(meta));
      const current = currentAttachmentChip();
      assert(current && attachmentChipName(current).indexOf('t3-batch-2.png') >= 0,
        '附件条的 is-current 应落在最后一张，实际 ' + (current ? attachmentChipName(current) : '无'));
      assert(messagesText().indexOf('已登记 2 个会话附件') >= 0, '缺少「已登记 N 个会话附件」清单提示');
    } finally {
      vision.restore();
      restoreConfig();
    }
  });

  /* ---------- 多轮 2：追问「这张图里有几个测点」→ 视觉桩必须收到 image_url ---------- */

  await test('T3 multi-turn: image follow-up sends the current image dataUrl to vision', async () => {
    const restoreConfig = enableVisionConfig();
    const vision = stubVisionMulti(['这张图里共有 6 个测点（T3 视觉桩）。']);
    const chat = stubIntentLlm();
    try {
      const idle = await waitAssistantIdle(5000);
      assert(idle, '追问前助手一直处于忙碌状态');
      const textBefore = messagesText();
      window.BTAssistant.send('这张图里有几个测点');
      const called = await until(() => vision.state.calls > 0, 4000);
      diagnostics.mtFollowUp = {
        visionCalls: vision.state.calls,
        chatCalls: chat.state.calls,
        maxTokens: vision.state.maxTokens
      };
      assert(called, '图片追问没有调用视觉模型：' + messagesText().slice(-240));
      assert(vision.state.calls === 1, '一次追问只应调用 1 次视觉模型，实际 ' + vision.state.calls);
      assert(chat.state.calls === 0, '图片追问应优先于意图模型，实际调用意图模型 ' + chat.state.calls + ' 次');
      const messages = vision.state.messages[0];
      const last = messages[messages.length - 1];
      assert(last && last.role === 'user' && Array.isArray(last.content), '视觉消息末条应为 user + content 数组');
      assert(last.content.length === 2 && last.content[0].type === 'text'
        && String(last.content[0].text).indexOf('这张图里有几个测点') >= 0,
        '视觉消息末条应包含当前问题文本：' + JSON.stringify(last.content));
      const url = visionImageUrl(messages);
      assert(url.indexOf('data:image/') === 0, 'image_url 应为 dataURL，实际 ' + urlTag(url));
      assert(url === multiTurn.recognitionUrls[1], '追问当前附件（第 2 张）应重发第 2 张原图');
      assert(vision.state.maxTokens[0] === 1200, '视觉追问 maxTokens 应为 1200，实际 ' + vision.state.maxTokens[0]);
      const answered = await until(() => messagesText().indexOf('T3 视觉桩') >= 0, 3000);
      assert(answered, '视觉回答没有渲染到消息区：' + messagesText().slice(-200));
      const tail = messagesText().slice(textBefore.length);
      diagnostics.mtFollowUp.tail = tail.slice(-200);
      assert(tail.indexOf('【基于图片 t3-batch-2.png】') >= 0, '回复应带「【基于图片 名称】」前缀：' + tail.slice(-200));
      assert(tail.indexOf('6 个测点') >= 0, '回复应包含视觉模型答案：' + tail.slice(-200));
    } finally {
      chat.restore();
      vision.restore();
      restoreConfig();
    }
  });

  /* ---------- 多轮 3：指代切换（点附件条切换 / 自然语言序号） ---------- */

  await test('T3 multi-turn: switching attachment changes which image is sent to vision', async () => {
    const restoreConfig = enableVisionConfig();
    const vision = stubVisionMulti(['第 1 张图：4 个测点。', '第 2 张图：6 个测点。']);
    const chat = stubIntentLlm();
    try {
      const idle = await waitAssistantIdle(5000);
      assert(idle, '切换前助手一直处于忙碌状态');
      const chips = attachmentChips();
      assert(chips.length === 2, '前置条件：附件条应有 2 项，实际 ' + JSON.stringify(attachmentChipNames()));
      chips[0].click();
      const switched = await until(() => {
        const chip = currentAttachmentChip();
        return Boolean(chip && attachmentChipName(chip).indexOf('t3-batch-1.png') >= 0);
      }, 2000);
      diagnostics.mtSwitch = { afterChipClick: attachmentChipNames(), current: attachmentChipName(currentAttachmentChip()) };
      assert(switched, '点击第 1 项后 current 应切到第 1 张：' + JSON.stringify(diagnostics.mtSwitch));

      await waitAssistantIdle(4000);
      const beforeFirst = vision.state.calls;
      window.BTAssistant.send('这张图里有几个测点');
      const askedFirst = await until(() => vision.state.calls > beforeFirst, 3000);
      assert(askedFirst, '切换后追问没有走视觉');
      assert(visionImageUrl(vision.state.messages[vision.state.calls - 1]) === multiTurn.recognitionUrls[0],
        '切换 current 后追问应重发第 1 张原图');

      /* 自然语言序号指代：先看「第二张图呢」是否切换 current（记录实测），
         再用「第二张图里有几个测点？」验证序号指代是否真的作用到视觉请求。 */
      const beforeRef = attachmentChipName(currentAttachmentChip());
      const callsBeforeRef = vision.state.calls;
      const textBeforeRef = messagesText();
      await waitAssistantIdle(4000);
      window.BTAssistant.send('第二张图呢');
      await wait(120);
      await waitAssistantIdle(4000);
      const afterRef = attachmentChipName(currentAttachmentChip());
      const refTail = messagesText().slice(textBeforeRef.length);
      diagnostics.mtRefNatural = {
        before: beforeRef, after: afterRef,
        visionDelta: vision.state.calls - callsBeforeRef,
        tail: refTail.slice(-160)
      };
      assert(afterRef.indexOf('t3-batch-2.png') >= 0,
        '「第二张图呢」应按指代把 current 切到第 2 张，实际仍是 ' + afterRef + '（实测：' + JSON.stringify(diagnostics.mtRefNatural) + '）');

      const callsBeforeOrdinal = vision.state.calls;
      await waitAssistantIdle(4000);
      window.BTAssistant.send('第二张图里有几个测点？');
      const askedOrdinal = await until(() => vision.state.calls > callsBeforeOrdinal, 3000);
      assert(askedOrdinal, '「第二张图里有几个测点？」没有走视觉');
      const ordinalUrl = visionImageUrl(vision.state.messages[vision.state.calls - 1]);
      diagnostics.mtRefOrdinal = { urlIsSecondImage: ordinalUrl === multiTurn.recognitionUrls[1], tail: messagesText().slice(-160) };
      assert(ordinalUrl === multiTurn.recognitionUrls[1],
        '「第二张图里有几个测点？」应按序号指代重发第 2 张原图（当前实现用 current 兜底会答错图）');
    } finally {
      chat.restore();
      vision.restore();
      restoreConfig();
    }
  });

  /* ---------- 多轮 4：导入后重复导入保护（import-again 才放行） ---------- */

  await test('T3 multi-turn: duplicate import is blocked until 再次导入', async () => {
    const restoreConfig = enableVisionConfig();
    const chat = stubIntentLlm();
    try {
      await waitAssistantIdle(5000);
      /* 1) 先把待确认的清洗结果真正导入 */
      const eventsBeforeImport = userDB.events.length;
      const confirm = lastActionButton('import-confirm');
      if (confirm) {
        confirm.click();
        await until(() => userDB.events.length > eventsBeforeImport, 4000);
        await waitAssistantIdle(5000);
      }
      diagnostics.mtImport = {
        eventsBefore: eventsBeforeImport,
        eventsAfter: userDB.events.length,
        manualConfirmPresent: Boolean(confirm),
        meta: attachmentMetaList()
      };
      const importedMeta = (attachmentMetaList() || []).filter((item) => item.importedAt);
      assert(importedMeta.length >= 1, '导入后应有附件带 importedAt：' + JSON.stringify(diagnostics.mtImport));

      /* 2) 已导入的当前附件再说「导入」→ 不写库 + 出现「再次导入」 */
      const eventsBeforeGuard = userDB.events.length;
      const textBeforeGuard = messagesText();
      window.BTAssistant.send('导入');
      const guarded = await until(() => messagesText().slice(textBeforeGuard.length).indexOf('导入过') >= 0, 4000);
      await wait(80);
      await waitAssistantIdle(5000);
      const guardTail = messagesText().slice(textBeforeGuard.length);
      diagnostics.mtGuard = {
        tail: guardTail.slice(-200),
        eventsBefore: eventsBeforeGuard,
        eventsAfter: userDB.events.length,
        againButton: Boolean(lastActionButton('import-again'))
      };
      assert(guarded, '已导入附件再说「导入」应给重复导入提示：' + guardTail.slice(-200));
      assert(userDB.events.length === eventsBeforeGuard,
        '重复导入保护失效：userDB.events 从 ' + eventsBeforeGuard + ' 变为 ' + userDB.events.length);
      assert(lastActionButton('import-again'), '重复导入提示应带 import-again 按钮');

      /* 3) 旧卡片上的「确认导入」不能绕过保护（没有待清洗结果时不应写库） */
      const staleConfirm = lastActionButton('import-confirm');
      if (staleConfirm) {
        staleConfirm.click();
        await wait(100);
        await waitAssistantIdle(5000);
        assert(userDB.events.length === eventsBeforeGuard,
          '旧卡片的「确认导入」绕过了重复导入保护：' + userDB.events.length + ' != ' + eventsBeforeGuard);
      }

      /* 4) 点「再次导入」后才重新走 清洗 → 确认导入 */
      const cardsBeforeAgain = countCleaningCards();
      const eventsBeforeAgain = userDB.events.length;
      const textBeforeAgain = messagesText();
      const againButton = lastActionButton('import-again');
      const againClickable = Boolean(againButton && document.contains(againButton) && !assistantBusy());
      againButton.click();
      /* 「再次导入」的通过证据：重新出现清洗/导入流程的回复（去重后可能 0 新增，不算失败） */
      const againStarted = await until(() => countCleaningCards() > cardsBeforeAgain
        || userDB.events.length > eventsBeforeAgain
        || messagesText().slice(textBeforeAgain.length).indexOf('开始再次导入') >= 0, 2500);
      await wait(80);
      await waitAssistantIdle(3000);
      diagnostics.mtImportAgain = {
        clickable: againClickable,
        newCleaningCard: countCleaningCards() > cardsBeforeAgain,
        eventsBefore: eventsBeforeAgain,
        tail: messagesText().slice(textBeforeAgain.length).slice(-200)
      };
      assert(againStarted, '点「再次导入」后没有出现重新清洗/导入的迹象：' + JSON.stringify(diagnostics.mtImportAgain));
      assert(diagnostics.mtImportAgain.tail.indexOf('开始再次导入') >= 0,
        '点「再次导入」应重新走清洗流程：' + diagnostics.mtImportAgain.tail);
      const againConfirm = lastActionButton('import-confirm');
      if (againConfirm) {
        againConfirm.click();
        await wait(120);
        await waitAssistantIdle(3000);
      }
      diagnostics.mtImportAgain.eventsAfter = userDB.events.length;
      assert(userDB.events.length >= eventsBeforeAgain,
        '再次导入不应破坏台账计数：' + JSON.stringify(diagnostics.mtImportAgain));

      /* 5) 再次导入后保护必须重新生效 */
      const eventsAfterAgain = userDB.events.length;
      const textBeforeSecondGuard = messagesText();
      window.BTAssistant.send('导入');
      await until(() => messagesText().slice(textBeforeSecondGuard.length).indexOf('导入过') >= 0, 3000);
      await wait(80);
      await waitAssistantIdle(3000);
      diagnostics.mtGuardAgain = { eventsBefore: eventsAfterAgain, eventsAfter: userDB.events.length };
      assert(userDB.events.length === eventsAfterAgain,
        '再次导入后保护未重新生效：' + eventsAfterAgain + ' -> ' + userDB.events.length);
    } finally {
      chat.restore();
      restoreConfig();
    }
  });

  /* ---------- 多轮 5：删除附件（current 归属）与空附件条 ---------- */

  await test('T3 multi-turn: removing attachments keeps a valid current and hides the empty bar', async () => {
    const restoreConfig = enableVisionConfig();
    const vision = stubVisionMulti([replyFor([ROW_C])]);
    try {
      await waitAssistantIdle(5000);
      /* 先补一张图凑到 3 项，才能同时验证「删非当前项」与「删当前项后回退」 */
      window.BTAssistant.handleFile(poolPng(2));
      const third = await until(() => attachmentChips().length === 3, 3000);
      await waitAssistantIdle(5000);
      diagnostics.mtRemoveBefore = { chips: attachmentChipNames(), meta: attachmentMetaList() };
      assert(third, '补传一张图后附件条应为 3 项：' + JSON.stringify(diagnostics.mtRemoveBefore));

      /* 1) 删除非当前项：数量 -1，current 不变 */
      const beforeNames = attachmentChipNames();
      const currentName = attachmentChipName(currentAttachmentChip());
      const other = attachmentChips().find((chip) => !chip.classList.contains('is-current'));
      assert(other, '附件条应存在非当前项：' + JSON.stringify(beforeNames));
      other.querySelector('[data-attachment-action="remove"]').click();
      await wait(80);
      await waitAssistantIdle(3000);
      diagnostics.mtRemoveOther = { before: beforeNames, after: attachmentChipNames(), current: attachmentChipName(currentAttachmentChip()) };
      assert(attachmentChips().length === beforeNames.length - 1, '删除一个附件后应少 1 项：' + JSON.stringify(diagnostics.mtRemoveOther));
      assert(attachmentChipName(currentAttachmentChip()) === currentName, '删除非当前项不应改变 current：' + JSON.stringify(diagnostics.mtRemoveOther));

      /* 2) 删除当前项：current 应回退到剩下的最新一项 */
      const currentChip = currentAttachmentChip();
      assert(currentChip, '删除前应存在 is-current 项');
      currentChip.querySelector('[data-attachment-action="remove"]').click();
      await wait(80);
      await waitAssistantIdle(3000);
      const left = attachmentChips();
      diagnostics.mtRemoveCurrent = { left: left.map(attachmentChipName), current: attachmentChipName(currentAttachmentChip()) };
      assert(left.length === beforeNames.length - 2, '删除当前项后应再少 1 项：' + JSON.stringify(diagnostics.mtRemoveCurrent));
      assert(currentAttachmentChip() === left[left.length - 1], '删除当前附件后 current 应回退到最新一项：' + JSON.stringify(diagnostics.mtRemoveCurrent));

      /* 3) 全部删除 → 附件条 hidden、门面清空 */
      while (attachmentChips().length) {
        const button = attachmentChips()[0].querySelector('[data-attachment-action="remove"]');
        if (!button) break;
        button.click();
        await wait(60);
      }
      await waitAssistantIdle(3000);
      diagnostics.mtRemoveAll = { chips: attachmentChipNames(), hidden: attachmentBarHidden(), meta: attachmentMetaList() };
      assert(attachmentChips().length === 0, '全部删除后不应残留附件项：' + JSON.stringify(diagnostics.mtRemoveAll));
      assert(attachmentBarHidden(), '附件为空时附件条应保持 hidden');
      const meta = attachmentMetaList();
      assert(meta && meta.length === 0, '全部删除后 listAttachments 应为空：' + JSON.stringify(meta));
    } finally {
      vision.restore();
      restoreConfig();
    }
  });

  /* ---------- 多轮 6：新会话清空附件；无附件时追问图片必须给明确提示 ---------- */

  await test('T3 multi-turn: new conversation clears attachments and stale image questions are refused', async () => {
    const restoreConfig = enableVisionConfig();
    const vision = stubVisionMulti([replyFor([ROW_C], '单图登记备注')]);
    const chat = stubIntentLlm();
    try {
      /* 先开新会话清空附件，保证这里走的是「唯一一张图」的单图登记路径 */
      document.getElementById('assistantNewChat').click();
      await wait(60);
      await waitAssistantIdle(3000);
      assert(attachmentChips().length === 0, '新会话未清空附件：' + JSON.stringify(attachmentChipNames()));
      window.BTAssistant.handleFile(poolPng(2));
      const single = await until(() => attachmentChips().length === 1, 3000);
      const hasUrl = await until(() => {
        const meta = attachmentMetaList();
        return Boolean(meta && meta.length === 1 && meta[0].hasDataUrl);
      }, 3000);
      diagnostics.mtSingle = { chips: attachmentChipNames(), meta: attachmentMetaList() };
      assert(single, '单图上传后附件条应有 1 项：' + JSON.stringify(diagnostics.mtSingle));
      assert(hasUrl, '单图登记应异步补上原图 dataUrl：' + JSON.stringify(attachmentMetaList()));
      await waitAssistantIdle(5000);

      /* 记下当前会话 id：稍后验证「历史会话只回填摘要」 */
      const historyBtn = document.getElementById('assistantHistoryBtn');
      assert(historyBtn, '缺少会话历史按钮 #assistantHistoryBtn');
      historyBtn.click();
      await wait(50);
      const activeItem = document.querySelector('#assistantHistory [data-assistant="history-item"][aria-current="true"]');
      multiTurn.conversationIdBeforeNewChat = activeItem ? String(activeItem.getAttribute('data-conversation-id')) : '';
      historyBtn.click();
      await wait(50);

      /* 新会话 → 附件清空 */
      const visionCallsBefore = vision.state.calls;
      document.getElementById('assistantNewChat').click();
      await wait(60);
      await waitAssistantIdle(3000);
      diagnostics.mtNewChat = { chips: attachmentChipNames(), hidden: attachmentBarHidden(), meta: attachmentMetaList() };
      assert(attachmentChips().length === 0, '新会话应清空附件条：' + JSON.stringify(diagnostics.mtNewChat));
      assert(attachmentBarHidden(), '新会话后附件条应保持 hidden');
      assert(attachmentMetaList().length === 0, '新会话后 listAttachments 应为空：' + JSON.stringify(diagnostics.mtNewChat));

      /* 无附件时问「这张图」→ 明确中文提示，且不得调用视觉模型 */
      /* 新会话后消息区回到空态占位，不能用文本长度判断新回复，直接等期望文案 */
      const idleBeforeAsk = await waitAssistantIdle(3000);
      assert(idleBeforeAsk, '无附件追问前助手一直处于忙碌状态');
      window.BTAssistant.send('这张图里有几个测点');
      const replied = await until(() => messagesText().indexOf('还没有附件') >= 0, 2500);
      await wait(80);
      await waitAssistantIdle(3000);
      const tail = messagesText();
      diagnostics.mtNoAttachment = { tail: tail.slice(0, 200), visionDelta: vision.state.calls - visionCallsBefore };
      assert(replied, '无附件追问没有任何回复');
      assert(vision.state.calls === visionCallsBefore, '无附件时不应调用视觉模型，实际多调 ' + (vision.state.calls - visionCallsBefore) + ' 次');
      assert(tail.indexOf('还没有附件') >= 0, '无附件追问应明确说明当前会话没有附件：' + tail.slice(0, 160));
    } finally {
      chat.restore();
      vision.restore();
      restoreConfig();
    }
  });

  /* ---------- 多轮 7：切回历史会话只有摘要，追问必须提示重新上传 ---------- */

  await test('T3 adversarial: reopened conversation keeps summaries only and asks for re-upload', async () => {
    const historyBtn = document.getElementById('assistantHistoryBtn');
    historyBtn.click();
    await wait(50);
    const targetId = multiTurn.conversationIdBeforeNewChat;
    const item = targetId
      ? document.querySelector('#assistantHistory [data-assistant="history-item"][data-conversation-id="' + targetId + '"]')
      : null;
    diagnostics.mtHistory = { targetId: targetId, found: Boolean(item) };
    assert(item, '历史会话列表里找不到刚才那个会话：' + targetId);
    item.click();
    await wait(80);
    await waitAssistantIdle(3000);
    const meta = attachmentMetaList();
    diagnostics.mtRestored = { chips: attachmentChipNames(), meta: meta };
    assert(attachmentChips().length >= 1, '切回历史会话应回填附件摘要：' + JSON.stringify(diagnostics.mtRestored));
    assert(meta && meta.every((entry) => entry.restored === true && entry.hasDataUrl === false),
      '历史会话只应回填摘要（无明细与原图）：' + JSON.stringify(meta));

    const vision = stubVisionMulti(['历史会话没有原图，不应被调用']);
    const textBefore = messagesText();
    try {
      window.BTAssistant.send('这张图里有几个测点');
      const replied = await until(() => messagesText().indexOf('重新上传') >= 0, 2500);
      await wait(80);
      await waitAssistantIdle(3000);
      const tail = messagesText().slice(textBefore.length);
      diagnostics.mtRestoredTail = { tail: tail.slice(0, 200), visionCalls: vision.state.calls };
      assert(replied, '历史会话追问没有任何回复');
      assert(vision.state.calls === 0, '历史会话没有原图时不应调用视觉模型');
      assert(tail.indexOf('重新上传') >= 0, '历史会话追问应提示重新上传：' + tail.slice(0, 160));
    } finally {
      vision.restore();
    }
  });

  /* ---------- 多轮 8：附件超过 3 个的淘汰 + 未配置模型时追问 ---------- */

  await test('T3 adversarial: FIFO over 3 attachments and unconfigured model follow-up', async () => {
    const restoreConfig = enableVisionConfig();
    const vision = stubVisionMulti([replyFor([ROW_A]), replyFor([ROW_B]), replyFor([ROW_C]), replyFor([ROW_A])]);
    const chat = stubIntentLlm();
    try {
      document.getElementById('assistantNewChat').click();
      await wait(60);
      await waitAssistantIdle(3000);
      const idle = await waitAssistantIdle(4000);
      assert(idle, '批量上传前助手一直处于忙碌状态');
      const pending = window.BTAssistant.handleFiles(poolPngs(4));
      if (pending && typeof pending.then === 'function') await pending;
      const fifo = await until(() => attachmentChips().length === 3, 4000);
      const meta = attachmentMetaList();
      const urls = vision.state.messages.map(visionImageUrl);
      diagnostics.mtFifo = { chips: attachmentChipNames(), meta: meta, visionCalls: vision.state.calls };
      assert(vision.state.calls === 4, '4 张图应各识别 1 次，实际 ' + vision.state.calls);
      assert(fifo, '超过 MAX_ATTACHMENTS=3 时应 FIFO 淘汰到 3 项：' + JSON.stringify(diagnostics.mtFifo));
      assert(meta && meta.length === 3 && meta[0].seq === 2 && meta[2].seq === 4, 'FIFO 应淘汰 seq=1 且不重排序号：' + JSON.stringify(meta));
      assert(attachmentChipNames()[0].indexOf('t3-batch-2.png') >= 0 && attachmentChipNames()[2].indexOf('t3-batch-4.png') >= 0,
        'FIFO 后应保留第 2~4 张：' + JSON.stringify(attachmentChipNames()));

      /* 未配置模型 → 明确提示且不调用视觉模型 */
      const restoreNoConfig = withoutVisionConfig();
      try {
        await waitAssistantIdle(4000);
        const callsBefore = vision.state.calls;
        const textBefore = messagesText();
        window.BTAssistant.send('这张图里有几个测点');
        const replied = await until(() => messagesText().indexOf('图片追问需要配置') >= 0, 2500);
        await wait(80);
        await waitAssistantIdle(3000);
        const tail = messagesText().slice(textBefore.length);
        diagnostics.mtUnconfigured = { tail: tail.slice(0, 200), visionDelta: vision.state.calls - callsBefore };
        assert(replied, '未配置模型时追问没有任何回复');
        assert(vision.state.calls === callsBefore, '未配置模型时不应调用视觉模型');
        assert(tail.indexOf('图片追问需要配置') >= 0, '未配置模型应给明确中文提示（禁止静默降级到规则）：' + tail.slice(0, 160));
      } finally {
        restoreNoConfig();
      }

      /* 恢复配置后：当前附件是第 4 张，追问必须重发第 4 张原图 */
      await waitAssistantIdle(4000);
      const callsBeforeResume = vision.state.calls;
      window.BTAssistant.send('这张图里有几个测点');
      const resumed = await until(() => vision.state.calls > callsBeforeResume, 3000);
      assert(resumed, '恢复模型配置后追问应重新走视觉');
      const resumeUrl = visionImageUrl(vision.state.messages[vision.state.calls - 1]);
      diagnostics.mtResume = { urlIsFourthImage: resumeUrl === urls[3], url: urlTag(resumeUrl) };
      assert(resumeUrl === urls[3], 'FIFO 后 current 应为第 4 张，追问应重发第 4 张原图');
    } finally {
      chat.restore();
      vision.restore();
      restoreConfig();
    }
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
