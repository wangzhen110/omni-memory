/* global fetch, URLSearchParams */
const NS = 'http://www.w3.org/2000/svg';
const API = '/omni-memory/overview';
const DAY = 24 * 60 * 60 * 1000;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const fmt = n => new Intl.NumberFormat('zh-CN').format(Number(n) || 0);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
));
const scopeLabel = { all: '全部层级', global: '全局库', project: '项目层' };
const rangeLabel = { '12w': '近 12 周', '6w': '近 6 周', '4w': '近 4 周' };
const state = { range: '12w', scope: 'all', data: null, loading: false };

function svgEl(tag, attrs = {}, text = '') {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  if (text !== '') el.textContent = text;
  return el;
}

function dateLabel(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function shortDate(value) {
  if (!value) return '—';
  const d = value instanceof Date ? value
    : typeof value === 'number' ? new Date(value)
      : new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function relative(ts) {
  if (!ts) return '—';
  const diff = Math.max(0, Date.now() - Number(ts));
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return dateLabel(ts).split(' ')[0];
}

function visibleProjects(data) {
  return (data.projects || []).filter(project => {
    if (state.scope === 'all') return true;
    if (state.scope === 'global') return project.scope === 'global';
    return project.scope !== 'global';
  });
}

function toast(html) {
  const el = $('#toast');
  el.innerHTML = html;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 2800);
}

document.addEventListener('click', event => {
  const el = event.target.closest('[data-toast]');
  if (!el) return;
  event.preventDefault();
  toast(el.dataset.toast);
});

async function load() {
  if (state.loading) return;
  state.loading = true;
  const banner = $('#errorBanner');
  banner.style.display = 'none';
  $('#sourcePill').textContent = '真实库 · 读取中';
  $('#snapshotPill').textContent = '读取中';
  try {
    const query = new URLSearchParams({ range: state.range, scope: state.scope });
    const response = await fetch(`${API}?${query}`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    state.data = body;
    renderAll(body);
  } catch (error) {
    banner.style.display = 'block';
    banner.textContent = `读取失败：${error.message}。请确认本地 7788 服务在运行，并通过 http://127.0.0.1:7788 打开页面。`;
    $('#sourcePill').textContent = '真实库 · 连接失败';
    $('#snapshotPill').textContent = '离线';
  } finally {
    state.loading = false;
  }
}

function renderAll(data) {
  const asOf = new Date(data.asOf);
  $('#asOf').textContent = `${asOf.getFullYear()}.${String(asOf.getMonth() + 1).padStart(2, '0')}.${String(asOf.getDate()).padStart(2, '0')} · 快照 ${String(asOf.getHours()).padStart(2, '0')}:${String(asOf.getMinutes()).padStart(2, '0')}`;
  $('#sourcePill').textContent = `真实库 · ${scopeLabel[data.scope] || data.scope}`;
  $('#versionPill').textContent = `v${data.version || '—'}`;
  $('#snapshotPill').textContent = `快照 ${String(asOf.getHours()).padStart(2, '0')}:${String(asOf.getMinutes()).padStart(2, '0')}`;
  $('#footerSource').textContent = `本地记忆库 · ${scopeLabel[data.scope] || data.scope}`;
  renderHero(data);
  renderKpis(data);
  renderHealth(data);
  renderProjects(data);
  renderHeatmap(data);
  renderPersona(data);
  renderBand(data);
  renderGraph(data);
  renderActivity(data);
  drawGrowth();
}

function renderHero(data) {
  const s = data.stats;
  const h = data.health;
  const series = data.series;
  const windowed = series.notes.reduce((a, b, i) => a + b + series.facts[i], 0);
  const week = series.labels.length - 1;
  const thisWeek = series.notes[week] + series.facts[week];
  const contested = s.contested;
  const rangeName = rangeLabel[data.range] || data.range;
  const totalMemory = s.notes + s.facts;

  if (s.notes === 0 && s.facts === 0) {
    $('#headline').innerHTML = '记忆库还是空的，<br>先写下第一条<em>可复用的经验</em>。';
  } else if (s.notes === 0) {
    $('#headline').innerHTML = `还没有笔记，<br>但有 <em>${fmt(s.facts)} 条事实</em> 可以直接调用。`;
  } else if (s.facts === 0) {
    $('#headline').innerHTML = `你记住了 ${fmt(s.notes)} 条活跃记忆，<br>其中 <em>${fmt(h.valid)} 条</em> 可以直接调用。`;
  } else {
    $('#headline').innerHTML = `你记住了 ${fmt(s.notes)} 条活跃记忆，<br>连同 ${fmt(s.facts)} 条事实，合计 <em>${fmt(h.valid)} 条</em> 可以直接调用。`;
  }
  $('#lede').textContent = s.notes === 0 && s.facts === 0
    ? '窗口内还没有写入。可以从记忆页新增一条笔记，或让 Agent 写入一条项目结论。'
    : `全局库 ${fmt(s.globalNotes)} 条笔记，项目层 ${fmt(s.projectNotes)} 条；另有 ${fmt(s.facts)} 条事实。${rangeName}写入 ${fmt(windowed)} 条记忆，最近一次是 ${relative(data.activity[0]?.ts)}。${contested ? `另有 ${fmt(contested)} 条有争议，值得先看一眼。` : '目前没有明显冲突。'}`;

  $('#signalGrowth').textContent = `+${fmt(windowed)}`;
  $('#signalGrowthNote').textContent = `${rangeName}新增 · 本周 ${fmt(thisWeek)} 条`;
  $('#signalPending').textContent = fmt(s.pending);
  $('#signalPendingNote').textContent = `${fmt(contested)} 争议 · ${fmt(s.pendingCandidates)} 候选 · ${fmt(h.invalid)} 失效`;
  $('#signalRecall').textContent = s.usefulRate == null ? '暂无' : `${s.usefulRate}%`;
  $('#signalRecallNote').textContent = s.recallTotal
    ? `${fmt(s.recallTotal)} 次召回 · ${fmt(s.usefulCount)} 次有用`
    : '还没有召回反馈，先不计算比例';
  $('#headline').dataset.memory = fmt(totalMemory);
}

function renderKpis(data) {
  const s = data.stats;
  const visible = visibleProjects(data);
  const activeProjects = visible.filter(project => project.scope !== 'global' && project.notes + project.facts > 0).length;
  const transcriptProjects = visible.filter(project => project.scope !== 'global' && project.notes + project.facts === 0 && project.chunks > 0).length;
  $('#kpiNotes').textContent = fmt(s.notes);
  const notesNote = $('#kpiNotesNote');
  notesNote.textContent = `全局 ${fmt(s.globalNotes)} · 项目 ${fmt(s.projectNotes)} · 事实 ${fmt(s.facts)}`;
  notesNote.className = `kpi-note${s.notes ? ' positive' : ''}`;

  $('#kpiProjects').textContent = fmt(activeProjects);
  $('#kpiProjectsNote').textContent = state.scope === 'global'
    ? '当前只看全局层'
    : activeProjects
      ? `${fmt(activeProjects)} 个有记忆${transcriptProjects ? ` · ${fmt(transcriptProjects)} 个仅转写` : ''}`
      : transcriptProjects ? `0 个有记忆 · ${fmt(transcriptProjects)} 个仅转写` : '项目层还没有写入';

  $('#kpiPending').textContent = fmt(s.pending);
  const pendingNote = $('#kpiPendingNote');
  pendingNote.textContent = `${fmt(s.contested)} 争议 · ${fmt(s.pendingCandidates)} 候选 · ${fmt(s.expiredFacts)} 失效`;
  pendingNote.className = `kpi-note${s.pending ? ' warn' : ' positive'}`;

  $('#kpiUseful').textContent = s.usefulRate == null ? '暂无' : `${s.usefulRate}%`;
  const usefulNote = $('#kpiUsefulNote');
  usefulNote.textContent = s.recallTotal
    ? `${fmt(s.recallTotal)} 次召回 · ${fmt(s.usefulCount)} 次有用`
    : '召回 0 次 · 还没有反馈';
  usefulNote.className = `kpi-note${s.usefulRate != null ? ' positive' : ''}`;

  $('#kpiLinks').textContent = fmt(s.connections);
  $('#kpiLinksNote').textContent = `${fmt(s.entities)} 个实体 · ${fmt(s.relations)} 条关系`;
}

function renderHealth(data) {
  const h = data.health;
  const s = data.stats;
  const total = Math.max(0, h.total);
  const pct = n => total ? n / total * 100 : 0;
  const valid = pct(h.valid);
  const contested = valid + pct(h.contested);
  const unverified = contested + pct(h.unverified);
  $('#healthRing').style.background = total
    ? `conic-gradient(var(--mint) 0 ${valid}%, var(--rose) ${valid}% ${contested}%, var(--gold) ${contested}% ${unverified}%, #536272 ${unverified}% 100%)`
    : '#536272';
  $('#healthScore').innerHTML = `${fmt(h.score)}<small>/100</small>`;
  $('#healthValid').textContent = fmt(h.valid);
  $('#healthContested').textContent = fmt(h.contested);
  $('#healthUnverified').textContent = fmt(h.unverified);
  $('#healthInvalid').textContent = fmt(h.invalid);
  $('#barValid').style.width = `${valid}%`;
  $('#barContested').style.width = `${pct(h.contested)}%`;
  $('#barUnverified').style.width = `${pct(h.unverified)}%`;
  $('#barInvalid').style.width = `${pct(h.invalid)}%`;

  const issues = [
    ['rose', '有争议记忆', h.contested],
    ['', '候选待确认', s.pendingCandidates],
    ['', '已失效 / 过期', h.invalid],
    ['cyan', '存在但未验证', h.unverified],
  ];
  $('#issues').innerHTML = issues.map(([tone, label, count]) => `
    <div class="issue"><span class="issue-dot ${tone}"></span>${label}<b>${fmt(count)}</b></div>
  `).join('');
  $('#healthLink').dataset.toast = `待处理队列：${fmt(h.contested)} 条有争议、${fmt(s.pendingCandidates)} 条候选、${fmt(h.invalid)} 条已失效、${fmt(h.unverified)} 条未验证。`;
}

function renderProjects(data) {
  const rows = visibleProjects(data);
  if (!rows.length) {
    $('#projectBars').innerHTML = `<div class="empty">${state.scope === 'global' ? '全局层还没有写入。' : '还没有项目层数据。'}</div>`;
    return;
  }
  const globalRow = rows.find(project => project.scope === 'global');
  const projectRows = rows.filter(project => project.scope !== 'global');
  const orderedRows = globalRow ? [globalRow, ...projectRows] : projectRows;
  const memoryOf = project => project.notes + project.facts;
  const projectMax = Math.max(...projectRows.map(memoryOf), 1);
  const globalCount = globalRow ? memoryOf(globalRow) : 0;
  const projectCount = projectRows.reduce((sum, project) => sum + memoryOf(project), 0);
  const memoryTotal = globalCount + projectCount;
  const chunksTotal = rows.reduce((sum, project) => sum + (project.chunks || 0), 0);
  const summary = globalRow
    ? `全局 <b>${fmt(globalCount)}</b> · 项目层 <b>${fmt(projectCount)}</b>${memoryTotal ? `（${(projectCount / memoryTotal * 100).toFixed(1)}%）` : ''}${chunksTotal ? ` · 另有 ${fmt(chunksTotal)} 个会话块不计入` : ''}`
    : `项目层 <b>${fmt(projectCount)}</b>${chunksTotal ? ` · 另有 ${fmt(chunksTotal)} 个会话块` : ''}`;
  $('#projectBars').innerHTML = `<div class="project-summary">${summary}</div>` + orderedRows.map(project => {
    const count = memoryOf(project);
    const status = project.status || (count ? 'quiet' : project.chunks ? 'transcript' : 'quiet');
    const isGlobal = project.scope === 'global';
    const width = isGlobal ? 100 : Math.max(count ? 1.5 : 0, count / projectMax * 100);
    const statusLabel = isGlobal ? '全局库' : status === 'transcript' ? '仅转写'
      : status === 'active' ? '近期活跃' : status === 'watch' ? '需关注' : '安静';
    return `
      <div class="project-row ${isGlobal ? 'global' : status}" title="${esc(project.scope)}">
        <div class="project-name">${esc(project.label || project.scope)}</div>
        <div class="project-track"><div class="project-bar" style="width:${width}%"></div></div>
        <div class="project-count">${fmt(count)}</div>
        <div class="project-meta">
          <span class="${isGlobal ? '' : status}">${statusLabel}</span>
          <span>笔记 ${fmt(project.notes)} · 事实 ${fmt(project.facts)}${project.chunks ? ` · 转写 ${fmt(project.chunks)}` : ''}</span>
          <span>最近 ${relative(project.memoryLastAt || project.lastAt)}</span>
        </div>
      </div>
    `;
  }).join('');
}

function renderHeatmap(data) {
  const daily = data.daily || [];
  const grid = $('#heatGrid');
  grid.replaceChildren();
  if (!daily.length) {
    grid.innerHTML = '<div class="empty">还没有日历数据。</div>';
    return;
  }
  const first = new Date(`${daily[0].date}T00:00:00`);
  const offset = first.getDay();
  for (let i = 0; i < offset; i += 1) {
    const blank = document.createElement('div');
    blank.className = 'heat-cell blank';
    grid.append(blank);
  }
  const max = Math.max(...daily.map(item => item.count), 1);
  let peak = daily[0];
  for (const item of daily) {
    const level = item.count === 0 ? 0
      : item.count >= max * .75 ? 4
        : item.count >= max * .35 ? 3
          : item.count >= max * .10 ? 2 : 1;
    const cell = document.createElement('div');
    cell.className = 'heat-cell';
    cell.dataset.level = level;
    cell.title = `${item.date.slice(5).replace('-', '/')} · ${fmt(item.count)} 条`;
    grid.append(cell);
    if (item.count > peak.count) peak = item;
  }
  const emptyDays = daily.filter(item => item.count === 0).length;
  $('#heatPeak').textContent = peak.count ? `峰值：${shortDate(peak.date)} · ${fmt(peak.count)} 条` : '峰值：暂无写入';
  $('#heatEmpty').textContent = `空白天数：${emptyDays} / ${daily.length}`;
  let streak = 0;
  for (let i = daily.length - 1; i >= 0; i -= 1) {
    if (!daily[i].count) break;
    streak += 1;
  }
  $('#heatPill').textContent = streak ? `连续 ${streak} 天` : '暂无连续写入';
}

function renderPersona(data) {
  const profile = data.profile || {};
  const persona = profile.persona || {};
  const keys = Object.keys(persona);
  const projects = visibleProjects(data).filter(project => project.scope !== 'global' && project.notes + project.facts > 0);
  let html = '';
  if (keys.length) {
    html += `<div class="persona-block"><div class="persona-label">显式画像</div><div class="chips">${keys.map(key => `<span class="chip gold" title="${esc(key)}">${esc(key)} · ${esc(persona[key])}</span>`).join('')}</div></div>`;
  } else {
    const signals = profile.signals || [];
    html += `<div class="persona-block"><div class="persona-label">画像状态</div><div class="chips"><span class="chip gold">画像表为空</span><span class="chip">${fmt(signals.length)} 条偏好信号</span></div><p class="persona-text">没有显式画像。这里只展示原始偏好笔记，不生成推断结论。</p></div>`;
    if (signals.length) {
      html += `<div class="persona-block"><div class="persona-label">偏好信号（可回原文）</div>${signals.map(signal => `
        <div class="persona-signal">
          <p title="${esc(signal.text)}">${esc(signal.text)}</p>
          <div class="evidence"><span>${esc(signal.source || 'global')} · ${dateLabel(signal.ts)}</span><b>#${signal.id}</b></div>
        </div>
      `).join('')}</div>`;
    } else {
      html += '<div class="empty">还没有可展示的偏好信号。可以在记忆页写入一条偏好，或刷新画像。</div>';
    }
  }
  if (projects.length) {
    html += `<div class="persona-block"><div class="persona-label">有记忆的项目层</div><div class="chips">${projects.map(project => `<span class="chip">${esc(project.label)} · ${fmt(project.notes + project.facts)}</span>`).join('')}</div></div>`;
  }
  $('#personaBody').innerHTML = html;
}

function renderBand(data) {
  const daily = data.daily || [];
  const projects = visibleProjects(data).filter(project => project.firstAt && project.lastAt);
  const container = $('#gantt');
  container.replaceChildren();
  if (!daily.length || !projects.length) {
    container.innerHTML = '<div class="empty">还没有可绘制的项目活跃区间。</div>';
    return;
  }
  const lastDay = new Date(`${daily.at(-1).date}T00:00:00`);
  const end = lastDay.getTime() + DAY;
  const earliest = Math.min(...projects.map(project => project.firstAt));
  const spanDays = Math.max(1, (end - earliest) / DAY);
  const days = spanDays < 30 ? 30 : 84;
  const start = end - days * DAY;
  const fmtTick = ts => shortDate(ts);
  const scale = document.createElement('div');
  scale.className = 'gantt-scale';
  scale.innerHTML = `<span>项目 / 活跃区间</span><div class="gantt-scale-track"><span>${fmtTick(start)}</span><span>${fmtTick(start + days * DAY / 3)}</span><span>${fmtTick(start + days * DAY * 2 / 3)}</span><span>${fmtTick(end)}</span></div>`;
  container.append(scale);
  projects.forEach(project => {
    const first = Math.max(start, project.firstAt);
    const last = Math.min(end, project.lastAt);
    if (last < start || first > end) return;
    const left = Math.max(0, Math.min(100, (first - start) / (end - start) * 100));
    const width = Math.max(1.6, Math.min(100 - left, (last - first) / (end - start) * 100));
    const count = project.notes + project.facts;
    const chunks = Number(project.chunks || 0);
    const status = project.status === 'transcript' ? 'quiet' : project.status || 'quiet';
    const range = `${shortDate(first)}–${shortDate(last)}`;
    const label = count ? `${fmt(count)} 条` : `仅转写 ${fmt(chunks)} 块`;
    const row = document.createElement('div');
    row.className = 'gantt-row';
    row.innerHTML = `<div class="gantt-label" title="${esc(project.label)}">${esc(project.label)}</div>
      <div class="gantt-track"><div class="gantt-bar ${status}" style="left:${left}%;width:${width}%" title="${range} · 记忆 ${fmt(count)} 条${chunks ? ` · 会话 ${fmt(chunks)} 块` : ''}">${width >= 14 ? label : ''}</div></div>`;
    container.append(row);
  });
  $('#bandToday').textContent = `窗口 ${days} 天 · 今天 ${shortDate(daily.at(-1).date)}`;
}

function renderGraph(data) {
  const graph = data.graph || {};
  const nodes = graph.nodes || [];
  const links = graph.links || [];
  const svg = $('#miniGraph');
  svg.replaceChildren();
  if (!nodes.length) {
    svg.append(svgEl('text', { x: 180, y: 108, 'text-anchor': 'middle', fill: '#5d6b7c', 'font-size': 11 }, '还没有事实关系，先写一条结构化事实。'));
    $('#graphFoot').textContent = '0 条连接 · 0 个实体';
    $('#graphUpdated').textContent = '—';
    return;
  }
  const degree = new Map();
  for (const link of links) {
    degree.set(link.source, (degree.get(link.source) || 0) + 1);
    degree.set(link.target, (degree.get(link.target) || 0) + 1);
  }
  const ordered = [...nodes].sort((a, b) => (b.weight || degree.get(b.id) || 0) - (a.weight || degree.get(a.id) || 0));
  const selected = ordered.slice(0, 9);
  const maxWeight = Math.max(...selected.map(node => node.weight || degree.get(node.id) || 0), 1);
  const positions = new Map();
  const center = selected[0];
  positions.set(center.id, { x: 180, y: 106 });
  selected.slice(1).forEach((node, index) => {
    const angle = -Math.PI / 2 + (index + 1) / (selected.length - 1) * Math.PI * 2;
    const radius = selected.length <= 4 ? 52 : 72;
    positions.set(node.id, { x: 180 + Math.cos(angle) * radius, y: 106 + Math.sin(angle) * radius });
  });
  for (const link of links) {
    const a = positions.get(link.source);
    const b = positions.get(link.target);
    if (!a || !b) continue;
    svg.append(svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: 'rgba(141,225,255,.20)', 'stroke-width': 1 }));
  }
  selected.forEach(node => {
    const point = positions.get(node.id);
    const weight = node.weight || degree.get(node.id) || 0;
    const radius = 9 + weight / maxWeight * 7;
    const color = weight >= 2 ? '#f6c177' : '#8de1ff';
    const g = svgEl('g', { class: 'graph-node' });
    g.append(svgEl('circle', { cx: point.x, cy: point.y, r: radius + 7, fill: color, opacity: .08 }));
    g.append(svgEl('circle', { cx: point.x, cy: point.y, r: radius, fill: 'rgba(10,16,23,.92)', stroke: color, 'stroke-width': 1 }));
    g.append(svgEl('circle', { cx: point.x, cy: point.y, r: 2.5, fill: color, opacity: .9 }));
    const label = String(node.label || node.id).slice(0, 8);
    g.append(svgEl('text', { x: point.x, y: point.y + radius + 14, 'text-anchor': 'middle', class: 'graph-label' }, label));
    g.addEventListener('click', () => toast(`节点：<b>${esc(node.label || node.id)}</b> · 关联 ${fmt(weight)} 条关系。`));
    g.append(svgEl('title', {}, `${node.label || node.id} · ${weight} 条关系`));
    svg.append(g);
  });
  const edges = Number(graph.edges || 0);
  $('#graphFoot').innerHTML = `<b>${fmt(links.length)}</b> 条事实关系${edges ? ` + ${fmt(edges)} 条确认边` : ''} · ${fmt(data.stats.entities)} 个实体`;
  $('#graphUpdated').textContent = data.activity[0]?.ts ? `最近活动 ${relative(data.activity[0].ts)}` : '尚无活动';
}

