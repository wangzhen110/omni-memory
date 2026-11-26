import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseJavaScript } from '../lib/project-adapters/js.mjs';
import { parseGeneric, parseCtagsJson } from '../lib/project-adapters/generic.mjs';
import { parseOpenApi, parseGraphQL } from '../lib/project-adapters/api.mjs';
import { PROJECT_INDEX_TABLES, createProjectIndexSchema, clearProjectScope } from '../lib/project-schema.mjs';
import { indexProject, projectContext, projectImpact, projectSearch, projectStatus } from '../lib/project-index.mjs';
import { makeContextTool } from '../hosts/shared/context-tool.mjs';

function db() {
  const value = new DatabaseSync(':memory:');
  value.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  createProjectIndexSchema(value);
  return value;
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'omni-project-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'test'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: '@fixture/app',
    description: 'Project index fixture',
  }));
  writeFileSync(path.join(root, 'README.md'), '# Fixture\n\nA project used by the code-index tests.\n');
  writeFileSync(path.join(root, 'src', 'auth.js'), `
import jwt from 'jsonwebtoken';
/** Verify a bearer token. */
export async function verifyToken(token) {
  const secret = 'SECRET_BODY_SHOULD_NOT_BE_INDEXED';
  return jwt.verify(token, secret);
}
export function login(req, res) { return res.json({ ok: verifyToken(req.body.token) }); }
`);
  writeFileSync(path.join(root, 'src', 'app.js'), `
import express from 'express';
import { login } from './auth.js';
const app = express();
export function createServer(port = 3000) {
  app.post('/api/login', login);
  return app.listen(port);
}
export class Router { get(path) { return path; } }
`);
  writeFileSync(path.join(root, 'test', 'app.test.js'), `
import { createServer } from '../src/app.js';
export function testServer() { return createServer(0); }
`);
  writeFileSync(path.join(root, 'openapi.yaml'), `openapi: 3.0.3
info:
  title: Fixture
  version: 1.0.0
paths:
  /api/login:
    post:
      summary: Login
      tags: [auth]
      responses:
        '200':
          description: ok
        '401':
          description: unauthorized
components:
  schemas:
    LoginRequest:
      type: object
      properties:
        token:
          type: string
`);
  writeFileSync(path.join(root, 'schema.graphql'), `
type Query { user(id: ID!): User }
type Mutation { login(token: String!): AuthPayload }
type User { id: ID! name: String! }
`);
  writeFileSync(path.join(root, 'scripts.py'), `import os\n\n@app.get('/health')\ndef health():\n    return {'ok': True}\n`);
  return root;
}

test('schema 20 exposes the five derived tables and can clear one scope', () => {
  const store = db();
  for (const table of PROJECT_INDEX_TABLES) {
    assert.ok(store.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table), table);
  }
  store.prepare("INSERT INTO code_files(scope,path,module_key,sha256,indexed_at) VALUES ('x','a','m','s',1)").run();
  clearProjectScope(store, 'x');
  assert.equal(store.prepare('SELECT COUNT(*) AS n FROM code_files').get().n, 0);
});

test('JS/TS reader extracts exports, classes, methods, docs and imports', () => {
  const value = parseJavaScript(`
import { x } from './x.js';
/**
 * First line.
 * Second line.
 */
export async function add(a, b) { return a + b; }
export const mul = (a, b) => a * b;
export class Store {
  constructor() { this.x = 1; }
  async get(key) { return this.x; }
}
export interface User { id: string; name: string; }
export type ID = string;
export enum Kind { A, B }
module.exports.legacy = 1;
`, 'src/lib.js');
  const names = value.symbols.map(symbol => symbol.name);
  assert.ok(names.includes('add'));
  assert.ok(names.includes('mul'));
  assert.ok(names.includes('Store'));
  assert.ok(value.symbols.some(symbol => symbol.qualifiedName === 'Store.get'));
  assert.ok(names.includes('User'));
  assert.ok(names.includes('ID'));
  assert.ok(names.includes('Kind'));
  assert.ok(names.includes('legacy'));
  assert.equal(value.imports[0].specifier, './x.js');
  const add = value.symbols.find(symbol => symbol.name === 'add');
  assert.equal(add.doc, 'First line. Second line.');
  assert.equal(add.exported, true);
});

