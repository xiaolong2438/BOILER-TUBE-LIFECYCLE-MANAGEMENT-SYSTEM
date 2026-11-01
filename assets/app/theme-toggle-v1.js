/* 主题切换：浅色（默认）/ 深色 / 液态玻璃，偏好持久化到 localStorage('blcms-theme')。 */
(function () {
  'use strict';

  var STORAGE_KEY = 'blcms-theme';
  var THEMES = ['light', 'dark', 'glass'];
  var THEME_META = { light: '#eef3f6', dark: '#02050c', glass: '#071426' };
  var THEME_LABEL = { light: '浅色', dark: '深色', glass: '液态玻璃' };
  var root = document.documentElement;

  function normalize(theme) {
    return THEMES.indexOf(theme) !== -1 ? theme : 'light';
  }

  function applyTheme(theme) {
    theme = normalize(theme);
    root.dataset.theme = theme;
    root.style.colorScheme = theme === 'light' ? 'light' : 'dark';

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_META[theme]);

    var button = document.getElementById('theme-toggle');
    if (button) {
      var icons = {
        light: button.querySelector('.theme-ico-moon'),
        dark: button.querySelector('.theme-ico-sun'),
        glass: button.querySelector('.theme-ico-glass')
      };
      Object.keys(icons).forEach(function (name) {
        if (icons[name]) icons[name].style.display = name === theme ? 'block' : 'none';
      });
      button.setAttribute('aria-label', '切换主题，当前为' + THEME_LABEL[theme]);
      button.setAttribute('title', '当前：' + THEME_LABEL[theme] + ' · 点击切换');
    }

    var options = document.querySelectorAll('[data-theme-option]');
    Array.prototype.forEach.call(options, function (option) {
      var selected = option.getAttribute('data-theme-option') === theme;
      option.setAttribute('aria-pressed', selected ? 'true' : 'false');
      option.classList.toggle('active', selected);
    });
  }

  function currentTheme() {
    return normalize(root.dataset.theme);
  }

  function closeThemeMenu(returnFocus) {
    var menu = document.getElementById('theme-menu');
    var button = document.getElementById('theme-toggle');
    if (!menu || !button) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (returnFocus) button.focus();
  }

  window.setTheme = function (theme) {
    var next = normalize(theme);
    try { localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* 隐私模式下仅本次会话生效 */ }
    applyTheme(next);
    closeThemeMenu(false);
    try {
      document.dispatchEvent(new CustomEvent('blcms:themechange', { detail: { theme: next } }));
    } catch (e) { /* 旧浏览器无需主题事件 */ }
    return next;
  };

  /* 保留原接口：依次切换浅色 → 深色 → 液态玻璃。 */
  window.toggleTheme = function () {
    var next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
    return window.setTheme(next);
  };

  window.toggleThemeMenu = function (forceOpen) {
    var menu = document.getElementById('theme-menu');
    var button = document.getElementById('theme-toggle');
    if (!menu || !button) return;
    var shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : menu.hidden;
    if (!shouldOpen) {
      closeThemeMenu(false);
      return;
    }
    applyTheme(currentTheme());
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    var selected = menu.querySelector('[data-theme-option][aria-pressed="true"]');
    if (selected) selected.focus();
  };

  document.addEventListener('click', function (event) {
    var switcher = document.getElementById('theme-switcher');
    if (switcher && !switcher.contains(event.target)) closeThemeMenu(false);
  });

  document.addEventListener('keydown', function (event) {
    var menu = document.getElementById('theme-menu');
    if (!menu || menu.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeThemeMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      closeThemeMenu(false);
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].indexOf(event.key) === -1) return;
    var options = Array.prototype.slice.call(menu.querySelectorAll('[data-theme-option]'));
    if (!options.length) return;
    event.preventDefault();
    var index = options.indexOf(document.activeElement);
    if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = options.length - 1;
    else if (event.key === 'ArrowDown') index = (index + 1 + options.length) % options.length;
    else index = (index - 1 + options.length) % options.length;
    options[index].focus();
  });

  applyTheme(currentTheme());
})();
