// Shared read-only panel helpers. Loaded before hub.js / mobile.js.
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const nf = new Intl.NumberFormat('zh-CN');
  const fmt = value => nf.format(Number(value) || 0);

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = String(value);
  }

  // Accept epoch millis, numeric strings, and ISO strings; return '' when the
  // value cannot be understood so callers can simply test truthiness.
  function ago(ts) {
    const numeric = typeof ts === 'number' ? ts : Number(ts);
    const parsed = Number.isFinite(numeric) ? numeric : Date.parse(String(ts ?? ''));
    if (!Number.isFinite(parsed)) return '';
    const ms = Date.now() - parsed;
    if (ms < 60000) return '刚刚';
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} 天前`;
    return new Date(parsed).toLocaleDateString('zh-CN');
  }

  // Hub uses data-show; mobile uses a class. Keep one implementation and let
  // the page choose the presentation.
  function showError(message, id = 'errorBanner', mode = 'data') {
    const el = $(id);
    if (!el) return;
    el.textContent = String(message);
    if (mode === 'class') el.classList.add('show');
    else el.dataset.show = '1';
  }

  async function getJson(path) {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
    return response.json();
  }

  window.OmniWeb = { $, nf, fmt, setText, ago, showError, getJson };
})();