test('JS reader recognizes Express, Fastify and Next.js route shapes', () => {
  const express = parseJavaScript(`
const app = require('express')();
app.get('/health', health);
app.post('/users/:id', updateUser);
router.route({ method: 'PUT', url: '/items' });
`, 'src/routes.js');
  assert.deepEqual(express.apis.map(api => `${api.method} ${api.route}`), ['GET /health', 'POST /users/:id', 'PUT /items']);

  const next = parseJavaScript(`export function GET() { return new Response('ok'); }`, 'app/api/health/route.ts');
  assert.equal(next.apis.length, 1);
  assert.equal(next.apis[0].method, 'GET');
  assert.equal(next.apis[0].route, '/api/health');
});

test('OpenAPI JSON reader extracts operation contracts and schemas', () => {
  const value = parseOpenApi(JSON.stringify({
    openapi: '3.0.3',
    paths: {
      '/users/{id}': {
        get: {
          summary: 'Get user',
          operationId: 'getUser',
          security: [{ bearer: [] }],
          parameters: [{ $ref: '#/components/schemas/UserId' }],
          responses: { 200: { $ref: '#/components/schemas/User' }, 404: { description: 'not found' } },
        },
      },
    },
    components: { schemas: { User: { type: 'object', properties: { id: { type: 'string' } } } } },
  }), 'openapi.json');
  assert.equal(value.apis.length, 1);
  assert.equal(value.apis[0].method, 'GET');
  assert.equal(value.apis[0].route, '/users/{id}');
  assert.match(value.apis[0].request, /UserId/);
  assert.match(value.apis[0].response, /200/);
  assert.equal(value.schemas[0].name, 'User');
});

test('OpenAPI YAML reader extracts paths, errors and component schemas', () => {
  const value = parseOpenApi(`openapi: 3.0.3
paths:
  /api/login:
    post:
      summary: Login
      tags: [auth]
      responses:
        '200':
          description: ok
        '401':
          description: unauthorized
components:
  schemas:
    LoginRequest:
      type: object
      properties:
        token:
          type: string
`, 'openapi.yaml');
  assert.equal(value.apis.length, 1);
  assert.equal(value.apis[0].method, 'POST');
  assert.equal(value.apis[0].route, '/api/login');
  assert.equal(value.apis[0].errors, '401');
  assert.equal(value.schemas[0].name, 'LoginRequest');
});

test('GraphQL SDL reader turns Query/Mutation fields into API contracts', () => {
  const value = parseGraphQL(`type Query { user(id: ID!): User users: [User!]! }
type Mutation { login(token: String!): AuthPayload }
type User { id: ID! name: String! }
`, 'schema.graphql');
  assert.equal(value.apis.length, 3);
  assert.ok(value.apis.some(api => api.method === 'QUERY' && api.route === 'user'));
  assert.ok(value.apis.some(api => api.method === 'MUTATION' && api.route === 'login'));
  assert.ok(value.symbols.some(symbol => symbol.kind === 'type' && symbol.name === 'User'));
});

test('generic reader covers Python decorators and Go handlers', () => {
  const py = parseGeneric(`import os\n@app.get('/health')\ndef health():\n    return {'ok': True}\nclass Worker:\n    pass\n`, 'scripts.py', 'python');
  assert.ok(py.apis.some(api => api.method === 'GET' && api.route === '/health'));
  assert.ok(py.symbols.some(symbol => symbol.name === 'Worker'));

  const go = parseGeneric(`package server\nimport "fmt"\nfunc Health(w http.ResponseWriter, r *http.Request) { fmt.Println("ok") }\nr.GET("/health", Health)\n`, 'server.go', 'go');
  assert.ok(go.symbols.some(symbol => symbol.name === 'Health'));
  assert.ok(go.apis.some(api => api.method === 'GET' && api.route === '/health'));
});

test('ctags JSON stream converts to symbol rows with paths and lines', () => {
  const value = parseCtagsJson('{"name":"ServeHTTP","kind":"function","path":"src/server.go","line":12,"signature":"func ServeHTTP(w, r)","scope":"Server"}\n', '.');
  assert.equal(value.length, 1);
  assert.equal(value[0].name, 'ServeHTTP');
  assert.equal(value[0].path, 'src/server.go');
  assert.equal(value[0].line, undefined);
  assert.equal(value[0].startLine, 12);
});

