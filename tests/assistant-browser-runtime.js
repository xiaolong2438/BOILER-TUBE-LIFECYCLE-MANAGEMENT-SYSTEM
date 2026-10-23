/* AI 数据助手端到端冒烟：在真实浏览器里跑一遍面板与数据链路。 */
window.runAssistantTests = async function () {
  const results = [];
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

  await test('page remains error-free', async () => {
    assert(!window.__testErrors.length, JSON.stringify(window.__testErrors));
  });

  return { passed: results.every((item) => item.passed), results: results, errors: window.__testErrors };
};
