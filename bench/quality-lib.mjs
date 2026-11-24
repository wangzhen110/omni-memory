// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Deterministic memory-quality suite.
 *
 * This is intentionally not a retrieval-only microbenchmark. It checks the
 * behaviours that make long-term memory trustworthy:
 *   - knowledge update: the new fact is active and the old fact is still in
 *     the timeline with a closed validity window;
 *   - conflict: explicit contradictions mark both notes as contested;
 *   - scope isolation: a project search never returns another project's note;
 *   - forget/restore: a tombstone disappears from active search and comes back
 *     after restore.
 *
 * The same suite is used by `bench/quality.mjs` and by the regression test, so
 * a code change cannot make the benchmark prettier than the test gate.
 */

const PROJECT_A = 'proj:quality-a#qa';
const PROJECT_B = 'proj:quality-b#qb';

function noteHits(result, id) {
  return (result.value?.hits ?? []).filter(hit => hit.kind === 'note' && String(hit.id) === String(id));
}

async function runUpdate(app, index) {
  const subject = `QualityUpdate${index}`;
  const oldValue = `旧值${index}`;
  const newValue = `新值${index}`;
  const first = await app.call('memory_write', {
    kind: 'fact', subject, relation: '状态', object: oldValue,
    text: `${subject} 状态 ${oldValue}`, scope: 'global',
  });
  const second = await app.call('memory_write', {
    kind: 'fact', subject, relation: '状态', object: newValue,
    text: `${subject} 状态 ${newValue}`, scope: 'global',
  });
  if (Number(second.value?.invalidated) !== 1) {
    throw new Error(`expected one invalidated fact, got ${second.value?.invalidated}`);
  }
  const timeline = await app.call('memory_timeline', { entity: subject, scope: 'global' });
  const entries = (timeline.value?.entries ?? []).filter(entry => entry.kind === 'fact');
  const closed = entries.filter(entry => entry.validTo !== null);
  const open = entries.filter(entry => entry.validTo === null);
  if (closed.length !== 1 || open.length !== 1) {
    throw new Error(`timeline expected 1 closed + 1 open fact, got ${closed.length}/${open.length}`);
  }
  if (closed[0].object !== oldValue || open[0].object !== newValue) {
    throw new Error('timeline did not preserve old value or expose new value');
  }
  const search = await app.call('memory_search', { query: subject, limit: 10, scope: 'global' });
  const active = (search.value?.hits ?? []).find(hit => hit.kind === 'fact' && hit.object === newValue);
  if (!active) throw new Error('new fact is not searchable by subject');
  return { firstId: first.value?.id, secondId: second.value?.id };
}

async function runConflict(app, index) {
  const token = `QualityConflict${index}`;
  const first = await app.call('memory_write', {
    kind: 'note', scope: 'global', text: `${token} 部署方式采用 Docker 容器`,
  });
  const second = await app.call('memory_write', {
    kind: 'note', scope: 'global', text: `${token} 部署方式改用裸机进程`,
    contradicts: [first.value.id],
  });
  if (!(second.value?.contestedWith ?? []).map(String).includes(String(first.value.id))) {
    throw new Error('explicit contradiction did not reference the first note');
  }
  const search = await app.call('memory_search', { query: token, limit: 10, scope: 'global' });
  const hits = (search.value?.hits ?? []).filter(hit => hit.kind === 'note');
  const firstHit = hits.find(hit => String(hit.id) === String(first.value.id));
  const secondHit = hits.find(hit => String(hit.id) === String(second.value.id));
  if (!firstHit || !secondHit) throw new Error('contradicting notes were not both retrievable');
  if (!firstHit.contested || !secondHit.contested) throw new Error('contested flag missing from search results');
  return { firstId: first.value?.id, secondId: second.value?.id };
}

async function runScope(app, index) {
  const tokenA = `QualityScopeA${index}`;
  const tokenB = `QualityScopeB${index}`;
  const a = await app.call('memory_write', { kind: 'note', scope: PROJECT_A, text: `${tokenA} A 项目专属结论` });
  const b = await app.call('memory_write', { kind: 'note', scope: PROJECT_B, text: `${tokenB} B 项目专属结论` });
  const searchA = await app.call('memory_search', { query: tokenA, limit: 10, scope: PROJECT_A });
  const searchB = await app.call('memory_search', { query: tokenB, limit: 10, scope: PROJECT_B });
  if (!noteHits(searchA, a.value.id).length) throw new Error('A note missing from A search');
  if (!noteHits(searchB, b.value.id).length) throw new Error('B note missing from B search');
  const foreignInA = (searchA.value?.hits ?? []).filter(hit => hit.kind === 'note' && String(hit.id) === String(b.value.id));
  const foreignInB = (searchB.value?.hits ?? []).filter(hit => hit.kind === 'note' && String(hit.id) === String(a.value.id));
  if (foreignInA.length || foreignInB.length) throw new Error('project-scoped search leaked a foreign note');
  return { aId: a.value?.id, bId: b.value?.id };
}

async function runForgetRestore(app, index) {
  const token = `QualityForget${index}`;
  const written = await app.call('memory_write', { kind: 'note', scope: 'global', text: `${token} 临时结论` });
  const forgotten = await app.call('memory_forget', { kind: 'note', id: written.value.id, scope: 'global' });
  if (forgotten.value?.forgotten !== true) throw new Error('forget did not mark the note');
  const hidden = await app.call('memory_search', { query: token, limit: 10, scope: 'global' });
  if (noteHits(hidden, written.value.id).length) throw new Error('tombstoned note leaked into search');
  const restored = await app.call('memory_restore', { kind: 'note', id: written.value.id, scope: 'global' });
  if (restored.value?.restored !== true) throw new Error('restore did not revive the note');
  const visible = await app.call('memory_search', { query: token, limit: 10, scope: 'global' });
  if (!noteHits(visible, written.value.id).length) throw new Error('restored note is not searchable');
  return { id: written.value?.id };
}

const RUNNERS = {
  'knowledge-update': runUpdate,
  conflict: runConflict,
  'scope-isolation': runScope,
  'forget-restore': runForgetRestore,
};

export async function runQualitySuite(app, { count = 120 } = {}) {
  if (!Number.isInteger(count) || count < 4 || count % 4 !== 0) {
    throw new Error('quality case count must be a multiple of 4');
  }
  const perCategory = count / 4;
  const started = performance.now();
  const results = [];
  const categories = Object.keys(RUNNERS);
  for (let index = 0; index < perCategory; index += 1) {
    for (const category of categories) {
      const caseStarted = performance.now();
      try {
        await RUNNERS[category](app, index);
        results.push({ category, index, ok: true, ms: performance.now() - caseStarted });
      } catch (error) {
        results.push({ category, index, ok: false, ms: performance.now() - caseStarted, error: String(error?.message ?? error) });
      }
    }
  }
  const byCategory = Object.fromEntries(categories.map(category => {
    const rows = results.filter(row => row.category === category);
    return [category, { total: rows.length, passed: rows.filter(row => row.ok).length, failed: rows.filter(row => !row.ok).length }];
  }));
  const elapsedMs = performance.now() - started;
  return {
    count: results.length,
    passed: results.filter(row => row.ok).length,
    failed: results.filter(row => !row.ok).length,
    elapsedMs: Number(elapsedMs.toFixed(1)),
    p50Ms: Number((results.map(row => row.ms).sort((a, b) => a - b)[Math.floor(results.length / 2)] ?? 0).toFixed(1)),
    byCategory,
    failures: results.filter(row => !row.ok),
  };
}
