// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
/**
 * Lightweight JavaScript / TypeScript source reader.
 *
 * It is deliberately not a full AST: the index is a rebuildable locator, not a
 * compiler. It extracts exports, declarations, class methods, imports and the
 * common route registration shapes, with line numbers and signatures. Source
 * bodies never leave this function.
 */

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'new', 'do', 'else', 'try', 'finally', 'typeof', 'await', 'yield']);

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineAt(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= index) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(1, lo);
}

/** Find the matching close brace, ignoring comments and quoted strings. */
function matchingBrace(text, openIndex) {
  let depth = 0;
  let started = false;
  let inLine = false;
  let inBlock = false;
  let quote = '';
  let template = false;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i += 1; }
      continue;
    }
    if (template) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === '`') template = false;
      continue;
    }
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { inLine = true; i += 1; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i += 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '`') { template = true; continue; }
    if (ch === '{') { depth += 1; started = true; continue; }
    if (ch === '}') {
      depth -= 1;
      if (started && depth === 0) return i;
    }
  }
  return -1;
}

function blockRange(text, starts, startLine) {
  const startIndex = starts[startLine - 1];
  const open = text.indexOf('{', startIndex);
  if (open < 0) return { start: startLine, end: startLine };
  const close = matchingBrace(text, open);
  return { start: startLine, end: close < 0 ? startLine : lineAt(starts, close) };
}

function cleanDoc(lines, index) {
  const out = [];
  let i = index - 1;
  while (i >= 0) {
    const line = lines[i].trim();
    if (!line) {
      if (out.length) break;
      i -= 1;
      continue;
    }
    if (line.startsWith('//')) { out.unshift(line.replace(/^\/\/\s?/, '')); i -= 1; continue; }
    if (line.endsWith('*/')) {
      let j = i;
      const block = [];
      while (j >= 0 && !lines[j].includes('/*')) { block.unshift(lines[j].trim()); j -= 1; }
      if (j >= 0) block.unshift(lines[j].trim());
      const cleaned = [];
      block.forEach(item => {
        const clean = item.replace(/^\s*\/\*\*?/, '').replace(/\*\/\s*$/, '').replace(/^\s*\*\s?/, '').trim();
        if (clean) cleaned.push(clean);
      });
      out.unshift(...cleaned);
      i = j - 1;
      continue;
    }
    break;
  }
  return out.join(' ').replace(/\s+/g, ' ').slice(0, 320);
}

