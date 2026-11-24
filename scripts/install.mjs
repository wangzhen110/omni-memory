#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Omni-Memory-Personal-Use-1.1
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * One-command local install.
 *
 * This is deliberately a wrapper, not a second installer: the content-addressed
 * launcher already exists in scripts/install-launcher.mjs. `setup` adds three
 * things a new user needs — a read-only preflight, a post-install doctor run,
 * and one readable summary.
 *
 * The hash checked here is the one declared in the same commit as the binary.
 * It catches corruption and accidental edits, not a tampered fork; the Ed25519
 * release signature is verified by `daily-sync --apply`, not by this offline
 * path. The output says so explicitly so "setup" cannot be mistaken for the
 * signed update chain.
 *
 * Default is dry-run. `--apply` is the only mode that writes to the home
 * directory or changes the scheduled task; `--start` is the only mode that
 * starts the service. A failure before `installLauncherFromCommit` leaves the
 * existing service untouched.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installLauncherFromCommit } from './install-launcher.mjs';
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
    const [rawKey, inline] = token.slice(2).split('=');
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
  --apply          安装内容哈希自洽的启动器并写入侧车配置（不验 Release 签名）
  --start          安装后重启计划任务，让 7788 用新启动器运行
  --home <目录>   数据根目录，默认 $OMNI_HOME / $DSH_HOME / ~/.dsh
  --port <端口>   服务端口，默认 7788
  --task <任务名> 计划任务名，默认 OmniMemory7788
  --no-task        只写内容寻址启动器与配置，不创建/修改计划任务
  --commit <sha>   从指定提交读取启动器；默认 HEAD
  --json           输出机器可读结果
  --help           显示本页

一键安装:
  npm run setup            等价于 node scripts/install.mjs --apply --start
  npm run setup:dry        只看计划
  node hosts/cli.mjs doctor 安装后诊断
`);
}

function value(flags, key) {
  return typeof flags[key] === 'string' ? flags[key] : undefined;
}

function human(result) {
  const lines = [];
  lines.push(`全息记忆安装 · ${result.dryRun ? '计划（未落盘）' : '已安装'}`);
  lines.push(`仓库: ${result.repo}`);
  lines.push(`数据根目录: ${result.home}`);
  lines.push(`启动器: ${result.plan?.target || '—'}`);
  lines.push('启动器校验: 同提交 SHA-256（本地自洽；Release Ed25519 签名只由 daily-sync --apply 验证）');
  lines.push(`计划任务: ${result.plan?.noTask ? '不创建/不修改' : result.task}`);
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

    const plan = installLauncherFromCommit({
      repo,
      home,
      port,
      task,
      commit,
      apply,
      restart: apply && start && task !== false,
      noTask: task === false,
      createTask: task !== false,
    });

    if (!apply) {
      const result = {
        ...base,
        dryRun: true,
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

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2));
  process.exitCode = 1;
});
