/* 全息记忆 · 独立面板
 * 只读展示：列表 / 搜索 / 星图 / 规则。写入仍走 MCP 工具或 POST 路由。
 *
 * 星图页是独立的 WebGL 记忆星系（star-map.html），本面板用 iframe 接入，
 * 它直接读取 /omni-memory/graph 与 /omni-memory/node，不再维护第二套 2D 投影。
 */


const state = {
  tab: 'list',
  query: '',
  scope: 'all',
  audit: false,
};

const $ = id => document.getElementById(id);
const starFrame = $('starFrame');

function ensureStarFrame() {
  if (!starFrame || starFrame.getAttribute('src')) return;
  starFrame.src = starFrame.dataset.src || '/star-map.html?embed=1';
}

function setStarFrameVisible(visible) {
  // The iframe owns a WebGL render loop. Pausing it when the list/rules tab is
  // active keeps the panel from spending GPU time behind a hidden tab.
  starFrame?.contentWindow?.postMessage({ type: 'omni:visible', visible: Boolean(visible) }, '*');
}

starFrame?.addEventListener('load', () => setStarFrameVisible(state.tab === 'map'));

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(`${path} → ${response.status}`);
  return response.json();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ---------- 统计 ---------- */

async function loadStats() {
  try {
    const status = await api('/omni-memory/status');
    const stats = status.stats ?? {};
    const box = $('stats');
    box.replaceChildren();
    for (const [label, value] of [['笔记', stats.notes], ['事实', stats.facts], ['转录', stats.chunks]]) {
      const cell = el('span');
      cell.append(label + ' ');
      cell.append(el('b', null, String(value ?? 0)));
      box.append(cell);
    }
  } catch { /* 面板本身不因统计失败而空白 */ }
}

/* ---------- 列表与搜索 ---------- */

function rowFor(item) {
  const row = el('div', `row ${item.kind}`);
  row.append(el('div', 'kind', item.kind));
  const body = el('div', 'body');

  let text = String(item.text ?? '');
  if (item.kind === 'fact') text = `${item.subject} ${item.relation} ${item.object}`;
  body.append(el('div', 'text', text));

  const meta = el('div', 'meta');
  const bits = [];
  if (item.kind !== 'chunk' && item.id != null) bits.push(`#${item.id}`);
  if (item.scope) bits.push(item.scope === 'global' ? 'global' : String(item.scope).replace(/^proj:/, ''));
  if (item.source) bits.push(item.source);
  if (item.solutionStatus && item.solutionStatus !== 'unverified') bits.push(item.solutionStatus);
  if (item.contested) bits.push('contested');
  if (item.superseded_by) bits.push(`被 #${item.superseded_by} 替代`);
  if (item.valid_to) bits.push('已失效');
  for (const bit of bits) meta.append(el('span', null, bit));

  body.append(meta);
  row.append(body);
  return row;
}

async function loadList() {
  const box = $('list');
  box.replaceChildren(el('div', 'empty', '加载中…'));

  try {
    const params = new URLSearchParams({ limit: '60', scope: state.scope });
    if (state.audit) params.set('audit', '1');

    let items = [];
    if (state.query.trim()) {
      const search = new URLSearchParams({ q: state.query.trim(), limit: '40' });
      if (state.scope !== 'all') search.set('scope', state.scope);
      const result = await api(`/omni-memory/search?${search}`);
      items = result.hits ?? [];
    } else {
      const result = await api(`/omni-memory/list?${params}`);
      items = [...(result.notes ?? []), ...(result.facts ?? []), ...(result.chunks ?? [])];
    }

    box.replaceChildren();
    if (!items.length) {
      box.append(el('div', 'empty', state.query ? '没有匹配的记忆' : '还没有任何记忆'));
      return;
    }
    for (const item of items) box.append(rowFor(item));
  } catch (err) {
    box.replaceChildren(el('div', 'empty', `读取失败：${err.message}`));
  }
}


/* ---------- 规则 ---------- */

async function loadRules() {
  try {
    const text = await (await fetch('/rules')).text();
    $('rules').textContent = text;
  } catch (err) {
    $('rules').textContent = `读取失败：${err.message}`;
  }
}

/* ---------- 交互 ---------- */

function activateTab(name) {
  state.tab = name;
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('is-active', tab.dataset.tab === name);
  for (const panel of document.querySelectorAll('.panel')) panel.classList.toggle('is-active', panel.id === `panel-${name}`);

  if (name === 'map') {
    // The real memory star map is a self-contained WebGL page. It is loaded
    // only when the tab is first opened; the panel does not pay 665 KB + 470k
    // points just because the dashboard is sitting on the memory list.
    ensureStarFrame();
    setStarFrameVisible(true);
  } else {
    setStarFrameVisible(false);
  }
  if (name === 'rules') loadRules();
  if (name === 'list') loadList();
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab));
}

let timer = null;
$('q').addEventListener('input', event => {
  clearTimeout(timer);
  const value = event.target.value;
  timer = setTimeout(() => { state.query = value; loadList(); }, 220);
});

$('scope').addEventListener('change', event => { state.scope = event.target.value; loadList(); });
$('audit').addEventListener('change', event => { state.audit = event.target.checked; loadList(); });

// `/hub` search submits `?q=`; show the same query in the panel instead of
// dropping it on arrival. The input listener handles later edits.
const initialQuery = new URLSearchParams(location.search).get('q');
if (initialQuery) {
  $('q').value = initialQuery;
  state.query = initialQuery;
}

loadStats();
setInterval(() => { if (!document.hidden) loadStats(); }, 30_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadStats(); });

const requestedTab = new URLSearchParams(location.search).get('tab') ?? location.hash.replace('#', '');
activateTab(['list', 'map', 'rules'].includes(requestedTab) ? requestedTab : 'list');

// Debug handle: the panel is read-only and local, and this makes the star map
// testable from a headless browser without a test-only build.
window.__omni = { state, activateTab };
