// Mobile read-only memory browser. Uses the same local HTTP API as the desktop panel.
const $ = id => document.getElementById(id);
const nf = new Intl.NumberFormat('zh-CN');
const fmt = value => nf.format(Number(value) || 0);

let requestSeq = 0;
let searchTimer = null;

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = String(value);
}

function ago(ts) {
  const value = Number(ts);
  if (!Number.isFinite(value)) return '';
  const ms = Date.now() - value;
  if (ms < 60000) return '刚刚';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(value).toLocaleDateString('zh-CN');
}

function scopeLabel(scope) {
  return String(scope || 'global')
    .replace(/^proj:/, '')
    .split('#')[0]
    .trim() || 'global';
}

function showError(message) {
  const el = $('mError');
  el.textContent = message;
  el.classList.add('show');
}

function clearError() {
  const el = $('mError');
  el.textContent = '';
  el.classList.remove('show');
}

async function getJson(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
  return response.json();
}

function flattenList(payload) {
  const notes = Array.isArray(payload.notes) ? payload.notes : [];
  const facts = Array.isArray(payload.facts) ? payload.facts : [];
  const chunks = Array.isArray(payload.chunks) ? payload.chunks : [];
  return [...notes, ...facts, ...chunks]
    .filter(item => item && item.text && !item.deleted_at)
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
}

function makeCard(item) {
  const kind = item.kind || (item.subject ? 'fact' : 'note');
  const card = document.createElement('article');
  card.className = 'm-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-expanded', 'false');

  const head = document.createElement('div');
  head.className = 'm-card-head';

  const kindEl = document.createElement('span');
  kindEl.className = `m-card-kind ${kind}`;
  kindEl.textContent = kind === 'fact' ? '事实' : kind === 'chunk' ? '片段' : '笔记';

  const scopeEl = document.createElement('span');
  scopeEl.className = 'm-card-scope';
  scopeEl.textContent = scopeLabel(item.scope);

  const timeEl = document.createElement('span');
  timeEl.className = 'm-card-time';
  timeEl.textContent = ago(item.ts);

  head.append(kindEl, scopeEl, timeEl);

  const textEl = document.createElement('p');
  textEl.className = 'm-card-text';
  textEl.textContent = item.text;

  const foot = document.createElement('div');
  foot.className = 'm-card-foot';
  const sourceEl = document.createElement('span');
  sourceEl.textContent = item.source || (item.subject ? `${item.subject} · ${item.relation || '事实'}` : '本地记忆');
  sourceEl.title = sourceEl.textContent;
  const toggleEl = document.createElement('span');
  toggleEl.textContent = '展开';
  foot.append(sourceEl, toggleEl);

  const toggle = () => {
    const open = card.classList.toggle('open');
    card.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggleEl.textContent = open ? '收起' : '展开';
  };
  card.addEventListener('click', toggle);
  card.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    }
  });

  card.append(head, textEl, foot);
  return card;
}

function render(items) {
  const host = $('mList');
  host.textContent = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'm-empty';
    empty.textContent = '没有找到匹配的记忆。换个词试试，或者清空搜索看最近写入。';
    host.append(empty);
    return;
  }
  for (const item of items) host.append(makeCard(item));
}

async function loadStats() {
  try {
    const [overview, health] = await Promise.all([
      getJson('/omni-memory/overview?range=12w&scope=all'),
      getJson('/health'),
    ]);
    const stats = overview.stats || {};
    const score = Number((overview.health || {}).score ?? 0);
    setText('mMemory', fmt(Number(stats.notes || 0) + Number(stats.facts || 0)));
    setText('mHealth', score ? `${score}` : '—');
    setText('mTools', health.tools || '—');
    const online = $('online');
    online.classList.toggle('on', Boolean(health.ok));
    online.innerHTML = '<i></i>本地库在跑';
  } catch {
    setText('mMemory', '—');
    setText('mHealth', '—');
    setText('mTools', '—');
    const online = $('online');
    online.classList.remove('on');
    online.innerHTML = '<i></i>未连接';
  }
}

async function loadList(query = '') {
  const seq = ++requestSeq;
  const trimmed = query.trim();
  const hint = $('mHint');
  hint.textContent = trimmed ? `搜索「${trimmed}」 · 点开任意一条展开全文` : '最近写入 · 点开任意一条展开全文';
  try {
    const path = trimmed
      ? `/omni-memory/search?q=${encodeURIComponent(trimmed)}&limit=30&scope=all`
      : '/omni-memory/list?limit=30&scope=all';
    const payload = await getJson(path);
    if (seq !== requestSeq) return;
    clearError();
    const items = trimmed
      ? (Array.isArray(payload.hits) ? payload.hits : []).filter(hit => hit.text)
      : flattenList(payload);
    render(items);
  } catch (error) {
    if (seq !== requestSeq) return;
    showError(`读不到记忆库：${error.message}。确认本地 7788 服务在运行。`);
    render([]);
  }
}

function scheduleSearch() {
  clearTimeout(searchTimer);
  const query = $('mQuery').value;
  $('mClear').hidden = !query;
  searchTimer = setTimeout(() => loadList(query), 280);
}

function clearSearch() {
  $('mQuery').value = '';
  $('mClear').hidden = true;
  loadList('');
  $('mQuery').focus();
}

$('mQuery').addEventListener('input', scheduleSearch);
$('mQuery').addEventListener('search', () => loadList($('mQuery').value));
$('mClear').addEventListener('click', clearSearch);

loadStats();
loadList('');
