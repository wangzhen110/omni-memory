// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * omni — the command line adapter.
 *
 * Three jobs, all of them about closing the gap MCP leaves open:
 *  - `rules`   writes the working rules into the client's own rule file, so the
 *              model reads them without anyone remembering to ask
 *  - `context` prints the profile + recalled memories as plain text, which is
 *              exactly what a SessionStart / UserPromptSubmit hook needs to splice
 *  - `serve`   starts the local panel and the HTTP MCP endpoint
 *
 * Runners like Claude Code hooks have no MCP session, so they need a CLI that
 * answers instantly and prints to stdout. That is this file.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep node:sqlite's ExperimentalWarning off stderr; hook runs read stderr as an error.
process.removeAllListeners('warning');
process.on('warning', warning => {
  if (warning && warning.name !== 'ExperimentalWarning') console.error(`[omni] ${warning.message ?? warning}`);
});

const USAGE = `全息记忆 · omni

用法:
  omni rules   [--file <路径>]... [--write] [--create]
               默认只预览；--write 落盘（区块幂等，可重复执行）
               不给 --file 时，自动查找 CLAUDE.md / AGENTS.md / .cursorrules
  omni context [--query <文本>] [--scope <层级>] [--limit <n>] [--semantic] [--dir <目录>]
               输出画像与相关记忆，适合给 hooks 拼接上下文；默认词法+哈希向量
  omni search  <关键词> [--scope <层级>] [--limit <n>] [--offset <n>] [--json] [--rerank] [--semantic] [--dir <目录>]
               文本模式显示分数、命中理由与候选总数；--json 输出完整命中对象
               默认不加载 37.5MiB 语义模型；--semantic 或 OMNI_CLI_SEMANTIC=1 开启
  omni ingest  (--text <文本> | --stdin | --file <路径>) [--role user|assistant|system|tool]
               [--session <id>] [--source <来源>] [--cwd <目录>] [--dir <目录>] [--scope <层级>]
               [--no-extract]   把一轮对话写入转录层；默认生成待确认候选 note
  omni candidates [--status pending|accepted|rejected|all] [--scope <层级>] [--cwd <目录>] [--dir <目录>]
               查看候选 note 队列
  omni candidate --id <候选id> --action accept|reject [--reason <原因>] [--scope <层级>] [--dir <目录>]
               接受或拒绝一条候选 note
  omni consolidate --problem-key <指纹> [--scope <层级>] [--min-notes <n>] [--apply] [--dir <目录>]
               把同问题指纹的活跃笔记浓缩成来源链摘要；默认 dry-run
  omni write   --kind note|fact|episode (--text <文本> | --stdin | --file <路径>)
               [--scope <层级>] [--importance <0..1>] [--source <来源>]
               [--problem-key <指纹>] [--status verified|unverified|failed|expired]
               [--evidence <证据>] [--subject <实体> --relation <关系> --object <值>]
               [--cardinality single|multi] [--contradicts <id,id>]
  omni feedback --kind note|fact --id <id> --rating useful|misleading [--dir <目录>] [--scope <层级>]
               记录一次真实召回反馈；这是 quality 排序的闭环信号
  omni report  --id <笔记id> --outcome success|failed|expired [--evidence <证据>]
               记录方案的真实结果；success 标 verified，failed/expired 留死路
  omni forget  --kind note|fact|chunk --id <行id>
  omni scope-alias --from <旧proj键> --to <新proj键> [--apply]
               旧项目键没有 project_path 证据时，显式合并 scope；默认只预览
  omni scope-alias --list
               列出已记录的旧键 → canonical 键映射
  omni project show [--dir <目录>]
               显示当前目录解析到的项目键、身份文件与路径回退键
  omni project init [--dir <目录>] [--force]
               在当前目录写 .omni-project；已有文件默认不覆盖
  omni project link --from <旧proj键> --to <新proj键> [--apply]
               合并同一项目的两个历史键；默认只预览
  omni kb-migrate [--source-prefix 专业知识/] [--from global] [--to proj:专业知识#967a81] [--apply]
               把导入的领域知识从 global 移到独立项目层；默认 dry-run
  omni serve   [--port <端口>] [--bind <地址>]
  omni doctor  [--home <目录>] [--port <端口>] [--task <任务名>] [--json] [--strict]
               只读诊断：Node、数据目录、SQLite 完整性、语义资产、HTTP、计划任务
  omni mcp     以 stdio 方式启动 MCP 服务（等同 hosts/mcp/bin.mjs）

环境变量:
  OMNI_HOME         数据根目录，默认 $DSH_HOME 再退回 ~/.dsh
  OMNI_PROJECT_DIR  项目层绑定的目录；默认向上查找 .omni-project，再退回 CLI 所在仓库根
  OMNI_CLI_SEMANTIC 设为 1 时，context/search 默认加载语义模型；等价于逐次传 --semantic
  OMNI_HTTP_PORT    7788 服务端口，默认 7788

通用选项:
  --dir <目录>      把本次命令的项目层绑定到该目录；context/search/write/ingest 都适用
                    不传时自动使用最近的项目身份文件；写入时若未显式 --scope 则强制项目层
                    全局规则请显式 --scope global
  --scope global    显式写全局层；--scope project 表示当前项目；--scope all 只读
`;

