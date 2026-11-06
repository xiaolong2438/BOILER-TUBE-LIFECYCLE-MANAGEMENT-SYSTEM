import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

/**
 * 懒加载契约：清单顺序、按需注入、失败重试、空闲无网络预载。
 * 这些性质一旦被改坏，页面表现是「某个模块静默不出现」或「首屏又变慢」，很难肉眼发现。
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const html = read('炉管全生命周期管理系统.html');
const lazySource = read('assets/app/lazy-v1.js');

/* ---------------- 1. 清单与顺序约束 ---------------- */
const require = createRequire(import.meta.url);
const Lazy = require('../assets/app/lazy-v1.js');
assert.ok(Lazy, 'BTLazy 必须通过 CommonJS 导出，便于 Node 测试');
assert.deepEqual(Object.keys(Lazy.GROUPS), ['assistant', 'overtemperature', 'overtemperature-import', 'xlsx', 'pdf']);
assert.equal(Lazy.XLSX_CDN, 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js');
assert.equal(Lazy.PDFJS_CDN, 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');

const indexOf = (list, name) => list.findIndex((src) => src.endsWith('/' + name));
const assistant = Lazy.GROUPS.assistant;
const overtemperature = Lazy.GROUPS.overtemperature;

assert.equal(indexOf(assistant, 'assistant-core-v1.js'), 0, 'assistant-core 必须先加载（其它模块依赖它）');
assert.equal(indexOf(assistant, 'assistant-v1.js'), assistant.length - 1, 'assistant-v1 是接线层，必须最后加载');
for (const name of ['assistant-core-v1.js', 'assistant-analysis-v1.js', 'assistant-docs-v1.js', 'assistant-attachments-v1.js', 'assistant-ui-v1.js', 'assistant-v1.js']) {
  assert.ok(assistant.some((src) => src.endsWith('/' + name)), 'assistant 组缺少 ' + name);
}
assert.equal(indexOf(overtemperature, 'assistant-core-v1.js'), 0, '超温组必须先加载 assistant-core');
assert.ok(
  indexOf(overtemperature, 'assistant-core-v1.js') < indexOf(overtemperature, 'overtemperature-core-v1.js'),
  'overtemperature-core 加载时校验 assistant-core 存在，顺序不能反'
);
assert.ok(
  indexOf(overtemperature, 'overtemperature-evidence-v1.js') > indexOf(overtemperature, 'overtemperature-v1.js'),
  'evidence 依赖 overtemperature 的公开 API，必须后加载'
);
assert.equal(indexOf(overtemperature, 'overtemperature-import-v1.js'), -1, '普通超温视图不加载导入解析器');
assert.deepEqual(Lazy.GROUPS['overtemperature-import'], [
  'assets/app/assistant-core-v1.js',
  'assets/app/overtemperature-core-v1.js',
  'assets/app/overtemperature-import-v1.js'
], '导入组独立保留核心依赖顺序');

/* ---------------- 2. 主页面不再静态加载这些模块 ---------------- */
for (const src of [...assistant, ...overtemperature, ...Lazy.GROUPS['overtemperature-import']]) {
  if (src.endsWith('/assistant-core-v1.js')) continue; // 管段身份核心独立于可选 UI，允许首屏加载。
  assert.ok(!html.includes(`<script src="${src}"`), `主页面不应再静态加载 ${src}`);
}
assert.ok(html.includes('<script src="assets/app/lazy-v1.js" defer></script>'), '页面缺少懒加载器');
assert.ok(
  html.indexOf('assets/app/lazy-v1.js') < html.indexOf('assets/app/app-v7.9.js'),
  'lazy-v1 必须先于 app-v7.9 执行（主应用按需入口依赖 BTLazy）'
);
assert.match(html, /<link rel="preconnect" href="https:\/\/cdn\.sheetjs\.com">/, '缺少 SheetJS 预连接');
assert.match(html, /<link rel="preconnect" href="https:\/\/cdnjs\.cloudflare\.com">/, '缺少 pdf.js 预连接');

/* ---------------- 3. 接线点存在且按需 ---------------- */
const appJs = read('assets/app/app-v7.9.js');
assert.doesNotMatch(appJs, /window\.BTLazy\.idle\(\)/, '主应用初始化不应安排空闲网络预载');
assert.match(appJs, /BTLazy\.ensure\('overtemperature'\)/, '超温视图打开时必须按需加载模块');
assert.match(appJs, /BTLazy\.ensure\('xlsx'\)/, 'Excel 导入/导出必须先按需加载 SheetJS');
assert.match(appJs, /BTLazy\.onReady\('assistant'/, '总览可视化面板必须等助手模块就绪后自动重跑');

const docsJs = read('assets/app/assistant-docs-v1.js');
assert.match(docsJs, /BTLazy\.ensure\('pdf'\)/, 'PDF 识别必须按需加载 pdf.js');
const wiringJs = read('assets/app/assistant-v1.js');
assert.match(wiringJs, /BTLazy\.ensure\('xlsx'\)/, '助手 Excel 导入/导出必须按需加载 SheetJS');

/* ---------------- 4. 运行时行为（模拟 DOM 注入） ---------------- */
function createSandbox({ failures = [] } = {}) {
  const requested = [];
  const sandbox = { console, setTimeout, clearTimeout, Promise, requested };
  sandbox.window = sandbox;
  sandbox.document = {
    createElement() {
      return {
        set src(value) { this._src = value; },
        get src() { return this._src; },
        onload: null,
        onerror: null
      };
    },
    head: {
      appendChild(el) {
        requested.push(el._src);
        setTimeout(() => {
          if (failures.includes(el._src)) {
            if (typeof el.onerror === 'function') el.onerror(new Error('simulated network error'));
          } else if (typeof el.onload === 'function') {
            el.onload();
          }
        }, 0);
      }
    }
  };
  return { sandbox, requested };
}

{
  /* 按清单顺序串行加载；同组只加载一次 */
  const { sandbox, requested } = createSandbox();
  vm.runInNewContext(lazySource, sandbox);
  const LZ = sandbox.BTLazy;
  assert.ok(LZ, 'BTLazy 必须挂到 window');
  await LZ.ensure('assistant');
  assert.deepEqual([...requested], [...LZ.GROUPS.assistant], '必须按清单顺序串行注入脚本');
  await LZ.ensure('assistant');
  assert.equal(requested.length, LZ.GROUPS.assistant.length, '同一组重复 ensure 不能重复注入');
  assert.equal(LZ.isReady('assistant'), true);
}

{
  /* 跨组共享脚本（assistant-core）只注入一次 */
  const { sandbox, requested } = createSandbox();
  vm.runInNewContext(lazySource, sandbox);
  const LZ = sandbox.BTLazy;
  await LZ.ensure('overtemperature');
  assert.equal(
    requested.filter((src) => src.endsWith('assistant-core-v1.js')).length,
    1,
    'assistant-core 在组之间共享，只能加载一次'
  );
  await LZ.ensure('assistant');
  assert.equal(
    requested.filter((src) => src.endsWith('assistant-core-v1.js')).length,
    1,
    '已加载脚本不能重复注入'
  );
}

{
  /* 加载失败不缓存：下次调用必须重试 */
  const failing = [Lazy.XLSX_CDN];
  const { sandbox, requested } = createSandbox({ failures: failing });
  vm.runInNewContext(lazySource, sandbox);
  const LZ = sandbox.BTLazy;
  await assert.rejects(() => LZ.ensure('xlsx'), /模块加载失败/);
  assert.equal(LZ.isReady('xlsx'), false);
  await assert.rejects(() => LZ.ensure('xlsx'), /模块加载失败/);
  assert.equal(requested.length, 2, '失败后必须允许重试');
}

{
  /* 就绪回调：已就绪时走微任务，不丢回调 */
  const { sandbox } = createSandbox();
  vm.runInNewContext(lazySource, sandbox);
  const LZ = sandbox.BTLazy;
  await LZ.ensure('xlsx');
  let fired = 0;
  LZ.onReady('xlsx', () => { fired += 1; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fired, 1, '已就绪的组注册回调必须执行');
}

{
  /* 兼容 idle 调用不安排后台网络；显式导入复用普通组的核心。 */
  const { sandbox, requested } = createSandbox();
  let scheduled = 0;
  sandbox.requestIdleCallback = () => { scheduled += 1; };
  sandbox.setTimeout = () => { scheduled += 1; };
  vm.runInNewContext(lazySource, sandbox);
  const LZ = sandbox.BTLazy;
  LZ.idle(); LZ.idle();
  await Promise.resolve();
  assert.equal(scheduled, 0);
  assert.deepEqual(requested, []);
  await LZ.ensure('overtemperature');
  assert.ok(!requested.some(src => src.endsWith('overtemperature-import-v1.js')));
  const before = requested.length;
  await Promise.all([LZ.ensure('overtemperature-import'), LZ.ensure('overtemperature-import')]);
  assert.deepEqual(requested.slice(before), ['assets/app/overtemperature-import-v1.js']);
  assert.equal(LZ.isReady('overtemperature-import'), true);
}

{
  const { sandbox, requested } = createSandbox();
  vm.runInNewContext(lazySource, sandbox);
  await sandbox.BTLazy.ensure('overtemperature-import');
  assert.deepEqual(requested, [...sandbox.BTLazy.GROUPS['overtemperature-import']], '独立导入入口必须按顺序加载核心依赖');
}

{
  const { sandbox, requested } = createSandbox();
  sandbox.BTAssistantCore = { canonicalTubeCode() {} };
  vm.runInNewContext(lazySource, sandbox);
  await sandbox.BTLazy.ensure('overtemperature');
  assert.ok(!requested.some(src => src.endsWith('/assistant-core-v1.js')), '已就绪的管段身份核心不能重复注入');
}
{
  const { sandbox, requested } = createSandbox();
  sandbox.BTAssistantCore = {};
  vm.runInNewContext(lazySource, sandbox);
  await sandbox.BTLazy.ensure('overtemperature');
  assert.equal(requested[0], 'assets/app/assistant-core-v1.js', '不完整的核心对象不能当成已就绪');
}

console.log('ok - lazy loader ordering, import isolation, retry and network-free idle');
