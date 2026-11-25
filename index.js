// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
/**
 * Omni memory — host half.
 *
 * Design borrows the strongest idea from each existing system:
 *  - Anthropic: transcripts stay raw; notes are a separate, small, curated layer.
 *  - Zep/Graphiti: facts are bi-temporal. Contradiction invalidates, never deletes.
 *  - HippoRAG: entities and edges make associative recall possible.
 *  - solopup-memory: every note keeps a source pointer and a revision counter.
 *  - dsh-memento: forgetting is a tombstone, so history stays auditable.
 *
 * Retrieval fuses a lexical route (FTS5 trigram) with a vector route (hashed
 * character n-grams) using reciprocal rank fusion, the same shape Hindsight
 * uses. Nothing here touches an Agent, a Session projection, or the chat render
 * tree: preparing a live Session would blank the conversation, so this plugin
 * only reads/writes its own SQLite file.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DIM, embedText, dot, toBlob, fromBlob, tokenize } from './lib/embed.mjs';
import { backendConfig, embedRemote } from './lib/embed-provider.mjs';
import { extractCandidateTexts } from './lib/capture-rules.mjs';
import { rerankConfig, rerankRemote } from './lib/rerank-provider.mjs';
import { semanticConfig, embedSemantic } from './lib/semantic-embed.mjs';
import { createBaseSchema, createFtsTables } from './lib/schema.mjs';
import { checkForUpdate, formatUpdateNotice, readLocalVersion } from './lib/version-check.mjs';
import { bindRouteRuntime, registerRoutes } from './lib/read-routes.mjs';
import { bindToolRuntime, defineTools } from './lib/tool-definitions.mjs';

import { currentPackageVersion, DB_FILE, PROFILE_BUDGET, PROFILE_CACHE_MS, MAX_CAPTURE_CHARS, store, localToolDefinitions, HTTP_TOOL_ALLOWLIST, prepareCached, SCOPE_GLOBAL, cwdBySession, projectByAgent, projectKeyFromCwd, normalizeWorkspaceLabel, discoverWorkspaces, normalizeScopeInput, httpScope, decideScope, newScopeFlag, resolveProjectKey, ensureProjectAlias, lastJudge, pickJudgeRoute, enqueueJudge, currentProject, AUTO_RECALL_TTL_MS, lastUserByAgent, recallByAgent, lastInjection, autoRecallEnabled, now, hash, findNoteByTextIndex, openStore, hostCtx, CJK_BIGRAM, reindexBigrams, pendingVectors, vectorDropped, vectorLastDropAt, metaGet, metaSet, ensureRemoteDim, upsertVector, backfillRemoteBatch, flushPendingVectors, activeVectorDim, SEMANTIC_BATCH, SEMANTIC_MIN_COSINE, semanticState, noteSemanticFailure, clearSemanticFailure, releaseSemanticLease, dropDerivedIndexes, reindexRow, flushSemanticPending, semanticStatus, reindexSemantic, backfillVectors, transaction, acquireLease, releaseLease, forgetMemory, snapshotStore, exportBackup, importBackup, restoreMemory, insertChunk, ingestTranscript, listNoteCandidates, consolidateProblemNotes, reviewNoteCandidate, bindStoreRuntime, configureStore, setHostCtx, setLastInjection, closeStore, entityCache } from './lib/store.mjs';
export * from './lib/store.mjs';

configureStore(process.env.OMNI_HOME || process.env.DSH_HOME || path.join(homedir(), '.dsh'));

import { queryTerms, scopeClause, writeScopeForTool, auditCrossScope, rank, canonicalEntity, linkEntity, relationCardinality, setRelationCardinality, SOLUTION_STATUSES, normalizeProblemKey, solutionStatusOf, solutionFields, feedbackFields, searchProblemKey, textBlock, dreamRun, dreamProposals, dreamReplace, dreamRollback, buildSearchResult, markContradictions, lastSearchProfile, runSearch } from './lib/search.mjs';
export * from './lib/search.mjs';
import { bindSearchRuntime } from './lib/search.mjs';
function profileFactLines(db, scopeKey, budget) {
  const filter = scopeKey === null || scopeKey === undefined
    ? ''
    : scopeKey === SCOPE_GLOBAL
      ? "AND (scope = 'global' OR scope IS NULL)"
      : "AND (scope = ? OR scope = 'global' OR scope IS NULL)";
  let rows;
  try {
    rows = prepareCached(db, `
      SELECT subject, relation, object FROM facts
      WHERE deleted_at IS NULL AND valid_to IS NULL AND contested = 0 ${filter}
      ORDER BY confidence DESC, valid_from DESC LIMIT 40
    `).all(...(scopeKey && scopeKey !== SCOPE_GLOBAL ? [scopeKey] : []));
  } catch {
    return [];
  }
  if (!rows.length) return [];
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.subject}·${row.relation}`;
    const values = groups.get(key) ?? [];
    if (values.length < 3) values.push(String(row.object ?? ''));
    groups.set(key, values);
  }
  const lines = ['相关事实：'];
  let used = lines[0].length;
  for (const [key, values] of groups) {
    const [subject, relation] = key.split('·');
    const line = `${subject} · ${relation}：${values.join(' / ')}`;
    if (used + line.length > budget) break;
    used += line.length;
    lines.push(line);
  }
  return lines.length > 1 ? lines : [];
}

const PERSONA_MAX_VALUE = 1200;
const PERSONA_MAX_TOTAL = 4000;

function personaGet(db) {
  try {
    const rows = prepareCached(db, 'SELECT key, value FROM persona ORDER BY key').all();
    const out = {};
    for (const row of rows) out[String(row.key)] = String(row.value);
    return out;
  } catch {
    return {};
  }
}

/** Validate one persona map; arbitrary keys are allowed, values are plain text. */
function personaNormalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('values must be an object');
  const values = {};
  let total = 0;
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = String(rawKey).trim();
    const value = String(rawValue ?? '').trim();
    if (!key) continue;
    if (key.length > 40) throw new Error('persona key is too long');
    if (value.length > PERSONA_MAX_VALUE) throw new Error(`persona value for "${key}" is too long`);
    if (!value) continue;
    total += value.length;
    values[key] = value;
  }
  if (total > PERSONA_MAX_TOTAL) throw new Error('persona settings are too long');
  return values;
}

