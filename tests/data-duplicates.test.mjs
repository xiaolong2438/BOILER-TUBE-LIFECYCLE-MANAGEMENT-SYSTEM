import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import vm from 'node:vm';

const app = readFileSync(new URL('../assets/app/app-v7.9.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../炉管全生命周期管理系统.html', import.meta.url), 'utf8');
function functionSource(name) {
  const start = app.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  const end = /^}/m.exec(app.slice(start));
  assert.ok(end, name);
  return app.slice(start, start + end.index + 1);
}
const report = { hidden: false, innerHTML: '' };
let renders = 0;
const ctx = vm.createContext({
  normalizeCodeDirection: () => null,
  document: { getElementById: () => report },
  renderDMTable: () => { renders++; },
  escapeHTML: value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
});
for (const name of ['normalizedTubeCode', 'dmDuplicateKey', 'dmDuplicateGroups', 'dmToggleDuplicateReport', 'renderDmDuplicateReport']) {
  vm.runInContext(functionSource(name), ctx);
}
const base = { date: '2026-04', code: '1G-GGRQ-GQ-L028-F001-W', type: '无损检测', desc: '方法：射线；结果：合格', inspectionResult: '合格' };
const duplicate = { ...base, sourceId: '另一来源', batch: '另一来源批次', spec: '不同的管材备注' };
assert.equal(ctx.dmDuplicateKey(base), ctx.dmDuplicateKey(duplicate), '来源和管材备注不改变四项查重口径');
assert.equal(ctx.dmDuplicateKey(base), ctx.dmDuplicateKey({ ...base, code: ' 1g-ggrq-gq-l028-f001-w001 ' }), '沿用现有历史数字尾和大小写归一');
assert.equal(ctx.dmDuplicateKey(base), ctx.dmDuplicateKey({ ...base, inspectionResult: '' }), '描述已有结果时与结果字段补齐记录一致');
for (const patch of [
  { date: '2026-05' }, { date: '2026-04-01' }, { code: '1G-GGRQ-GQ-L028-F001-Q' },
  { code: '2G-GGRQ-GQ-L028-F001-W' }, { type: '金相分析' }, { desc: '方法：超声；结果：合格' },
  { inspectionResult: '不合格' }, { thickness: '6.8' }, { hardness: '180' }
]) {
  assert.notEqual(ctx.dmDuplicateKey(base), ctx.dmDuplicateKey({ ...base, ...patch }), JSON.stringify(patch));
}
for (const patch of [{ date: '' }, { code: '' }, { desc: '', thickness: '', hardness: '' }]) {
  assert.equal(ctx.dmDuplicateKey({ ...base, ...patch }), '', '缺少必要内容不将空值误判为重复');
}
const records = [base, duplicate, { ...base, sourceId: '第三来源' }, { ...base, date: '2022-10' }];
const before = JSON.stringify(records);
const groups = ctx.dmDuplicateGroups(records);
assert.equal(groups.length, 1);
assert.equal(groups[0].length, 3);
assert.equal(JSON.stringify(records), before, '查重不得修改记录或元数据');
ctx.renderDmDuplicateReport(records);
assert.match(report.innerHTML, /1 组重复、涉及 3 条记录（超出 2 条）/);
assert.match(report.innerHTML, /另一来源/);
assert.match(report.innerHTML, /仅标记，不自动删除/);
ctx.renderDmDuplicateReport([{ ...base, sourceId: '<img src=x onerror=alert(1)>' }, base]);
assert.doesNotMatch(report.innerHTML, /<img/);
assert.match(report.innerHTML, /&lt;img/);
ctx.renderDmDuplicateReport([base]);
assert.match(report.innerHTML, /未发现/);
ctx.dmToggleDuplicateReport();
assert.equal(report.hidden, true);
assert.equal(renders, 1);
assert.match(html, /id="dm-duplicate-report"[^>]*hidden/);
assert.match(app, /onclick="dmToggleDuplicateReport\(\)"/);
assert.match(app, /renderDmDuplicateReport\(all\)/, '报告从表格相同的筛选结果计算');
assert.doesNotMatch(functionSource('renderDmDuplicateReport') + functionSource('dmDuplicateGroups'), /saveDB|\.splice\(|\.push\(eventRecord|localStorage|cloudStorage/);
console.log('ok - duplicate audit groups date/code/inspection/result matches without changing records');
