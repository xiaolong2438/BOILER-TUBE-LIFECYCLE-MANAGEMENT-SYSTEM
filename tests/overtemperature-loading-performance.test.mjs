import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/app/overtemperature-v1.js', import.meta.url), 'utf8');
const parser = readFileSync(new URL('../assets/app/overtemperature-import-v1.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const summary = label => ({ summary: { recordCount: 0 }, byPoint: [], label });
function setup({ lazy = false } = {}) {
  const elements = new Map(), listeners = {}, calls = [], groups = [], ready = [];
  let active = true, failImport = false;
  const element = () => ({ innerHTML: '', setAttribute() {}, scrollIntoView() {}, querySelector() { return null; } });
  const root = { ...element(), addEventListener(name, fn) { listeners[name] = fn; }, contains() { return true; }, querySelectorAll() { return []; }, querySelector(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } };
  const document = { readyState: 'complete', hidden: false, addEventListener() {}, getElementById(id) { return id === 'ot-app' ? root : id === 'view-overtemperature' ? { classList: { contains: () => active } } : null; } };
  const box = { console, document, URLSearchParams, setTimeout, clearTimeout, localStorage: { getItem() { return null; } }, BTOvertemperatureCore: { MATRIX: [], formatTime: String, parseTime: value => Number(value), resolveConfig() { return null; } }, fetch(url) { return new Promise(resolve => calls.push({ url, finish(data, status = 200) { resolve({ ok: status === 200, status, text: async () => JSON.stringify(data) }); } })); } };
  box.window = box;
  if (lazy) box.BTLazy = { isReady() { return false; }, onReady(group, fn) { ready.push(fn); }, async ensure(group) { groups.push(group); if (failImport) throw new Error('simulated import failure'); vm.runInContext(parser, context); } };
  const context = vm.createContext(box);
  vm.runInContext(source, context);
  const click = (action, id) => listeners.click({ target: { closest: () => ({ dataset: { action, id } }) } });
  return { box, calls, groups, ready, elements, click, setImportFailure(value) { failImport = value; }, setActive(value) { active = value; } };
}

{
  const t = setup({ lazy: true });
  assert.equal(t.calls.length, 0, 'module start waits for bundle completion');
  t.ready[0]();
  const first = t.box.BTOvertemperature.refresh();
  assert.equal(t.box.BTOvertemperature.refresh(), first, 'duplicate refresh shares the exact in-flight promise');
  await tick();
  assert.equal(t.calls.length, 2, 'one summary and one options request across startup and bundle completion');
  t.calls.find(c => c.url.includes('/summary')).finish(summary('first'));
  t.calls.find(c => c.url.includes('/points')).finish({ items: [], total: 0 });
  await first;
  assert.deepEqual(t.groups, [], 'ordinary rendering never requests the import parser');
  await t.click('importReport');
  assert.deepEqual(t.groups, ['overtemperature-import']);
  assert.match(t.elements.get('#ot-composer').innerHTML, /导入月度超温报表/);
  await t.click('closeImport');
  await t.click('importPoints');
  assert.equal(t.groups.length, 1, 'already loaded parser is reused');
  assert.match(t.elements.get('#ot-composer').innerHTML, /导入基础测点台账/);
}

{
  const t = setup({ lazy: true });
  t.setImportFailure(true);
  await t.click('importPoints');
  assert.match(t.elements.get('#ot-sync').innerHTML, /simulated import failure/);
  t.setImportFailure(false);
  await t.click('importPoints');
  assert.equal(t.groups.length, 2, 'failed explicit activation can retry');
  assert.match(t.elements.get('#ot-composer').innerHTML, /导入基础测点台账/);
}

{
  const t = setup();
  const original = t.box.BTOvertemperature.refresh();
  await tick();
  const forced = t.box.BTOvertemperature.refresh({ force: true });
  assert.notEqual(original, forced, 'force supersedes an identical request');
  await tick();
  assert.equal(t.calls.filter(c => c.url.includes('/points')).length, 1, 'overlapping refreshes share options loading');
  const summaries = t.calls.filter(c => c.url.includes('/summary'));
  summaries[1].finish(summary('latest'));
  t.calls.find(c => c.url.includes('/points')).finish({ items: [], total: 0 });
  await forced;
  summaries[0].finish({ error: 'old failure' }, 500);
  await original;
  assert.doesNotMatch(t.elements.get('#ot-sync').innerHTML, /old failure|HTTP 500/, 'stale failures do not overwrite newer success');
  const next = t.box.BTOvertemperature.refresh();
  await tick();
  t.calls.at(-1).finish(summary('next'));
  await next;
  assert.equal(t.calls.filter(c => c.url.includes('/summary')).length, 3, 'settled calls are not permanently cached');
}

{
  const t = setup();
  const initial = t.box.BTOvertemperature.refresh();
  await tick();
  t.calls.find(c => c.url.includes('/summary')).finish(summary('initial'));
  t.calls.find(c => c.url.includes('/points')).finish({ items: [], total: 0 });
  await initial;
  await t.click('tab', 'records');
  await tick();
  t.calls.at(-1).finish(summary('records'));
  await tick();
  const oldRecords = t.calls.at(-1);
  assert.ok(oldRecords.url.includes('/records'));
  const changed = t.click('unit', '2');
  await tick();
  assert.match(t.calls.at(-1).url, /unit=2/);
  t.calls.at(-1).finish(summary('unit two'));
  await tick();
  t.calls.at(-1).finish({ items: [], total: 0 });
  await changed;
  const rendered = t.elements.get('#ot-content').innerHTML;
  oldRecords.finish({ items: [{ id: 'stale', pointId: 'old', note: 'STALE RECORD', kind: 'observation' }], total: 1 });
  await tick();
  assert.equal(t.elements.get('#ot-content').innerHTML, rendered, 'late records cannot mutate the newer filtered list');
}

console.log('ok - explicit import activation, startup and refresh deduplication, force and stale response guards');