function personaSet(db, input, options = {}) {
  const values = personaNormalize(input);
  transaction(db, () => {
    if (options.replace !== false) db.exec('DELETE FROM persona');
    const insert = prepareCached(db, `
      INSERT INTO persona(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    for (const [key, value] of Object.entries(values)) insert.run(key, value, now());
  });
  return personaGet(db);
}

/** Evidence for persona synthesis: recent high-signal notes and active facts. */
function profileEligibleNote(row) {
  const text = String(row?.text ?? '').trim();
  const source = String(row?.source ?? '');
  if (!text) return false;
  // Imported domain knowledge is not a user rule. Keep it searchable in its own
  // project/kb layer, but never spend the always-injected profile budget on it.
  if (/^(?:专业知识|知识库|knowledge|kb)[\\/]/i.test(source)) return false;
  // Test, audit and deployment reports describe the system, not the user.
  if (/(测试结论|测试报告|审计报告|审计发现|验收报告|复审|回归测试|压测|基准测试|benchmark|隔离副本库|缺陷|本机部署|版本更新|CHANGELOG|Release)/i.test(text)) return false;
  // A knowledge-import or tooling note is an operating fact, not a standing
  // instruction. Generic project conclusions (including consolidation summaries)
  // remain eligible; only obvious support chatter is filtered.
  if (/(专业知识库|知识库已灌入|Obsidian 笔记库|GitHub push|github\.com|140\.82|CLI|工具清单|插件|面板|schema|memory_|HTTP GET|HTTP POST|JSON body|端口|API token|数据库表|ADR|busy_timeout|npm run|importance|参考手册|多客户端并发|v\d+\.\d+\.\d+|\/hub|\/m|dashboard\.css|star-map|抖音|视频|发布片)/i.test(text)
    && !/(用户偏好|铁律|长期设定|固定规则|一律|永远|禁止|不得)/i.test(text)) return false;
  return true;
}

/** Persona evidence may read ordinary notes, but never technical fragments. */
function personaEvidenceEligible(row) {
  const text = String(row?.text ?? '').trim();
  const source = String(row?.source ?? '');
  if (!text) return false;
  if (/^(?:专业知识|知识库|knowledge|kb)[\\/]/i.test(source)) return false;
  if (/(测试结论|测试报告|审计报告|审计发现|验收报告|复审|回归测试|压测|基准测试|benchmark|隔离副本库|缺陷|本机部署|版本更新|CHANGELOG|Release)/i.test(text)) return false;
  if (/(插件|面板|schema|ADR|memory_|测试|路由|接口|迁移|数据库|函数|字段|版本|用例|构建|HTTP|JSON|CLI|search|write|context|scope|proj:|note#|v\d|代码|仓库|路径|目录|审计|修复|优化|token|API)/i.test(text)) return false;
  return true;
}

function personaEvidence(db) {
  const notes = [];
  const facts = [];
  const technical = /(插件|面板|schema|ADR|memory_|测试|路由|接口|迁移|数据库|函数|字段|版本|用例|构建|HTTP)/i;
  try {
    const rows = prepareCached(db, `
      SELECT text, source FROM notes
      WHERE deleted_at IS NULL AND superseded_by IS NULL AND contested = 0
        AND (scope = 'global' OR scope IS NULL)
      ORDER BY importance DESC, ts DESC LIMIT 40
    `).all();
    for (const row of rows) {
      if (!personaEvidenceEligible(row)) continue;
      const text = String(row.text);
      if (!technical.test(text)) notes.push(text);
    }
  } catch { /* ignore */ }
  try {
    const rows = prepareCached(db, `
      SELECT subject, relation, object FROM facts
      WHERE deleted_at IS NULL AND valid_to IS NULL AND contested = 0
        AND (scope = 'global' OR scope IS NULL)
      ORDER BY confidence DESC, valid_from DESC LIMIT 80
    `).all();
    for (const row of rows) facts.push(`${row.subject} ${row.relation} ${row.object}`);
  } catch { /* ignore */ }
  const utterances = [];
  try {
    const rows = prepareCached(db, `
      SELECT text FROM chunks
      WHERE role = 'user' AND deleted_at IS NULL
        AND (scope = 'global' OR scope IS NULL)
      ORDER BY ts DESC LIMIT 100
    `).all();
    for (const row of rows) {
      const text = String(row.text);
      if (!technical.test(text) && text.length <= 600) utterances.push(text);
    }
  } catch { /* ignore */ }
  return { notes, facts, utterances };
}

const PERSONA_RELATIONS = {
  称呼: /^(称呼|名字|昵称|name)$/i,
  偏好: /(喜欢|偏好|讨厌|常用|习惯用|prefer)/i,
  习惯: /(习惯|每天|通常|定期|固定)/i,
  性格: /(性格|风格|说话)/i,
};

/** Rule extraction: works offline; the model only refines these results. */
function personaFromRules(evidence) {
  const out = {};
  const add = (key, value) => {
    const text = String(value ?? '').trim().replace(/\s+/g, ' ');
    if (!personaValueOk(text)) return;
    out[key] = out[key] ? `${out[key]}；${text}` : text;
  };
  const userSubject = /^(用户|我|user|me)$/i;
  for (const line of evidence.facts) {
    const parts = String(line).split(' ');
    if (parts.length < 3) continue;
    const subject = parts[0];
    if (!userSubject.test(subject)) continue;
    const object = parts.slice(2).join(' ');
    const relation = parts[1];
    if (PERSONA_RELATIONS.称呼.test(relation)) add('称呼', object);
    else if (PERSONA_RELATIONS.偏好.test(relation)) add('偏好', `${relation} ${object}`);
    else if (PERSONA_RELATIONS.习惯.test(relation)) add('习惯', `${relation} ${object}`);
    else if (PERSONA_RELATIONS.性格.test(relation)) add('性格', `${relation} ${object}`);
  }
  for (const note of [...evidence.utterances, ...evidence.notes]) {
    const patterns = [
      ['称呼', /(?:叫我|称呼我|可以叫我|我的名字是)[：:\s]*(?:是)?\s*([^\n。；，,]{1,20})/],
      ['性格', /(?:我的性格|回答风格|说话方式)[：:\s是为]+([^\n。；]{1,50})/],
      ['偏好', /我(?:更|最)?(?:喜欢|偏好|讨厌|不要)[^\n。；]{0,40}/],
      ['偏好', /(?:以后|今后)[^。；\n]{2,30}(?:都|统一|用|说)[^。；\n]{0,20}/],
      ['偏好', /(?:不要|别)[^。；\n]{4,30}/],
      ['习惯', /我(?:习惯|每天|通常|定期)[^\n。；]{0,40}/],
    ];
    for (const pair of patterns) {
      const key = pair[0];
      const match = String(note).match(pair[1]);
      if (match) add(key, match[1] ?? match[0]);
    }
  }
  return out;
}

const PERSONA_BAD_VALUE = /(插件|面板|schema|ADR|memory_|测试|路由|接口|迁移|数据库|函数|字段|版本|用例|构建|HTTP|JSON|body|sessionQuery|conversation|chat|flow|API|token|\/)/i;

function personaValueOk(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length < 2 || text.length > 200) return false;
  if (PERSONA_BAD_VALUE.test(text)) return false;
  // Reject heading residues and note fragments: markdown marks, em dashes,
  // blockquote/table syntax, or more than one clause separator. Those are
  // section titles copied out of a document, not a stable user setting.
  if (/[\]\[{}|*#`>]|——/.test(text)) return false;
  if ((text.match(/[。；;]/g) ?? []).length > 1) return false;
  if (/^(?:即|参见|详见|见第|第[一二三四五六七八九十\d]+[章节])/.test(text)) return false;
  return true;
}

function parsePersonaJson(text) {
  try {
    const match = String(text ?? '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const out = {};
    for (const key of ['称呼', '性格', '习惯', '偏好', '其他']) {
      const value = String(parsed[key] ?? '').trim();
      if (personaValueOk(value)) out[key] = value;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

async function personaFromModel(ctx, evidence) {
  try {
    const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined;
    if (!llm || typeof llm.stream !== 'function') return null;
    const route = await pickJudgeRoute(llm);
    if (!route) return null;
    const evidenceText = [...evidence.utterances, ...evidence.facts, ...evidence.notes]
      .map(item => `- ${String(item).replace(/\s+/g, ' ').slice(0, 160)}`)
      .join('\n')
      .slice(0, 6000);
    if (!evidenceText) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let out = '';
    try {
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system: 'Extract the long-lived settings of the user from their memory records. Fields: 称呼 (how to address them), 性格 (communication style), 习惯 (recurring routines), 偏好 (likes/dislikes), 其他. Only use facts present in the records; empty fields are allowed. Reply with a single JSON object using those keys.',
        messages: [{ role: 'user', content: [{ type: 'text', text: `records:\n${evidenceText}\nJSON:` }] }],
        maxTokens: 400,
        temperature: 0,
        signal: controller.signal,
      });
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta') out += chunk.text ?? '';
        else if (chunk?.type === 'finish') break;
      }
    } finally {
      clearTimeout(timer);
    }
    return parsePersonaJson(out);
  } catch {
    return null;
  }
}

/** Synthesize settings from everyday memory; rules first, model refinement second. */
/** Automatic persona synthesis must be explicitly opted in before it calls the host model. */
function personaModelEnabled() {
  const value = String(process.env.OMNI_PERSONA_MODEL ?? 'off').toLowerCase();
  return value === 'auto' || value === 'on' || value === '1';
}

async function personaRefresh(ctx, options = {}) {
  const s = openStore();
  const evidence = personaEvidence(s.db);
  const rules = personaFromRules(evidence);
  const model = options.model === true ? await personaFromModel(ctx ?? hostCtx, evidence) : null;
  const existing = personaGet(s.db);
  const merged = { ...existing, ...rules, ...model };
  const source = model ? 'model' : 'rules';
  const applied = options.apply === true && Object.keys(merged).length > 0;
  if (applied) {
    // Merge instead of replacing: a refresh that only found a preference must not
    // erase the user's hand-written name or custom fields.
    personaSet(s.db, merged, { replace: false });
    metaSet(s.db, 'persona_updated_at', now());
    metaSet(s.db, 'persona_source', source);
  }
  return {
    persona: options.apply === true ? personaGet(s.db) : merged,
    source,
    applied,
    modelUsed: Boolean(model),
    evidence: evidence.utterances.length + evidence.notes.length + evidence.facts.length,
  };
}

/** Occasionally re-derive persona from everyday memory (never blocks a write). */
function maybeRefreshPersona(ctx) {
  try {
    if (typeof ctx?.get !== 'function' || !ctx.get('llm')) return;
    const s = openStore();
    const pending = Number(metaGet(s.db, 'persona_pending') ?? 0) + 1;
    const last = Number(metaGet(s.db, 'persona_updated_at') ?? 0);
    if (pending < 20 || now() - last < 3_600_000) {
      metaSet(s.db, 'persona_pending', pending);
      return;
    }
    metaSet(s.db, 'persona_pending', 0);
    setTimeout(() => {
      void personaRefresh(ctx, { apply: true, model: personaModelEnabled() }).catch(() => {});
    }, 0);
  } catch { /* best effort */ }
}

/** Prompt lines for the always-injected persona block, kept short and explicit. */

function personaLines(db) {
  const values = personaGet(db);
  const keys = Object.keys(values);
  if (!keys.length) return [];
  const lines = ['用户长期设定（来自面板，高于临时指令）：'];
  for (const key of keys) {
    const line = `- ${key}：${String(values[key]).replace(/\s+/g, ' ').slice(0, 300)}`;
    lines.push(line);
  }
  return lines;
}

/** Join profile lines and enforce the budget on the final string, separators included. */
function capProfileLines(lines) {
  let text = lines.join('\n');
  while (text.length > PROFILE_BUDGET && lines.length) {
    lines.pop();
    text = lines.join('\n');
  }
  // Budget pressure must not leave a section heading with no rows beneath it.
  while (lines.length && /^##\s/.test(lines[lines.length - 1])) {
    lines.pop();
    text = lines.join('\n');
  }
  return text;
}

/** Read the highest-importance notes that fit the always-injected budget. */
function buildProfileText(projectKey, options = {}) {
  const s = openStore();
  const includeAll = options.includeAll === true;
  // Filter the layer in SQL instead of taking 60 rows from every project and
  // discarding most of them in JS: a busy foreign project could otherwise crowd
  // the global notes out of the profile budget.
  const noteScope = includeAll
    ? ''
    : projectKey
      ? "AND (scope = 'global' OR scope IS NULL OR scope = ?)"
      : "AND (scope = 'global' OR scope IS NULL)";
  const rows = prepareCached(s.db,
    `SELECT id, text, importance, scope, source FROM notes
     WHERE deleted_at IS NULL AND superseded_by IS NULL AND contested = 0
       AND COALESCE(solution_status, 'unverified') NOT IN ('failed', 'expired') ${noteScope}
     ORDER BY importance DESC, ts DESC LIMIT 60`
  ).all(...(projectKey ? [projectKey] : []));
  // Global notes follow the model everywhere; project notes only in their own
  // project. Unknown project => global only, so one project cannot leak into
  // another through the always-injected block. Only stable rules and user
  // settings are eligible; searchable reports/knowledge stay out of this budget.
  const visible = includeAll ? rows : rows.filter(row => {
    const scope = String(row.scope ?? 'global');
    if (scope === 'global' || scope === '') return true;
    return projectKey ? scope === projectKey : false;
  });
  const eligible = visible.filter(row => profileEligibleNote(row));
  const lines = [];
  let used = 0;
  const addLine = line => {
    if (used + line.length > PROFILE_BUDGET) return false;
    used += line.length;
    lines.push(line);
    return true;
  };
  // Layered profile: global rules first, then the current project's rules.
  // The headings make the budget boundary visible instead of silently mixing
  // two layers into one undifferentiated bullet list.
  const globalRows = eligible.filter(row => String(row.scope ?? SCOPE_GLOBAL) === SCOPE_GLOBAL);
  const projectRows = projectKey
    ? eligible.filter(row => String(row.scope ?? SCOPE_GLOBAL) === projectKey)
    : [];
  const addSection = (title, items) => {
    if (!items.length) return;
    // Don't spend budget on a heading unless at least one row can follow it.
    if (used + title.length + `- ${items[0].text}`.length > PROFILE_BUDGET) return;
    addLine(title);
    for (const row of items) {
      if (addLine(`- ${row.text}`) === false) break;
    }
  };
  addSection('## 全局', globalRows);
  addSection('## 当前项目', projectRows);
  if (includeAll) {
    const otherRows = eligible.filter(row => {
      const scope = String(row.scope ?? SCOPE_GLOBAL);
      return scope !== SCOPE_GLOBAL && scope !== projectKey;
    });
    addSection('## 其他项目', otherRows);
  }

  for (const line of profileFactLines(s.db, projectKey || SCOPE_GLOBAL, PROFILE_BUDGET - used)) {
    const withBullet = line === '相关事实：' ? line : `- ${line}`;
    if (addLine(withBullet) === false) break;
  }
  return capProfileLines(lines);
}

const PACKET_BUDGET = 1800;

/**
 * Build the text a host with no prompt hook can splice in before a turn.
 *
 * This is deliberately transport-neutral: `memory_context` (MCP/CLI) and
 * `GET /omni-memory/packet` (browser/sidecar) return the same shape, while
 * `POST /omni-memory/tool` exposes the callable half to OpenAPI clients.
 */
async function buildMemoryPacket(scope, query, options = {}) {
  const limit = Math.min(10, Math.max(1, Number(options.limit ?? 5) || 5));
  const budget = Math.min(4000, Math.max(400, Number(options.budget ?? PACKET_BUDGET) || PACKET_BUDGET));
  const localVersion = currentPackageVersion();
  const versionPromise = checkForUpdate({
    localVersion: localVersion === '0.0.0' ? undefined : localVersion,
  }).catch(() => null);
  const s = openStore();
  const persona = personaLines(s.db);
  const personaBody = persona.length ? persona.slice(1).join('\n').trim() : '';
  // `project` means "all project layers" for search, but the profile has no
  // single project to prefer, so it falls back to the global profile.
  const profileScope = scope && scope !== 'project' && scope !== 'all' ? scope : null;
  const profile = buildProfileText(profileScope).trim();
  const search = query ? await runSearch(s, query, limit, scope) : { hits: [] };
  const version = await versionPromise;
  const updateNotice = formatUpdateNotice(version);
  const hits = (search.hits ?? [])
    .filter(hit => hit.kind !== 'note' || !['failed', 'expired'].includes(String(hit.solutionStatus ?? 'unverified')))
    .slice(0, limit);
  const sections = [];
  if (updateNotice) sections.push(updateNotice);
  if (personaBody) sections.push('## 用户设定\n' + personaBody);
  if (profile && profile !== 'memory is empty') sections.push('## 常驻画像\n' + profile);
  if (hits.length) {
    sections.push('## 与当前任务相关\n' + hits.map(hit => {
      const layer = hit.scope && hit.scope !== 'global' ? ` · ${hit.scope}` : '';
      const flag = hit.contested ? ' · contested' : '';
      const status = hit.solutionStatus && hit.solutionStatus !== 'unverified' ? ` · ${hit.solutionStatus}` : '';
      const stale = hit.staleVersion ? ` · old:v${hit.staleVersion}` : '';
      return `- [${hit.kind}#${hit.id}] ${String(hit.text ?? '').replace(/\s+/g, ' ').slice(0, 220)}${layer}${status}${stale}${flag}`;
    }).join('\n'));
  }
  if (!sections.length) {
    return { text: '', chars: 0, hits: 0, truncated: false, memories: [], update: null };
  }
  sections.push('以上内容可能过时。涉及删除、覆盖、外部发送等不可逆动作前，先 memory_search 复核。');
  const full = sections.join('\n\n');
  const text = full.length > budget ? full.slice(0, budget) : full;
  return {
    text,
    chars: text.length,
    hits: hits.length,
    truncated: text.length < full.length,
    memories: hits.map(hit => ({
      kind: hit.kind, id: hit.id, scope: hit.scope ?? null,
      solutionStatus: hit.solutionStatus ?? null, contested: Boolean(hit.contested),
      text: String(hit.text ?? '').slice(0, 220),
    })),
    update: version?.updateAvailable ? {
      localVersion: version.localVersion,
      remoteVersion: version.remoteVersion,
      checkedAt: version.checkedAt,
      source: version.source,
    } : null,
  };
}

/** OpenAPI document for the plain-HTTP host adapter. */
const HOST_OPENAPI = {
  openapi: '3.0.3',
  info: {
    title: 'Omni Memory host adapter',
    version: '1.0.0',
    description: 'Loopback-only REST adapter for hosts without MCP. GET /packet returns prompt-ready context; POST /tool exposes the non-destructive memory tool subset. Writes require x-omni-csrf: 1.',
  },
  servers: [{ url: 'http://127.0.0.1:7788' }],
  paths: {
    '/omni-memory/packet': {
      get: {
        summary: 'Prompt-ready memory packet',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Current task text; omit for profile only.' },
          { name: 'scope', in: 'query', schema: { type: 'string' }, description: 'all, project, global, or one exact project key.' },
          { name: 'cwd', in: 'query', schema: { type: 'string' }, description: 'Derive the project layer from a working directory when scope is omitted.' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 10, default: 5 } },
          { name: 'budget', in: 'query', schema: { type: 'integer', minimum: 400, maximum: 4000, default: 1800 } },
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'text'], default: 'json' } },
        ],
        responses: { 200: { description: 'Packet JSON, or plain text when format=text' } },
      },
    },
    '/omni-memory/search': {
      get: {
        summary: 'Hybrid memory search',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 60, default: 30 } },
          { name: 'scope', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Ranked hits' } },
      },
    },
    '/omni-memory/list': {
      get: { summary: 'Browse memories', parameters: [
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 40 } },
        { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
        { name: 'scope', in: 'query', schema: { type: 'string' } },
      ], responses: { 200: { description: 'Memory list and stats' } } },
    },
    '/omni-memory/node': {
      get: { summary: 'One entity or note detail', parameters: [
        { name: 'node', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'scope', in: 'query', schema: { type: 'string' } },
      ], responses: { 200: { description: 'Node detail' } } },
    },
    '/omni-memory/status': {
      get: { summary: 'Runtime status', responses: { 200: { description: 'Status' } } },
    },
    '/omni-memory/consolidate': {
      post: {
        summary: 'Consolidate notes sharing one problemKey',
        description: 'Requires x-omni-csrf: 1. Dry-run unless apply=1; applying supersedes the source notes, never deletes them.',
        parameters: [
          { name: 'problemKey', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'scope', in: 'query', schema: { type: 'string' }, description: 'One exact global/project key; all and project are rejected.' },
          { name: 'minNotes', in: 'query', schema: { type: 'integer', minimum: 2, maximum: 10, default: 2 } },
          { name: 'apply', in: 'query', schema: { type: 'boolean', default: false } },
        ],
        responses: { 200: { description: 'Dry-run or applied summary' }, 403: { description: 'Missing CSRF header or non-loopback caller' } },
      },
    },
    '/omni-memory/ingest': {
      post: {
        summary: 'Ingest one transcript turn from any host',
        description: 'Requires x-omni-csrf: 1. Writes a chunk and parks at most three candidates; never writes a note directly.',
        parameters: [
          { name: 'text', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'role', in: 'query', schema: { type: 'string', enum: ['user', 'assistant', 'system', 'tool', 'note'], default: 'user' } },
          { name: 'sessionId', in: 'query', schema: { type: 'string' } },
          { name: 'source', in: 'query', schema: { type: 'string' } },
          { name: 'cwd', in: 'query', schema: { type: 'string' } },
          { name: 'scope', in: 'query', schema: { type: 'string' } },
          { name: 'importance', in: 'query', schema: { type: 'number', minimum: 0, maximum: 1 } },
          { name: 'extract', in: 'query', schema: { type: 'boolean', default: true } },
        ],
        responses: { 200: { description: 'Chunk id, scope and pending candidates' }, 403: { description: 'Missing CSRF header or non-loopback caller' } },
      },
    },
    '/omni-memory/candidates': {
      get: {
        summary: 'List extracted note candidates',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'all'], default: 'pending' } },
          { name: 'scope', in: 'query', schema: { type: 'string' } },
          { name: 'cwd', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        ],
        responses: { 200: { description: 'Candidate queue' } },
      },
    },
    '/omni-memory/candidate': {
      post: {
        summary: 'Accept or reject one candidate',
        description: 'Requires x-omni-csrf: 1. Accepting writes a normal note with the chunk source; review is scoped by default.',
        parameters: [
          { name: 'id', in: 'query', required: true, schema: { type: 'integer' } },
          { name: 'action', in: 'query', required: true, schema: { type: 'string', enum: ['accept', 'reject'] } },
          { name: 'scope', in: 'query', schema: { type: 'string' } },
          { name: 'cwd', in: 'query', schema: { type: 'string' } },
          { name: 'reason', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Review result' }, 403: { description: 'Missing CSRF header or non-loopback caller' } },
      },
    },
    '/omni-memory/tool': {
      post: {
        summary: 'Call one allowlisted memory tool',
        description: 'Requires header x-omni-csrf: 1. Names: memory_write, memory_search, memory_solution_report, memory_feedback, memory_get, memory_amend, memory_profile, memory_timeline.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object', required: ['name'], additionalProperties: false,
            properties: {
              name: { type: 'string', enum: [...HTTP_TOOL_ALLOWLIST] },
              arguments: { type: 'object', additionalProperties: true },
            },
          } } },
        },
        responses: { 200: { description: 'Tool value and rendered text' }, 403: { description: 'Missing CSRF header or non-loopback caller' } },
      },
    },
  },
};

