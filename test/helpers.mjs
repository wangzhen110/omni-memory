import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let counter = 0;

/** The only directory memory_export/memory_import accept. */
export function backupDirOf(app) {
  return path.join(app.home, 'memory', 'backups');
}

/** Return a valid in-sandbox backup path, creating the directory if needed. */
export function backupPathOf(app, name) {
  const dir = backupDirOf(app);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

/** Copy an exported backup between two throwaway stores (the test equivalent of a user copy). */
export function copyBackup(sourceApp, targetApp, name) {
  const target = backupPathOf(targetApp, name);
  copyFileSync(backupPathOf(sourceApp, name), target);
  return target;
}

/**
 * Boot the plugin against a throwaway DSH_HOME and return stubs for every host
 * surface it registers on. Each call uses a fresh module instance so module
 * level caches (store, profile cache) never leak between cases.
 */
export async function boot(options = {}) {
  const home = options.home ?? mkdtempSync(path.join(tmpdir(), 'omni-test-'));
  // index.js prefers OMNI_HOME over DSH_HOME. Setting only DSH_HOME let a
  // developer who exported OMNI_HOME for their real adapter silently run these
  // tests against production memory. Always pin both names to the temp home.
  process.env.OMNI_HOME = home;
  process.env.DSH_HOME = home;
  process.env.OMNI_VERSION_CHECK_DISABLED = '1';
  delete process.env.OMNI_BACKUP_DIR;
  delete process.env.OMNI_TRUSTED_HOSTS;
  // The bundled model costs ~216MB RSS per process. Tests opt in with
  // boot({ semantic: true }) instead of paying that cost on every case.
  if (options.semantic === true) delete process.env.OMNI_DISABLE_SEMANTIC;
  else process.env.OMNI_DISABLE_SEMANTIC = '1';
  counter += 1;
  const mod = await import(`../index.js?case=${counter}-${Date.now()}`);

  const tools = new Map();
  const listeners = new Map();
  const routes = [];
  let section = null;
  let lastSessionId = 'session-test';

  const ctx = {
    agent: { id: lastSessionId },
    session: { id: lastSessionId, cwd: process.cwd() },
    scope: { id: lastSessionId },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    on(name, handler) {
      listeners.set(name, handler);
      return () => listeners.delete(name);
    },
    get(name) {
      if (name === 'systemPrompt') {
        return {
          section(value) {
            section = value;
            return () => { section = null; };
          },
        };
      }
      if (name === 'webServer') {
        return {
          register(route) {
            routes.push(route);
            return () => { const at = routes.indexOf(route); if (at >= 0) routes.splice(at, 1); };
          },
        };
      }
      if (name === 'llm') return options.llm;
      return undefined;
    },
    effect(fn) {
      fn();
      return () => {};
    },
  };

  mod.apply(ctx);

  const call = async (name, args = {}) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`missing tool ${name}`);
    const value = await tool.execute(args, { agent: { id: lastSessionId }, session: { id: lastSessionId } });
    const rendered = tool.output.render(args, value);
    return { value, text: rendered.map(block => block.text).join('\n') };
  };

  const fire = (type, text, seq = 1, sessionId = 'session-test') => {
    lastSessionId = sessionId;
    const listener = listeners.get('session/event');
    if (!listener) throw new Error('capture listener is not registered');
    listener({ id: sessionId }, {
      type, seq, time: Date.now(),
      data: { message: { content: [{ type: 'text', text }] } },
    });
  };

  const fireRaw = (event) => {
    const listener = listeners.get('session/event');
    if (!listener) throw new Error('capture listener is not registered');
    listener({ id: 'session-test' }, event);
  };

  const route = routePath => {
    const found = routes.find(item => item.path === routePath);
    if (!found) throw new Error(`missing route ${routePath}`);
    return found;
  };

  const fireWithCwd = (cwd, type, text, seq = 1, sessionId = 'session-test') => {
    lastSessionId = sessionId;
    const listener = listeners.get('session/event');
    if (!listener) throw new Error('capture listener is not registered');
    listener({ id: sessionId, header: { cwd } }, {
      type, seq, time: Date.now(),
      data: { message: { content: [{ type: 'text', text }] } },
    });
  };

  const fireInbox = (text, agentId = 'agent-test') => {
    const listener = listeners.get('agent/inbox/claimed');
    if (!listener) throw new Error('auto-recall listener is not registered');
    listener({
      agent: { id: agentId },
      turn: 1,
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
  };

  return { home, tools, listeners, routes, call, fire, fireInbox, fireRaw, fireWithCwd, route, section: () => section, mod };
}

export function fakeRes() {
  const state = { statusCode: 0, body: '', headers: {} };
  const res = {
    setHeader(key, value) { state.headers[String(key).toLowerCase()] = value; },
    end(chunk) { if (chunk !== undefined) state.body += String(chunk); },
  };
  Object.defineProperty(res, 'statusCode', {
    get: () => state.statusCode,
    set: value => { state.statusCode = value; },
  });
  return { res, state, json() { return JSON.parse(state.body); } };
}

export function fakeReq(url, address = '127.0.0.1') {
  return { method: 'GET', url, headers: { host: '127.0.0.1' }, socket: { remoteAddress: address } };
}

/** Minimal POST request with a JSON body; emits data/end on next microtask. */
export function fakePost(body, address = '127.0.0.1', url = '/omni-memory/forget') {
  const handlers = new Map();
  const headers = { host: '127.0.0.1' };
  const req = {
    method: 'POST',
    url,
    socket: { remoteAddress: address },
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
      return req;
    },
  };
  Object.defineProperty(req, 'headers', {
    get: () => headers,
    set: value => { Object.assign(headers, value ?? {}); },
  });
  queueMicrotask(() => {
    const payload = JSON.stringify(body ?? {});
    for (const handler of handlers.get('data') ?? []) handler(payload);
    for (const handler of handlers.get('end') ?? []) handler();
  });
  return req;
}

/**
 * POST whose stream the host already consumed (the real DSH web server behaves
 * this way): no `data`/`end` events ever arrive.
 */
export function fakePostConsumed(url, address = '127.0.0.1') {
  return {
    method: 'POST',
    url,
    complete: true,
    readable: false,
    headers: { host: '127.0.0.1' },
    socket: { remoteAddress: address },
    on() { return this; },
  };
}
