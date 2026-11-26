#!/usr/bin/env node
/**
 * Documentation consistency gate.
 *
 * Every review that found drift found it the same way: the docs claimed a
 * version / test count / route count that the code no longer had. This script
 * fails `npm run check` when the two disagree, so drift cannot ship silently.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { designTestHookMatches } from '../lib/design-contract.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tapArg = process.argv.indexOf('--tap');
const tapArgValue = tapArg >= 0 ? process.argv[tapArg + 1] : undefined;
if (tapArg >= 0 && !tapArgValue) {
  console.error('--tap requires a path');
  process.exit(1);
}
const tapFile = tapArg >= 0
  ? path.resolve(process.cwd(), tapArgValue)
  : path.join(root, '.test-results.tap');
if (tapArg >= 0 && !existsSync(tapFile)) {
  console.error(`TAP file missing: ${tapFile}`);
  process.exit(1);
}
const read = file => {
  const full = path.join(root, file);
  if (!existsSync(full)) {
    console.error(`missing required doc: ${file}`);
    process.exit(1);
  }
  return readFileSync(full, 'utf8');
};

const pkg = JSON.parse(read('package.json'));
const index = read('index.js');
const toolSource = index + read('lib/tool-definitions.mjs');
const routeSource = index + read('lib/read-routes.mjs');
const readme = read('README.md');
const design = read('docs/DESIGN.md');
const changelog = read('docs/CHANGELOG.md');
const mcpReadme = read('hosts/mcp/README.md');
const hostAdapters = read('docs/HOST-ADAPTERS.md');
const reference = read('docs/REFERENCE.md');
const profileSource = read('lib/profile.mjs');
const adapterSource = read('hosts/shared/context-tool.mjs') + read('hosts/shared/rules.mjs');

const tools = [...new Set([...toolSource.matchAll(/name:\s*'((?:memory|project)_[a-z_]+)'/g)].map(match => match[1]))].sort();
const adapterTools = [...new Set([...adapterSource.matchAll(/name:\s*'(memory_[a-z_]+)'/g)].map(match => match[1]))]
  .filter(tool => !tools.includes(tool))
  .sort();
const mcpTools = tools.length + adapterTools.length;
const routes = [...new Set([...routeSource.matchAll(/path:\s*'\/omni-memory\/([a-z/.]+)'/g)].map(match => match[1]))].sort();
const adrCount = readdirSync(path.join(root, 'docs', 'ADR')).filter(file => file.endsWith('.md')).length;

// OpenAPI is a separate surface from the 26 REST routes: only a documented
// subset is published to C-class hosts. Count the actual `paths` block so the
// three docs cannot drift back to stale path counts.
const openapiStart = profileSource.indexOf('const HOST_OPENAPI');
const openapiEnd = profileSource.indexOf('export {', openapiStart);
const openapiSource = openapiStart >= 0 && openapiEnd > openapiStart
  ? profileSource.slice(openapiStart, openapiEnd)
  : '';
const openapiPaths = [...new Set(
  [...openapiSource.matchAll(/'\/omni-memory\/([a-z./]+)':\s*\{/g)].map(match => match[1]),
)].sort();

// `npm test` emits TAP; when present it is the truth. A standalone
// `npm run check` falls back to counting declarations, but never claims the
// declarations actually ran.
function readTapSummary() {
  let tap;
  try {
    tap = readFileSync(tapFile, 'utf8');
  } catch {
    return null;
  }
  const value = label => {
    const match = new RegExp(`^# ${label} (\\d+)$`, 'm').exec(tap);
    return match ? Number(match[1]) : null;
  };
  const summary = {
    tests: value('tests'),
    pass: value('pass'),
    fail: value('fail'),
    cancelled: value('cancelled'),
    skipped: value('skipped') ?? 0,
  };
  // An existing but truncated TAP must not silently fall back to the
  // declaration count: that is exactly the "test file never ran" blind spot
  // this gate exists to catch.
  return summary.tests === null ? { invalid: true } : summary;
}

let declaredTests = 0;
for (const file of readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.test.mjs'))) {
  declaredTests += (readFileSync(path.join(root, 'test', file), 'utf8').match(/^test\(/gm) ?? []).length;
}
const tap = readTapSummary();
const tests = tap?.tests ?? declaredTests;

const failures = [];
const check = (label, ok, detail) => {
  if (ok) {
    console.log(`ok   ${label}`);
    return;
  }
  failures.push(`${label}: ${detail}`);
  console.log(`FAIL ${label}: ${detail}`);
};

check('package version equals DESIGN', design.includes(`| 插件版本 | ${pkg.version} |`), `DESIGN does not claim ${pkg.version}`);
check('README badge test count', readme.includes(`tests-${tests}%2F${tests}`), `README badge is not ${tests}/${tests}`);
check('README test count line', readme.includes(`**${tests} / ${tests} 通过**`), `README does not say ${tests}/${tests} 通过`);
check('README npm test hint', readme.includes(`# ${tests} 个用例`), `README does not say ${tests} 个用例`);
check('DESIGN test reliability', design.includes(`${tests}/${tests}`), `DESIGN NFR does not say ${tests}/${tests}`);
check('README ADR count', readme.includes(`（${adrCount} 份）`), `README does not say ${adrCount} 份`);
check('DESIGN route list', routes.every(route => design.includes(route)) && design.includes(`${routes.length} 条 loopback HTTP`), `DESIGN routes do not match ${routes.join(',')}`);
check('README tool count', tools.every(tool => readme.includes(tool)), `README misses a tool (${tools.join(',')})`);
check('README MCP tool count', readme.includes(`${mcpTools} 个 MCP 工具`), `README does not say ${mcpTools} 个 MCP 工具`);
check('MCP README tool count', mcpReadme.includes(`${mcpTools} 个 MCP 工具`), `hosts/mcp/README.md does not say ${mcpTools} 个 MCP 工具`);
check('MCP README route count', mcpReadme.includes(`${routes.length} 条 REST 路由`), `hosts/mcp/README.md does not say ${routes.length} 条 REST 路由`);
check('DESIGN core tool count', design.includes(`${tools.length} 个插件工具`), `DESIGN does not say ${tools.length} 个插件工具`);
check('CHANGELOG has current version', new RegExp(`## \\[${pkg.version.replaceAll('.', '\\.')}\\]`).test(changelog), `CHANGELOG has no ${pkg.version} entry`);
check('TAP summary is complete', !tap?.invalid,
  'TAP file exists but has no # tests summary; refusing to fall back to declared test count');

// TAP is the truth for pass/fail, but a smaller TAP can also mean a whole test
// file failed to load and was never seen by the runner. Keep the declaration
// count as a lower bound so a silently smaller run cannot pass as green.
if (tap && !tap.invalid) {
  check('TAP covers every declared test', tap.tests >= declaredTests,
    `TAP ran ${tap.tests}, but ${declaredTests} test declarations exist`);
}

// The rules text used to exist in three long-lived copies plus a summary per
// host. Every doc must now say the same thing, or a future edit will silently
// reintroduce the fork.
for (const [label, doc] of [
  ['README', readme],
  ['HOST-ADAPTERS', hostAdapters],
  ['REFERENCE', reference],
  ['MCP README', mcpReadme],
]) {
  check(`${label} rules channels share RULES_TEXT`,
    doc.includes('共享同一份 `RULES_TEXT`'),
    `${label} must say all rule channels share the same RULES_TEXT`);
}
check('README drops the never-drift claim',
  !readme.includes('永不漂移'),
  'README still uses the old "永不漂移" wording instead of naming RULES_TEXT');

check('REFERENCE documents REST /search limit',
  reference.includes('默认 30，上限 60'),
  'REFERENCE must document the /search limit default 30 and cap 60');
check('REFERENCE assigns persona clear to HTTP only',
  reference.includes('仅 HTTP 管理面') && reference.includes('MCP 工具不支持 clear'),
  'REFERENCE must mark persona clear as HTTP-only and absent from MCP');

check('no retired OMNI_TEST_KEY_FILE name',
  ![readme, design, changelog, reference, hostAdapters, mcpReadme].some(doc => doc.includes('OMNI_TEST_KEY_FILE')),
  'a doc still uses the retired OMNI_TEST_KEY_FILE variable');
check('test public key file variable is documented',
  design.includes('OMNI_TEST_UPDATE_PUBLIC_KEY_FILE') && changelog.includes('OMNI_TEST_UPDATE_PUBLIC_KEY_FILE'),
  'DESIGN/CHANGELOG must name OMNI_TEST_UPDATE_PUBLIC_KEY_FILE');

check('OpenAPI path count is consistent',
  openapiPaths.length > 0
  && [design, hostAdapters, reference].every(doc => doc.includes(`${openapiPaths.length} 条 path`)),
  `OpenAPI paths=${openapiPaths.length}; docs must all say "${openapiPaths.length} 条 path"`);

check('DESIGN test hook matches child-only contract',
  designTestHookMatches(design),
  'DESIGN must say the test hook accepts only child / child-vN and is not a security boundary');

// Reports used to hand-copy measurements from a different run. Once a release
// has a tracked TAP evidence file, the completion report must quote those
// exact lines, so a number cannot drift away from the archived artifact.
const evidenceFile = `docs/evidence/${pkg.version}.json`;
if (existsSync(path.join(root, evidenceFile))) {
  const evidence = JSON.parse(read(evidenceFile));
  const completion = readdirSync(path.join(root, 'docs'))
    .find(name => name.startsWith(`COMPLETION-${pkg.version}-`) && name.endsWith('.md'));
  const completionText = completion ? read(`docs/${completion}`) : '';
  const required = [evidence.summaryLine, evidence.durationLine, ...(evidence.adrLines ?? []), evidence.indexLine]
    .filter(Boolean);
  check('completion report quotes archived TAP evidence',
    Boolean(completion) && required.every(line => completionText.includes(line)),
    `completion report must quote ${evidenceFile} exactly (${required.length} line(s))`);
}

check('stdio and HTTP initialize use RULES_TEXT',
  read('hosts/mcp/bin.mjs').includes('instructions: RULES_TEXT')
  && read('hosts/http/server.mjs').includes('instructions: RULES_TEXT'),
  'one host still sends a separate initialize summary');

if (tap && !tap.invalid) {
  check('TAP run has no failures', tap.fail === 0,
    `TAP reports ${tap.fail} failure(s)`);
}

console.log(`\n${tests} tests${tap && !tap.invalid ? ' (TAP)' : ' (declared)'}, ${tools.length} core tools / ${mcpTools} MCP tools, ${routes.length} routes, ${openapiPaths.length} OpenAPI paths, ${adrCount} ADRs, version ${pkg.version}`);
if (failures.length) {
  console.error(`\n${failures.length} documentation mismatch(es). Update the docs before shipping.`);
  process.exit(1);
}
console.log('documentation is consistent');