const profileCache = new Map();

function cachedProfile(projectKey) {
  const key = projectKey || 'global';
  const cached = profileCache.get(key);
  const nowMs = now();
  if (cached && nowMs - cached.at < PROFILE_CACHE_MS) return cached.text;
  let text = '';
  try {
    text = buildProfileText(projectKey);
  } catch {
    text = '';
  }
  profileCache.set(key, { text, at: nowMs });
  return text;
}

function invalidateProfile() {
  profileCache.clear();
}

function inboxText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').trim();
}

/** Precompute recall for an incoming user message; never blocks the turn. */
async function precomputeRecall(agentId, text) {
  try {
    const project = projectByAgent.get(agentId) ?? SCOPE_GLOBAL;
    const result = await runSearch(openStore(), text, 3, project);
    // Dead ends and expired advice are useful when explicitly searched for, but
    // must not be injected as recommendations into the next turn.
    const hits = result.hits.filter(hit => hit.kind !== 'note'
      || !['failed', 'expired'].includes(String(hit.solutionStatus ?? 'unverified')));
    recallByAgent.set(agentId, { hits, query: text, at: now(), project });
  } catch { /* recall is best effort */ }
}

function projectForAgentId(agentId) {
  const id = String(agentId ?? '');
  if (!id) return null;
  const known = projectByAgent.get(id);
  if (known) return known;
  const cwd = cwdBySession.get(id);
  if (cwd) {
    try { return resolveProjectKey(openStore().db, cwd); } catch { /* fall through to persisted map */ }
  }
  // Survive a plugin reload: the mapping is persisted when it is learned.
  try {
    const stored = metaGet(openStore().db, `agent_project:${id}`);
    if (stored) {
      projectByAgent.set(id, stored);
      return stored;
    }
  } catch { /* store unavailable */ }
  return null;
}

