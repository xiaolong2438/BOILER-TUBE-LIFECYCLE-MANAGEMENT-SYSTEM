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
