// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
import { HTTP_TOOL_ALLOWLIST, PROFILE_BUDGET, PROFILE_CACHE_MS, SCOPE_GLOBAL, currentPackageVersion, hostCtx, metaGet, metaSet, now, openStore, pickJudgeRoute, prepareCached, transaction } from './store.mjs';
import { runSearch } from './search.mjs';
import { checkForUpdate, formatUpdateNotice, readLocalVersion } from './version-check.mjs';
import { projectContext } from './project-index.mjs';

/** Persona, profile text, memory packet and local OpenAPI descriptor. */
export function resetProfileCache() {
  profileCache.clear();
}

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
    // The bullet costs "- " (2 chars) plus the '\n' separator, so the budget
    // must charge line.length + 3; charging only +1 let an oversized fact
    // leave a stranded "相关事实：" heading with no rows beneath it.
    const cost = line.length + 3;
    if (used + cost > budget) continue;
    used += cost;
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
function capProfileLines(lines, owners = [], onTrim = null) {
  let text = lines.join('\n');
  while (text.length > PROFILE_BUDGET && lines.length) {
    const owner = owners.pop() ?? null;
    const line = lines.pop();
    if (onTrim) onTrim(owner, line);
    text = lines.join('\n');
  }
  // Budget pressure must not leave a section heading with no rows beneath it.
  while (lines.length && /^(##\s|相关事实：$)/.test(lines[lines.length - 1])) {
    lines.pop();
    owners.pop();
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
  const owners = [];
  const report = { budget: PROFILE_BUDGET, used: 0, included: [], omitted: [] };
  let used = 0;
  // Budget is measured on the joined text, so every line after the first also
  // pays one '\n'. Accounting without that separator let a profile pass the
  // pre-check and then get silently popped by capProfileLines.
  const addLine = (line, owner = null) => {
    const cost = line.length + (lines.length ? 1 : 0);
    if (used + cost > PROFILE_BUDGET) return false;
    used += cost;
    lines.push(line);
    owners.push(owner);
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
    // Don't spend budget on a heading unless at least one row (or its compact
    // pointer) can follow it. When even that does not fit, every note in the
    // section must still be reported: an early return here used to drop the
    // whole section silently and leave `omitted` empty.
    const headingCost = (lines.length ? 1 : 0) + title.length;
    const pointerFor = row => `- note#${row.id} 超长已省略（memory_search 取回）`;
    // Pick the cheapest row across the whole section, not just items[0]: a huge
    // first row must not make us drop a shorter row that would still fit.
    const rowCosts = items.map(row => Math.min(`- ${row.text}`.length, pointerFor(row).length) + 1);
    const cheapestRowCost = Math.min(...rowCosts);
    // Suffix minimum of the same cost, so the loop can reserve room for the
    // cheapest row that is still pending: a pointer written for an oversized
    // row must not eat the budget a later short row needs. Fixing only the
    // heading pre-check moved the starvation into the loop.
    const pendingCheapest = new Array(items.length + 1).fill(0);
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const next = pendingCheapest[i + 1];
      pendingCheapest[i] = next === 0 ? rowCosts[i] : Math.min(rowCosts[i], next);
    }
    if (used + headingCost + cheapestRowCost > PROFILE_BUDGET) {
      for (const row of items) {
        const id = Number(row.id);
        if (report.omitted.some(item => item.id === id)) continue;
        report.omitted.push({ id, chars: String(row.text).length, pointer: false });
      }
      return;
    }
    addLine(title);
    for (let i = 0; i < items.length; i += 1) {
      const row = items[i];
      const owner = { id: Number(row.id), chars: String(row.text).length, pointer: false };
      if (addLine(`- ${row.text}`, owner) !== false) {
        report.included.push(Number(row.id));
        continue;
      }
      // One oversized rule must not starve every shorter rule behind it: keep
      // scanning, and leave a compact pointer only when there is still room for
      // it *and* for the cheapest row that is still pending.
      const pointer = pointerFor(row);
      const pointerCost = pointer.length + (lines.length ? 1 : 0);
      const reserve = pendingCheapest[i + 1];
      const pointerAdded = used + pointerCost + reserve <= PROFILE_BUDGET
        && addLine(pointer, { ...owner, pointer: true }) !== false;
      report.omitted.push({ id: Number(row.id), chars: owner.chars, pointer: pointerAdded });
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

  // Only open the fact block when at least one fact bullet fits; otherwise the
  // heading would be rendered alone and stripped later, or worse, left stranded.
  const factLines = profileFactLines(s.db, projectKey || SCOPE_GLOBAL, PROFILE_BUDGET - used);
  if (factLines.length > 1) {
    const heading = factLines[0];
    const headingCost = (lines.length ? 1 : 0) + heading.length;
    const firstBulletCost = 1 + `- ${factLines[1]}`.length;
    if (used + headingCost + firstBulletCost <= PROFILE_BUDGET) {
      addLine(heading);
      for (const line of factLines.slice(1)) {
        if (addLine(`- ${line}`) === false) continue;
      }
    }
  }
  const text = capProfileLines(lines, owners, (owner, line) => {
    if (!owner) return;
    if (owner.pointer) {
      // The pointer itself was trimmed: the note is still omitted, but there is
      // no compact marker left in the text, so the report must say so.
      const existing = report.omitted.find(item => item.id === owner.id);
      if (existing) existing.pointer = false;
      else report.omitted.push({ id: owner.id, chars: owner.chars, pointer: false });
      return;
    }
    report.omitted.push({ id: owner.id, chars: owner.chars, pointer: false });
  });
  // A row pushed into `included` before capProfileLines ran may have been
  // trimmed afterwards; only report ids that are still on screen.
  const kept = new Set(owners.filter(owner => owner && !owner.pointer).map(owner => owner.id));
  report.included = report.included.filter(id => kept.has(id));
  report.used = text.length;
  if (options.report && typeof options.report === 'object') Object.assign(options.report, report);
  return text;
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

  // Code facts are appended only for an explicit project layer and only when
  // the query resolves to a project reference. Source files stay authoritative;
  // this section carries sourceRef + line + sha + stale, never source bodies.
  let project = null;
  const projectScope = scope && scope !== 'all' && scope !== 'project' && scope !== SCOPE_GLOBAL ? scope : null;
  if (projectScope && query) {
    const packet = projectContext(s.db, query, {
      scope: projectScope,
      budget: Math.min(1000, Math.max(300, Math.round(budget * 0.45))),
    });
    if (packet.ok && packet.text) {
      sections.push(packet.text);
      project = { stale: packet.stale, chars: packet.text.length, refs: packet.refs?.length ?? 0 };
    }
  }
  if (!sections.length) {
    return { text: '', chars: 0, hits: 0, truncated: false, memories: [], project: null, update: null };
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
    project,
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
    '/omni-memory/project/status': {
      get: {
        summary: 'Project code index status',
        parameters: [
          { name: 'root', in: 'query', schema: { type: 'string' }, description: 'Project root; defaults to the bound project directory.' },
          { name: 'scope', in: 'query', schema: { type: 'string' }, description: 'One exact project scope; derived from root when omitted.' },
        ],
        responses: { 200: { description: 'Indexed files, modules, symbols, APIs, edges, stale and missing' } },
      },
    },
    '/omni-memory/project/search': {
      get: {
        summary: 'Search the project code index',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'root', in: 'query', schema: { type: 'string' } },
          { name: 'scope', in: 'query', schema: { type: 'string' } },
          { name: 'kind', in: 'query', schema: { type: 'string', enum: ['all', 'module', 'file', 'symbol', 'api'], default: 'all' } },
          { name: 'path', in: 'query', schema: { type: 'string' } },
          { name: 'module', in: 'query', schema: { type: 'string' } },
          { name: 'method', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        ],
        responses: { 200: { description: 'Ranked modules, files, symbols and APIs with sourceRef, line, sha and stale' } },
      },
    },
    '/omni-memory/project/context': {
      get: {
        summary: 'Bounded project context for one module, file, symbol or API',
        parameters: [
          { name: 'ref', in: 'query', required: true, schema: { type: 'string' }, description: 'Module key, path, symbol name or sourceRef.' },
          { name: 'root', in: 'query', schema: { type: 'string' } },
          { name: 'scope', in: 'query', schema: { type: 'string' } },
          { name: 'budget', in: 'query', schema: { type: 'integer', minimum: 400, maximum: 4000, default: 1800 } },
        ],
        responses: { 200: { description: 'Responsibility, public surface, imports, tests and exact source references' } },
      },
    },
    '/omni-memory/project/impact': {
      get: {
        summary: 'Reverse dependency impact for a file or module',
        parameters: [
          { name: 'ref', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'root', in: 'query', schema: { type: 'string' } },
          { name: 'scope', in: 'query', schema: { type: 'string' } },
          { name: 'depth', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 8, default: 4 } },
        ],
        responses: { 200: { description: 'Importers, dependent modules and related tests' } },
      },
    },
    '/omni-memory/project/sync': {
      post: {
        summary: 'Build or incrementally rebuild the project code index',
        description: 'Requires x-omni-csrf: 1. Source files remain authoritative; rows are a rebuildable cache and never store source bodies.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['root'],
            properties: {
              root: { type: 'string' },
              scope: { type: 'string' },
              full: { type: 'boolean', default: false },
              ctags: { type: 'boolean', default: true },
              gitCommit: { type: 'string' },
            },
          } } },
        },
        responses: { 200: { description: 'files, parsed, unchanged, removed, symbols, apis, modules, edges and durationMs' }, 403: { description: 'Missing CSRF header or non-loopback caller' } },
      },
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
  } catch (error) {
    // Never let a profile-build failure blank the injected block silently, and
    // keep the last good text instead of caching an empty string.
    try { console.error('[omni] profile build failed:', key, error?.message ?? error); } catch { /* stderr unavailable */ }
    if (cached?.text) return cached.text;
    text = '';
  }
  profileCache.set(key, { text, at: nowMs });
  return text;
}

function invalidateProfile() {
  profileCache.clear();
}

export { profileFactLines, PERSONA_MAX_VALUE, PERSONA_MAX_TOTAL, personaGet, personaNormalize, personaSet, profileEligibleNote, personaEvidenceEligible, personaEvidence, PERSONA_RELATIONS, personaFromRules, PERSONA_BAD_VALUE, personaValueOk, parsePersonaJson, personaFromModel, personaModelEnabled, personaRefresh, maybeRefreshPersona, personaLines, capProfileLines, buildProfileText, PACKET_BUDGET, buildMemoryPacket, HOST_OPENAPI, profileCache, cachedProfile, invalidateProfile };
