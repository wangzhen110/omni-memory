#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * One-command local install.
 *
 * This is deliberately a wrapper, not a second installer: the content-addressed
 * launcher already exists in scripts/install-launcher.mjs. `setup` adds three
 * things a new user needs — a read-only preflight, a post-install doctor run,
 * and one readable summary.
 *
 * `--require-release` makes the install fail closed: it verifies the official
 * Ed25519 release manifest, requires a clean checkout at the signed commit,
 * and only then installs. Without that flag the hash is the one declared in the
 * same commit as the binary; it catches corruption and accidental edits, not a
 * tampered fork. The output says which path was used so "setup" cannot be
 * mistaken for an offline hash-only install.
 *
 * Default is dry-run. `--apply` is the only mode that writes to the home
 * directory or changes the scheduled task; `--start` is the only mode that
 * starts the service. A failure before `installLauncherFromCommit` leaves the
 * existing service untouched.
 */
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installLauncherFromCommit } from './install-launcher.mjs';
import { verifyRelease } from './verify-release.mjs';
import { describeHeadDelta } from './release-delta.mjs';
import { runDoctor, formatDoctor } from '../hosts/shared/doctor.mjs';

// `omni doctor` is a user-facing command; keep node:sqlite's experimental
// warning off stderr. Errors and other warnings still surface.
process.removeAllListeners('warning');
process.on('warning', warning => {
  if (warning && warning.name !== 'ExperimentalWarning') console.error(`[omni] ${warning.message ?? warning}`);
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const raw = token.slice(2);
    const eq = raw.indexOf('=');
    const rawKey = eq >= 0 ? raw.slice(0, eq) : raw;
    const inline = eq >= 0 ? raw.slice(eq + 1) : undefined;
    if (inline !== undefined) {
      flags[rawKey] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[rawKey] = next;
      index += 1;
    } else {
      flags[rawKey] = true;
    }
  }
  return flags;
}

function printHelp() {
  console.log(`全息记忆 · 本地安装

用法:
  node scripts/install.mjs [选项]

默认 dry-run，只打印计划，不写文件、不碰计划任务。
  --apply          安装启动器并写入侧车配置
  --start          安装后重启计划任务，让 7788 用新启动器运行
  --require-release 先验证官方 Release 的 Ed25519 签名、干净检出与签名 commit；
                   任何一步不符立即失败。npm run setup 默认启用这条路径
  --home <目录>   数据根目录，默认 $OMNI_HOME / $DSH_HOME / ~/.dsh
  --port <端口>   服务端口，默认 7788
  --task <任务名> 计划任务名，默认 OmniMemory7788
  --no-task        只写内容寻址启动器与配置，不创建/修改计划任务
  --commit <sha>   从指定提交读取启动器；默认 HEAD
  --json           输出机器可读结果
  --help           显示本页

一键安装:
  npm run setup            发布验签安装：node scripts/install.mjs --apply --start --require-release
  npm run setup:dev        本地开发安装：跳过 Release 验签（仅适合已可信的检出）
  npm run setup:dry        只看计划（不验签、不落盘）
  node hosts/cli.mjs doctor 安装后诊断
`);
}

function value(flags, key) {
  return typeof flags[key] === 'string' ? flags[key] : undefined;
}