/**
 * Resolve the project for one prompt assembly.
 *
 * `AssembleContext.scope` is an opaque ScopeKey. If it cannot be resolved, only
 * the global layer may be injected. The previous fallback to the last project
 * seen anywhere turned a concurrent or unknown session into a cross-project
 * leak, so it is deliberately gone.
 */
function projectForScope(scope) {
  const id = scope?.id ? String(scope.id) : '';
  if (!id) return null;
  const known = projectForAgentId(id);
  if (known) return known;
  const exact = cwdBySession.get(id);
  if (exact) {
    try {
      const project = resolveProjectKey(openStore().db, exact);
      if (project !== SCOPE_GLOBAL) return project;
    } catch { /* fall through to prefix matching */ }
  }
  // The host may hand over a truncated or opaque id (for example `session-b707`).
  // Match it only when both ids share at least 12 characters AND exactly one
  // captured session matches; an ambiguous prefix must fail closed instead of
  // guessing another project's layer.
  const matches = [];
  let db;
  try { db = openStore().db; } catch { db = undefined; }
  for (const [sessionId, cwd] of cwdBySession) {
    const common = Math.min(sessionId.length, id.length);
    if (common < 12) continue;
    if (!sessionId.startsWith(id) && !id.startsWith(sessionId)) continue;
    const project = db ? resolveProjectKey(db, cwd) : projectKeyFromCwd(cwd);
    if (project !== SCOPE_GLOBAL && !matches.includes(project)) matches.push(project);
  }
  return matches.length === 1 ? matches[0] : null;
}

