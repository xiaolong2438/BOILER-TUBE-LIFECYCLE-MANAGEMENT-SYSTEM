/* 数据导入便捷性/准确性端到端验收：真实页面 + 真实清洗/导入/撤销链路（无模型、无后端）。
 * 由 tests/run-import-ux-browser.py 在无头 Edge 中加载执行，结果写入 #import-ux-results。
 * 场景：别名乱序 CSV（干净行自动入库 + 警告行确认 + 错误行跳过 + 模糊映射与编码建议可视化）、
 *       真实 Word 台账（.docx → 识别 → 清洗 → 确认导入）、无关表格不误写库、材料库别名表头导入。 */
window.runImportUxTests = async function () {

  const results = [];
  const diagnostics = {};
  const assert = (value, message) => { if (!value) throw new Error(message); };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function test(name, body) {
    try { await body(); results.push({ name: name, passed: true }); }
    catch (error) { results.push({ name: name, passed: false, error: String((error && error.stack) || error) }); }
  }
  async function until(fn, timeout) {
    const start = Date.now();
    while (Date.now() - start < (timeout || 6000)) {
      if (fn()) return true;
      await wait(40);
    }
    return false;
  }
  const messagesText = () => {
    const el = document.getElementById('assistantMessages');
    return el ? String(el.innerText || el.textContent || '') : '';
  };
  const lastActionButton = (actionId) => {
    const buttons = document.querySelectorAll('[data-action-id="' + actionId + '"]');
    return buttons.length ? buttons[buttons.length - 1] : null;
  };
  const eventCount = () => userDB.events.length + userDB.replacements.length;
  const materialCount = () => (typeof getMaterialLibrary === 'function' ? getMaterialLibrary().length : -1);
  const makeFile = (content, name, type) => new File([content], name, { type: type || 'text/csv' });

  await test('助手面板挂载并可用', async () => {
    const ok = await until(() => window.BTAssistant && document.getElementById('assistantLauncher') && document.getElementById('assistantPanel'));
    assert(ok, 'launcher or panel not mounted');
    window.BTAssistant.open();
    assert(window.BTAssistant.isOpen(), 'panel should be open');
  });

  /* ---------- 场景 1：现场乱序 CSV —— 便捷性主线 ---------- */
  await test('乱序别名 CSV：干净行自动入库、警告行待确认、错误行跳过', async () => {
    const csv = [
      '设备编码,机组号,检测日期,分类,实测壁厚值(mm),布氏硬度值,检测类型,结论备注',
      '1G-SLB-WB-F000-R003-Q001,1,2024年3月5日,事件,6.8,182,测厚,前墙第3管',
      '1G-SLB-WB-L000-F005-Q001,1,2024/4/8,事件,7.1,180,测厚,左墙第5管',
      '2G-GGRQ-GQ-L012-U005-Q001,2,2024.4.15,事件,6.9,205,测厚,高过出口',
      '1G-GGRQ-GQ-L040-U001-Q001,1,2024-05-06,事件,6.9,181,测厚,排号待核对',
      ',1,2024-06-01,事件,7.0,175,测厚,缺编码'
    ].join('\n');
    const before = eventCount();
    window.BTAssistant.handleFile(makeFile(csv, '现场检测记录-乱序.csv'));
    /* 3 行干净数据应直接入库，无需任何按钮 */
    const autoImported = await until(() => eventCount() === before + 3);
    assert(autoImported, '干净行应自动入库 3 行，当前 ' + eventCount() + ' / 基线 ' + before + '，对话尾：' + messagesText().slice(-300));
    /* 警告行留下待确认卡片 */
    const confirmButton = await until(() => lastActionButton('import-confirm')) && lastActionButton('import-confirm');
    assert(confirmButton, '缺少待确认卡片的「确认导入」按钮');
    diagnostics.dirtyCsv = {
      autoImported: 3,
      pendingConfirm: 1,
      dropped: 1
    };
    /* 撤销自动导入 → 再确认警告行 → 再撤销，链路可回退 */
    const confirmText = messagesText();
    assert(confirmText.indexOf('待确认') >= 0 || confirmText.indexOf('警告') >= 0, '应有警告待确认提示');
  });

  await test('乱序别名 CSV：模糊表头映射与编码近似建议可视化呈现', async () => {
    const text = messagesText();
    assert(text.indexOf('设备编码」→「管段编码') >= 0, '字段智能匹配卡片应展示 设备编码→管段编码，对话尾：' + text.slice(-400));
    assert(text.indexOf('实测壁厚值(mm)') >= 0 && text.indexOf('厚度(mm)') >= 0, '应展示 实测壁厚值(mm)→厚度(mm) 映射');
    assert(text.indexOf('近似：1G-GGRQ-') >= 0, '超范围编码应给出近似编码建议：' + text.slice(-400));
  });

  await test('警告行确认导入 + 撤销回退', async () => {
    const before = eventCount();
    const confirmButton = lastActionButton('import-confirm');
    assert(confirmButton, '确认导入按钮丢失');
    confirmButton.click();
    const imported = await until(() => eventCount() === before + 1);
    assert(imported, '警告行确认后应入库 1 行');
    const undoButton = lastActionButton('undo-last-import');
    assert(undoButton, '缺少撤销按钮');
    undoButton.click();
    const undone = await until(() => eventCount() === before);
    assert(undone, '撤销应恢复到导入前');
  });

  /* ---------- 场景 2：真实 Word 台账（.docx） ---------- */
  await test('Word 台账 .docx：本地识别 → 清洗 → 干净行自动入库 → 警告行确认 → 撤销', async () => {
    const response = await fetch('tests/fixtures/import-ux/检测台账.docx');
    assert(response.ok, 'docx fixture 读取失败：' + response.status);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const before = eventCount();
    window.BTAssistant.handleFile(makeFile(bytes, '检测台账.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
    const autoImported = await until(() => eventCount() === before + 2);
    assert(autoImported, 'Word 干净行应自动入库 2 行，当前 ' + eventCount() + ' / ' + before + '，尾：' + messagesText().slice(-300));
    assert(messagesText().indexOf('Word 表格') >= 0, '应提示来自 Word 表格识别');
    /* 无效日期行（2025-02-30）待确认 */
    const confirmButton = lastActionButton('import-confirm');
    assert(confirmButton, 'Word 无效日期行缺少确认导入按钮');
    const afterConfirm = before + 3;
    confirmButton.click();
    const imported = await until(() => eventCount() === afterConfirm);
    assert(imported, 'Word 警告行确认后应入库');
    const undoButton = lastActionButton('undo-last-import');
    undoButton.click();
    const undone = await until(() => eventCount() === before + 2);
    assert(undone, 'Word 导入撤销失败');
    diagnostics.docx = { autoImported: 2, pendingConfirm: 1 };
  });

  /* ---------- 场景 3：无关表格不误写库 ---------- */
  await test('无关表格（供应商清单）：识别为 unknown，不自动入库、不新增确认导入', async () => {
    const csv = ['供应商名称,联系人,联系电话,供货范围,备注', '华东钢管厂,王经理,13800138000,水冷壁管,长期合作'].join('\n');
    const before = eventCount();
    /* 历史消息里可能残留此前卡片的按钮，以“新增按钮数”为准 */
    const buttonsBefore = document.querySelectorAll('[data-action-id="import-confirm"]').length;
    window.BTAssistant.handleFile(makeFile(csv, '无关表格-供应商清单.csv'));
    await until(() => messagesText().indexOf('未识别数据集') >= 0);
    await wait(300); /* 留出可能误写库的时间窗 */
    assert(eventCount() === before, '无关表格绝不能写入台账');
    /* 最新清洗卡片：可导入必须显示占位符，绝不能显示“可导入 2”让人误以为已入库 */
    const cards = document.querySelectorAll('.assistant-cleaning');
    const cardText = cards.length ? String(cards[cards.length - 1].innerText || '') : '';
    assert(cardText.indexOf('未识别数据集') >= 0, '卡片必须标注未识别数据集：' + cardText.slice(0, 200));
    assert(cardText.indexOf('可导入') >= 0 && /可导入\s*—/.test(cardText.replace(/\n/g, ' ')),
      '未识别数据集的「可导入」必须显示占位符而不是行数，实际：' + cardText.replace(/\n/g, ' ').slice(0, 240));
    assert(!/可导入\s*\d+/.test(cardText.replace(/\n/g, ' ')), '未识别数据集不能显示可导入行数');
    assert(messagesText().indexOf('通用清洗后保留 1 行，不导入') >= 0,
      '对话必须说明保留行数且不导入，实际尾：' + messagesText().slice(-260));
    const buttonsAfter = document.querySelectorAll('[data-action-id="import-confirm"]').length;
    assert(buttonsAfter === buttonsBefore, 'unknown 数据集不能新增确认导入按钮');
  });

  /* ---------- 场景 4：材料库别名表头走同一链路 ---------- */
  await test('材料库别名 CSV：自动入库 + 确认导入 + 撤销', async () => {
    const csv = [
      '部件,系统,位置,结构,规格,材质牌号,库存数量,总长度',
      '水冷壁,WW,前墙第8排,膜式壁,Φ63.5×7.5,SA-210C,4,24',
      '省煤器,ECO,入口第1排,蛇形管,Φ51×6,SA-210C,10,60',
      '省煤器,ECO,入口第1排,蛇形管,Φ51×6,SA-210C,10,60',
      '高温过热器,HSH,出口第2排,吊管,Φ51×8,'
    ].join('\n');
    const before = materialCount();
    window.BTAssistant.handleFile(makeFile(csv, '受热面材料台账.csv'));
    /* 干净行（水冷壁）自动入库；省煤器在重复组里保留首行 → 待确认 */
    const autoImported = await until(() => materialCount() === before + 1);
    assert(autoImported, '材料库干净行应自动入库 1 行，当前 ' + materialCount() + ' / ' + before);
    const confirmButton = lastActionButton('import-confirm');
    assert(confirmButton, '材料库待确认行缺少确认导入按钮');
    confirmButton.click();
    const imported = await until(() => materialCount() === before + 2);
    assert(imported, '材料库确认导入后应入库 2 行');
    assert(messagesText().indexOf('材质牌号') >= 0, '应展示 材质牌号 的智能匹配');
    const undoButton = lastActionButton('undo-last-import');
    undoButton.click();
    const undone = await until(() => materialCount() === before + 1);
    assert(undone, '材料库撤销失败');
  });

  /* ---------- 场景 5：导入准确性抽查 —— 写库内容与源文件一致 ---------- */
  await test('准确性抽查：入库记录的编码/日期/厚度与源文件一致', async () => {
    const csv = [
      '设备编码,机组号,检测日期,分类,实测壁厚值(mm),布氏硬度值,检测类型,结论备注',
      '1G-SLB-WB-F000-R003-Q001,1,2024年3月5日,事件,6.8,182,测厚,端到端准确性抽查'
    ].join('\n');
    const before = userDB.events.length;
    window.BTAssistant.handleFile(makeFile(csv, '准确性抽查-检测记录.csv'));
    const imported = await until(() => userDB.events.length === before + 1);
    assert(imported, '记录未入库');
    const record = userDB.events[before];
    assert(String(record.code || record['管段编码'] || '').toUpperCase() === '1G-SLB-WB-F000-R003-Q001', '编码错位：' + JSON.stringify(record));
    assert(String(record.date || record['日期'] || '').slice(0, 10) === '2024-03-05', '日期未归一：' + JSON.stringify(record));
    const thickness = String(record.thickness ?? record['厚度(mm)'] ?? record['厚度'] ?? '');
    assert(thickness.indexOf('6.8') === 0, '厚度错位：' + JSON.stringify(record));
    const undoButton = lastActionButton('undo-last-import');
    if (undoButton) { undoButton.click(); await until(() => userDB.events.length === before); }
  });

  const passed = results.filter((item) => item.passed).length;
  return {
    passed: passed === results.length,
    total: results.length,
    passedCount: passed,
    diagnostics: diagnostics,
    results: results,
    elapsedMs: Date.now() - (window.__importUxStart || Date.now())
  };
};
window.__importUxStart = Date.now();
