import test from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../assets/app/app-v7.9.js', import.meta.url), 'utf8');

function functionSource(name) {
  const start = app.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} must exist`);
  const rest = app.slice(start);
  const firstLine = rest.split('\n')[0].trimEnd();
  if (firstLine.endsWith('}')) return firstLine;
  const end = /^}/m.exec(rest);
  assert.ok(end, `${name} must have a closing brace`);
  return rest.slice(0, end.index + 1);
}

function elements(initial) {
  const map = new Map();
  const create = () => ({ value: '', innerHTML: '', textContent: '' });
  for (const [id, value] of Object.entries(initial)) {
    const element = create();
    element.value = value;
    map.set(id, element);
  }
  return {
    get(id) {
      if (!map.has(id)) map.set(id, create());
      return map.get(id);
    },
    has: id => map.has(id)
  };
}

function run(fields) {
  const dom = elements({ 'codeOut': '', ...fields });
  const ctx = vm.createContext({
    console,
    document: { getElementById: id => dom.get(id) },
    window: { BTAssistantCore: { validateTubeCode: () => null } },
    matrix: [],
    escapeHTML: value => String(value ?? ''),
    validateCodeAgainstMatrix: () => null
  });
  vm.runInContext(functionSource('m0pad') + '\n' + functionSource('genCode'), ctx);
  ctx.genCode();
  return {
    code: ctx.window._curCode,
    output: dom.get('codeOut').innerHTML,
    desc: dom.get('codeDesc').textContent
  };
}

test('编码生成器可生成普通管段 Q/W 且不再触发 TDZ', () => {
  const q = run({
    'f-boiler': '1G', 'f-system': 'GGRQ', 'f-comp': 'GQ',
    'f-pos-letter': 'L', 'f-pos-num': '2', 'f-dir': 'F', 'f-tube': '4', 'f-part-kind': 'Q'
  });
  assert.equal(q.code, '1G-GGRQ-GQ-L002-F004-Q');
  assert.match(q.output, /GGRQ/);

  const w = run({
    'f-boiler': '1G', 'f-system': 'GGRQ', 'f-comp': 'GQ',
    'f-pos-letter': 'L', 'f-pos-num': '2', 'f-dir': 'F', 'f-tube': '4', 'f-part-kind': 'W'
  });
  assert.equal(w.code, '1G-GGRQ-GQ-L002-F004-W');
});

test('集箱进出口侧蛇形管生成 SQ-U/D 且不带 Q/W 尾段', () => {
  const out = run({
    'f-boiler': '1G', 'f-system': 'GGRQ', 'f-comp': 'EXOUT',
    'f-pos-letter': 'L', 'f-pos-num': '1', 'f-pos2-num': '1', 'f-dir': 'U', 'f-part-kind': 'W'
  });
  assert.equal(out.code, '1G-GGRQ-EXOUT-L001-B001-SQ-U');

  const inSide = run({
    'f-boiler': '1G', 'f-system': 'GGRQ', 'f-comp': 'EXIN',
    'f-pos-letter': 'L', 'f-pos-num': '2', 'f-pos2-num': '5', 'f-dir': 'D', 'f-part-kind': 'Q'
  });
  assert.equal(inSide.code, '1G-GGRQ-EXIN-L002-F005-SQ-D');
});

test('其余编码分支（水冷壁/大屏/低过/燃烧器）保持原口径', () => {
  assert.equal(run({
    'f-boiler': '1G', 'f-system': 'SLB', 'f-comp': 'WB',
    'f-pos': 'F000', 'f-dir': 'R', 'f-tube': '25', 'f-part-kind': 'Q'
  }).code, '1G-SLB-WB-F000-R025-Q');

  assert.equal(run({
    'f-boiler': '1G', 'f-system': 'DPGRQ', 'f-comp': 'GQ',
    'f-pos-letter': 'L', 'f-pos-num': '1', 'f-pos2-letter': 'F', 'f-pos2-num': '2',
    'f-dir': 'F', 'f-tube': '7', 'f-part-kind': 'Q'
  }).code, '1G-DPGRQ-GQ-L001-F002-F007-Q');

  assert.equal(run({
    'f-boiler': '1G', 'f-system': 'DGRQ', 'f-comp': 'GQ',
    'f-space': '2KJ', 'f-pos-letter': 'L', 'f-pos-num': '45', 'f-dir': 'D', 'f-tube': '3', 'f-part-kind': 'Q'
  }).code, '1G-DGRQ-GQ-2KJ-L045-D003-Q');

  assert.equal(run({
    'f-boiler': '1G', 'f-system': 'SLB', 'f-comp': 'RSQ',
    'f-corner': '2', 'f-layer': 'C', 'f-nozzle': '3', 'f-part-kind': 'Q'
  }).code, '1G-SLB-RSQ-J2-C03-Q');
});
