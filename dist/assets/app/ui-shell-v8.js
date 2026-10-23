/* Keep the application-level top bar distinct from per-view headings. */
(function () {
  'use strict';

  const APP_TITLE = '锅炉炉管全生命周期管理系统';

  function keepApplicationTitle() {
    const title = document.getElementById('topbar-title');
    if (title && title.textContent !== APP_TITLE) title.textContent = APP_TITLE;
  }

  const originalSwitchView = window.switchView;
  if (typeof originalSwitchView === 'function') {
    window.switchView = function (...args) {
      const result = originalSwitchView.apply(this, args);
      keepApplicationTitle();
      return result;
    };
  }

  keepApplicationTitle();
  const title = document.getElementById('topbar-title');
  if (title) {
    new MutationObserver(keepApplicationTitle).observe(title, {
      childList: true,
      characterData: true,
      subtree: true
    });
  }
})();

/* 侧边栏折叠（桌面端）：logo 行按钮收起，顶栏汉堡恢复，状态持久化。 */
(function () {
  'use strict';

  const STORAGE_KEY = 'blcms-rail-collapsed';
  const desktopQuery = window.matchMedia('(min-width: 961px)');

  function syncCollapseButton() {
    const button = document.getElementById('rail-collapse');
    if (!button) return;
    const collapsed = document.body.classList.contains('rail-collapsed');
    button.setAttribute('aria-expanded', String(!collapsed));
    button.title = collapsed ? '展开侧边栏' : '收起侧边栏';
    button.setAttribute('aria-label', button.title);
  }

  window.toggleRailCollapse = function () {
    if (!desktopQuery.matches) return; // 窄屏走既有抽屉逻辑，不折叠
    const collapsed = !document.body.classList.contains('rail-collapsed');
    document.body.classList.toggle('rail-collapsed', collapsed);
    try { localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0'); } catch (e) { /* 隐私模式下仅本次会话生效 */ }
    syncCollapseButton();
  };

  try {
    if (desktopQuery.matches && localStorage.getItem(STORAGE_KEY) === '1') {
      document.body.classList.add('rail-collapsed');
    }
  } catch (e) { /* localStorage 不可用时忽略 */ }

  syncCollapseButton();

  // 切到窄屏时清掉折叠态，交还抽屉逻辑
  desktopQuery.addEventListener('change', (event) => {
    if (!event.matches) document.body.classList.remove('rail-collapsed');
  });
})();
