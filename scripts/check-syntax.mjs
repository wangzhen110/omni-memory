// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
// Syntax gate for every runtime JavaScript module, not a hand-maintained list.
// The previous `check` script omitted hosts/* and several shared modules, so a
// syntax error could reach a running host while `npm run check` stayed green.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILES = readdirSync(ROOT, { withFileTypes: true })
  .filter(entry => entry.isFile() && /\.(?:mjs|js)$/.test(entry.name))
  .map(entry => entry.name);
for (const dir of ['lib', 'hosts', 'scripts', 'bench']) {
  const walk = relative => {
    let entries;
    try {
      entries = readdirSync(path.join(ROOT, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && /\.(?:mjs|js)$/.test(entry.name)) FILES.push(child);
    }
  };
  walk(dir);
}

const failures = [];
for (const relative of FILES) {
  const result = spawnSync(process.execPath, ['--check', path.join(ROOT, relative)], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    failures.push({
      file: relative,
      error: String(result.stderr || result.stdout || `node --check exited ${result.status}`).trim(),
    });
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`${failure.file}: ${failure.error}`);
  process.exitCode = 1;
} else {
  console.log(`syntax check passed: ${FILES.length} files`);
}
