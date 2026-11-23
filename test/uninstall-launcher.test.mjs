import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { uninstallLauncher, withinHome } from '../scripts/uninstall-launcher.mjs';

test('uninstall-launcher only removes launcher-owned files and never the memory database', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-uninstall-'));
  try {
    mkdirSync(path.join(home, 'memory'), { recursive: true });
    writeFileSync(path.join(home, 'omni-serve-7788.json'), '{}\n');
    writeFileSync(path.join(home, 'omni-serve-7788-0123abcd.exe'), 'binary');
    writeFileSync(path.join(home, 'omni-serve-7788.log'), 'log');
    writeFileSync(path.join(home, 'memory', 'omni.sqlite'), 'database');

    const dry = uninstallLauncher({ home, noTask: true, removeBinaries: true, removeLogs: true, dryRun: true });
    assert.equal(dry.ok, true);
    assert.ok(dry.kept.includes(path.join(home, 'omni-serve-7788.json')));
    assert.equal(existsSync(path.join(home, 'omni-serve-7788.json')), true);

    const applied = uninstallLauncher({ home, noTask: true, removeBinaries: true, removeLogs: true });
    assert.equal(applied.ok, true);
    assert.equal(existsSync(path.join(home, 'omni-serve-7788.json')), false);
    assert.equal(existsSync(path.join(home, 'omni-serve-7788-0123abcd.exe')), false);
    assert.equal(existsSync(path.join(home, 'omni-serve-7788.log')), false);
    assert.equal(existsSync(path.join(home, 'memory', 'omni.sqlite')), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall-launcher refuses to modify a task action outside the omni home', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-uninstall-scope-'));
  try {
    assert.equal(withinHome(path.join(home, 'omni-serve-7788.exe'), home), true);
    assert.equal(withinHome('C:\\Windows\\System32\\cmd.exe', home), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
