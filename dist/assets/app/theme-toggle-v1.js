/* 主题切换：浅色（默认）/ 深色，偏好持久化到 localStorage('blcms-theme')。 */
(function () {
  'use strict';

  var STORAGE_KEY = 'blcms-theme';
  var THEME_META = { light: '#eef3f6', dark: '#02050c' };
  var root = document.documentElement;

  function normalize(theme) {
    return theme === 'dark' ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    theme = normalize(theme);
    root.dataset.theme = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_META[theme]);

    var button = document.getElementById('theme-toggle');
    if (button) {
      var sunIcon = button.querySelector('.theme-ico-sun');
      var moonIcon = button.querySelector('.theme-ico-moon');
      if (sunIcon) sunIcon.style.display = theme === 'dark' ? 'block' : 'none';
      if (moonIcon) moonIcon.style.display = theme === 'dark' ? 'none' : 'block';
    }
  }

  function currentTheme() {
    return normalize(root.dataset.theme);
  }

  window.toggleTheme = function () {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* 隐私模式下仅本次会话生效 */ }
    applyTheme(next);
  };

  applyTheme(currentTheme());
})();