test('indexProject builds modules, symbols, APIs and edges in one pass', () => {
  const root = fixture();
  const store = db();
  const report = indexProject(store, root, { scope: 'proj:fixture', ctags: false });
  assert.equal(report.ok, true);
  assert.equal(report.files, 8);
  assert.ok(report.symbols > 5);
  assert.ok(report.apis >= 3);
  assert.equal(report.modules, 1);
  assert.ok(report.edges >= 8);
  const module = store.prepare('SELECT * FROM code_modules WHERE scope = ?').get('proj:fixture');
  assert.match(module.description, /Project index fixture/);
  assert.match(module.public_surface, /createServer/);
});

test('indexProject is incremental and leaves unchanged rows alone', () => {
  const root = fixture();
  const store = db();
  indexProject(store, root, { scope: 'proj:fixture', ctags: false });
  const before = store.prepare('SELECT id, source_ref FROM code_symbols WHERE scope = ? ORDER BY id').all('proj:fixture');
  const again = indexProject(store, root, { scope: 'proj:fixture', ctags: false });
  assert.equal(again.parsed, 0);
  assert.equal(again.unchanged, again.files);
  assert.deepEqual(store.prepare('SELECT id, source_ref FROM code_symbols WHERE scope = ? ORDER BY id').all('proj:fixture'), before);
});

test('a content change is detected even when mtime and size are preserved', () => {
  const root = fixture();
  const store = db();
  indexProject(store, root, { scope: 'proj:fixture', ctags: false });
  const file = path.join(root, 'src', 'app.js');
  const before = statSync(file);
  writeFileSync(file, readFileSync(file, 'utf8').replace('createServer', 'createServerV2'));
  utimesSync(file, before.atime, before.mtime);
  const status = projectStatus(store, root, { scope: 'proj:fixture' });
  assert.ok(status.stale >= 1);
  const search = projectSearch(store, 'createServer', { scope: 'proj:fixture', root });
  assert.ok(search.symbols.some(symbol => symbol.stale));
  const next = indexProject(store, root, { scope: 'proj:fixture', ctags: false });
  assert.equal(next.parsed, 1);
  assert.ok(store.prepare("SELECT name FROM code_symbols WHERE scope = ? AND name = 'createServerV2'").get('proj:fixture'));
});

test('removed files are cleaned from files, symbols, APIs and edges', () => {
  const root = fixture();
  const store = db();
  indexProject(store, root, { scope: 'proj:fixture', ctags: false });
  rmSync(path.join(root, 'src', 'auth.js'));
  const report = indexProject(store, root, { scope: 'proj:fixture', ctags: false });
  assert.equal(report.removed, 1);
  assert.equal(store.prepare("SELECT COUNT(*) AS n FROM code_files WHERE scope = ? AND path = 'src/auth.js'").get('proj:fixture').n, 0);
  assert.equal(store.prepare("SELECT COUNT(*) AS n FROM code_symbols WHERE scope = ? AND path = 'src/auth.js'").get('proj:fixture').n, 0);
  assert.equal(store.prepare("SELECT COUNT(*) AS n FROM code_edges WHERE scope = ? AND dst = 'code:src/auth.js'").get('proj:fixture').n, 0);
});

test('full rebuild parses every file and drops old rows', () => {
  const root = fixture();
  const store = db();
  indexProject(store, root, { scope: 'proj:fixture', ctags: false });
  const source = path.join(root, 'src', 'app.js');
  writeFileSync(source, readFileSync(source, 'utf8').replace('createServer', 'createServerFull'));
  const report = indexProject(store, root, { scope: 'proj:fixture', ctags: false, full: true });
  assert.equal(report.parsed, report.files);
  assert.equal(report.unchanged, 0);
  assert.equal(store.prepare("SELECT COUNT(*) AS n FROM code_symbols WHERE scope = ? AND name = 'createServer'").get('proj:fixture').n, 0);
  assert.ok(store.prepare("SELECT COUNT(*) AS n FROM code_symbols WHERE scope = ? AND name = 'createServerFull'").get('proj:fixture').n);
});