function renderActivity(data) {
  const rows = data.activity || [];
  if (!rows.length) {
    $('#activityList').innerHTML = '<div class="empty">还没有最近写入记录。</div>';
    return;
  }
  $('#activityList').innerHTML = rows.map(row => {
    const tag = row.kind === 'fact' ? '事实' : row.kind === 'candidate' ? '候选' : '笔记';
    const kind = row.kind === 'fact' ? 'fact' : row.kind === 'candidate' ? 'candidate' : 'note';
    return `<div class="activity-item"><span class="activity-time">${dateLabel(row.ts)}</span><span class="activity-text" title="${esc(row.text)}"><b>${tag}</b> · ${esc(row.text)}</span><span class="activity-type ${kind}">${tag}</span></div>`;
  }).join('');
}

function niceMax(value) {
  if (value <= 0) return 10;
  if (value <= 20) return Math.ceil(value / 5) * 5;
  if (value <= 100) return Math.ceil(value / 10) * 10;
  return Math.ceil(value / 100) * 100;
}

function drawGrowth() {
  const data = state.data;
  if (!data) return;
  const series = data.series;
  const labels = series.labels || [];
  const notes = series.notes || [];
  const facts = series.facts || [];
  const chunks = series.chunks || [];
  const base = Number(series.base || 0);
  const svg = $('#growthSvg');
  svg.replaceChildren();
  const W = 840, H = 300, L = 48, R = 56, T = 24, B = 38;
  const plotW = W - L - R;
  const plotH = H - T - B;
  const weekly = labels.map((_, i) => notes[i] + facts[i]);
  const maxWeekly = niceMax(Math.max(...weekly, 0));
  let cumulative = base;
  const cumulativeSeries = series.cumulative?.length
    ? series.cumulative
    : labels.map((_, i) => {
      cumulative += weekly[i];
      return cumulative;
    });
  const cMax = Math.max(...cumulativeSeries, base, 1);
  const cMin = Math.min(base, ...cumulativeSeries, cMax - 1);
  const yBar = value => T + plotH - (value / maxWeekly) * plotH;
  const yLine = value => T + plotH - ((value - cMin) / Math.max(1, cMax - cMin)) * plotH;
  const x = i => L + plotW * (i + .5) / Math.max(1, labels.length);
  const gap = plotW / Math.max(1, labels.length);

  for (let k = 0; k <= 4; k += 1) {
    const yy = T + plotH * k / 4;
    svg.append(svgEl('line', { x1: L, x2: W - R, y1: yy, y2: yy, stroke: 'rgba(180,205,230,.10)', 'stroke-width': 1 }));
  }

  labels.forEach((label, i) => {
    const bx = x(i) - Math.min(22, gap * .30);
    const bw = Math.min(44, gap * .60);
    let yy = T + plotH;
    const height = value => (value / maxWeekly) * plotH;
    const hNotes = height(notes[i]);
    if (hNotes) {
      svg.append(svgEl('rect', { x: bx, y: yy - hNotes, width: bw, height: hNotes, rx: 4, fill: 'rgba(141,225,255,.48)', stroke: 'rgba(141,225,255,.12)' }));
      yy -= hNotes;
    }
    const hFacts = height(facts[i]);
    if (hFacts) {
      svg.append(svgEl('rect', { x: bx, y: yy - hFacts, width: bw, height: hFacts, rx: 3, fill: 'rgba(246,193,119,.52)' }));
    }
    svg.append(svgEl('text', { x: x(i), y: H - 15, 'text-anchor': 'middle', fill: '#6e7d8f', 'font-size': 9 }, label));
  });

  const points = cumulativeSeries.map((value, i) => `${x(i)},${yLine(value)}`).join(' ');
  svg.append(svgEl('polyline', { points, fill: 'none', stroke: 'rgba(233,246,255,.88)', 'stroke-width': 2, 'stroke-linecap': 'round' }));
  cumulativeSeries.forEach((value, i) => {
    svg.append(svgEl('circle', { cx: x(i), cy: yLine(value), r: 3.5, fill: '#0e151d', stroke: '#e9f6ff', 'stroke-width': 1.5 }));
  });

  for (let k = 0; k <= 4; k += 1) {
    const value = Math.round(cMin + (cMax - cMin) * k / 4);
    svg.append(svgEl('text', { x: W - R + 8, y: T + plotH - plotH * k / 4 + 3, fill: '#5d6b7c', 'font-size': 9, 'text-anchor': 'start' }, fmt(value)));
  }
  svg.append(svgEl('text', { x: L, y: 16, fill: '#5d6b7c', 'font-size': 9 }, '每周新增'));
  for (let k = 0; k <= 2; k += 1) {
    const value = Math.round(maxWeekly * k / 2);
    svg.append(svgEl('text', { x: L - 8, y: yBar(value) + 3, fill: '#5d6b7c', 'font-size': 9, 'text-anchor': 'end' }, fmt(value)));
  }

  if (weekly.every(value => value === 0)) {
    svg.append(svgEl('text', { x: L + plotW / 2, y: T + plotH / 2, 'text-anchor': 'middle', fill: '#5d6b7c', 'font-size': 11 }, '这个窗口内还没有写入'));
  }

  const tip = $('#growthTip');
  labels.forEach((label, i) => {
    const hit = svgEl('rect', { x: L + gap * i, y: T, width: gap, height: plotH, fill: 'transparent' });
    hit.addEventListener('pointerenter', () => {
      tip.innerHTML = `<b>${label} 当周</b>新增 ${fmt(weekly[i])} 条 · 累计 ${fmt(cumulativeSeries[i])}<br>笔记 ${fmt(notes[i])} / 事实 ${fmt(facts[i])}${chunks[i] ? ` · 另有 ${fmt(chunks[i])} 个会话块未计入` : ''}`;
      tip.style.opacity = '1';
      tip.style.left = `${(x(i) / W) * 100}%`;
      tip.style.top = `${(yLine(cumulativeSeries[i]) / H) * 100}%`;
    });
    hit.addEventListener('pointerleave', () => { tip.style.opacity = '0'; });
    svg.append(hit);
  });

  $('#footThisWeek').textContent = fmt(weekly.at(-1) || 0);
  $('#footWindow').textContent = fmt(weekly.reduce((a, b) => a + b, 0));
  const peakIndex = weekly.indexOf(Math.max(...weekly));
  $('#footPeak').textContent = weekly[peakIndex] ? `${labels[peakIndex]} · ${fmt(weekly[peakIndex])}` : '—';
  $('#footAvg').textContent = (weekly.reduce((a, b) => a + b, 0) / Math.max(1, weekly.length)).toFixed(1);
}

$$('#rangeSwitch button').forEach(button => {
  button.addEventListener('click', () => {
    state.range = button.dataset.range;
    $$('#rangeSwitch button').forEach(item => item.classList.toggle('on', item === button));
    load();
  });
});
$('#scopeSelect').addEventListener('change', event => {
  state.scope = event.target.value;
  load();
});

load();
setInterval(() => {
  if (document.visibilityState === 'visible') load();
}, 60_000);