function rememberUserMessage(agent, message) {
  try {
    const agentId = String(agent?.id ?? '');
    if (!agentId) return;
    const text = inboxText(message);
    if (!text) return;
    lastUserByAgent.set(agentId, { text, at: now() });
    const cwd = cwdBySession.get(agentId);
    if (cwd) {
      const db = openStore().db;
      const project = resolveProjectKey(db, cwd);
      projectByAgent.set(agentId, project);
      try { metaSet(db, `agent_project:${agentId}`, project); } catch { /* best effort */ }
    }
    if (!autoRecallEnabled()) return;
    void precomputeRecall(agentId, text);
  } catch { /* never break the loop */ }
}

function recallFor(scope) {
  if (!autoRecallEnabled()) return null;
  const agentId = String(scope?.id ?? '');
  if (!agentId) return null;
  const entry = recallByAgent.get(agentId);
  if (!entry) return null;
  if (now() - entry.at > AUTO_RECALL_TTL_MS) return null;
  const project = projectForScope({ id: agentId }) ?? SCOPE_GLOBAL;
  if (entry.project && entry.project !== project) return null;
  return entry;
}

function messageText(data) {
  const blocks = Array.isArray(data?.message?.content) ? data.message.content : [];
  return blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').trim();
}

/**
 * Capture committed session events into the transcript layer. This listens to
 * the post-commit feed only: it never prepares a Session, never reads a
 * projection, and never blocks the turn.
 */