test('index never stores a function body or source text', () => {
  const root = fixture();
  const store = db();
  indexProject(store, root, { scope: 'proj:fixture', ctags: false });
  const blob = JSON.stringify([
    ...store.prepare('SELECT * FROM code_files WHERE scope = ?').all('proj:fixture'),
    ...store.prepare('SELECT * FROM code_symbols WHERE scope = ?').all('proj:fixture'),
    ...store.prepare('SELECT * FROM code_apis WHERE scope = ?').all('proj:fixture'),
  ]);
  assert.doesNotMatch(blob, /SECRET_BODY_SHOULD_NOT_BE_INDEXED/);
});

test('search returns exact symbol fields with sourceRef, line and sha', () => {
  const root = fixture();
  const store = db();
  indexProject(store, root, { scope: 'proj:fixture', ctags: false });
  const value = projectSearch(store, 'verifyToken', { scope: 'proj:fixture', root });
  assert.equal(value.symbols.length, 1);
  assert.equal(value.symbols[0].name, 'verifyToken');
  assert.equal(value.symbols[0].line, 4);
  assert.match(value.symbols[0].sourceRef, /^code:src\/auth\.js#L4:/);
  assert.equal(value.symbols[0].sha.length, 64);
  assert.equal(value.symbols[0].stale, false);
});

test('search filters API by method and route', () => {
  const root = fixture();
  const store = db();
  indexProject(store, root, { scope: 'proj:fixture', ctags: false });
  const value = projectSearch(store, '/api/login', { scope: 'proj:fixture', root, kind: 'api', method: 'POST' });
  assert.ok(value.apis.length >= 1);
  assert.ok(value.apis.every(api => api.method === 'POST'));
  assert.ok(value.apis.some(api => api.route === '/api/login'));
});

test('search clamps negative and non-numeric limits before SQL', () => {
  const root = fixture();
  const store = db();
  indexProject(store, root, { scope: 'proj:fixture', ctags: false });
  const negative = projectSearch(store, '', { scope: 'proj:fixture', root, limit: -1 });
  assert.ok(negative.symbols.length <= 1, 'limit=-1 must behave as one row, not an unbounded scan');
  assert.ok(negative.files.length <= 1);
  const huge = projectSearch(store, '', { scope: 'proj:fixture', root, limit: 999999 });
  assert.ok(huge.symbols.length <= 80);
  assert.ok(huge.files.length <= 48);
  const nonsense = projectSearch(store, '', { scope: 'proj:fixture', root, limit: 'abc' });
  assert.equal(nonsense.ok, true);
  assert.ok(nonsense.symbols.length > 0);
});

test('context is bounded and carries sourceRef, line, sha and stale', () => {
  const root = fixture();
  const store = db();
  indexProject(store, root, { scope: 'proj:fixture', ctags: false });
  const value = projectContext(store, 'code:src/auth.js#L4:function:verifyToken', { scope: 'proj:fixture', root, budget: 700 });
  assert.equal(value.ok, true);
  assert.ok(value.chars <= 700);
  assert.match(value.text, /sourceRef|code:src\/auth\.js#L4/);
  assert.match(value.text, /sha:/);
  assert.equal(value.refs[0].sha.length, 64);
  assert.equal(value.refs[0].stale, false);
});

test('impact walks reverse static imports and test links', () => {
  const root = fixture();
  const store = db();
  indexProject(store, root, { scope: 'proj:fixture', ctags: false });
  const value = projectImpact(store, 'src/auth.js', { scope: 'proj:fixture', root });
  assert.equal(value.ok, true);
  assert.ok(value.importers.includes('src/app.js'));
  assert.ok(value.tests.some(item => item.path === 'test/app.test.js'));
});

test('module context reports responsibility, imports and public surface', () => {
  const root = fixture();
  const store = db();
  indexProject(store, root, { scope: 'proj:fixture', ctags: false });
  const value = projectContext(store, 'module:root', { scope: 'proj:fixture', root, budget: 1800 });
  assert.equal(value.ok, true);
  assert.match(value.text, /负责: Project index fixture/);
  assert.match(value.text, /公开面:/);
  assert.match(value.text, /imports:/);
});

test('monorepo manifests become separate modules', () => {
  const root = fixture();
  mkdirSync(path.join(root, 'packages', 'core', 'src'), { recursive: true });
  writeFileSync(path.join(root, 'packages', 'core', 'package.json'), JSON.stringify({ name: '@fixture/core' }));
  writeFileSync(path.join(root, 'packages', 'core', 'src', 'index.ts'), 'export const answer = 42;\n');
  const store = db();
  const report = indexProject(store, root, { scope: 'proj:fixture', ctags: false });
  assert.equal(report.modules, 2);
  const modules = store.prepare('SELECT key FROM code_modules WHERE scope = ? ORDER BY key').all('proj:fixture').map(row => row.key);
  assert.deepEqual(modules, ['module:packages/core', 'module:root']);
});

test('status reports stale and missing files', () => {
  const root = fixture();
  const store = db();
  indexProject(store, root, { scope: 'proj:fixture', ctags: false });
  rmSync(path.join(root, 'src', 'app.js'));
  const value = projectStatus(store, root, { scope: 'proj:fixture' });
  assert.equal(value.ok, true);
  assert.equal(value.missing, 1);
  assert.ok(value.stale >= 1);
});

test('resolving a symbol name returns its context', () => {
  const root = fixture();
  const store = db();
  indexProject(store, root, { scope: 'proj:fixture', ctags: false });
  const value = projectContext(store, 'login', { scope: 'proj:fixture', root, budget: 800 });
  assert.equal(value.ok, true);
  assert.match(value.text, /login/);
  assert.match(value.text, /auth\.js/);
});

test('1,000 files cold index under 30s and warm sync within the disk-relative budget', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'omni-project-scale-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'scale-fixture' }));
  for (let i = 0; i < 1000; i += 1) {
    writeFileSync(path.join(root, 'src', `f${i}.js`), `export function f${i}() { return ${i}; }\n`);
  }
  const store = db();
  const coldStart = Date.now();
  const cold = indexProject(store, root, { scope: 'proj:scale', ctags: false });
  const coldMs = Date.now() - coldStart;
  assert.equal(cold.files, 1001);
  assert.ok(coldMs < 30_000, `cold index took ${coldMs}ms`);
  const warmStart = Date.now();
  const warm = indexProject(store, root, { scope: 'proj:scale', ctags: false });
  const warmMs = Date.now() - warmStart;
  assert.equal(warm.parsed, 0);
  // A fixed 2s ceiling assumes a warm page cache and a fast disk. Keep that as
  // the floor, but on a slow/virtualised disk allow up to 2x the measured cold
  // pass so the test still catches a warm path that re-parses or re-walks.
  const warmBudgetMs = Math.max(2_000, coldMs * 2);
  t.diagnostic(`1000-file cold ${coldMs}ms · warm ${warmMs}ms · budget ${Math.round(warmBudgetMs)}ms`);
  assert.ok(warmMs < warmBudgetMs, `warm sync took ${warmMs}ms (budget ${Math.round(warmBudgetMs)}ms, cold ${coldMs}ms)`);
  const queryTimes = [];
  for (let i = 0; i < 40; i += 1) {
    const queryStart = Date.now();
    projectSearch(store, `f${990 + (i % 10)}`, { scope: 'proj:scale', root });
    queryTimes.push(Date.now() - queryStart);
  }
  queryTimes.sort((a, b) => a - b);
  const p95 = queryTimes[Math.min(queryTimes.length - 1, Math.ceil(queryTimes.length * 0.95) - 1)];
  assert.ok(p95 < 50, `p95 query took ${p95}ms`);
});

test('memory_context appends a bounded project packet only when a reference resolves', async () => {
  const root = fixture();
  const store = db();
  indexProject(store, root, { scope: 'proj:ctx', ctags: false });
  const host = {
    tools: {
      get(name) {
        if (name !== 'project_context') return null;
        return {
          execute: args => projectContext(store, args.ref, { scope: args.scope, budget: args.budget }),
        };
      },
    },
  };
  const tool = makeContextTool(host);
  const hit = await tool.execute({ query: 'verifyToken', scope: 'proj:ctx' });
  assert.match(hit.text, /## 项目代码索引/);
  assert.match(hit.text, /code:src\/auth\.js#L4/);
  assert.match(hit.text, /sha:/);
  assert.ok(hit.project && hit.project.chars > 0);
  assert.equal(hit.project.stale, 0);
  const miss = await tool.execute({ query: 'no-such-project-symbol-xyz', scope: 'proj:ctx' });
  assert.equal(miss.project, null);
  assert.doesNotMatch(miss.text, /## 项目代码索引/);
  rmSync(root, { recursive: true, force: true });
});