const BOOLEAN_FLAGS = new Set([
  'apply', 'check', 'create', 'force', 'help', 'json', 'list', 'no-extract',
  'rerank', 'semantic', 'skip-http', 'skip-task', 'stdin', 'strict', 'write',
]);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const [rawKey, inline] = token.slice(2).split('=');
      const key = rawKey.trim();
      if (inline !== undefined) {
        flags[key] = inline;
        continue;
      }
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

function listFlag(flags, key) {
  const value = flags[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const command = (positional.shift() ?? 'help').toLowerCase();

// The CLI is often run from a chat/agent working directory that is not the
// project it belongs to. Prefer an explicit --dir, then OMNI_PROJECT_DIR,
// then the nearest .omni-project going upward, then the checkout that owns
// this CLI. Only fall back to the raw cwd when none of those identify a
// project, so `omni search` does not silently land in `proj:new-chat`.
function hasProjectIdentity(dir) {
  return existsSync(path.join(dir, '.omni-project'))
    || existsSync(path.join(dir, '.omni', 'project.json'));
}
function nearestProjectRoot(start) {
  let dir = path.resolve(String(start ?? '').trim() || '.');
  for (let depth = 0; depth < 12; depth += 1) {
    if (hasProjectIdentity(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const explicitDir = flags.dir === undefined || flags.dir === true ? '' : String(flags.dir).trim();
const envProjectDir = String(process.env.OMNI_PROJECT_DIR ?? '').trim();
const workdir = path.resolve(
  explicitDir
  || envProjectDir
  || nearestProjectRoot(process.cwd())
  || (hasProjectIdentity(cliRoot) ? cliRoot : process.cwd()),
);

const log = message => console.error(`[omni] ${message}`);

function semanticRequested() {
  if (process.env.OMNI_CLI_SEMANTIC === '1') return true;
  const value = flags.semantic;
  if (value === undefined) return false;
  if (value === true) return true;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

if (flags.help === true || process.argv.includes('-h')) {
  process.stdout.write(USAGE);
  process.exit(0);
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

async function boot() {
  const { bootHost } = await import('./shared/boot.mjs');
  return bootHost({ workdir, sessionId: process.env.OMNI_SESSION_ID });
}

async function callTool(booted, name, args) {
  const def = booted.host.tools.get(name);
  if (!def) throw new Error(`tool not found: ${name}`);
  return def.execute(args, booted.toolContext);
}

class CliUsageStop extends Error {}

async function callToolSafe(booted, name, args) {
  try {
    return await callTool(booted, name, args);
  } catch (error) {
    // Tool argument errors are user-facing. Command functions have try/finally,
    // so throwing this sentinel still disposes the host.
    log(String(error?.message ?? error));
    process.exitCode = 2;
    throw new CliUsageStop();
  }
}

async function commandRules() {
  const { RULES_TEXT, applyManagedBlock } = await import('./shared/rules.mjs');
  const write = flags.write === true;
  const create = flags.create === true;
  let targets = listFlag(flags, 'file').map(file => path.resolve(workdir, file));

  if (!targets.length) {
    const defaults = ['CLAUDE.md', 'AGENTS.md', '.cursorrules', '.clinerules'];
    targets = defaults.map(name => path.join(workdir, name)).filter(file => existsSync(file));
  }

  if (!targets.length && !create) {
    process.stdout.write(RULES_TEXT + '\n\n');
    log('没有找到规则文件。用 --file <路径> --create 生成一份，或直接复制上面的文本。');
    return;
  }

  if (!targets.length && create) targets = [path.join(workdir, 'AGENTS.md')];

  for (const target of targets) {
    const exists = existsSync(target);
    if (!exists && !create) {
      log(`跳过不存在的文件：${target}（加 --create 可创建）`);
      continue;
    }

    const current = exists ? readFileSync(target, 'utf8') : '';
    let applied;
    try {
      applied = applyManagedBlock(current);
    } catch (error) {
      // A malformed marker must never be auto-repaired by deleting prose.
      log(`跳过 ${target}：${error?.message ?? error}`);
      continue;
    }
    const { changed, text } = applied;

    if (!write) {
      process.stdout.write(`--- ${target} ${exists ? '' : '（将新建）'}\n`);
      process.stdout.write(text + '\n');
      continue;
    }

    if (!changed && exists) {
      log(`已是最新：${target}`);
      continue;
    }

    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text, 'utf8');
    log(`已写入：${target}`);
  }

  if (!write) log('预览结束。加 --write 落盘。');
}

async function commandContext() {
  const booted = await boot();
  try {
    let query = String(flags.query ?? '');
    if (flags.stdin === true && !query) {
      // Hook payloads (Claude Code UserPromptSubmit / SessionStart) arrive as JSON
      // on stdin. Only `prompt` is meaningful; everything else is metadata.
      const raw = await readStdin();
      try {
        const payload = JSON.parse(raw);
        query = String(payload?.prompt ?? payload?.user_prompt ?? payload?.text ?? '');
      } catch {
        query = raw.trim();
      }
    }
    const args = { query, limit: Number(flags.limit ?? 5) };
    if (flags.scope) args.scope = String(flags.scope);
    args.semantic = semanticRequested();
    const value = await callToolSafe(booted, 'memory_context', args);
    process.stdout.write(value.text + '\n');
  } finally {
    booted.host.dispose();
  }
}

function hookPayloadText(raw) {
  try {
    const payload = JSON.parse(raw);
    const candidates = [
      payload?.prompt,
      payload?.user_prompt,
      payload?.text,
      payload?.last_assistant_message,
      payload?.message?.content,
      payload?.message,
      payload?.content,
    ];
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (Array.isArray(value)) {
        const text = value
          .filter(block => block?.type === 'text' || typeof block === 'string')
          .map(block => typeof block === 'string' ? block : block.text ?? '')
          .join('\n').trim();
        if (text) return text;
      }
    }
  } catch { /* not JSON; treat as plain text */ }
  return String(raw ?? '').trim();
}

async function commandIngest() {
  let text = String(flags.text ?? '');
  if (!text && flags.stdin === true) text = hookPayloadText(await readStdin());
  if (!text && flags.file) text = readFileSync(path.resolve(workdir, String(flags.file)), 'utf8').trim();
  if (!text) {
    log('需要内容：--text、--stdin 或 --file');
    process.exitCode = 2;
    return;
  }
  const args = { text, cwd: String(flags.cwd ?? workdir) };
  if (flags.role) args.role = String(flags.role);
  if (flags.session) args.sessionId = String(flags.session);
  if (flags.source) args.source = String(flags.source);
  if (flags.scope) args.scope = String(flags.scope);
  else if (flags.dir) args.scope = 'project';
  if (flags['no-extract'] === true) args.extract = false;
  const booted = await boot();
  try {
    const value = await callToolSafe(booted, 'memory_ingest', args);
    process.stdout.write(JSON.stringify(value) + '\n');
  } finally {
    booted.host.dispose();
  }
}

async function commandCandidates() {
  const args = { action: 'list' };
  if (flags.status) args.status = String(flags.status);
  if (flags.scope) args.scope = String(flags.scope);
  if (flags.cwd) args.cwd = String(flags.cwd);
  else if (flags.dir) args.cwd = workdir;
  if (flags.limit) args.limit = Number(flags.limit);
  const booted = await boot();
  try {
    const value = await callToolSafe(booted, 'memory_candidate', args);
    process.stdout.write(JSON.stringify(value) + '\n');
  } finally {
    booted.host.dispose();
  }
}

async function commandCandidate() {
  const id = Number(flags.id);
  const action = String(flags.action ?? '').trim().toLowerCase();
  if (!Number.isFinite(id) || id <= 0 || !['accept', 'reject'].includes(action)) {
    log('需要 --id <正整数> 与 --action accept|reject');
    process.exitCode = 2;
    return;
  }
  const args = { action, id };
  if (flags.scope) args.scope = String(flags.scope);
  if (flags.cwd) args.cwd = String(flags.cwd);
  else if (flags.dir) args.cwd = workdir;
  if (flags.reason) args.reason = String(flags.reason);
  const booted = await boot();
  try {
    const value = await callToolSafe(booted, 'memory_candidate', args);
    process.stdout.write(JSON.stringify(value) + '\n');
  } finally {
    booted.host.dispose();
  }
}

async function commandConsolidate() {
  const problemKey = String(flags['problem-key'] ?? '').trim();
  if (!problemKey) {
    log('需要 --problem-key <指纹>');
    process.exitCode = 2;
    return;
  }
  const args = { problemKey };
  if (flags.scope) args.scope = String(flags.scope);
  else if (flags.dir) args.scope = 'project';
  if (flags['min-notes']) args.minNotes = Number(flags['min-notes']);
  if (flags.apply === true) args.apply = true;
  const booted = await boot();
  try {
    const value = await callToolSafe(booted, 'memory_consolidate', args);
    process.stdout.write(JSON.stringify(value) + '\n');
  } finally {
    booted.host.dispose();
  }
}

async function commandWrite() {
  const kind = String(flags.kind ?? 'note');
  let text = String(flags.text ?? '');

  if (!text && flags.stdin === true) text = (await readStdin()).trim();
  if (!text && flags.file) text = readFileSync(path.resolve(workdir, String(flags.file)), 'utf8').trim();

  if (!text) {
    log('需要内容：--text、--stdin 或 --file');
    process.exitCode = 2;
    return;
  }

  const args = { kind, text };
  if (flags.scope) args.scope = String(flags.scope);
  else if (flags.dir) args.scope = 'project';
  if (flags.importance) args.importance = Number(flags.importance);
  if (flags.source) args.source = String(flags.source);
  if (flags['problem-key']) args.problemKey = String(flags['problem-key']);
  if (flags.status) args.solutionStatus = String(flags.status);
  if (flags.evidence) args.evidence = String(flags.evidence);
  if (flags.subject) args.subject = String(flags.subject);
  if (flags.relation) args.relation = String(flags.relation);
  if (flags.object) args.object = String(flags.object);
  if (flags.cardinality) args.cardinality = String(flags.cardinality);
  if (flags.contradicts) args.contradicts = String(flags.contradicts).split(',').map(Number).filter(Boolean);

  const booted = await boot();
  try {
    const value = await callToolSafe(booted, 'memory_write', args);
    process.stdout.write(JSON.stringify(value) + '\n');
  } finally {
    booted.host.dispose();
  }
}

async function commandReport() {
  const id = Number(flags.id);
  const outcome = String(flags.outcome ?? '');
  if (!id || !outcome) {
    log('需要 --id 与 --outcome');
    process.exitCode = 2;
    return;
  }
  const booted = await boot();
  try {
    const args = { id, outcome };
    if (flags.evidence) args.evidence = String(flags.evidence);
    const value = await callToolSafe(booted, 'memory_solution_report', args);
    process.stdout.write(JSON.stringify(value) + '\n');
  } finally {
    booted.host.dispose();
  }
}

async function commandFeedback() {
  const kind = String(flags.kind ?? '');
  const id = Number(flags.id);
  const rating = String(flags.rating ?? '');
  if (!id || !kind || !rating) {
    log('需要 --kind note|fact、--id 与 --rating useful|misleading');
    process.exitCode = 2;
    return;
  }
  const booted = await boot();
  try {
    const args = { kind, id, rating };
    if (flags.scope) args.scope = String(flags.scope);
    const value = await callToolSafe(booted, 'memory_feedback', args);
    process.stdout.write(JSON.stringify(value) + '\n');
  } finally {
    booted.host.dispose();
  }
}

async function commandForget() {
  const id = Number(flags.id);
  const kind = String(flags.kind ?? '');
  if (!id || !kind) {
    log('需要 --kind 与 --id');
    process.exitCode = 2;
    return;
  }
  const booted = await boot();
  try {
    const value = await callToolSafe(booted, 'memory_forget', { kind, id });
    process.stdout.write(JSON.stringify(value) + '\n');
  } finally {
    booted.host.dispose();
  }
}

async function commandSearch() {
  const query = String(flags.query ?? positional.join(' ')).trim();
  const problemKey = String(flags['problem-key'] ?? '').trim();
  if (!query && !problemKey) {
    log('需要关键词，或用 --problem-key 精确查；例如 omni search "端口占用"');
    process.exitCode = 2;
    return;
  }
  const booted = await boot();
  try {
    const args = { query, limit: Number(flags.limit ?? 8) };
    if (flags.offset) args.offset = Number(flags.offset);
    if (flags.scope) args.scope = String(flags.scope);
    if (flags.dir) args.cwd = workdir;
    if (problemKey) args.problemKey = problemKey;
    if (flags.status) args.status = String(flags.status);
    if (flags.kind) args.kind = String(flags.kind);
    if (flags.rerank) args.rerank = true;
    args.semantic = semanticRequested();
    const value = await callToolSafe(booted, 'memory_search', args);
    if (flags.json === true) {
      process.stdout.write(JSON.stringify(value, null, 2) + '\n');
      return;
    }
    const def = booted.host.tools.get('memory_search');
    const blocks = def.output.render(args, value);
    process.stdout.write(blocks.map(block => block.text).join('\n') + '\n');
  } finally {
    booted.host.dispose();
  }
}

async function commandScopeAlias() {
  const booted = await boot();
  try {
    const { openStore, migrateScopeAlias, scopeHasRows } = await import('../index.js');
    const store = openStore();
    if (flags.list === true) {
      const rows = store.db.prepare('SELECT alias, canonical, created_at FROM scope_aliases ORDER BY created_at').all();
      process.stdout.write(JSON.stringify({ aliases: rows }) + '\n');
      return;
    }
    const from = String(flags.from ?? '').trim();
    const to = String(flags.to ?? '').trim();
    if (!from.startsWith('proj:') || !to.startsWith('proj:')) {
      log('--from 与 --to 必须是 proj:<名称>#<哈希> 形式；不允许合并 global');
      process.exitCode = 2;
      return;
    }
    if (from === to) {
      log('--from 与 --to 相同，无需迁移');
      return;
    }
    const preview = {
      from,
      to,
      fromHasRows: scopeHasRows(store.db, from),
      toHasRows: scopeHasRows(store.db, to),
      applied: flags.apply === true,
    };
    if (flags.apply !== true) {
      process.stdout.write(JSON.stringify({ ...preview, hint: '加 --apply 执行合并；默认只预览' }) + '\n');
      return;
    }
    const result = migrateScopeAlias(store.db, from, to, { literal: true });
    process.stdout.write(JSON.stringify({ ...preview, ...result }) + '\n');
  } finally {
    booted.host.dispose();
  }
}

async function commandProject() {
  const action = String(positional[0] ?? 'show').trim().toLowerCase();
  const { projectIdentityFromCwd, projectKeyFromCwd, legacyProjectKeyFromCwd, openStore, migrateScopeAlias, scopeHasRows } = await import('../index.js');
  if (action === 'show' || action === 'status') {
    const identity = projectIdentityFromCwd(workdir);
    const key = projectKeyFromCwd(workdir);
    const legacy = legacyProjectKeyFromCwd(workdir);
    process.stdout.write(JSON.stringify({
      dir: workdir,
      key,
      pathFallback: legacy,
      identity: identity ? { source: identity.source, file: identity.file, root: identity.root, name: identity.name } : null,
    }, null, 2) + '\n');
    return;
  }
  if (action === 'init') {
    const file = path.join(workdir, '.omni-project');
    if (existsSync(file) && flags.force !== true) {
      log(`已存在：${file}（加 --force 覆盖）`);
      process.stdout.write(JSON.stringify({ dir: workdir, file, key: projectKeyFromCwd(workdir), created: false }) + '\n');
      return;
    }
    const key = projectKeyFromCwd(workdir);
    if (!/^proj:[^#\s]+#[a-z0-9]{6,}$/i.test(key)) {
      log(`无法从 ${workdir} 解析项目键；请在项目目录内执行`);
      process.exitCode = 2;
      return;
    }
    const name = path.basename(workdir) || 'project';
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ key, name }, null, 2) + '\n', 'utf8');
    process.stdout.write(JSON.stringify({ dir: workdir, file, key, name, created: true }) + '\n');
    return;
  }
  if (action === 'link') {
    const from = String(flags.from ?? '').trim();
    const to = String(flags.to ?? '').trim();
    if (!from.startsWith('proj:') || !to.startsWith('proj:')) {
      log('--from 与 --to 必须是 proj:<名称>#<哈希> 形式；不允许合并 global');
      process.exitCode = 2;
      return;
    }
    if (from === to) {
      log('--from 与 --to 相同，无需迁移');
      return;
    }
    const booted = await boot();
    try {
      const store = openStore();
      const db = store.db;
      const preview = {
        from, to,
        fromHasRows: scopeHasRows(db, from),
        toHasRows: scopeHasRows(db, to),
        applied: flags.apply === true,
      };
      if (flags.apply !== true) {
        process.stdout.write(JSON.stringify({ ...preview, hint: '加 --apply 执行合并；默认只预览' }) + '\n');
        return;
      }
      process.stdout.write(JSON.stringify({ ...preview, ...migrateScopeAlias(db, from, to, { literal: true }) }) + '\n');
    } finally {
      booted.host.dispose();
    }
    return;
  }
  log(`未知 project 动作：${action}；可用 show / init / link`);
  process.exitCode = 2;
}

async function commandKbMigrate() {
  const { openStore, migrateKnowledgeNotes } = await import('../index.js');
  const store = openStore();
  const result = migrateKnowledgeNotes(store.db, {
    fromScope: String(flags.from ?? 'global'),
    target: String(flags.to ?? 'proj:专业知识#967a81'),
    sourcePrefix: String(flags['source-prefix'] ?? '专业知识/'),
    apply: flags.apply === true,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

async function commandServe() {
  const { startHttpServer } = await import('./http/server.mjs');
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const server = await startHttpServer({
    workdir,
    port: Number(flags.port ?? process.env.OMNI_HTTP_PORT ?? 7788),
    bind: String(flags.bind ?? process.env.OMNI_HTTP_BIND ?? '127.0.0.1'),
    version: pkg.version,
    log,
  });
  process.stdout.write(`${server.url}\n`);

  const stop = async () => { await server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function commandMcp() {
  // Same process contract as the dedicated entry point; kept here so a client
  // can use one binary for everything.
  await import('./mcp/bin.mjs');
}

async function commandDoctor() {
  const { runDoctor, formatDoctor } = await import('./shared/doctor.mjs');
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const port = flags['skip-http'] === true ? false : Number(flags.port ?? process.env.OMNI_HTTP_PORT ?? 7788);
  const task = flags['skip-task'] === true ? false : String(flags.task ?? process.env.OMNI_SERVICE_TASK ?? 'OmniMemory7788');
  const result = await runDoctor({
    repo,
    home: flags.home,
    port,
    task,
    strict: flags.strict === true,
  });
  if (flags.json === true) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${formatDoctor(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

try {
  switch (command) {
  case 'rules':
    await commandRules();
    break;
  case 'context':
    await commandContext();
    break;
  case 'search':
    await commandSearch();
    break;
  case 'ingest':
    await commandIngest();
    break;
  case 'candidates':
    await commandCandidates();
    break;
  case 'candidate':
    await commandCandidate();
    break;
  case 'consolidate':
    await commandConsolidate();
    break;
  case 'write':
    await commandWrite();
    break;
  case 'report':
    await commandReport();
    break;
  case 'feedback':
    await commandFeedback();
    break;
  case 'forget':
    await commandForget();
    break;
  case 'scope-alias':
    await commandScopeAlias();
    break;
  case 'project':
    await commandProject();
    break;
  case 'kb-migrate':
    await commandKbMigrate();
    break;
  case 'serve':
    await commandServe();
    break;
  case 'doctor':
    await commandDoctor();
    break;
  case 'mcp':
    await commandMcp();
    break;
  case 'help':
  case '--help':
  case '-h':
    process.stdout.write(USAGE);
    break;
  default:
    process.stdout.write(USAGE);
    process.exitCode = 2;
  }
} catch (error) {
  if (!(error instanceof CliUsageStop)) {
    log(String(error?.stack ?? error));
    process.exitCode = 1;
  }
}
