/* 海马体 · 通用工具 */
(function (global) {
  'use strict';

  const DAY = 86400000;
  const U = {};
  U.DAY = DAY;

  U.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  U.lerp = (a, b, t) => a + (b - a) * t;
  U.sum = (arr) => arr.reduce((a, b) => a + b, 0);
  U.mean = (arr) => (arr.length ? U.sum(arr) / arr.length : 0);
  U.uid = (p) => (p || '') + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  U.escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  /* 时间显示 */
  U.fmtAgo = function (ms, now) {
    now = now || Date.now();
    if (!ms) return '—';
    const d = (now - ms) / DAY;
    if (d < 0.02) return '刚刚';
    if (d < 1) return Math.max(1, Math.round(d * 24)) + ' 小时前';
    if (d < 1.8) return '昨天';
    if (d < 45) return Math.round(d) + ' 天前';
    if (d < 365) return (d / 30).toFixed(d < 90 ? 1 : 0).replace('.0', '') + ' 个月前';
    return (d / 365).toFixed(1) + ' 年前';
  };

  U.fmtSpan = function (days) {
    if (days == null || !isFinite(days)) return '—';
    if (days < 1) return (days * 24).toFixed(0) + ' 小时';
    if (days < 60) return Math.round(days) + ' 天';
    if (days < 730) return (days / 30).toFixed(1).replace('.0', '') + ' 个月';
    return (days / 365).toFixed(1) + ' 年';
  };

  U.fmtPct = (v, digits) => (v * 100).toFixed(digits == null ? 0 : digits) + '%';

  U.fmtClock = function (now) {
    const d = new Date(now || Date.now());
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };

  U.daysAgo = (d) => Date.now() - d * DAY;

  /* 确定性伪随机：保证每次打开布局一致 */
  U.hashString = function (str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  U.mulberry32 = function (seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  U.rand = function (seedStr) {
    return U.mulberry32(U.hashString(String(seedStr)));
  };

  U.debounce = function (fn, wait) {
    let t = null;
    return function () {
      const args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(ctx, args), wait);
    };
  };

  /* 简单 DOM 构造 */
  U.el = function (tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  U.qs = (sel, root) => (root || document).querySelector(sel);
  U.qsa = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  global.HU = U;
})(typeof window !== 'undefined' ? window : globalThis);
