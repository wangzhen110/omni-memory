#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Omni-Memory-Personal-Use-1.1
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
// NonCommercial use only; attribution required. See LICENSE and ATTRIBUTION.md.

// Compile-gate for the Windows silent launcher. This is intentionally separate
// from the JavaScript syntax gate: a green npm run check must not ship a stale
// or uncompilable .exe.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'scripts', 'build-launcher.mjs');
const CSC = process.env.CSC_BIN || 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

if (process.platform !== 'win32' && !existsSync(CSC)) {
  console.log('launcher compile check skipped: csc is only available on Windows');
  process.exit(0);
}

const result = spawnSync(process.execPath, [BUILD, '--check'], {
  cwd: ROOT,
  encoding: 'utf8',
  windowsHide: true,
});
if (result.status !== 0) {
  console.error(String(result.stderr || result.stdout || 'launcher build check failed').trim());
  process.exit(1);
}
console.log(String(result.stdout).trim());
