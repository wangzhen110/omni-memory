// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Installation smoke test: prove the package installs and runs from a plain
 * consumer directory, i.e. with none of the repository layout present.
 *
 * This turns the one-off docs/INTEGRATION-PROBE-*.md check into an automated
 * regression gate. It never touches the real production store — every module
 * load happens with OMNI_HOME/DSH_HOME pointing at a throwaway directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Invoke npm through its JS entry so we never depend on a shell / npm.cmd shim.
// The install layout differs by runtime manager (nvm/fnm put npm under ../lib,
// Windows keeps it under node_modules); npm_execpath is set whenever this test
// is run through `npm test` and is the most reliable pointer.
const npmCli = [
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  '/usr/lib/node_modules/npm/bin/npm-cli.js',
  '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
].find(candidate => candidate && existsSync(candidate));
assert.ok(npmCli, 'cannot locate npm-cli.js for the install smoke test');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Windows keeps a SQLite file locked until the connection is fully released. */
async function rm(dir) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;
      await delay(200);
    }
  }
  throw new Error(`could not remove temp directory (locked): ${dir}`);
}

// Mirrors scripts/check-semantic-assets.mjs — these must ship inside the tarball.
const RUNTIME_ASSETS = [
  'index.js',
  'hosts/mcp/bin.mjs',
  'models/bge-small-zh-v1.5/model_int8.onnx',
  'models/bge-small-zh-v1.5/tokenizer.json',
  'models/bge-small-zh-v1.5/tokenizer_config.json',
  'models/bge-small-zh-v1.5/config.json',
  'models/bge-small-zh-v1.5/MODEL-CARD.md',
  'lib/vendor/ort.wasm.bundle.min.mjs',
  'lib/vendor/ort-wasm-simd-threaded.wasm',
  'lib/vendor/ort-wasm-simd-threaded.mjs',
  'lib/vendor/tokenizers.min.mjs',
  'lib/vendor/ONNXRUNTIME-LICENSE.txt',
  'lib/vendor/TOKENIZERS-LICENSE.txt',
];

/** Minimal host context, matching test/helpers.mjs boot() closely enough for apply(). */
function makeCtx() {
  const tools = new Map();
  const disposers = [];
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    on() { return () => {}; },
    get(name) {
      if (name === 'systemPrompt') return { section() { return () => {}; } };
      if (name === 'webServer') return { register() { return () => {}; } };
      return undefined;
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {
        const at = disposers.indexOf(dispose);
        if (at >= 0) disposers.splice(at, 1);
        if (typeof dispose === 'function') dispose();
      };
    },
  };
  const call = (name, args) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return tool.execute(args ?? {}, {
      agent: { id: 'install-smoke-session' },
      session: { id: 'install-smoke-session' },
      scope: { id: 'install-smoke-session' },
    });
  };
  // apply() registers an effect that closes the SQLite store — running it is
  // what releases the DB file lock so the temp home can be deleted on Windows.
  const dispose = () => {
    for (const fn of disposers.reverse()) {
      try { fn(); } catch { /* ignore teardown errors */ }
    }
    disposers.length = 0;
  };
  return { ctx, call, dispose };
}