function signatureOf(line) {
  const value = line
    .replace(/^\s*export\s+/, '')
    .replace(/^\s*default\s+/, '')
    .trim();
  const cut = value.search(/\s*\{\s*$/);
  return (cut >= 0 ? value.slice(0, cut) : value).replace(/\s+/g, ' ').slice(0, 220);
}

function symbolRef(rel, line, kind, name) {
  return `code:${rel}#L${line}:${kind}:${name}`;
}

function addSymbol(list, rel, line, kind, name, extra = {}) {
  const item = {
    kind,
    name,
    qualifiedName: extra.qualifiedName ?? name,
    signature: extra.signature ?? '',
    startLine: extra.startLine ?? line,
    endLine: extra.endLine ?? line,
    exported: extra.exported === true,
    doc: extra.doc ?? '',
    sourceRef: symbolRef(rel, line, kind, extra.qualifiedName ?? name),
  };
  list.push(item);
}

function parseClassMethods(text, starts, lines, rel, className, range, exported, out) {
  for (let i = range.start; i < range.end - 1; i += 1) {
    const line = lines[i];
    if (i < range.start) continue;
    // A method line must be indented and look like `name(...) {`; control
    // statements are rejected explicitly instead of indexed as methods.
    const match = line.match(/^\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$#][\w$#]*)\s*\(([^)]*)\)\s*(?:\{|=>)/);
    if (!match) continue;
    const name = match[1];
    if (KEYWORDS.has(name)) continue;
    if (name === 'constructor') {
      addSymbol(out, rel, i + 1, 'constructor', `${className}.constructor`, {
        qualifiedName: `${className}.constructor`,
        signature: `constructor(${match[2]})`,
        exported,
        doc: cleanDoc(lines, i),
        startLine: i + 1,
        endLine: blockRange(text, starts, i + 1).end,
      });
      continue;
    }
    addSymbol(out, rel, i + 1, 'method', name, {
      qualifiedName: `${className}.${name}`,
      signature: `${name}(${match[2]})`,
      exported,
      doc: cleanDoc(lines, i),
      startLine: i + 1,
      endLine: blockRange(text, starts, i + 1).end,
    });
  }
}

function importsFromLine(line) {
  const specs = [];
  const from = line.match(/^\s*(?:import|export)\s+[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/);
  if (from) specs.push(from[1]);
  const bare = line.match(/^\s*import\s+['"]([^'"]+)['"]/);
  if (bare) specs.push(bare[1]);
  for (const match of line.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(match[1]);
  for (const match of line.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(match[1]);
  return specs;
}

function routeFromLine(line) {
  const fastifyRoute = line.match(/\.\s*route\s*\(\s*\{[\s\S]{0,220}?method\s*:\s*['"]([A-Z]+)['"][\s\S]{0,160}?url\s*:\s*['"`]([^'"`]+)['"`]/);
  if (fastifyRoute) return { method: fastifyRoute[1].toUpperCase(), route: fastifyRoute[2], handler: '' };
  const http = line.match(/\b(?:app|router|server|fastify|api|routes?|r)\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*['"`]([^'"`]+)['"`]/i);
  if (http) return { method: http[1].toUpperCase(), route: http[2], handler: handlerAfter(line, http[2]) };
  // Python decorators are handled by the generic reader, but the same line
  // shape also appears in JS decorators; keep it here without inventing a path.
  const decorator = line.match(/^\s*@(Get|Post|Put|Patch|Delete|Options|Head)\s*\(\s*['"`]([^'"`]*)['"`]/);
  if (decorator) return { method: decorator[1].toUpperCase(), route: decorator[2], handler: '' };
  return null;
}

function handlerAfter(line, route) {
  const index = line.indexOf(route);
  if (index < 0) return '';
  const tail = line.slice(index + route.length);
  const match = tail.match(/,\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/);
  return match ? match[1] : '';
}

function nextRouteSummary(lines, index) {
  return cleanDoc(lines, index).slice(0, 220);
}

/** Parse one JS/TS file. Returns only metadata, never the source body. */
export function parseJavaScript(text, relPath) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const lines = source.split('\n');
  const starts = lineStarts(source);
  const symbols = [];
  const imports = [];
  const apis = [];
  let controller = '';
  const seenRoutes = new Set();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;

    for (const spec of importsFromLine(line)) {
      imports.push({ specifier: spec, line: i + 1 });
    }

    const controllerMatch = line.match(/^\s*@Controller\s*\(\s*['"`]([^'"`]*)['"`]/);
    if (controllerMatch) controller = normalizeRoute(controllerMatch[1]);

    const route = routeFromLine(line);
    if (route) {
      const prefix = route.route.startsWith('/') ? route.route : `/${route.route}`;
      const full = controller && !prefix.startsWith(controller)
        ? `${controller}${prefix}`.replace(/\/+/g, '/')
        : prefix;
      const key = `${route.method} ${full} ${i + 1}`;
      if (!seenRoutes.has(key)) {
        seenRoutes.add(key);
        apis.push({
          kind: 'route',
          method: route.method,
          route: normalizeRoute(full),
          handler: route.handler,
          line: i + 1,
          summary: nextRouteSummary(lines, i),
          auth: '',
        });
      }
    }

    const fn = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/);
    if (fn) {
      addSymbol(symbols, relPath, i + 1, 'function', fn[1], {
        qualifiedName: fn[1],
        signature: `${/async/.test(line) ? 'async ' : ''}function ${fn[1]}(${fn[2]})`,
        exported: /\bexport\b/.test(line),
        doc: cleanDoc(lines, i),
        endLine: blockRange(source, starts, i + 1).end,
      });
      continue;
    }

    const arrow = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/);
    if (arrow) {
      addSymbol(symbols, relPath, i + 1, 'function', arrow[1], {
        qualifiedName: arrow[1],
        signature: `${/async/.test(line) ? 'async ' : ''}${arrow[1]}(${arrow[2] ?? arrow[3] ?? ''}) =>`,
        exported: /\bexport\b/.test(line),
        doc: cleanDoc(lines, i),
        endLine: blockRange(source, starts, i + 1).end,
      });
      continue;
    }

    const klass = line.match(/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (klass) {
      const range = blockRange(source, starts, i + 1);
      addSymbol(symbols, relPath, i + 1, 'class', klass[1], {
        qualifiedName: klass[1],
        signature: `class ${klass[1]}`,
        exported: /\bexport\b/.test(line),
        doc: cleanDoc(lines, i),
        endLine: range.end,
      });
      parseClassMethods(source, starts, lines, relPath, klass[1], range, /\bexport\b/.test(line), symbols);
      continue;
    }

    const typeDecl = line.match(/^\s*(?:export\s+)?(?:default\s+)?(interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
    if (typeDecl) {
      addSymbol(symbols, relPath, i + 1, typeDecl[1], typeDecl[2], {
        qualifiedName: typeDecl[2],
        signature: signatureOf(line),
        exported: /\bexport\b/.test(line),
        doc: cleanDoc(lines, i),
        endLine: blockRange(source, starts, i + 1).end,
      });
      continue;
    }

    const exportList = line.match(/^\s*export\s*\{([^}]+)\}\s*(?:from\s+['"]([^'"]+)['"])?/);
    if (exportList) {
      for (const raw of exportList[1].split(',')) {
        const item = raw.trim();
        if (!item) continue;
        const [local, alias] = item.split(/\s+as\s+/).map(part => part.trim());
        const name = alias || local;
        addSymbol(symbols, relPath, i + 1, 'export', name, {
          qualifiedName: name,
          signature: exportList[2] ? `export { ${local} } from '${exportList[2]}'` : `export { ${local} }`,
          exported: true,
          doc: '',
        });
      }
      continue;
    }

    const commonJs = line.match(/^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/);
    if (commonJs) {
      addSymbol(symbols, relPath, i + 1, 'export', commonJs[1], {
        qualifiedName: commonJs[1],
        signature: `exports.${commonJs[1]}`,
        exported: true,
      });
      continue;
    }

    const exportedConst = line.match(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.*)$/);
    if (exportedConst && !arrow) {
      addSymbol(symbols, relPath, i + 1, 'const', exportedConst[1], {
        qualifiedName: exportedConst[1],
        signature: `${exportedConst[1]} = ${exportedConst[2].replace(/\s+/g, ' ').slice(0, 120)}`,
        exported: true,
        doc: cleanDoc(lines, i),
      });
    }
  }

  // Next.js file routing: the exported verbs are the API contract.
  const nextRoute = nextRouteForPath(relPath);
  if (nextRoute) {
    for (const symbol of symbols) {
      if (!symbol.exported) continue;
      const method = symbol.name.toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(method)) continue;
      apis.push({
        kind: 'route',
        method,
        route: nextRoute,
        handler: symbol.name,
        line: symbol.startLine,
        summary: symbol.doc,
        auth: '',
      });
    }
  }

  return { symbols, imports, apis };
}

function normalizeRoute(value) {
  let route = String(value ?? '').trim();
  if (!route) return '/';
  if (!route.startsWith('/')) route = `/${route}`;
  return route.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
}

function nextRouteForPath(relPath) {
  const posix = relPath.replace(/\\/g, '/');
  const app = posix.match(/(?:^|\/)app\/(.*)\/route\.(?:js|jsx|ts|tsx|mjs|cjs)$/);
  if (app) {
    const parts = app[1].split('/').filter(Boolean).map(part => part.startsWith('(') ? '' : part.replace(/^\[(?:\.\.\.)?/, '').replace(/\]$/, ':param'));
    return `/${parts.filter(Boolean).join('/')}`.replace(/\/$/, '') || '/';
  }
  const pages = posix.match(/(?:^|\/)pages\/api\/(.*)\.(?:js|jsx|ts|tsx|mjs|cjs)$/);
  if (pages) return `/api/${pages[1].replace(/\/index$/, '')}`;
  return '';
}
