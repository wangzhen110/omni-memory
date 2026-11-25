// Hub landing page — reads the same local overview/health payloads as the dashboard.
const { $, fmt, setText, ago, showError, getJson } = window.OmniWeb;

function asOfLabel(value) {
  const relative = ago(value);
  if (!relative || relative === '刚刚') return '实时读取';
  return `截至 ${relative}`;
}

function projectLabel(project) {
  return String(project || '本地库')
    .replace(/^proj:/, '')
    .split('#')[0]
    .trim() || '本地库';
}

function renderRecent(activity) {
  const host = $('recentList');
  host.textContent = '';
  const rows = Array.isArray(activity) ? activity.slice(0, 4) : [];
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '还没有最近归档。打开一次客户端的记忆写入，这里就会出现。';
    host.append(empty);
    return;
  }
  for (const row of rows) {
    const item = document.createElement('div');
    item.className = 'hub-recent-item';

    const time = document.createElement('span');
    time.className = 'hub-recent-time';
    time.textContent = ago(row.ts) || '—';

    const text = document.createElement('span');
    text.className = 'hub-recent-text';
    text.textContent = row.text || '(空)';
    text.title = row.text || '';

    const type = document.createElement('span');
    type.className = `hub-recent-type ${row.kind || ''}`;
    type.textContent = row.kind === 'fact' ? '事实' : row.kind === 'candidate' ? '候选' : '笔记';

    item.append(time, text, type);
    host.append(item);
  }
}

async function load() {
  const [overviewResult, healthResult] = await Promise.allSettled([
    getJson('/omni-memory/overview?range=12w&scope=all'),
    getJson('/health'),
  ]);

  const overview = overviewResult.status === 'fulfilled' ? overviewResult.value : null;
  const health = healthResult.status === 'fulfilled' ? healthResult.value : null;

  if (!overview && !health) {
    showError('读不到本地记忆库。确认 7788 服务在运行，然后刷新这一页。');
    setText('dbPill', '本地库 · 未连接');
    setText('statusWord', '未连接');
    return;
  }

  if (!overview) {
    showError('能连上服务，但概览接口没有返回数据；下面的版本和工具信息仍来自 /health。');
  }

  const stats = overview?.stats || {};
  const healthData = overview?.health || {};
  const version = overview?.version || health?.version || '—';
  const total = Number(stats.notes || 0) + Number(stats.facts || 0);
  const score = Number(healthData.score ?? 0);
  const pending = Number(stats.pendingBreakdown?.total ?? stats.pending ?? 0);

  setText('versionPill', `v${version}`);
  setText('dbPill', health ? '本地库 · 运行中' : '本地库 · 已连接');
  setText('asOfPill', asOfLabel(overview?.asOf));
  setText('statusWord', health?.ok ? '运行中' : '只读');
  setText('statusVersion', `v${version}`);
  setText('statusTools', health?.tools ? `${health.tools} 个` : '—');
  setText('statusProject', projectLabel(health?.project));
  setText('statusScore', `${score}/100`);

  setText('memoryTotal', fmt(total));
  setText('memorySplit', `笔记 ${fmt(stats.notes)} · 事实 ${fmt(stats.facts)}`);
  setText('memoryHealth', `健康 ${score}/100`);
  setText('entityCount', fmt(stats.entities));
  setText('relationCount', `${fmt(stats.relations)} 条关系`);
  setText('projectCount', fmt(stats.projects));
  setText('projectSplit', `全局 ${fmt(stats.globalNotes)} · 项目 ${fmt(stats.projectNotes)}`);
  setText('toolCount', health?.tools ? fmt(health.tools) : '—');
  setText('healthScore', score || '—');
  setText('pendingCount', `${fmt(pending)} 待处理`);
  setText('engineState', health?.ok ? '本地引擎在跑' : '本地引擎待启动');
  setText('footerSource', `本地记忆库 · v${version}`);

  renderRecent(overview?.activity || []);
}

load().catch(error => {
  showError(`页面读取失败：${error.message}`);
  setText('dbPill', '本地库 · 未连接');
  setText('statusWord', '未连接');
});
