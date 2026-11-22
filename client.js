// SPDX-License-Identifier: LicenseRef-Omni-Memory-Personal-Use-1.1
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
// NonCommercial use only; attribution required. See LICENSE and ATTRIBUTION.md.
window.__ModuleLoader__.load({
  id: '@local/omni-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'omni-memory';
    const PAGE_SIZE = 20;
const EMPTY_HIGHLIGHT = [];

    const DICT = {
      zh: {
        title: '全息记忆',
        search: '搜索',
        reset: '重置',
        refresh: '刷新',
        placeholder: '搜索记忆：关键词、实体、或原话片段',
        prev: '上一页',
        next: '下一页',
        loading: '读取记忆…',
        empty: '还没有记忆。让我在对话里记住点什么，或者用 memory_write 写入。',
        errorNetwork: '连不上记忆服务（Host 半边未加载）',
        errorRead: '读取失败',
        retry: '重试',
        forget: '遗忘',
        note: '笔记',
        fact: '事实',
        contested: '有争议',
        supported: '已核实',
        weak: '证据不足',
        contradicted: '与原文矛盾',
        unsupported: '缺少依据',
        noSource: '无来源',
        solutionVerified: '已验证解法',
        solutionUnverified: '待验证',
        solutionFailed: '失败尝试',
        solutionExpired: '已失效',
        reuse: '复用 {n} 次',
        evidence: '证据',
        superseded: '已被替代',
        stats: '笔记 {notes} · 事实 {facts} · 片段 {chunks} · 争议 {contested}',
        hits: '命中 {n} 条',
        scopeAll: '全部',
        scopeGlobal: '全局',
        scopeProject: '项目',
        scopeHint: '全局 = 跨项目通用；项目 = 仅在该工作区生效',
        transcript: '转录',
        projectsTitle: '项目分层',
        projectsTitleCount: '项目分层 · 共 {n} 个（含暂无记忆）',
        projectNoMemory: '暂无记忆',
        recentTranscripts: '最近转录',
        backToProjects: '返回项目列表',
        projectSummary: '{notes} 笔记 · {facts} 事实 · {chunks} 转录',
        lastActive: '最近 {date}',
        projectEmpty: '该项目还没有笔记；转录会被自动记录，可在下方查看。',
        graphHint: '拖拽旋转 · 滚轮缩放',
        graphGlobal: '全局',
        graphCollapse: '收起星图',
        panelList: '列表',
        panelListClose: '收起列表',
        graphExpand: '展开星图',
        graphFallback: '星图暂不可用，已自动降级，不影响记忆功能。',
        kindNote: '笔记',
        relationMentions: '提到',
        focusMode: '聚焦',
        auditMode: '审计',
        auditHint: '审计模式：显示历史（被替代/已删除/失效）',
        exportNow: '导出',
        restore: '恢复',
        rollback: '反替代',
        spinOn: '自转中',
        spinOff: '已暂停',
        personaTitle: '设定',
        personaName: '称呼',
        personaPersonality: '性格',
        personaHabits: '习惯',
        personaPreferences: '偏好',
        personaOther: '其他',
        personaHint: 'AI 会从日常记忆里提炼这些设定；也可以在这里修正。留空即清除该项。',
        personaDerive: '重新提炼',
        personaSave: '保存',
        personaClose: '关闭',
        deleted: '已删除',
        kindEntity: '实体',
        nodeMeta: '层级 {scope} · 重要度 {importance}',
        nodeEmpty: '这条记忆已不可读取',
        graphEmpty: '还没有关系数据，先写入几条事实和笔记',
        tailIdle: '待命',
        tailOff: '已关闭',
        tailInjected: '注入 {chars} 字',
        tailRecall: '召回 {n}',
        tailTotal: '共 {notes} 条',
        tailHover: '全息记忆：本次注入 {chars} 字，召回 {recall} 条，库中 {notes} 条',
        tailTitle: '每次装配注入的长时记忆；绿色表示本轮已生效',
      },
      en: {
        title: 'Omni Memory',
        search: 'Search',
        reset: 'Reset',
        refresh: 'Refresh',
        placeholder: 'Search memories: keyword, entity, or original phrase',
        prev: 'Prev',
        next: 'Next',
        loading: 'Reading memory…',
        empty: 'No memories yet. Ask me to remember something, or call memory_write.',
        errorNetwork: 'Memory service unreachable (host half not loaded)',
        errorRead: 'Read failed',
        retry: 'Retry',
        forget: 'Forget',
        note: 'note',
        fact: 'fact',
        contested: 'contested',
        supported: 'verified',
        weak: 'weak evidence',
        contradicted: 'contradicted',
        unsupported: 'unsupported',
        noSource: 'no source',
        solutionVerified: 'verified solution',
        solutionUnverified: 'unverified',
        solutionFailed: 'failed attempt',
        solutionExpired: 'expired',
        reuse: 'reused {n}×',
        evidence: 'evidence',
        superseded: 'superseded',
        stats: 'notes {notes} · facts {facts} · chunks {chunks} · contested {contested}',
        hits: '{n} hits',
        scopeAll: 'All',
        scopeGlobal: 'Global',
        scopeProject: 'Project',
        scopeHint: 'Global applies everywhere; project applies to one workspace',
        transcript: 'transcript',
        projectsTitle: 'Project layers',
        projectsTitleCount: 'Project layers · {n} total',
        projectNoMemory: 'No memories yet',
        recentTranscripts: 'Recent transcripts',
        backToProjects: 'Back to projects',
        projectSummary: '{notes} notes · {facts} facts · {chunks} transcripts',
        lastActive: 'last {date}',
        projectEmpty: 'No notes in this project yet; transcripts are captured automatically and listed below.',
        graphHint: 'drag to rotate · wheel to zoom',
        graphGlobal: 'Global',
        graphCollapse: 'Collapse',
        panelList: 'List',
        panelListClose: 'Hide list',
        graphExpand: 'Expand',
        graphFallback: 'The star map is unavailable right now; memory features keep working.',
        kindNote: 'Note',
        relationMentions: 'mentions',
        focusMode: 'Focus',
        auditMode: 'Audit',
        auditHint: 'Audit view: history (superseded / deleted / expired)',
        exportNow: 'Export',
        restore: 'Restore',
        rollback: 'Roll back',
        spinOn: 'Spinning',
        spinOff: 'Paused',
        personaTitle: 'Persona',
        personaName: 'Name',
        personaPersonality: 'Personality',
        personaHabits: 'Habits',
        personaPreferences: 'Preferences',
        personaOther: 'Other',
        personaHint: 'The assistant derives these from everyday memory; edit to correct. Empty clears a field.',
        personaDerive: 'Derive',
        personaSave: 'Save',
        personaClose: 'Close',
        deleted: 'Deleted',
        kindEntity: 'Entity',
        nodeMeta: 'layer {scope} · importance {importance}',
        nodeEmpty: 'This memory can no longer be read',
        graphEmpty: 'No relations yet — add some facts and notes first',
        tailIdle: 'idle',
        tailOff: 'off',
        tailInjected: 'injected {chars} chars',
        tailRecall: 'recall {n}',
        tailTotal: '{notes} stored',
        tailHover: 'Omni Memory: {chars} chars injected, {recall} recalled, {notes} stored',
        tailTitle: 'Long-term memory injected on each assembly; green means this turn used it',
      },
    };

    const MUTED = { color: 'var(--dsw-alias-text-tertiary, #8899aa)', fontSize: 11 };
    const CHIP = {
      fontSize: 10, padding: '1px 7px', borderRadius: 999,
      border: '1px solid var(--dsw-alias-border-secondary, #2a3546)',
      flex: '0 0 auto',
    };
    const BTN = {
      fontSize: 12, padding: '4px 12px', borderRadius: 999, cursor: 'pointer',
      border: '1px solid var(--dsw-alias-border-secondary, #2a3546)',
      background: 'transparent', color: 'inherit',
    };

    function kindColor(kind) {
      if (kind === 'note') return 'var(--dsw-alias-border-accent, #4d6bfe)';
      if (kind === 'fact') return 'var(--dsw-alias-state-success-primary, #3fb950)';
      return 'var(--dsw-alias-text-tertiary, #8899aa)';
    }

    function verificationColor(verdict) {
      if (verdict === 'supported') return 'var(--dsw-alias-state-success-primary, #3fb950)';
      if (verdict === 'contradicted' || verdict === 'unsupported') return 'var(--dsw-alias-label-dangerous, #d9483b)';
      return 'var(--dsw-alias-text-tertiary, #8899aa)';
    }

    function solutionColor(status) {
      if (status === 'verified') return 'var(--dsw-alias-state-success-primary, #3fb950)';
      if (status === 'failed' || status === 'expired') return 'var(--dsw-alias-label-dangerous, #d9483b)';
      return 'var(--dsw-alias-text-tertiary, #8899aa)';
    }

    function solutionLabel(status, t) {
      return {
        verified: t('solutionVerified'),
        unverified: t('solutionUnverified'),
        failed: t('solutionFailed'),
        expired: t('solutionExpired'),
      }[status] ?? null;
    }

    function format(template, vars) {
      return String(template).replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? ''));
    }

    function Card({ item, t, onForget, onRestore, onRollback }) {
      const [busy, setBusy] = React.useState(false);
      const kindLabel = item.kind === 'note' ? t('note') : item.kind === 'fact' ? t('fact') : item.kind === 'chunk' ? t('transcript') : item.kind;
      const verdictKey = {
        supported: 'supported', weak: 'weak', contradicted: 'contradicted',
        unsupported: 'unsupported', no_source: 'noSource',
      }[item.verification];
      const solution = item.kind === 'note'
        ? (item.solutionStatus ?? item.solution_status ?? null)
        : null;
      const reuseCount = Number(item.reuseCount ?? item.reuse_count ?? 0);
      const solutionText = solution && solution !== 'unverified' ? solutionLabel(solution, t) : null;

      const forget = async () => {
        if (busy) return;
        setBusy(true);
        try { await onForget(item.kind, item.id, item.scope); } finally { setBusy(false); }
      };

      const restore = async () => {
        if (busy || !onRestore) return;
        setBusy(true);
        try { await onRestore(item.kind, item.id, item.scope); } finally { setBusy(false); }
      };

      const rollback = async () => {
        if (busy || !onRollback) return;
        setBusy(true);
        try { await onRollback(item.id, item.scope); } finally { setBusy(false); }
      };

      return h('div', {
        style: {
          border: '1px solid var(--dsw-alias-border-secondary, #2a3546)',
          borderRadius: 10, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 5,
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { ...CHIP, color: kindColor(item.kind), borderColor: kindColor(item.kind) } }, kindLabel),
          item.subject ? h('span', { style: { fontSize: 12, fontWeight: 600 } }, `${item.subject} · ${item.relation}`) : null,
          item.contested ? h('span', { style: { ...CHIP, color: 'var(--dsw-alias-label-dangerous, #d9483b)', borderColor: 'var(--dsw-alias-label-dangerous, #d9483b)' } }, t('contested')) : null,
          solutionText ? h('span', { style: { ...CHIP, color: solutionColor(solution), borderColor: solutionColor(solution) } }, `${solutionText}${reuseCount > 0 ? ` · ${format(t('reuse'), { n: reuseCount })}` : ''}`) : null,
          verdictKey ? h('span', { style: { ...CHIP, color: verificationColor(item.verification), borderColor: verificationColor(item.verification) } }, t(verdictKey)) : null,
          item.superseded_by ? h('span', { style: MUTED }, t('superseded')) : null,
          item.deleted_at ? h('span', { style: { ...CHIP, color: 'var(--dsw-alias-label-dangerous, #d9483b)', borderColor: 'var(--dsw-alias-label-dangerous, #d9483b)' } }, t('deleted')) : null,
          h('span', { style: { ...MUTED, marginLeft: 'auto' } }, `#${item.id}`),
          item.deleted_at && onRestore
            ? h('button', {
                type: 'button', onClick: restore, disabled: busy,
                style: { ...BTN, fontSize: 10, padding: '1px 8px' },
              }, busy ? '…' : t('restore'))
            : item.superseded_by && onRollback
            ? h('button', {
                type: 'button', onClick: rollback, disabled: busy,
                style: { ...BTN, fontSize: 10, padding: '1px 8px' },
              }, busy ? '…' : t('rollback'))
            : h('button', {
                type: 'button', onClick: forget, disabled: busy,
                style: {
                  ...BTN, fontSize: 10, padding: '1px 8px',
                  color: 'var(--dsw-alias-label-dangerous, #d9483b)',
                },
              }, busy ? '…' : t('forget'))),
        h('div', { style: { fontSize: 13, lineHeight: 1.6, wordBreak: 'break-word' } }, item.text),
        item.evidence ? h('div', { style: MUTED }, `${t('evidence')}: ${item.evidence}`) : null,
        (() => {
          const meta = [];
          if (item.scope && item.scope !== 'global') meta.push(item.scope);
          if (item.source) meta.push(item.source);
          if (item.validTo) meta.push('expired');
          if (Number.isFinite(item.importance)) meta.push(`importance ${Number(item.importance).toFixed(2)}`);
          return meta.length ? h('div', { style: MUTED }, meta.join(' · ')) : null;
        })());
    }

    function MemoryView(props) {
      const t = props.t ?? (key => key);
      const [state, setState] = React.useState({ loading: true, data: null, error: '', hits: null });
      const [query, setQuery] = React.useState('');
      const [offset, setOffset] = React.useState(0);
      const [scopeFilter, setScopeFilter] = React.useState('all');
      const [drawer, setDrawer] = React.useState(false);
      const [selected, setSelected] = React.useState(null);
      const [hitIds, setHitIds] = React.useState([]);
      const [focusMode, setFocusMode] = React.useState(false);
      const [audit, setAudit] = React.useState(false);
      const [personaOpen, setPersonaOpen] = React.useState(false);
      const [personaDraft, setPersonaDraft] = React.useState({});
      const [personaBusy, setPersonaBusy] = React.useState(false);

      const load = React.useCallback(async (nextOffset = offset) => {
        try {
          const query = audit
            ? `/omni-memory/list?limit=200&offset=0&scope=${encodeURIComponent(scopeFilter)}&audit=1`
            : `/omni-memory/list?limit=${PAGE_SIZE}&offset=${nextOffset}&scope=${encodeURIComponent(scopeFilter)}`;
          const response = await fetch(query, { headers: { accept: 'application/json' } });
          const body = await response.json();
          setState(prev => ({
            ...prev,
            loading: false,
            data: body?.ok ? body : null,
            error: body?.ok ? '' : 'list-failed',
            hits: null,
          }));
        } catch {
          setState(prev => ({ ...prev, loading: false, error: 'network' }));
        }
      }, [offset, scopeFilter, audit]);

      React.useEffect(() => { load(offset); }, [load, offset]);

      const search = async () => {
        const q = query.trim();
        if (!q) { setOffset(0); return load(0); }
        try {
          const searchScope = scopeFilter;
          const response = await fetch(
            `/omni-memory/search?q=${encodeURIComponent(q)}&limit=40&scope=${encodeURIComponent(searchScope)}`,
            { headers: { accept: 'application/json' } },
          );
          const body = await response.json();
          const hits = body?.ok ? body.hits : [];
          setState(prev => ({ ...prev, hits }));
          setDrawer(true);
          setHitIds([...new Set((hits ?? []).flatMap(hit => (hit.kind === 'note'
            ? [`n:${hit.id}`]
            : [`e:${hit.subject}`, `e:${hit.object}`]).filter(Boolean)))]);
        } catch {
          setState(prev => ({ ...prev, hits: [] }));
        }
      };

      const restore = async (kind, id, scope) => {
        let error = '';
        const layer = scope || 'global';
        try {
          const response = await fetch(`/omni-memory/restore?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}&scope=${encodeURIComponent(layer)}`, {
            method: 'POST',
            headers: { accept: 'application/json', 'x-omni-csrf': '1' },
          });
          const body = await response.json().catch(() => null);
          if (!response.ok || body?.ok === false) error = body?.error || 'restore failed';
          else if (body?.restored === false) error = body?.reason || 'restore failed';
        } catch {
          error = 'restore failed';
        }
        await load(offset);
        if (error) setState(prev => ({ ...prev, error }));
      };

      const rollbackDream = async (noteId, scope) => {
        const layer = scope || 'global';
        try {
          await fetch(`/omni-memory/dream/rollback?noteId=${encodeURIComponent(noteId)}&scope=${encodeURIComponent(layer)}`, {
            method: 'POST',
            headers: { accept: 'application/json', 'x-omni-csrf': '1' },
          });
        } finally {
          await load(offset);
        }
      };

      const personaFields = [
        ['称呼', 'personaName'],
        ['性格', 'personaPersonality'],
        ['习惯', 'personaHabits'],
        ['偏好', 'personaPreferences'],
        ['其他', 'personaOther'],
      ];

      const openPersona = async () => {
        setPersonaOpen(true);
        try {
          const response = await fetch('/omni-memory/persona', { headers: { accept: 'application/json' } });
          const body = await response.json();
          setPersonaDraft(body?.persona ?? {});
        } catch { /* keep an empty form */ }
      };

      const refreshPersona = async () => {
        if (personaBusy) return;
        setPersonaBusy(true);
        try {
          await fetch('/omni-memory/persona/refresh', {
            method: 'POST',
            headers: { accept: 'application/json', 'x-omni-csrf': '1' },
          });
          const response = await fetch('/omni-memory/persona', { headers: { accept: 'application/json' } });
          const body = await response.json();
          setPersonaDraft(body?.persona ?? {});
        } finally {
          setPersonaBusy(false);
        }
      };

      const savePersona = async () => {
        if (personaBusy) return;
        setPersonaBusy(true);
        try {
          const values = {};
          const known = new Set(personaFields.map(([key]) => key));
          for (const [key, value] of Object.entries(personaDraft ?? {})) {
            if (known.has(key)) continue;
            const text = String(value ?? '').trim();
            if (text) values[key] = text;
          }
          for (const [key] of personaFields) {
            const text = String(personaDraft[key] ?? '').trim();
            if (text) values[key] = text;
          }
          await fetch('/omni-memory/persona', {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              'x-omni-csrf': '1',
            },
            body: JSON.stringify({ values }),
          });
          setPersonaOpen(false);
        } finally {
          setPersonaBusy(false);
        }
      };

      const exportBackup = async () => {
        try {
          const response = await fetch('/omni-memory/export?download=1', { headers: { accept: 'application/json' } });
          const body = await response.json();
          if (!body?.ok) return;
          const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = `omni-backup-${new Date().toISOString().slice(0, 10)}.json`;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch { /* export is best effort */ }
      };

      const forget = async (kind, id, scope) => {
        const layer = scope || 'global';
        try {
          await fetch(`/omni-memory/forget?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}&scope=${encodeURIComponent(layer)}`, {
            method: 'POST',
            headers: { accept: 'application/json', 'x-omni-csrf': '1' },
          });
        } finally {
          await load(offset);
        }
      };

      const openNode = async node => {
        setSelected({ node, loading: true, detail: null });
        try {
          const searchScope = scopeFilter;
          const response = await fetch(`/omni-memory/node?node=${encodeURIComponent(node.id)}&scope=${encodeURIComponent(searchScope)}`);
          const body = await response.json();
          setSelected(body?.ok
            ? { node, loading: false, detail: body.node }
            : { node, loading: false, detail: null });
        } catch {
          setSelected({ node, loading: false, detail: null });
        }
      };

      const data = state.data ?? { notes: [], facts: [], stats: {}, page: {}, projects: [] };
      const stats = data.stats ?? {};
      const page = data.page ?? {};
      const projects = data.projects ?? [];
      const items = state.hits
        ? state.hits
        : [
            ...(data.notes ?? []).map(row => ({ ...row, kind: 'note' })),
            ...(data.facts ?? []).map(row => ({ ...row, kind: 'fact', validTo: row.valid_to ?? null })),
          ];
      const from = page.offset ?? 0;
      const notesOnPage = (data.notes ?? []).length;
      const to = from + notesOnPage;
      const isExactProject = scopeFilter !== 'all' && scopeFilter !== 'global' && scopeFilter !== 'project';
      const projectName = value => String(value ?? '').replace(/^proj:/, '').split('#')[0];
      const shortDate = value => (value ? new Date(Number(value)).toISOString().slice(0, 10) : '');

      const floatingBar = {
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
        borderRadius: 12, border: '1px solid rgba(90,120,190,.4)',
        background: 'rgba(8,12,24,.72)', backdropFilter: 'blur(10px)',
        color: 'rgba(200,215,235,.9)',
      };
      const ghostButton = {
        fontSize: 11, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
        border: '1px solid rgba(90,120,190,.5)', background: 'rgba(12,18,32,.6)',
        color: 'rgba(190,210,235,.9)',
      };

      return h('div', {
        style: { position: 'relative', height: '100%', width: '100%', overflow: 'hidden', background: '#05060f' },
      },
        h(MemoryGraph, {
          t, fill: true, highlight: hitIds, onSelect: openNode,
          focus: selected?.node?.id ?? null,
          focusMode,
        }),
        h('div', { style: { position: 'absolute', top: 10, right: 12, left: 340, display: 'flex', justifyContent: 'flex-end', gap: 6 } },
          h('div', { style: { ...floatingBar, flex: '0 1 360px', minWidth: 160 } },
            h('input', {
              value: query,
              placeholder: t('placeholder'),
              onChange: event => setQuery(event.target.value),
              onKeyDown: event => { if (event.key === 'Enter') search(); },
              style: {
                flex: 1, minWidth: 0, fontSize: 12, padding: '4px 8px', borderRadius: 8,
                border: '1px solid rgba(90,120,190,.4)', background: 'rgba(4,8,18,.6)',
                color: 'rgba(215,230,250,.95)', outline: 'none',
              },
            }),
            h('button', { type: 'button', style: ghostButton, onClick: search }, t('search')),
            h('button', { type: 'button', style: ghostButton, onClick: () => { setQuery(''); setOffset(0); setHitIds([]); load(0); } }, t('reset'))),
          h('button', {
            type: 'button',
            style: { ...ghostButton, ...(focusMode ? { borderColor: 'rgba(120,200,255,.85)', color: '#9fd8ff' } : {}) },
            onClick: () => setFocusMode(value => !value),
          }, t('focusMode')),
          h('button', { type: 'button', style: ghostButton, onClick: () => setDrawer(value => !value) },
            drawer ? t('panelListClose') : t('panelList')),
          h('button', {
            type: 'button',
            style: { ...ghostButton, ...(audit ? { borderColor: 'rgba(120,200,255,.85)', color: '#9fd8ff' } : {}) },
            onClick: () => setAudit(value => !value),
          }, t('auditMode')),
          h('button', { type: 'button', style: ghostButton, onClick: openPersona }, t('personaTitle')),
          h('button', { type: 'button', style: ghostButton, onClick: exportBackup }, t('exportNow')),
          h('button', { type: 'button', style: ghostButton, onClick: () => load(offset) }, t('refresh'))),
        h('div', {
          style: {
            position: 'absolute', left: 14, bottom: 12, fontSize: 10,
            color: 'rgba(150,175,210,.8)', pointerEvents: 'none',
          },
        }, format(t('stats'), {
          notes: stats.notes ?? 0, facts: stats.facts ?? 0,
          chunks: stats.chunks ?? 0, contested: stats.contested ?? 0,
        })),
        personaOpen
          ? h('div', {
              style: {
                position: 'absolute', inset: 0, zIndex: 3, background: 'rgba(2,5,12,.72)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
              },
            },
            h('div', {
              style: {
                width: 520, maxWidth: '100%', maxHeight: '90%', overflow: 'auto',
                borderRadius: 16, border: '1px solid rgba(110,170,255,.5)',
                background: 'rgba(8,13,26,.98)', padding: 16,
                display: 'flex', flexDirection: 'column', gap: 10,
              },
            },
              h('div', { style: { display: 'flex', alignItems: 'center' } },
                h('div', { style: { fontSize: 14, fontWeight: 600 } }, t('personaTitle')),
                h('button', {
                  type: 'button',
                  style: { ...ghostButton, marginLeft: 'auto', padding: '2px 9px' },
                  onClick: () => setPersonaOpen(false),
                }, '×')),
              h('div', { style: { ...MUTED, fontSize: 11 } }, t('personaHint')),
              ...personaFields.map(([key, labelKey]) => h('div', {
                key,
                style: { display: 'flex', flexDirection: 'column', gap: 4 },
              },
                h('div', { style: { fontSize: 11, color: 'rgba(190,210,235,.9)' } }, t(labelKey)),
                h('textarea', {
                  value: personaDraft[key] ?? '',
                  rows: key === '其他' ? 3 : 2,
                  onChange: event => {
                    const value = event.target.value;
                    setPersonaDraft(previous => ({ ...previous, [key]: value }));
                  },
                  style: {
                    resize: 'vertical', fontSize: 12, lineHeight: 1.5, padding: '6px 8px',
                    borderRadius: 8, border: '1px solid rgba(90,120,190,.4)',
                    background: 'rgba(4,8,18,.6)', color: 'rgba(215,230,250,.95)', outline: 'none',
                  },
                }))),
              h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
                h('button', { type: 'button', style: ghostButton, onClick: refreshPersona, disabled: personaBusy },
                  personaBusy ? '…' : t('personaDerive')),
                h('button', { type: 'button', style: ghostButton, onClick: () => setPersonaOpen(false) }, t('personaClose')),
                h('button', { type: 'button', style: ghostButton, onClick: savePersona, disabled: personaBusy },
                  personaBusy ? '…' : t('personaSave')))))
          : null,
        selected
          ? h('div', {
              style: {
                position: 'absolute', top: 58, right: drawer ? 462 : 12, width: 380,
                maxWidth: 'calc(100% - 24px)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8,
                borderRadius: 14, border: '1px solid rgba(110,170,255,.45)',
                background: 'rgba(6,10,20,.94)', backdropFilter: 'blur(12px)',
                color: 'rgba(215,228,245,.94)', zIndex: 2,
              },
            },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('span', {
                  style: {
                    fontSize: 10, padding: '1px 7px', borderRadius: 999,
                    background: selected.node.kind === 'note' ? 'rgba(60,160,220,.25)' : 'rgba(220,160,60,.25)',
                    color: selected.node.kind === 'note' ? '#9fd8ff' : '#ffd08a',
                  },
                }, selected.node.kind === 'note' ? t('kindNote') : t('kindEntity')),
                h('button', {
                  type: 'button',
                  style: { ...ghostButton, marginLeft: 'auto', padding: '2px 8px' },
                  onClick: () => setSelected(null),
                }, '×')),
              selected.loading ? h('div', { style: MUTED }, t('loading')) : null,
              selected.detail && selected.detail.kind === 'note'
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                    h('div', {
                      style: {
                        fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre-wrap',
                        maxHeight: 240, overflow: 'auto',
                      },
                    }, selected.detail.text),
                    h('div', { style: { ...MUTED, fontSize: 10 } }, format(t('nodeMeta'), {
                      scope: selected.detail.scope,
                      importance: Number(selected.detail.importance ?? 0).toFixed(2),
                    })),
                    h('div', { style: { display: 'flex', gap: 6 } },
                      h('button', {
                        type: 'button',
                        style: ghostButton,
                        onClick: () => { forget('note', selected.detail.id, selected.detail.scope); setSelected(null); },
                      }, t('forget'))))
                : null,
              selected.detail && selected.detail.kind === 'entity'
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                    h('div', { style: { fontSize: 12, fontWeight: 600 } }, selected.detail.name),
                    ...(selected.detail.facts ?? []).slice(0, 8).map((fact, index) => h('div', {
                      key: index,
                      style: { fontSize: 11, color: 'rgba(190,210,235,.85)' },
                    }, `${fact.subject} —${fact.relation}→ ${fact.object}`)))
                : null,
              !selected.loading && !selected.detail
                ? h('div', { style: MUTED }, t('nodeEmpty'))
                : null)
          : null,
        drawer
          ? h('div', {
              style: {
                position: 'absolute', top: 58, right: 12, bottom: 12, width: 430, maxWidth: 'calc(100% - 24px)',
                display: 'flex', flexDirection: 'column', gap: 8, padding: 12, overflow: 'auto',
                borderRadius: 14, border: '1px solid rgba(90,120,190,.4)',
                background: 'rgba(6,10,20,.9)', backdropFilter: 'blur(12px)',
                color: 'rgba(210,223,240,.92)',
              },
            },
              state.loading
                ? h('div', { style: { ...MUTED, paddingTop: 8 } }, t('loading'))
                : null,
              state.error
                ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                    h('span', { style: { ...MUTED, flex: 1 } }, state.error === 'network' ? t('errorNetwork') : t('errorRead')),
                    h('button', { type: 'button', style: ghostButton, onClick: () => load(offset) }, t('retry')))
                : null,
              h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                ...[['all', 'scopeAll'], ['global', 'scopeGlobal'], ['project', 'scopeProject']].map(([key, label]) =>
                  h('button', {
                    key,
                    type: 'button',
                    onClick: () => { setScopeFilter(key); setOffset(0); },
                    style: {
                      ...ghostButton,
                      ...((scopeFilter === key || (key === 'project' && isExactProject))
                        ? { borderColor: 'rgba(120,200,255,.85)', color: '#9fd8ff' }
                        : {}),
                    },
                  }, t(label)))),
              h('div', { style: { ...MUTED, fontSize: 10 } }, audit ? t('auditHint') : `${from + 1}–${to} / ${page.totalNotes ?? 0}`),
              projects.length
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                    h('div', { style: { ...MUTED, fontSize: 10 } }, format(t('projectsTitleCount'), { n: projects.length })),
                    ...projects.map(project => {
                      const label = project.label ?? projectName(project.scope);
                      const empty = Boolean(project.empty);
                      return h('div', {
                        key: project.scope || project.label,
                        role: empty ? undefined : 'button',
                        onClick: empty ? undefined : () => { setScopeFilter(project.scope); setOffset(0); },
                        style: {
                          border: '1px solid rgba(90,120,190,.35)', borderRadius: 10, padding: '6px 8px',
                          cursor: empty ? 'default' : 'pointer', display: 'flex', flexDirection: 'column', gap: 2,
                          background: 'rgba(12,18,32,.5)', opacity: empty ? 0.55 : 1,
                        },
                      },
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                          h('span', { style: { fontSize: 12, fontWeight: 600 } }, label),
                          h('span', { style: { ...MUTED, marginLeft: 'auto', fontSize: 10 } },
                            empty ? t('projectNoMemory') : format(t('lastActive'), { date: shortDate(project.lastAt) }))),
                        empty
                          ? null
                          : h('div', { style: { ...MUTED, fontSize: 10 } }, format(t('projectSummary'), {
                              notes: project.notes ?? 0, facts: project.facts ?? 0, chunks: project.chunks ?? 0,
                            })));
                    }))
                : null,
              state.hits
                ? h('div', { style: { ...MUTED, fontSize: 10 } }, format(t('hits'), { n: state.hits.length }))
                : null,
              items.length === 0
                ? h('div', { style: { ...MUTED, paddingTop: 10 } }, t('empty'))
                : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                    ...items.map(item => h(Card, { key: `${item.kind}-${item.id}`, item, t, onForget: forget, onRestore: restore, onRollback: rollbackDream }))),
              h('div', { style: { display: 'flex', gap: 6, justifyContent: 'space-between' } },
                h('button', {
                  type: 'button', style: { ...ghostButton, flex: 1 }, disabled: from <= 0,
                  onClick: () => setOffset(Math.max(0, from - PAGE_SIZE)),
                }, t('prev')),
                h('button', {
                  type: 'button', style: { ...ghostButton, flex: 1 }, disabled: !page.hasMoreNotes,
                  onClick: () => setOffset(from + PAGE_SIZE),
                }, t('next'))))
          : null);
    }

    /**
     * Memory star map.
     *
     * Entities are stars, open fact edges are constellation lines, and notes hang
     * off the entities they mention. Drag to rotate, wheel to zoom, with inertia
     * and idle auto-rotation. Plain canvas 2D with manual 3D projection so the
     * plugin stays dependency-free.
     */
    function galaxyRng(seed) {
      let t = (seed + 0x6d2b79f5) | 0;
      return () => {
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    /**
     * Spiral-arm placement, ported from the common procedural-galaxy recipe:
     * four arms, radius distributed by sqrt for even density, arm width and
     * vertical thickness falling off with radius.
     */
    function galaxyPoint(index, radiusMin) {
      const arms = 4;
      const rand = galaxyRng(Math.imul(index + 1, 2654435761));
      const r = radiusMin + Math.sqrt(rand()) * (0.98 - radiusMin);
      const arm = index % arms;
      const angle = (arm * Math.PI * 2) / arms + r * 2.35 + (rand() - 0.5) * 0.6;
      const thickness = (1 - r * 0.62) * 0.17;
      return {
        x: Math.cos(angle) * r,
        y: (rand() - 0.5) * thickness * 2,
        z: Math.sin(angle) * r,
        r,
        phase: rand() * Math.PI * 2,
      };
    }

    /**
     * Memory galaxy.
     *
     * Entities and notes become bright stars on a four-arm spiral; facts become
     * the filaments between them. Drag to orbit, wheel to zoom, idle spin, and a
     * layer switcher for the global map and each project map.
     */
    function MemoryGraph(props) {
      const t = props.t ?? (key => key);
      const fill = Boolean(props.fill);
      const highlight = props.highlight ?? EMPTY_HIGHLIGHT;
      const onSelect = props.onSelect;
      const highlightRef = React.useRef(EMPTY_HIGHLIGHT);
      highlightRef.current = highlight;
      const focusRef = React.useRef(null);
      focusRef.current = props.focus ?? null;
      const focusModeRef = React.useRef(false);
      focusModeRef.current = Boolean(props.focusMode);
      const canvasRef = React.useRef(null);
      const dataRef = React.useRef({ nodes: [], links: [], stars: [], labels: new Map() });
      const viewRef = React.useRef({
        yaw: 0.35, pitch: -0.32, zoom: 1.05,
        vx: 0.0011, vy: 0.0001, dragging: false,
        lastX: 0, lastY: 0, lastMove: 0,
        tooltipId: null, screen: new Map(), linkScreen: [], nebula: null, w: 0, h: 0, dpr: 1,
        stride: 1, slowFrames: 0, frameTime: 16,
        trig: { cy: 1, sy: 0, cp: 1, sp: 0 }, radius: 1,
      });
      const [tooltip, setTooltip] = React.useState(null);
      const [scopes, setScopes] = React.useState([]);
      const [active, setActive] = React.useState('global');
      const [collapsed, setCollapsed] = React.useState(false);
      const [broken, setBroken] = React.useState('');
      const reduceMotion = (() => {
        try {
          return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        } catch { return false; }
      })();
      const [spin, setSpin] = React.useState(() => {
        try {
          const saved = window.localStorage?.getItem('omni-spin');
          if (saved === '1') return true;
          if (saved === '0') return false;
        } catch { /* private mode */ }
        return !reduceMotion;
      });

      React.useEffect(() => {
        let alive = true;
        fetch(`/omni-memory/graph?scope=${encodeURIComponent(active)}`, { headers: { accept: 'application/json' } })
          .then(response => response.json())
          .then(body => {
            if (!alive || !body?.ok) return;
            setScopes(Array.isArray(body.scopes) ? body.scopes : []);
            const nodes = (body.nodes ?? []).map((node, index) => ({
              ...node,
              ...galaxyPoint(index + 11, 0.18),
            }));
            const stars = [];
            for (let i = 0; i < 2800; i += 1) {
              const point = galaxyPoint(i, 0.08);
              const rand = galaxyRng(Math.imul(i + 3, 40503));
              stars.push({ ...point, size: 0.6 + rand() * 1.5, warm: point.r < 0.5, bright: 0.35 + rand() * 0.65 });
            }
            dataRef.current = { nodes, links: body.links ?? [], stars, labels: new Map(nodes.map(node => [node.id, node.label])) };
          })
          .catch(() => { /* keep the panel usable without a graph */ });
        return () => { alive = false; };
      }, [active]);

      React.useEffect(() => {
        if (collapsed && !fill) return undefined;
        const canvas = canvasRef.current;
        if (!canvas) return undefined;
        const ctx = canvas.getContext('2d');
        const view = viewRef.current;
        if (!ctx) {
          setBroken('canvas-2d-unavailable');
          return undefined;
        }

        const resize = () => {
          try {
            const rect = canvas.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            view.w = rect.width;
            view.h = rect.height;
            view.dpr = dpr;
            canvas.width = Math.round(view.w * dpr);
            canvas.height = Math.round(view.h * dpr);
            view.nebula = null;
          } catch { /* keep last known size */ }
        };
        resize();
        let observer;
        try {
          observer = new ResizeObserver(resize);
          observer.observe(canvas);
        } catch { observer = undefined; }
        window.addEventListener('resize', resize);

        const project = point => {
          // Trig and the radius are frame constants. Recomputing them per star
          // meant 2800 × four trig calls every frame.
          const { cy, sy, cp, sp } = view.trig;
          const x1 = point.x * cy - point.z * sy;
          const z1 = point.x * sy + point.z * cy;
          const y2 = point.y * cp - z1 * sp;
          const z2 = point.y * sp + z1 * cp;
          const radius = view.radius;
          const perspective = 1 / (1.65 - z2 * 0.55);
          return {
            x: view.w / 2 + x1 * radius * perspective,
            y: view.h / 2 + y2 * radius * perspective,
            z: z2,
            scale: perspective,
          };
        };

        let raf = 0;
        let last = performance.now();
        let disposed = false;
        const frame = time => {
          raf = 0;
          if (disposed || (typeof document !== 'undefined' && document.hidden)) return;
          try {
            const delta = Math.max(1, time - last);
            last = time;
            view.trig = {
              cy: Math.cos(view.yaw), sy: Math.sin(view.yaw),
              cp: Math.cos(view.pitch), sp: Math.sin(view.pitch),
            };
            view.radius = Math.min(view.w * 0.55, view.h * 0.82) * view.zoom;
            // Adaptive quality: if frames stay slow, draw fewer background stars.
            view.frameTime = view.frameTime * 0.92 + delta * 0.08;
            if (view.frameTime > 34) {
              view.slowFrames += 1;
              if (view.slowFrames > 90 && view.stride < 3) {
                view.stride += 1;
                view.slowFrames = 0;
              }
            } else if (view.frameTime < 20) {
              view.slowFrames = Math.max(0, view.slowFrames - 1);
            }

            const { nodes, links, stars, labels } = dataRef.current;
            const dpr = view.dpr || 1;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = '#05060f';
            ctx.fillRect(0, 0, view.w, view.h);

            if (!view.nebula) {
              const common = Math.min(view.w, view.h);
              const make = (cx, cy, radius, rgb, alpha) => {
                const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
                gradient.addColorStop(0, `rgba(${rgb},${alpha})`);
                gradient.addColorStop(1, 'rgba(0,0,0,0)');
                return gradient;
              };
              view.nebula = [
                make(view.w * 0.5, view.h * 0.52, common * 0.55, '74,58,160', 0.30),
                make(view.w * 0.62, view.h * 0.42, common * 0.34, '36,110,180', 0.22),
              ];
            }
            for (const gradient of view.nebula) {
              ctx.fillStyle = gradient;
              ctx.fillRect(0, 0, view.w, view.h);
            }

            const screenNodes = view.screen;
            screenNodes.clear();
            for (const node of nodes) screenNodes.set(node.id, project(node));

            ctx.globalCompositeOperation = 'lighter';
            const twinkle = time * 0.0016;
            for (let index = 0; index < stars.length; index += view.stride) {
              const star = stars[index];
              const point = project(star);
              const depth = 1 - (point.z + 1) / 2;
              const alpha = Math.max(0.05, (0.32 + depth * 0.55) * star.bright * (0.75 + 0.25 * Math.sin(twinkle + star.phase)));
              const size = Math.max(0.5, star.size * point.scale * view.zoom * view.stride * 0.8);
              ctx.fillStyle = star.warm
                ? `rgba(255,214,170,${alpha.toFixed(3)})`
                : `rgba(150,190,255,${alpha.toFixed(3)})`;
              ctx.fillRect(point.x, point.y, size, size);
            }

            const focusId = focusRef.current;
            const focusOn = focusModeRef.current;
            const focusSet = (() => {
              if (!focusOn || !focusId) return null;
              const set = new Set([focusId]);
              for (const link of links) {
                if (link.source === focusId) set.add(link.target);
                if (link.target === focusId) set.add(link.source);
              }
              return set;
            })();
            const linkScreen = view.linkScreen;
            linkScreen.length = 0;
            for (const link of links) {
              const a = screenNodes.get(link.source);
              const b = screenNodes.get(link.target);
              if (!a || !b) continue;
              const mention = link.rel === 'mentions';
              const near = focusSet ? (link.source === focusId || link.target === focusId) : true;
              const depth = 1 - (a.z + b.z) / 2;
              const base = (0.05 + depth * 0.22) * (near ? 1 : 0.22);
              ctx.setLineDash(mention ? [3, 4] : []);
              ctx.strokeStyle = mention
                ? `rgba(140,232,255,${base.toFixed(3)})`
                : `rgba(120,170,255,${(base * 1.1).toFixed(3)})`;
              ctx.lineWidth = mention ? 1 : 1.2;
              ctx.beginPath();
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(b.x, b.y);
              ctx.stroke();
              ctx.setLineDash([]);
              if (!mention) {
                const angle = Math.atan2(b.y - a.y, b.x - a.x);
                const size = 5;
                ctx.fillStyle = `rgba(140,185,255,${(base * 1.4).toFixed(3)})`;
                ctx.beginPath();
                ctx.moveTo(b.x, b.y);
                ctx.lineTo(b.x - Math.cos(angle - 0.42) * size, b.y - Math.sin(angle - 0.42) * size);
                ctx.lineTo(b.x - Math.cos(angle + 0.42) * size, b.y - Math.sin(angle + 0.42) * size);
                ctx.closePath();
                ctx.fill();
              }
              linkScreen.push({
                x1: a.x, y1: a.y, x2: b.x, y2: b.y,
                rel: link.rel,
                from: labels.get(link.source) ?? link.source,
                to: labels.get(link.target) ?? link.target,
                mention,
              });
            }
            view.linkScreen = linkScreen;

            const marked = new Set(highlightRef.current);
            for (const node of nodes) {
              const point = screenNodes.get(node.id);
              const isMarked = marked.has(node.id);
              const dim = (marked.size && !isMarked ? 0.2 : 1) * (focusSet ? (focusSet.has(node.id) ? 1 : 0.22) : 1);
              const depth = 1 - (point.z + 1) / 2;
              const twinkleAlpha = 0.8 + 0.2 * Math.sin(twinkle * 1.7 + node.weight * 9);
              const base = Math.min(1, 0.45 + depth * 0.75) * twinkleAlpha * dim;
              const rgb = node.kind === 'note' ? '95,216,255' : '255,196,110';
              const core = (1.4 + node.weight * 3.4) * point.scale * view.zoom;
              ctx.fillStyle = `rgba(${rgb},${(0.10 * base).toFixed(3)})`;
              ctx.beginPath();
              ctx.arc(point.x, point.y, core * 4.2, 0, Math.PI * 2);
              ctx.fill();
              ctx.fillStyle = `rgba(${rgb},${(0.30 * base).toFixed(3)})`;
              ctx.beginPath();
              ctx.arc(point.x, point.y, core * 2.1, 0, Math.PI * 2);
              ctx.fill();
              ctx.fillStyle = `rgba(255,255,255,${(0.85 * base).toFixed(3)})`;
              ctx.beginPath();
              ctx.arc(point.x, point.y, Math.max(0.7, core * 0.55), 0, Math.PI * 2);
              ctx.fill();
              if (isMarked) {
                const pulse = 0.5 + 0.5 * Math.sin(time * 0.004 + node.weight * 6);
                ctx.strokeStyle = `rgba(125,255,205,${(0.30 + 0.45 * pulse).toFixed(3)})`;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(point.x, point.y, core * 6.5 + 2 + pulse * 3, 0, Math.PI * 2);
                ctx.stroke();
              }
            }

            ctx.globalCompositeOperation = 'source-over';
            if (!nodes.length) {
              ctx.fillStyle = 'rgba(150,170,200,.85)';
              ctx.font = '12px "Microsoft YaHei", sans-serif';
              ctx.textAlign = 'center';
              ctx.fillText(t('graphEmpty'), view.w / 2, view.h / 2);
              ctx.textAlign = 'start';
            }

            if (!view.dragging && spin) {
              view.yaw += view.vx;
              view.pitch = Math.max(-1.3, Math.min(1.3, view.pitch + view.vy));
              view.vx *= 0.985;
              view.vy *= 0.985;
              if (Date.now() - view.lastMove > 2500) view.yaw += 0.0011;
            }
          } catch {
            // Never let a drawing error take down the panel.
            setBroken('render-failed');
            return;
          }
          raf = requestAnimationFrame(frame);
        };
        const onVisibility = () => {
          if (disposed || typeof document === 'undefined') return;
          if (document.hidden) {
            cancelAnimationFrame(raf);
            raf = 0;
          } else if (!raf) {
            last = performance.now();
            raf = requestAnimationFrame(frame);
          }
        };
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
        if (typeof document === 'undefined' || !document.hidden) raf = requestAnimationFrame(frame);

        return () => {
          disposed = true;
          cancelAnimationFrame(raf);
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
          window.removeEventListener('resize', resize);
          if (observer) observer.disconnect();
        };
      }, [t, active, collapsed, fill, spin]);

      const distanceToSegment = (px, py, x1, y1, x2, y2) => {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const lengthSq = dx * dx + dy * dy;
        if (!lengthSq) return Math.hypot(px - x1, py - y1);
        const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq));
        return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
      };

      const pick = event => {
        const view = viewRef.current;
        const rect = event.currentTarget.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        let best = null;
        let bestDistance = 16;
        for (const [id, point] of view.screen) {
          const distance = Math.hypot(point.x - x, point.y - y);
          if (distance < bestDistance) { bestDistance = distance; best = id; }
        }
        if (best) {
          const node = dataRef.current.nodes.find(item => item.id === best);
          if (node && best !== view.tooltipId) {
            view.tooltipId = best;
            setTooltip({ id: best, x, y, label: node.label, kind: node.kind });
          }
          return;
        }
        // Nothing under the pointer: fall back to the nearest relation line.
        let line = null;
        let lineDistance = 10;
        for (const entry of view.linkScreen ?? []) {
          const distance = distanceToSegment(x, y, entry.x1, entry.y1, entry.x2, entry.y2);
          if (distance < lineDistance) { lineDistance = distance; line = entry; }
        }
        if (!line) {
          view.tooltipId = null;
          setTooltip(null);
          return;
        }
        const label = line.mention
          ? `${line.from} ${t('relationMentions')} ${line.to}`
          : `${line.from} —${line.rel}→ ${line.to}`;
        const key = `link:${line.from}:${line.rel}:${line.to}`;
        if (key !== view.tooltipId) {
          view.tooltipId = key;
          setTooltip({ id: key, x, y, label, kind: 'link' });
        }
      };

      const scopeLabel = scope => (scope.key === 'global' ? t('graphGlobal') : scope.label);

      return h('div', {
        style: {
          overflow: 'hidden', background: '#05060f',
          position: fill ? 'absolute' : 'relative',
          inset: fill ? 0 : undefined,
          height: fill ? '100%' : collapsed ? 44 : 420,
          minHeight: fill ? '100%' : collapsed ? 44 : 420,
          width: '100%', flex: '0 0 auto', transition: 'height .18s ease',
          border: fill ? 'none' : '1px solid rgba(90,120,190,.35)',
          borderRadius: fill ? 0 : 14,
        },
      },
        h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', flexWrap: 'wrap' },
        },
          ...scopes.slice(0, 8).map(scope => h('button', {
            key: scope.key,
            type: 'button',
            onClick: () => setActive(scope.key),
            style: {
              fontSize: 11, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
              border: scope.key === active ? '1px solid rgba(120,200,255,.85)' : '1px solid rgba(90,120,190,.45)',
              background: scope.key === active ? 'rgba(90,170,255,.18)' : 'rgba(8,12,24,.55)',
              color: scope.key === active ? '#9fd8ff' : 'rgba(170,190,220,.85)',
            },
          }, `${scopeLabel(scope)} ${scope.facts + scope.notes}`)),
          h('button', {
            type: 'button',
            onClick: () => setSpin(value => {
              const next = !value;
              try { window.localStorage?.setItem('omni-spin', next ? '1' : '0'); } catch { /* ignore */ }
              return next;
            }),
            style: {
              fontSize: 11, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
              border: '1px solid rgba(90,120,190,.45)', background: 'rgba(8,12,24,.55)',
              color: spin ? '#9fd8ff' : 'rgba(170,190,220,.85)',
            },
          }, spin ? t('spinOn') : t('spinOff')),
          fill ? null : h('button', {
            type: 'button',
            onClick: () => setCollapsed(value => !value),
            style: {
              marginLeft: 'auto', fontSize: 11, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
              border: '1px solid rgba(90,120,190,.45)', background: 'rgba(8,12,24,.55)',
              color: 'rgba(170,190,220,.85)',
            },
          }, collapsed ? t('graphExpand') : t('graphCollapse'))),
        (collapsed && !fill) || broken ? null : h('canvas', {
          ref: canvasRef,
          style: { display: 'block', width: '100%', height: 'calc(100% - 44px)', touchAction: 'none', cursor: 'grab' },
          onPointerDown: event => {
            const view = viewRef.current;
            view.dragging = true;
            view.downX = event.clientX;
            view.downY = event.clientY;
            view.moved = false;
            view.lastX = event.clientX;
            view.lastY = event.clientY;
            view.lastMove = Date.now();
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
          },
          onPointerLeave: () => {
            const view = viewRef.current;
            view.pointerInside = false;
            view.tooltipId = null;
            setTooltip(null);
          },
          onPointerMove: event => {
            const view = viewRef.current;
            view.pointerInside = true;
            if (view.dragging) {
              const dx = event.clientX - view.lastX;
              const dy = event.clientY - view.lastY;
              if (Math.hypot(event.clientX - view.downX, event.clientY - view.downY) > 4) view.moved = true;
              view.lastX = event.clientX;
              view.lastY = event.clientY;
              view.yaw += dx * 0.006;
              view.pitch = Math.max(-1.3, Math.min(1.3, view.pitch + dy * 0.005));
              view.vx = dx * 0.0007;
              view.vy = dy * 0.0003;
              view.lastMove = Date.now();
            } else {
              pick(event);
            }
          },
          onPointerUp: event => {
            const view = viewRef.current;
            const wasDrag = view.moved;
            view.dragging = false;
            view.lastMove = Date.now();
            if (wasDrag || !onSelect) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            let best = null;
            let bestDistance = 18;
            for (const [id, point] of view.screen) {
              const distance = Math.hypot(point.x - x, point.y - y);
              if (distance < bestDistance) { bestDistance = distance; best = id; }
            }
            if (!best) return;
            const node = dataRef.current.nodes.find(item => item.id === best);
            if (node) onSelect(node);
          },
          onPointerEnter: () => { viewRef.current.pointerInside = true; },
          onPointerLeave: () => {
            viewRef.current.pointerInside = false;
            viewRef.current.dragging = false;
            viewRef.current.tooltipId = null;
            setTooltip(null);
          },
          onWheel: event => {
            event.preventDefault();
            const view = viewRef.current;
            view.zoom = Math.max(0.45, Math.min(2.8, view.zoom * (event.deltaY > 0 ? 0.92 : 1.08)));
          },
        }),
        broken
          ? h('div', {
              style: { padding: '10px 12px', fontSize: 11, color: 'rgba(255,157,157,.9)' },
            }, t('graphFallback'))
          : null,
        (collapsed && !fill) || broken ? null : h('div', {
          style: {
            position: 'absolute', right: 12, bottom: 10, fontSize: 10,
            color: 'rgba(150,175,210,.7)', pointerEvents: 'none',
          },
        }, t('graphHint')),
        tooltip
          ? h('div', {
              style: {
                position: 'absolute', left: Math.min(tooltip.x + 12, 999), top: Math.max(44, tooltip.y - 10),
                padding: '2px 8px', borderRadius: 6, fontSize: 11, whiteSpace: 'nowrap',
                background: 'rgba(8,12,24,.92)', border: '1px solid rgba(110,170,255,.5)',
                color: 'rgba(225,238,255,.95)', pointerEvents: 'none',
              },
            }, tooltip.label)
          : null);
    }

    /**
     * The conversation footer: a one-line proof that memory is live. It reads
     * the same status route the host updates on every prompt assembly, so a
     * green dot means the last turn really did carry memory.
     */
    function MemoryTail(props) {
      const t = props.t ?? (key => key);
      const [status, setStatus] = React.useState(null);
      const [hover, setHover] = React.useState(false);

      React.useEffect(() => {
        let alive = true;
        const read = async () => {
          if (typeof document !== 'undefined' && document.hidden) return;
          try {
            const response = await fetch('/omni-memory/status', { headers: { accept: 'application/json' } });
            const body = await response.json();
            if (alive && body?.ok) setStatus(body);
          } catch { /* keep the last known state */ }
        };
        const onVisibility = () => { if (!document.hidden) read(); };
        read();
        const timer = setInterval(read, 5000);
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
        return () => {
          alive = false;
          clearInterval(timer);
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
        };
      }, []);

      if (!status) return null;
      const last = status.lastInjection ?? {};
      const fresh = Date.now() - Number(last.at ?? 0) < 60_000;
      const detail = status.autoRecall
        ? format(t('tailHover'), {
            chars: last.chars ?? 0,
            recall: last.recall ?? 0,
            notes: status.stats?.notes ?? 0,
          })
        : `${t('title')} · ${t('tailOff')}`;

      // Ambient, not a widget: a dot plus the product name. Details live in a
      // self-drawn popover above the chip, because a native title tooltip drops
      // below the window when the composer sits at the bottom of the screen.
      // Sizes are em-relative so everything follows the application font size.
      return h('div', {
        style: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
      },
        h('div', {
          style: {
            display: 'inline-flex', alignItems: 'center', gap: '0.45em',
            fontSize: 'inherit', lineHeight: 'inherit',
            color: 'var(--dsw-alias-text-tertiary, #8899aa)',
            whiteSpace: 'nowrap', cursor: 'default',
          },
        },
          h('span', {
            style: {
              width: '0.42em', height: '0.42em', borderRadius: '50%', flex: '0 0 auto',
              background: fresh
                ? 'var(--dsw-alias-state-success-primary, #3fb950)'
                : 'var(--dsw-alias-border-secondary, #2a3546)',
            },
          }),
          h('span', null, t('title'))),
        hover ? h('div', {
          style: {
            position: 'absolute', bottom: '100%', right: 0, marginBottom: 6,
            padding: '3px 8px', borderRadius: 6, whiteSpace: 'nowrap',
            fontSize: '0.9em', lineHeight: '1.5',
            background: 'var(--dsw-alias-bg-elevated, #1c2333)',
            border: '1px solid var(--dsw-alias-border-secondary, #2a3546)',
            color: 'var(--dsw-alias-text-secondary, #aab8c8)',
            boxShadow: '0 4px 14px rgba(0,0,0,.25)',
            pointerEvents: 'none', zIndex: 20,
          },
        }, detail) : null);
    }

    function MemoryIcon(props) {      const size = props && typeof props.size === 'number' ? props.size : 20;
      const active = Boolean(props && props.active);
      const stroke = active ? 'var(--dsw-alias-brand-primary, #4d6bfe)' : 'currentColor';
      return h('svg', {
        width: size, height: size, viewBox: '0 0 20 20', fill: 'none',
        'aria-hidden': 'true', focusable: 'false',
      },
        h('path', {
          d: 'M5.4 6.2c0-1.6 1.2-2.8 2.8-2.8s2.8 1.2 2.8 2.8M5.4 6.2c-1.5.3-2.6 1.6-2.6 3.2 0 1.1.5 2 1.3 2.6-.2 1.6 1 3 2.6 3 .4 0 .8-.1 1.2-.3.4.9 1.3 1.5 2.3 1.5 1.4 0 2.5-1.1 2.5-2.5 0-.3 0-.6-.1-.9.9-.5 1.5-1.5 1.5-2.6 0-1.6-1.2-2.9-2.8-3.1',
          stroke, strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M10 3.4v9.2M7.6 6.6c1.6 0 2.4.9 2.4 2.4M12.6 7.2c-1.6 0-2.6.9-2.6 2.4',
          stroke, strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        }));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Register both dictionaries and re-render on a locale switch instead of
        // freezing the labels captured at mount time.
        const disposers = [];
        for (const [locale, dict] of Object.entries(DICT)) {
          try { disposers.push(ctx.locale.register(NS, locale, dict)); } catch { /* best effort */ }
        }

        const withLocale = Component => function Localized(props) {
          const [tick, setTick] = React.useState(0);
          React.useEffect(() => {
            if (typeof ctx.locale.subscribe !== 'function') return undefined;
            const off = ctx.locale.subscribe(() => setTick(value => value + 1));
            return () => { try { off?.(); } catch { /* ignore */ } };
          }, []);
          let t = key => key;
          try { t = ctx.locale.bind(NS); } catch { /* fall back to keys */ }
          void tick;
          return h(Component, { ...props, t });
        };

        class PanelBoundary extends React.Component {
          constructor(props) {
            super(props);
            this.state = { error: null };
          }

          static getDerivedStateFromError(error) {
            return { error };
          }

          render() {
            if (this.state.error) {
              return h('div', {
                style: {
                  padding: 16, color: '#ffb4a8', background: '#0a0d16',
                  fontFamily: 'system-ui, sans-serif', fontSize: 12, lineHeight: 1.6,
                },
              }, [
                '全息记忆面板渲染失败：' + String(this.state.error?.message ?? this.state.error),
                h('div', { key: 'hint', style: { marginTop: 8, opacity: 0.7 } },
                  '先按 Ctrl+R 刷新；如果仍出现，把这段文字发给我。'),
              ]);
            }
            return this.props.children;
          }
        }

        const LocalizedView = withLocale(MemoryView);
        const BoundedView = props => h(PanelBoundary, null, h(LocalizedView, props));
        const LocalizedTail = withLocale(MemoryTail);

        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: NS,
        }, BoundedView)), 'omni-memory: main panel');

        ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'memory-tail',
          order: 3,
        }, LocalizedTail)), 'omni-memory: composer tail');

        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: NS,
          order: 20,
          label: () => {
            try { return ctx.locale.bind(NS)('title'); } catch { return '记忆'; }
          },
        }, MemoryIcon)), 'omni-memory: nav entry');

        ctx.effect(() => () => {
          for (const dispose of disposers) {
            try { dispose?.(); } catch { /* ignore */ }
          }
        }, 'omni-memory: locale cleanup');
      },
    };
  },
});
