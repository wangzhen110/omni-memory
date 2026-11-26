#!/usr/bin/env node
/**
 * Documentation consistency gate.
 *
 * Every review that found drift found it the same way: the docs claimed a
 * version / test count / route count that the code no longer had. This script
 * fails `npm run check` when the two disagree, so drift cannot ship silently.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = file => readFileSync(path.join(root, file), 'utf8');

const pkg = JSON.parse(read('package.json'));
const index = read('index.js');
const toolSource = index + read('lib/tool-definitions.mjs');
const routeSource = index + read('lib/read-routes.mjs');
const readme = read('README.md');
const design = read('docs/DESIGN.md');
const changelog = read('docs/CHANGELOG.md');
const mcpReadme = read('hosts/mcp/README.md');
const adapterSource = read('hosts/shared/context-tool.mjs') + read('hosts/shared/rules.mjs');

const tools = [...new Set([...toolSource.matchAll(/name:\s*'((?:memory|project)_[a-z_]+)'/g)].map(match => match[1]))].sort();
const adapterTools = [...new Set([...adapterSource.matchAll(/name:\s*'(memory_[a-z_]+)'/g)].map(match => match[1]))]
  .filter(tool => !tools.includes(tool))
  .sort();
const mcpTools = tools.length + adapterTools.length;
const routes = [...new Set([...routeSource.matchAll(/path:\s*'\/omni-memory\/([a-z/.]+)'/g)].map(match => match[1]))].sort();
const adrCount = readdirSync(path.join(root, 'docs', 'ADR')).filter(file => file.endsWith('.md')).length;

let tests = 0;
for (const file of readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.test.mjs'))) {
  tests += (readFileSync(path.join(root, 'test', file), 'utf8').match(/^test\(/gm) ?? []).length;
}

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

console.log(`\n${tests} tests, ${tools.length} core tools / ${mcpTools} MCP tools, ${routes.length} routes, ${adrCount} ADRs, version ${pkg.version}`);
if (failures.length) {
  console.error(`\n${failures.length} documentation mismatch(es). Update the docs before shipping.`);
  process.exit(1);
}
console.log('documentation is consistent');