function runGit(repo, args) {
  const candidates = [process.env.GIT_BIN, 'C:\\Program Files\\Git\\cmd\\git.exe', 'git'].filter(Boolean);
  const git = candidates.find(candidate => candidate === 'git' || existsSync(candidate));
  if (!git) throw new Error('git not found; install Git or set GIT_BIN');
  return execFileSync(git, args, { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).trim();
}

async function verifyOfficialRelease(repo, commit) {
  const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const release = await verifyRelease({ tag: `v${pkg.version}` });
  if (release.version !== pkg.version) {
    throw new Error(`release version ${release.version} does not match local ${pkg.version}`);
  }
  const head = runGit(repo, ['rev-parse', 'HEAD']);
  if (head !== release.commit) {
    // Docs-only descendants are tolerated: they cannot change the launcher,
    // its hash or the package hash, so the released bytes are still what gets
    // installed. Any non-doc path still forces a checkout of the tag.
    const delta = describeHeadDelta(runGit, repo, release.commit, head);
    if (!delta.allowed) {
      const stray = delta.files.slice(0, 3).join(', ');
      throw new Error(`HEAD ${head} is not the signed release commit ${release.commit} (${delta.reason}${stray ? `: ${stray}` : ''}); checkout the release tag first`);
    }
    release.headDelta = delta;
  }
  if (commit && commit !== release.commit) {
    throw new Error(`--commit ${commit} does not match the signed release commit ${release.commit}`);
  }
  const dirty = runGit(repo, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) throw new Error(`working tree has uncommitted tracked changes; refusing a release-verified install:\n${dirty}`);
  return release;
}

function human(result) {
  const lines = [];
  lines.push(`全息记忆安装 · ${result.dryRun ? '计划（未落盘）' : '已安装'}`);
  lines.push(`仓库: ${result.repo}`);
  lines.push(`数据根目录: ${result.home ?? result.plan?.home ?? '未解析（doctor 使用默认 ~/.dsh）'}`);
  lines.push(`启动器: ${result.plan?.target || '—'}`);
  if (result.release) {
    lines.push(`发布验签: ${result.release.tag} · commit ${result.release.commit} · key ${result.release.keyId}`);
    if (result.release.headDelta) {
      lines.push(`提交谱系: HEAD 领先发布提交 ${result.release.headDelta.commits} 个 docs-only 提交；安装对象仍取发布提交 ${result.release.commit.slice(0, 8)}`);
    } else {
      lines.push(`提交谱系: HEAD 与发布提交一致`);
    }
    lines.push('启动器校验: Release manifest v2 Ed25519 + 发布提交对象 SHA-256（package.json 与启动器直比 manifest）');
  } else {
    lines.push('启动器校验: 同提交 SHA-256（本地自洽；未验 Release 签名）');
  }
  const taskLabel = result.plan?.noTask
    ? '不创建/不修改'
    : (result.task ?? result.plan?.task ?? '未解析');
  lines.push(`计划任务: ${taskLabel}`);
  if (result.plan?.taskUnknown) lines.push(`任务探测: 未知（${result.plan.taskError}）`);
  if (result.plan) lines.push(`提交: ${result.plan.commit} · sha256 ${result.plan.sha256}`);
  lines.push('');
  lines.push(formatDoctor(result.doctor));
  if (result.dryRun) {
    lines.push('');
    lines.push('这是 dry-run。确认要安装时执行: npm run setup');
  }
  if (result.error) lines.push(`错误: ${result.error}`);
  return lines.join('\n');
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    printHelp();
    return;
  }

  const repo = ROOT;
  const home = value(flags, 'home');
  const port = Number(value(flags, 'port') || process.env.OMNI_HTTP_PORT || 7788);
  const task = flags['no-task'] === true ? false : String(value(flags, 'task') || process.env.OMNI_SERVICE_TASK || 'OmniMemory7788');
  const commit = value(flags, 'commit');
  const apply = flags.apply === true;
  const start = flags.start === true;
  const json = flags.json === true;
  const requireRelease = flags['require-release'] === true;

  const base = {
    repo,
    home,
    port,
    task,
    apply,
    start,
  };

  try {
    const preflight = await runDoctor({
      repo,
      home,
      port: false,
      task: false,
      strict: false,
    });
    if (!preflight.ok) {
      throw new Error(`preflight failed: ${preflight.checks.filter(c => c.status === 'fail').map(c => c.name).join(', ')}`);
    }

    const release = requireRelease ? await verifyOfficialRelease(repo, commit) : null;
    // Read the launcher and package.json from the signed release commit itself.
    // The docs-only tolerance then only decides whether installing is allowed;
    // it never decides which bytes are installed.
    const installCommit = release ? release.commit : commit;

    const plan = installLauncherFromCommit({
      repo,
      home,
      port,
      task,
      commit: installCommit,
      expectedPackageJsonSha256: release?.packageJsonSha256,
      expectedLauncherSha256: release?.launcherSha256,
      apply,
      restart: apply && start && task !== false,
      noTask: task === false,
      createTask: task !== false,
      releaseVerified: Boolean(release),
    });

    if (!apply) {
      const result = {
        ...base,
        dryRun: true,
        requireRelease,
        release,
        plan,
        preflight,
        doctor: await runDoctor({ repo, home, port, task, strict: false }),
      };
      console.log(json ? JSON.stringify(result, null, 2) : human(result));
      process.exitCode = result.doctor.ok ? 0 : 1;
      return;
    }

    if (!plan.ok) throw new Error(plan.error || 'launcher installation failed');

    if (start && task !== false) {
      // `installLauncherFromCommit` already restarted the scheduled task. Give
      // the service a moment to boot before the post-install HTTP check.
      await new Promise(resolve => setTimeout(resolve, 2200));
    }

    const doctor = await runDoctor({ repo, home, port, task, strict: false });
    const result = {
      ...base,
      dryRun: false,
      requireRelease,
      release,
      plan,
      preflight,
      doctor,
    };
    console.log(json ? JSON.stringify(result, null, 2) : human(result));
    process.exitCode = doctor.ok ? 0 : 1;
  } catch (error) {
    const result = {
      ...base,
      dryRun: !apply,
      requireRelease,
      ok: false,
      error: String(error?.message ?? error),
    };
    console.log(json ? JSON.stringify(result, null, 2) : human({
      ...result,
      plan: null,
      doctor: {
        ok: false,
        checks: [{ name: 'install', status: 'fail', detail: result.error }],
        counts: { ok: 0, warn: 0, fail: 1 },
        repo,
        home: home || path.join(process.env.USERPROFILE || '', '.dsh'),
        db: '',
      },
    }));
    process.exitCode = 1;
  }
}

// Exported so tests can pin the human-readable summary (notably the data-root
// fallback: `home` is absent on the apply path, and it must never print
// "undefined"). Importing this file must not run the installer.
export { human };

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().catch(error => {
    console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2));
    process.exitCode = 1;
  });
}
