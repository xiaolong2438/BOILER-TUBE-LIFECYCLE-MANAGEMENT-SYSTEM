/* ============================================================
 * 模块懒加载器（首屏瘦身）
 * ------------------------------------------------------------
 * 首屏只保留核心模块；AI 助手、超温分析等按空闲预载或按需加载，
 * SheetJS（Excel）与 pdf.js（PDF 识别）两个 CDN 库推迟到首次使用时加载。
 *
 * 挂载：window.BTLazy
 *   BTLazy.ensure(group)      按组加载，返回 Promise（同一组只加载一次，失败可重试）
 *   BTLazy.idle()             空闲时后台预载 assistant / overtemperature 两组
 *   BTLazy.onReady(group, fn) 组就绪后回调；已就绪则下一个微任务立即回调
 *   BTLazy.loadScript(src)    注入并缓存单个脚本
 *   BTLazy.notify(message)    统一错误提示（有 showToast 用 toast，否则打日志）
 *
 * 顺序约束（勿调整）：
 *   - overtemperature-core-v1.js 加载时校验 BTAssistantCore 已存在，会抛错，
 *     因此 assistant-core 必须排在其前面；
 *   - assistant-v1.js 是接线层，最后加载以完成助手挂载；
 *   - 同组内脚本严格按数组顺序串行加载。
 * ============================================================ */
(function (global) {
  'use strict';

  const XLSX_CDN = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
  const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';

  const GROUPS = {
    assistant: [
      'assets/app/assistant-core-v1.js',
      'assets/app/assistant-analysis-v1.js',
      'assets/app/assistant-docs-v1.js',
      'assets/app/assistant-attachments-v1.js',
      'assets/app/assistant-ui-v1.js',
      'assets/app/assistant-v1.js'
    ],
    overtemperature: [
      'assets/app/assistant-core-v1.js',
      'assets/app/overtemperature-core-v1.js',
      'assets/app/overtemperature-v1.js',
      'assets/app/overtemperature-evidence-v1.js'
    ],
    xlsx: [XLSX_CDN],
    pdf: [PDFJS_CDN]
  };

  const scriptPromises = new Map();   // src -> Promise
  const groupPromises = new Map();    // group -> Promise
  const finishedGroups = new Set();
  const readyCallbacks = new Map();   // group -> [fn]
  let idleScheduled = false;

  function notify(message) {
    if (typeof global.showToast === 'function') {
      global.showToast(message, 'error', 6000);
      return;
    }
    console.warn('[懒加载] ' + message);
  }

  function loadScript(src) {
    const cached = scriptPromises.get(src);
    if (cached) return cached;
    const promise = new Promise((resolve, reject) => {
      const el = global.document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = () => resolve(src);
      el.onerror = () => {
        scriptPromises.delete(src); // 网络恢复后允许重试
        reject(new Error('模块加载失败：' + src));
      };
      (global.document.head || global.document.body || global.document.documentElement).appendChild(el);
    });
    scriptPromises.set(src, promise);
    return promise;
  }

  function loadInOrder(list) {
    return list.reduce((chain, src) => chain.then(() => loadScript(src)), Promise.resolve());
  }

  function fireReady(group) {
    finishedGroups.add(group);
    const callbacks = readyCallbacks.get(group);
    if (!callbacks) return;
    readyCallbacks.delete(group);
    callbacks.forEach((fn) => {
      Promise.resolve().then(fn).catch((err) => console.warn('[懒加载] 就绪回调失败：', err));
    });
  }

  function ensure(group) {
    const list = GROUPS[group];
    if (!list) return Promise.reject(new Error('未知模块组：' + group));
    const cached = groupPromises.get(group);
    if (cached) return cached;
    const promise = loadInOrder(list).then(() => {
      fireReady(group);
      return group;
    }, (err) => {
      groupPromises.delete(group); // 失败不缓存，调用方可重试
      throw err;
    });
    groupPromises.set(group, promise);
    return promise;
  }

  function onReady(group, fn) {
    if (typeof fn !== 'function') return;
    if (finishedGroups.has(group)) {
      Promise.resolve().then(fn).catch((err) => console.warn('[懒加载] 就绪回调失败：', err));
      return;
    }
    if (!readyCallbacks.has(group)) readyCallbacks.set(group, []);
    readyCallbacks.get(group).push(fn);
  }

  function isReady(group) {
    return finishedGroups.has(group);
  }

  /* 空闲时后台预载：首屏渲染完成后再拉取，用户点开时通常已就绪。 */
  function idle() {
    if (idleScheduled) return;
    idleScheduled = true;
    const run = () => {
      // 先助手后超温：超温组依赖 assistant-core，串行避免重复并发拉取
      ensure('assistant')
        .then(() => ensure('overtemperature'))
        .catch((err) => console.warn('[懒加载] 后台预载失败：', err.message));
    };
    if (typeof global.requestIdleCallback === 'function') {
      global.requestIdleCallback(run, { timeout: 2000 });
    } else {
      global.setTimeout(run, 2000);
    }
  }

  global.BTLazy = {
    GROUPS: GROUPS,
    XLSX_CDN: XLSX_CDN,
    PDFJS_CDN: PDFJS_CDN,
    loadScript: loadScript,
    ensure: ensure,
    onReady: onReady,
    isReady: isReady,
    idle: idle,
    notify: notify
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.BTLazy;
})(typeof window !== 'undefined' ? window : globalThis);