function captureEvent(session, event) {
  try {
    const type = String(event?.type ?? '');
    if (type !== 'user/message' && type !== 'assistant/message') return;
    const text = messageText(event.data);
    if (!text) return;
    const sessionId = String(session?.id ?? '');
    const scope = scopeForSession(session);
    const role = type === 'user/message' ? 'user' : 'assistant';
    const source = `session:${sessionId}#${String(event.seq ?? '')}`;
    if (scope && scope !== SCOPE_GLOBAL && sessionId) {
      try { metaSet(openStore().db, `agent_project:${sessionId}`, scope); } catch { /* best effort */ }
    }
    insertChunk(openStore(), {
      text: text.length > MAX_CAPTURE_CHARS ? text.slice(0, MAX_CAPTURE_CHARS) : text,
      role,
      ts: Number(event.time ?? now()),
      sessionId,
      source,
      importance: role === 'user' ? 0.6 : 0.4,
      scope,
    });
  } catch { /* capture must never break a turn */ }
}

/** Resolve (and remember) the project scope of a session from its workspace. */
function scopeForSession(session) {
  const sessionId = String(session?.id ?? '');
  const cwd = session?.header?.cwd;
  if (cwd) cwdBySession.set(sessionId, String(cwd));
  const known = cwdBySession.get(sessionId);
  if (!known) return SCOPE_GLOBAL;
  try {
    const db = openStore().db;
    ensureProjectAlias(db, known);
    return resolveProjectKey(db, known);
  } catch {
    return projectKeyFromCwd(known);
  }
}

/** Capture: transcript ingest, candidate review and consolidation. */

export const inject = ['tools'];

/** Whether the optional HTTP route surface has been attached yet. */
let routeState = { status: 'pending', count: 0, at: 0, error: null };

function serviceFrom(ctx, name) {
  if (!ctx) return undefined;
  if (typeof ctx.get === 'function') {
    try {
      const value = ctx.get(name);
      if (value !== undefined) return value;
    } catch { /* service not ready */ }
  }
  return ctx[name];
}

/**
 * Register an optional service only when the host can provide it.
 *
 * Cordis hosts activate optional services (webServer, systemPrompt) after
 * plugins, so a one-shot `ctx.get()` races the service and silently drops the
 * route/profile surface. `ctx.inject([name], cb)` waits for the service. Hosts
 * without that API (the lightweight test/MCP shims) fall back to the old
 * immediate lookup.
 */