/** Fallback transport: drive the installed MCP server with real JSON-RPC frames. */
async function runViaMcp({ bin, cwd, env, marker }) {
  const child = spawn(process.execPath, [bin], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let buffer = '';
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame.id != null && pending.has(frame.id)) {
        pending.get(frame.id)(frame);
        pending.delete(frame.id);
      }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP request timed out: ${method}`));
    }, 20_000);
    pending.set(id, frame => { clearTimeout(timer); resolve(frame); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  try {
    const init = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'install-smoke', version: '1.0.0' },
    });
    assert.equal(init.result?.serverInfo?.name, 'omni-memory',
      `initialize must be a real JSON-RPC frame with serverInfo, got ${JSON.stringify(init)}`);
    assert.ok(init.result?.protocolVersion, 'initialize frame missing protocolVersion');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const write = await request('tools/call', {
      name: 'memory_write',
      arguments: { kind: 'note', text: marker },
    });
    assert.equal(write.result?.isError, false, `memory_write failed: ${JSON.stringify(write)}`);
    const writeText = (write.result?.content ?? []).map(c => c.text).join('\n');
    const idMatch = writeText.match(/stored note #(\d+)/);
    const id = idMatch ? Number(idMatch[1]) : NaN;

    const search = await request('tools/call', {
      name: 'memory_search',
      arguments: { query: marker },
    });
    assert.equal(search.result?.isError, false, `memory_search failed: ${JSON.stringify(search)}`);
    const searchText = (search.result?.content ?? []).map(c => c.text).join('\n');
    return { id, matchedText: searchText, path: 'mcp-handshake' };
  } finally {
    child.stdin.end();
    child.kill('SIGKILL');
    await Promise.race([once(child, 'exit').catch(() => {}), delay(2000)]);
  }
}

test('installed package works outside the repository layout', { timeout: 300_000 }, async t => {
  const packDir = mkdtempSync(path.join(tmpdir(), 'omni-install-smoke-pack-'));
  const consumerDir = mkdtempSync(path.join(tmpdir(), 'omni-install-smoke-consumer-'));
  const isoHome = mkdtempSync(path.join(tmpdir(), 'omni-install-smoke-home-'));
  const prodDb = path.join(homedir(), '.dsh', 'memory', 'omni.db');
  const prodBefore = existsSync(prodDb) ? statSync(prodDb).mtimeMs : null;
  const savedEnv = {
    OMNI_HOME: process.env.OMNI_HOME,
    DSH_HOME: process.env.DSH_HOME,
    OMNI_DISABLE_SEMANTIC: process.env.OMNI_DISABLE_SEMANTIC,
  };
  const marker = `INSTALL-SMOKE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let disposeInstalled = null;

  try {
    // Set isolation BEFORE any dynamic import: index.js resolves the store path at eval time.
    process.env.OMNI_HOME = isoHome;
    process.env.DSH_HOME = isoHome;
    process.env.OMNI_DISABLE_SEMANTIC = '1';
    assert.equal(process.env.OMNI_HOME, isoHome, 'isolation home must be active before import');

    // 1. npm pack (JSON output) from the project root.
    let tarball;
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [npmCli, 'pack', '--json', '--pack-destination', packDir],
        { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
      );
      const meta = JSON.parse(stdout.trim())[0];
      tarball = meta?.path ?? path.join(packDir, meta?.filename);
    } catch (err) {
      throw new Error(`npm pack failed: ${err.stderr || err.message}`);
    }
    assert.ok(tarball && existsSync(tarball), `tarball not found: ${tarball}`);
    t.diagnostic(`tarball: ${tarball}`);

    // 2. Install into a separate consumer directory, no network, no dev deps.
    try {
      await execFileAsync(
        process.execPath,
        [npmCli, 'install', tarball, '--no-save', '--omit=dev', '--no-audit', '--no-fund'],
        { cwd: consumerDir, maxBuffer: 16 * 1024 * 1024, timeout: 180_000 },
      );
    } catch (err) {
      throw new Error(`npm install failed: ${err.stderr || err.message}`);
    }
    const pkgRoot = path.join(consumerDir, 'node_modules', '@local', 'omni-memory');
    assert.ok(existsSync(path.join(pkgRoot, 'package.json')), 'installed package.json is missing');

    // 3. Runtime assets must be present (not zero-length) in the installed tree.
    const missing = RUNTIME_ASSETS.filter(rel => {
      const file = path.join(pkgRoot, ...rel.split('/'));
      return !existsSync(file) || statSync(file).size === 0;
    });
    assert.deepEqual(missing, [], `installed package missing runtime assets: ${missing.join(', ')}`);
    assert.ok(
      statSync(path.join(pkgRoot, 'models/bge-small-zh-v1.5/model_int8.onnx')).size > 20_000_000,
      'installed ONNX model looks truncated',
    );
    assert.ok(
      statSync(path.join(pkgRoot, 'lib/vendor/ort-wasm-simd-threaded.wasm')).size > 10_000_000,
      'installed WASM runtime looks truncated',
    );

    // 4. Write + recall through the installed package.
    let result;
    let mod;
    try {
      const entry = `${pathToFileURL(path.join(pkgRoot, 'index.js')).href}?install-smoke=${Date.now()}`;
      mod = await import(entry);
    } catch (importErr) {
      // 5. Fallback only for path/resolution problems (the artifact layout can
      // differ on some platforms). Any other import error is a real packaging
      // defect and must fail the test instead of passing through the MCP path.
      const code = importErr?.code ?? '';
      const pathLike = [
        'ERR_MODULE_NOT_FOUND',
        'MODULE_NOT_FOUND',
        'ERR_UNSUPPORTED_DIR_IMPORT',
        'ERR_INVALID_MODULE_SPECIFIER',
        'ERR_UNSUPPORTED_ESM_URL_SCHEME',
      ].includes(code) || /Cannot find (module|package)|Failed to resolve/i.test(importErr?.message ?? '');
      if (!pathLike) throw importErr;
      t.diagnostic(`dynamic import failed (${importErr.message}); falling back to MCP handshake`);
      result = await runViaMcp({
        bin: path.join(pkgRoot, 'hosts', 'mcp', 'bin.mjs'),
        cwd: consumerDir,
        env: { ...process.env, OMNI_HOME: isoHome, DSH_HOME: isoHome, OMNI_DISABLE_SEMANTIC: '1' },
        marker,
      });
    }
    if (mod) {
      // Assertions stay outside the try: a broken install must fail the test
      // instead of being swallowed as an "import failed" fallback.
      const { ctx, call, dispose } = makeCtx();
      disposeInstalled = dispose;
      mod.apply(ctx);
      const written = await call('memory_write', { kind: 'note', text: marker });
      assert.equal(typeof written.id, 'number', 'memory_write must return a numeric id');
      assert.ok(Number.isFinite(written.id), `memory_write id must be finite, got ${written.id}`);
      const found = await call('memory_search', { query: marker });
      const hit = (found.hits ?? []).find(item => item.kind === 'note' && item.id === written.id);
      assert.ok(hit, `recall missed written note id=${written.id}: ${JSON.stringify(found.hits)}`);
      assert.match(hit.text, new RegExp(marker), 'recalled note must contain the unique marker');
      result = { id: written.id, matchedText: hit.text, path: 'dynamic-import' };
    }
    assert.equal(typeof result.id, 'number', `write id must be numeric (path=${result.path})`);
    assert.ok(Number.isFinite(result.id), `write id must be finite (path=${result.path}, id=${result.id})`);
    assert.ok(result.matchedText.includes(marker), 'recall must return the written marker');
    t.diagnostic(`write+search OK via ${result.path} (id=${result.id})`);

    // Safety guard: the production store must be byte-for-byte untouched.
    const prodAfter = existsSync(prodDb) ? statSync(prodDb).mtimeMs : null;
    assert.equal(prodAfter, prodBefore, 'production DB ~/.dsh/memory/omni.db must not be touched');
  } finally {
    // Close the installed store first so no SQLite handle keeps the temp dir locked.
    if (disposeInstalled) disposeInstalled();
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await rm(packDir);
    await rm(consumerDir);
    await rm(isoHome);
  }
});
