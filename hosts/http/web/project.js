(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { selected: null, root: '', scope: '' };

  function showError(message) {
    const el = $('errorBanner');
    if (!el) return;
    el.textContent = message;
    el.dataset.show = '1';
  }

  function clearError() {
    const el = $('errorBanner');
    if (el) el.dataset.show = '0';
  }

  async function getJson(path) {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
    return response.json();
  }

  function queryUrl(path, params) {
    const url = new URL(path, location.origin);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && String(value).trim() !== '') url.searchParams.set(key, String(value));
    }
    return url.pathname + '?' + url.searchParams.toString();
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = String(value ?? '—');
  }

  function readInputs() {
    state.root = $('rootInput').value.trim();
    state.scope = $('scopeInput').value.trim();
    if (state.root) localStorage.setItem('omni.project.root', state.root);
    if (state.scope) localStorage.setItem('omni.project.scope', state.scope);
  }

  function params(extra = {}) {
    return { root: state.root, scope: state.scope, ...extra };
  }

  function renderStatus(value) {
    setText('statusWord', value.ok ? '已索引' : '未索引');
    setText('statusFiles', value.counts?.files ?? 0);
    setText('statusModules', `${value.counts?.modules ?? 0} / ${value.counts?.symbols ?? 0}`);
    setText('statusApis', `${value.counts?.apis ?? 0} / ${value.counts?.edges ?? 0}`);
    setText('statusStale', `${value.stale ?? 0} / ${value.missing ?? 0}`);
    setText('statusRoot', value.root ? `${value.root}${value.indexedAt ? ` · 最近索引 ${new Date(value.indexedAt).toLocaleString('zh-CN')}` : ''}` : '还没有索引。输入项目目录，点“建立索引”。');
  }

  async function loadStatus() {
    try {
      const value = await getJson(queryUrl('/omni-memory/project/status', params()));
      renderStatus(value);
      if (value.root && !$('rootInput').value.trim()) {
        $('rootInput').value = value.root;
        state.root = value.root;
      }
    } catch (error) {
      showError(`状态读取失败：${error.message}`);
    }
  }

  function group(title) {
    const h = document.createElement('h3');
    h.className = 'result-group';
    h.textContent = title;
    return h;
  }

  function row(kind, name, sub, line, ref) {
    const el = document.createElement('div');
    el.className = 'result-row';
    el.tabIndex = 0;
    el.dataset.ref = ref;
    const k = document.createElement('span');
    k.className = 'result-kind';
    k.textContent = kind;
    const main = document.createElement('div');
    main.className = 'result-main';
    const n = document.createElement('div');
    n.className = 'result-name';
    n.textContent = name;
    const s = document.createElement('div');
    s.className = 'result-sub';
    s.textContent = sub || '';
    main.append(n, s);
    const l = document.createElement('span');
    l.className = 'result-line';
    l.textContent = line || '';
    el.append(k, main, l);
    el.addEventListener('click', () => openContext(ref, name));
    el.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openContext(ref, name); }
    });
    return el;
  }

  function renderResults(value) {
    const host = $('results');
    host.textContent = '';
    const groups = [];
    if (value.modules?.length) groups.push(['模块', value.modules.map(item => row('module', item.key, item.description, item.name, item.key))]);
    if (value.symbols?.length) groups.push(['符号', value.symbols.map(item => {
      const suffix = `${item.path}:${item.line}${item.sha ? ' · ' + String(item.sha).slice(0, 12) : ''}${item.stale ? ' · stale' : ''}`;
      return row(item.kind, item.qualifiedName, item.signature, suffix, item.sourceRef);
    })]);
    if (value.apis?.length) groups.push(['API', value.apis.map(item => {
      const suffix = `${item.path}:${item.line}${item.sha ? ' · ' + String(item.sha).slice(0, 12) : ''}${item.stale ? ' · stale' : ''}`;
      return row(item.method, item.route, item.summary || item.handler, suffix, item.sourceRef);
    })]);
    if (value.files?.length) groups.push(['文件', value.files.map(item => row('file', item.path, `${item.lang} · ${item.loc} loc`, item.stale ? 'stale' : '', item.path))]);
    if (!groups.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = `未命中：${value.query || ''}。先建立索引，或换模块/符号/路径/路由。`;
      host.append(p);
      return;
    }
    for (const [title, rows] of groups) {
      host.append(group(`${title} · ${rows.length}`));
      for (const item of rows) host.append(item);
    }
  }

  async function search() {
    clearError();
    readInputs();
    const query = $('queryInput').value.trim();
    if (!query) { showError('输入模块、函数、路径或路由。'); return; }
    try {
      const value = await getJson(queryUrl('/omni-memory/project/search', params({ q: query, limit: 20 })));
      renderResults(value);
      if (state.root) {
        const url = new URL(location.href);
        url.searchParams.set('root', state.root);
        url.searchParams.set('q', query);
        history.replaceState(null, '', url);
      }
    } catch (error) {
      showError(`查询失败：${error.message}`);
    }
  }

  async function openContext(ref, title) {
    if (!ref) return;
    clearError();
    state.selected = ref;
    $('detail').hidden = false;
    $('impactBox').hidden = true;
    $('detailTitle').textContent = title || ref;
    $('detailText').textContent = '读取中…';
    try {
      const value = await getJson(queryUrl('/omni-memory/project/context', params({ ref, budget: 1800 })));
      $('detailText').textContent = value.text || `未找到：${ref}`;
      setText('statusStale', `${value.stale ?? 0} / —`);
      if (state.root) {
        const url = new URL(location.href);
        url.searchParams.set('root', state.root);
        url.searchParams.set('ref', ref);
        history.replaceState(null, '', url);
      }
    } catch (error) {
      $('detailText').textContent = `读取失败：${error.message}`;
    }
  }

  async function impact() {
    if (!state.selected) { showError('先选择一个模块、符号、文件或路由。'); return; }
    const box = $('impactBox');
    box.hidden = false;
    box.textContent = '计算中…';
    try {
      const value = await getJson(queryUrl('/omni-memory/project/impact', params({ ref: state.selected, depth: 4 })));
      box.textContent = '';
      const h = document.createElement('h3');
      h.textContent = `影响面 · ${value.ok ? `${value.importers.length} 个引用方 · ${value.tests.length} 个测试` : '未找到'}`;
      box.append(h);
      const ul = document.createElement('ul');
      for (const item of [...(value.importers || []), ...(value.tests || []).map(test => `test: ${test.path}`)]) {
        const li = document.createElement('li');
        li.textContent = item;
        ul.append(li);
      }
      if (ul.children.length) box.append(ul);
      else {
        const p = document.createElement('p');
        p.textContent = '没有静态 import 或测试关联。';
        box.append(p);
      }
    } catch (error) {
      box.textContent = `读取失败：${error.message}`;
    }
  }

  async function sync() {
    clearError();
    readInputs();
    if (!state.root) { showError('填写项目目录后再建立索引。'); return; }
    const button = $('syncBtn');
    button.disabled = true;
    button.textContent = '索引中…';
    try {
      const response = await fetch('/omni-memory/project/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-omni-csrf': '1' },
        body: JSON.stringify({ root: state.root, scope: state.scope || undefined, ctags: true }),
      });
      const value = await response.json();
      if (!response.ok || !value.ok) throw new Error(value.error || `HTTP ${response.status}`);
      await loadStatus();
      await search();
      showStatusLine(`已索引 ${value.files} 个文件 · ${value.modules} 个模块 · ${value.symbols} 个符号 · ${value.apis} 个 API · ${value.durationMs}ms`);
    } catch (error) {
      showError(`索引失败：${error.message}`);
    } finally {
      button.disabled = false;
      button.textContent = '建立索引';
    }
  }

  function showStatusLine(text) {
    const el = $('statusRoot');
    if (el) el.textContent = text;
  }

  function init() {
    const url = new URL(location.href);
    $('rootInput').value = url.searchParams.get('root') || localStorage.getItem('omni.project.root') || '';
    $('scopeInput').value = url.searchParams.get('scope') || localStorage.getItem('omni.project.scope') || '';
    const query = url.searchParams.get('q') || '';
    if (query) $('queryInput').value = query;
    state.root = $('rootInput').value.trim();
    state.scope = $('scopeInput').value.trim();

    $('syncBtn').addEventListener('click', sync);
    $('statusBtn').addEventListener('click', loadStatus);
    $('searchBtn').addEventListener('click', search);
    $('queryInput').addEventListener('keydown', event => { if (event.key === 'Enter') search(); });
    $('impactBtn').addEventListener('click', impact);
    $('closeDetail').addEventListener('click', () => { $('detail').hidden = true; });

    loadStatus();
    if (query) search();
    const ref = url.searchParams.get('ref');
    if (ref) openContext(ref, ref);
  }

  init();
})();