function registerWhenAvailable(ctx, name, register) {
  let dispose;
  let stopped = false;
  const started = Date.now();
  const timers = [];
  const debugEnabled = String(process.env.OMNI_ROUTE_DEBUG ?? '') === '1';
  const debug = message => {
    if (!debugEnabled) return;
    try {
      appendFileSync(
        path.join(process.env.TEMP || '.', 'omni-route-debug.log'),
        `${new Date().toISOString()} ${name}: ${message}\n`,
      );
    } catch { /* diagnostics must never break apply */ }
  };

  const attach = candidate => {
    if (stopped || typeof dispose === 'function') return true;
    let service;
    try {
      // Never read service members from the context proxy without injection:
      // Cordis guards those reads. A context exposes `get`; a service does not.
      service = (candidate && typeof candidate.get === 'function')
        ? serviceFrom(candidate, name)
        : candidate;
    } catch { return false; }
    if (!service) return false;
    try {
      const value = register(service);
      if (typeof value === 'function') {
        dispose = value;
        debug(`registered after ${Date.now() - started}ms`);
        return true;
      }
      debug('register returned no disposer');
    } catch (error) {
      debug(`register failed: ${error?.message ?? error}`);
    }
    return false;
  };

  // The service may already be active when the plugin is (re)loaded.
  attach(ctx);

  let off;
  if (typeof dispose !== 'function' && ctx && typeof ctx.inject === 'function') {
    try {
      off = ctx.inject([name], inner => {
        debug('inject fired');
        attach(inner);
      });
    } catch (error) {
      debug(`inject threw: ${error?.message ?? error}`);
    }
  }

  // Cold start: the host may activate the service well after this plugin.
  // Poll for up to a minute; the host is fully booted long before that and the
  // first successful attach stops the loop.
  const schedule = delay => {
    const timer = setTimeout(() => {
      if (stopped || typeof dispose === 'function') return;
      if (attach(ctx)) return;
      const elapsed = Date.now() - started;
      if (elapsed < 60_000) schedule(500);
      else debug(`gave up after ${elapsed}ms`);
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    timers.push(timer);
  };
  if (typeof dispose !== 'function') {
    debug('not ready at apply; polling');
    schedule(250);
  }

  return () => {
    stopped = true;
    for (const timer of timers) {
      try { clearTimeout(timer); } catch { /* already gone */ }
    }
    try {
      if (typeof off === 'function') off();
      else off?.dispose?.();
    } catch { /* already gone */ }
    try { dispose?.(); } catch { /* already gone */ }
    dispose = undefined;
  };
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Host names a local service may answer for.
 *
 * A browser request is not authenticated by the socket alone: a DNS-rebinding
 * page also reaches 127.0.0.1. The Host header is the one field the page cannot
 * choose, so it must be one of the loopback names, an explicitly configured
 * bind address, or an operator-supplied allowlist.
 */
function trustedHostNames() {
  const names = new Set(['127.0.0.1', 'localhost', '::1']);
  const add = raw => {
    const value = String(raw ?? '').trim().toLowerCase();
    if (!value || value === '0.0.0.0' || value === '::' || value === '*') return;
    const hostname = value.startsWith('[')
      ? value.slice(1, value.indexOf(']'))
      : value.split(':')[0];
    if (hostname) names.add(hostname);
  };
  for (const item of String(process.env.OMNI_TRUSTED_HOSTS ?? '').split(',')) add(item);
  add(process.env.OMNI_HTTP_BIND);
  return names;
}

function requestHostName(req) {
  const raw = String(req.headers?.host ?? '').trim().toLowerCase();
  if (!raw) return null;
  try {
    const parsed = new URL(`http://${raw}`);
    return parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

function hostHeaderAllowed(req) {
  const name = requestHostName(req);
  return Boolean(name && trustedHostNames().has(name));
}

/**
 * Request-forgery guard for mutating routes.
 *
 * A browser sends Origin on cross-site POSTs; a local non-browser client may
 * omit it. An Origin is accepted only when its host is both the request Host
 * and a trusted local host name. The old check compared Origin with Host alone,
 * which let `Host: attacker.example` authenticate `Origin: attacker.example`
 * after DNS rebinding. The explicit CSRF header remains necessary because a
 * malicious page cannot send it without a CORS preflight this server never
 * grants.
 */
function sameOrigin(req) {
  if (String(req.headers?.['sec-fetch-site'] ?? '').trim().toLowerCase() === 'cross-site') return false;
  const origin = String(req.headers?.origin ?? '').trim();
  if (!origin) return true;
  if (!hostHeaderAllowed(req)) return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  const requestHost = String(req.headers?.host ?? '').trim().toLowerCase();
  return parsed.host.toLowerCase() === requestHost;
}

function mutationAllowed(req) {
  if (!sameOrigin(req)) return false;
  return String(req.headers?.['x-omni-csrf'] ?? '') === '1';
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Read a small JSON request body; never trusts its size or shape. */
function httpBodyError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function readJsonBody(req, limit = 8192, options = {}) {
  const strict = options.strict === true;
  const allowMissing = options.allowMissing !== false;
  return new Promise((resolve, reject) => {
    if (!req || typeof req.on !== 'function' || req.complete === true || req.readable === false) {
      if (strict && !allowMissing) {
        reject(httpBodyError('body_unavailable', 'request body is not readable', 400));
      } else {
        resolve({});
      }
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (code, message, status = 400) => {
      if (settled) return;
      settled = true;
      if (strict) reject(httpBodyError(code, message, status));
      else resolve({});
    };
    const done = () => {
      if (settled) return;
      const bytes = Buffer.concat(chunks);
      if (!bytes.length) {
        fail('body_empty', 'request body is empty', 400);
        return;
      }
      settled = true;
      let parsed;
      try {
        parsed = JSON.parse(bytes.toString('utf8'));
      } catch {
        if (strict) reject(httpBodyError('body_invalid_json', 'request body must be valid JSON', 400));
        else resolve({});
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        if (strict) reject(httpBodyError('body_invalid_object', 'request body must be a JSON object', 400));
        else resolve({});
        return;
      }
      resolve(parsed);
    };
    req.on('data', chunk => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      chunks.push(buffer);
      size += buffer.length;
      if (size > limit) {
        fail('body_too_large', `request body exceeds ${limit} bytes`, 413);
        if (typeof req.resume === 'function') {
          try { req.resume(); } catch { /* best effort drain */ }
        }
      }
    });
    req.on('end', done);
    req.on('error', () => fail('body_unavailable', 'request body could not be read', 400));
  });
}

/**
 * Count rows into fixed weekly buckets. The cumulative baseline is the count
 * strictly before the first bucket, matching the in-memory implementation.
 */
function weeklyBuckets(s, table, column, active, params, startMs, weekMs, buckets) {
  const endMs = startMs + weekMs * buckets;
  const base = Number(prepareCached(s.db,
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${active} AND ${column} < ?`
  ).get(...params, startMs).n ?? 0);
  const values = Array(buckets).fill(0);
  const rows = prepareCached(s.db, `
    SELECT CAST((${column} - ?) / ? AS INTEGER) AS bucket, COUNT(*) AS n
    FROM ${table}
    WHERE ${active} AND ${column} >= ? AND ${column} < ?
    GROUP BY bucket ORDER BY bucket
  `).all(startMs, weekMs, ...params, startMs, endMs);
  for (const row of rows) {
    const index = Number(row.bucket);
    if (index >= 0 && index < buckets) values[index] = Number(row.n);
  }
  return { values, base };
}

/** Per-local-day counts, using the same wall-clock day key as the UI heatmap. */
function dailyBuckets(s, table, column, active, params, dayStartMs, dayEndMs) {
  return prepareCached(s.db, `
    SELECT date(${column} / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS n
    FROM ${table}
    WHERE ${active} AND ${column} >= ? AND ${column} < ?
    GROUP BY day
  `).all(...params, dayStartMs, dayEndMs).map(row => [row.day, Number(row.n)]);
}

/** Packet, candidate queue, browser list, overview, graph and node. */
export function attachSession(sessionId, cwd) {
  const id = String(sessionId ?? '').trim();
  if (!id) return null;
  const raw = String(cwd ?? '').trim();
  let project = raw ? projectKeyFromCwd(raw) : SCOPE_GLOBAL;
  if (raw) cwdBySession.set(id, raw);
  try {
    const db = openStore().db;
    if (raw) {
      ensureProjectAlias(db, raw);
      project = resolveProjectKey(db, raw);
    }
    metaSet(db, `agent_project:${id}`, project);
  } catch { /* best effort */ }
  projectByAgent.set(id, project);
  return project;
}
bindStoreRuntime({
  scopeClause, relationCardinality, normalizeProblemKey, projectForScope, invalidateProfile,
});

bindSearchRuntime({ invalidateProfile });

bindRouteRuntime({
  DB_FILE, HOST_OPENAPI, HTTP_TOOL_ALLOWLIST, MAX_CAPTURE_CHARS, PACKET_BUDGET, SCOPE_GLOBAL,
  activeVectorDim, auditCrossScope, autoRecallEnabled, buildMemoryPacket, buildSearchResult,
  consolidateProblemNotes, currentPackageVersion, dailyBuckets, discoverWorkspaces, dreamProposals,
  dreamReplace, dreamRollback, forgetMemory, hash, httpScope, ingestTranscript, invalidateProfile,
  isLoopback, json, listNoteCandidates, localToolDefinitions, metaSet, mutationAllowed,
  normalizeScopeInput, normalizeWorkspaceLabel, now, openStore, personaGet, personaRefresh, personaSet,
  prepareCached, pendingVectors, projectByAgent, queryTerms, readJsonBody, resolveProjectKey, restoreMemory,
  routeState, runSearch, scopeClause, semanticStatus, serviceFrom, snapshotStore, solutionStatusOf, weeklyBuckets,
  getStore: () => store,
  getLastInjection: () => lastInjection,
  getLastSearchProfile: () => lastSearchProfile,
  getLastJudge: () => lastJudge,
  getVectorDropped: () => vectorDropped,
  getVectorLastDropAt: () => vectorLastDropAt,
  getHostCtx: () => hostCtx,
});

bindToolRuntime({
  DB_FILE, PROFILE_BUDGET, SCOPE_GLOBAL, SOLUTION_STATUSES, auditCrossScope, backfillRemoteBatch,
  ingestTranscript, listNoteCandidates, consolidateProblemNotes, reviewNoteCandidate, backfillVectors, buildProfileText, buildSearchResult, canonicalEntity, currentProject, decideScope,
  dreamProposals, dreamReplace, dreamRollback, dreamRun, dropDerivedIndexes, enqueueJudge, ensureRemoteDim,
  entityCache, exportBackup, feedbackFields, findNoteByTextIndex, flushPendingVectors, forgetMemory, hash,
  importBackup, insertChunk, invalidateProfile, json, linkEntity, localToolDefinitions, markContradictions,
  maybeRefreshPersona, newScopeFlag, normalizeProblemKey, normalizeScopeInput, now, openStore, pendingVectors,
  personaGet, personaRefresh, personaSet, prepareCached, queryTerms, rank, reindexBigrams, reindexRow,
  reindexSemantic, relationCardinality, resolveProjectKey, restoreMemory, runSearch, scopeClause,
  searchProblemKey, setRelationCardinality, solutionFields, solutionStatusOf, textBlock, transaction,
  writeScopeForTool,
  getHostCtx: () => hostCtx,
});


export function apply(ctx) {
  setHostCtx(ctx);
  ctx.effect(() => {
    const disposers = defineTools(ctx);
    return () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* already gone */ }
      }
    };
  }, 'omni-memory: tools');

  ctx.effect(() => {
    return registerWhenAvailable(ctx, 'webServer', inner => registerRoutes(inner));
  }, 'omni-memory: routes');

  // Transcript capture: post-commit feed only. Reading a Session projection or
  // preparing one here would blank the live conversation.
  ctx.effect(() => {
    if (typeof ctx.on !== 'function') return undefined;
    const dispose = ctx.on('session/event', (session, event) => captureEvent(session, event));
    return () => { try { dispose?.(); } catch { /* ignore */ } };
  }, 'omni-memory: capture');

  // Auto-recall input: capture the user message as it is claimed into a turn, so
  // the synchronous prompt provider has something to recall against.
  ctx.effect(() => {
    if (typeof ctx.on !== 'function') return undefined;
    const dispose = ctx.on('agent/inbox/claimed', payload => {
      rememberUserMessage(payload?.agent, payload?.message);
    });
    return () => { try { dispose?.(); } catch { /* ignore */ } };
  }, 'omni-memory: auto recall');

  // Always-injected profile: a small, cached block of the strongest notes, plus
  // the precomputed recall for this request when the switch is on.
  ctx.effect(() => {
    return registerWhenAvailable(ctx, 'systemPrompt', inner => {
      const prompt = (inner && typeof inner.section === 'function')
        ? inner
        : serviceFrom(inner, 'systemPrompt');
      if (!prompt || typeof prompt.section !== 'function') return undefined;
      const dispose = prompt.section({
      name: 'omni-memory',
      order: 600,
      text: assemblyContext => {
        const project = projectForScope(assemblyContext?.scope);
        const lines = [];
        try {
          lines.push(...personaLines(openStore().db));
        } catch { /* persona is optional */ }
        const body = cachedProfile(project);
        if (body) {
          lines.push('Long-term memory from earlier sessions. It may be stale; confirm with memory_search before relying on it for a destructive or irreversible action.');
          lines.push(body);
        }
        if (project) {
          lines.push(`Current project scope: ${project}. Pass it as \`scope\` to memory_write/memory_search for project-only knowledge; omit it for cross-project rules.`);
        }
        const recalled = recallFor(assemblyContext?.scope);
        const safeHits = (recalled?.hits ?? []).filter(hit => !hit.contested && !hit.superseded_by);
        if (safeHits.length) {
          lines.push('Recalled for this request (ranked by the same hybrid search; verify before acting on it):');
          for (const hit of safeHits.slice(0, 3)) {
            lines.push(`- [${hit.kind}#${hit.id}] ${String(hit.text).replace(/\s+/g, ' ').slice(0, 180)}`);
          }
        }
        // The budget applies to the whole injected section, including the header,
        // project line and recalled hits -- not just the profile body.
        let text = lines.join('\n');
        if (text.length > PROFILE_BUDGET) {
          const withoutRecall = lines.filter(line => !line.startsWith('Recalled for this request') && !line.startsWith('- ['));
          text = withoutRecall.join('\n').slice(0, PROFILE_BUDGET);
        }
        setLastInjection({
          at: now(),
          chars: text.length,
          recall: safeHits.length,
          auto: autoRecallEnabled(),
          project: project ?? SCOPE_GLOBAL,
          // Diagnostics: whether the optional HTTP route surface was attached.
          routes: routeState.status,
          // Diagnostics: whether the assembly handed us a usable scope id at all.
          scopeId: assemblyContext?.scope?.id ? String(assemblyContext.scope.id).slice(0, 12) : null,
        });
        return text;
      },
    });
    return () => { try { dispose?.(); } catch { /* ignore */ } };
    });
  }, 'omni-memory: prompt section');

  // Optional offline consolidation. Off by default: a background verifier that
  // costs model calls or disk churn must be an explicit choice.
  ctx.effect(() => {
    const intervalMs = Number(process.env.OMNI_DREAM_INTERVAL_MS ?? 0);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0 || typeof setInterval !== 'function') return undefined;
    const timer = setInterval(() => {
      try {
        const s = openStore();
        // Several hosts can run this timer at once. The lease makes it one
        // verification pass per interval across the whole machine instead of one
        // per open window.
        const dreamLease = acquireLease(s.db, 'dream', intervalMs);
        if (!dreamLease) return;
        try { dreamRun(s, true); } finally { releaseLease(s.db, 'dream', dreamLease); }
      } catch { /* never break the host */ }
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, 'omni-memory: dream timer');

  ctx.effect(() => () => {
    if (store) releaseSemanticLease(store);
    closeStore();
  }, 'omni-memory: store');
}

