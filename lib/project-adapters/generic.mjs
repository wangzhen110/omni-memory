// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
/**
 * Language-neutral fallback readers.
 *
 * The first version treats JS/TS as a first-class language, then uses regex
 * declarations for Python/Go/Rust/Java/C#/PHP/Ruby and an optional universal
 * ctags stream for anything else. It never reads or stores a function body.
 */

function ref(rel, line, kind, name) {
  return `code:${rel}#L${line}:${kind}:${name}`;
}

function push(list, rel, line, kind, name, extra = {}) {
  list.push({
    kind,
    name,
    qualifiedName: extra.qualifiedName ?? name,
    signature: extra.signature ?? '',
    startLine: extra.startLine ?? line,
    endLine: extra.endLine ?? line,
    exported: extra.exported === true,
    doc: extra.doc ?? '',
    sourceRef: ref(rel, line, kind, extra.qualifiedName ?? name),
  });
}

function docAbove(lines, index) {
  const out = [];
  for (let i = index - 1; i >= 0 && out.length < 4; i -= 1) {
    const line = lines[i].trim();
    if (!line) break;
    if (line.startsWith('#') || line.startsWith('//') || line.startsWith('///')) {
      out.unshift(line.replace(/^#+\s?/, '').replace(/^\/\/+\s?/, '').trim());
    } else break;
  }
  return out.join(' ').slice(0, 260);
}

function normalizeRoute(value, prefix = '') {
  let route = String(value ?? '').trim();
  if (!route) route = '/';
  if (!route.startsWith('/')) route = `/${route}`;
  const joined = prefix ? `${prefix}${route}` : route;
  return joined.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
}

function api(list, method, route, line, handler = '', summary = '') {
  list.push({
    kind: 'route',
    method: String(method || 'GET').toUpperCase(),
    route: normalizeRoute(route),
    handler,
    line,
    summary,
    auth: '',
  });
}

/** Python, Go, Rust, Java/Kotlin/C#, PHP, Ruby, GDScript and Lua declarations. */
export function parseGeneric(text, relPath, lang) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split('\n');
  const symbols = [];
  const imports = [];
  const apis = [];
  const language = String(lang || '').toLowerCase();
  let pythonClass = '';

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const n = i + 1;

    if (language === 'python') {
      const from = line.match(/^\s*from\s+([.\w]+)\s+import/);
      if (from) imports.push({ specifier: from[1], line: n });
      const imp = line.match(/^\s*import\s+([.\w]+)/);
      if (imp) imports.push({ specifier: imp[1], line: n });

      const pyClass = line.match(/^\s*class\s+([A-Za-z_]\w*)\s*(?::|\(([^)]*)\))/);
      if (pyClass) {
        pythonClass = pyClass[1];
        push(symbols, relPath, n, 'class', pyClass[1], {
          signature: `class ${pyClass[1]}${pyClass[2] ? `(${pyClass[2]})` : ''}`,
          doc: docAbove(lines, i),
          exported: !pyClass[1].startsWith('_'),
        });
        continue;
      }
      const pyFn = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/);
      if (pyFn) {
        const name = pyFn[1];
        push(symbols, relPath, n, 'function', name, {
          qualifiedName: pythonClass ? `${pythonClass}.${name}` : name,
          signature: `${/async/.test(line) ? 'async ' : ''}def ${name}(${pyFn[2]})`,
          doc: docAbove(lines, i),
          exported: !name.startsWith('_'),
        });
      }
      const fastapi = line.match(/@\s*(?:app|router|bp|blueprint)\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*['"]([^'"]+)['"]/i);
      if (fastapi) {
        const handler = (lines[i + 1] ?? '').match(/def\s+([A-Za-z_]\w*)/)?.[1] ?? '';
        api(apis, fastapi[1], fastapi[2], n, handler, docAbove(lines, i));
        continue;
      }
      const flask = line.match(/@\s*(?:app|bp|blueprint)\s*\.\s*route\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*methods\s*=\s*\[([^\]]+)\])?/i);
      if (flask) {
        const methods = (flask[2] ?? 'GET').match(/[A-Z]+/g) ?? ['GET'];
        const handler = (lines[i + 1] ?? '').match(/def\s+([A-Za-z_]\w*)/)?.[1] ?? '';
        for (const method of methods) api(apis, method, flask[1], n, handler, docAbove(lines, i));
        continue;
      }
    }

    if (language === 'go') {
      const imp = line.match(/^\s*"([^\"]+)"$/);
      if (imp && /^import\s*\(/.test(lines[i - 1] ?? '')) imports.push({ specifier: imp[1], line: n });
      const one = line.match(/^\s*import\s+"([^"]+)"/);
      if (one) imports.push({ specifier: one[1], line: n });
      const fn = line.match(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(([^)]*)\)/);
      if (fn) {
        push(symbols, relPath, n, 'function', fn[1], {
          signature: `func ${fn[1]}(${fn[2]})`,
          doc: docAbove(lines, i),
          exported: /^[A-Z]/.test(fn[1]),
        });
      }
      const typ = line.match(/^\s*type\s+([A-Za-z_]\w*)\s+(struct|interface)/);
      if (typ) push(symbols, relPath, n, typ[2], typ[1], { signature: `type ${typ[1]} ${typ[2]}`, exported: /^[A-Z]/.test(typ[1]), doc: docAbove(lines, i) });
      const http = line.match(/^\s*(?:r|router|mux|app|g)\s*\.\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(\s*["`]([^"`]+)["`]/);
      if (http) api(apis, http[1], http[2], n, line.match(/,\s*([A-Za-z_]\w*)\s*\)/)?.[1] ?? '', docAbove(lines, i));
    }

    if (language === 'rust') {
      const imp = line.match(/^\s*use\s+([^;]+);/);
      if (imp) imports.push({ specifier: imp[1], line: n });
      const fn = line.match(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/);
      if (fn) push(symbols, relPath, n, 'function', fn[1], { signature: `${/pub/.test(line) ? 'pub ' : ''}fn ${fn[1]}(${fn[2]})`, exported: /pub/.test(line), doc: docAbove(lines, i) });
      const typ = line.match(/^\s*(?:pub\s+)?(struct|enum|trait|type)\s+([A-Za-z_]\w*)/);
      if (typ) push(symbols, relPath, n, typ[1], typ[2], { signature: `${typ[1]} ${typ[2]}`, exported: /pub/.test(line), doc: docAbove(lines, i) });
    }

    if (['java', 'kotlin', 'cs', 'csharp', 'php', 'ruby', 'gdscript', 'lua', 'swift', 'dart'].includes(language)) {
      const imp = line.match(/^\s*(?:using|import)\s+([^;]+);/);
      if (imp) imports.push({ specifier: imp[1].trim(), line: n });
      const typ = line.match(/^\s*(?:public\s+|private\s+|protected\s+|internal\s+|open\s+|abstract\s+|sealed\s+|data\s+)*(class|interface|enum|struct|record)\s+([A-Za-z_]\w*)/);
      if (typ) push(symbols, relPath, n, typ[1], typ[2], { signature: `${typ[1]} ${typ[2]}`, exported: /public/.test(line), doc: docAbove(lines, i) });
      const fn = line.match(/^\s*(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|async\s+|override\s+|suspend\s+|fun\s+|function\s+|def\s+)*([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:\{|=>|:)/);
      if (fn && !['if', 'for', 'while', 'switch', 'catch', 'return', 'new'].includes(fn[1])) {
        push(symbols, relPath, n, 'function', fn[1], { signature: `${fn[1]}(${fn[2]})`, exported: /public/.test(line), doc: docAbove(lines, i) });
      }
    }
  }

  return { symbols, imports, apis };
}

/** Convert universal-ctags JSON lines into our symbol rows. */
export function parseCtagsJson(text, relPath) {
  const symbols = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || !line.startsWith('{')) continue;
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    const name = String(item.name ?? '').trim();
    if (!name) continue;
    const kind = String(item.kind ?? item.type ?? 'symbol').toLowerCase();
    const lineNumber = Number(item.line ?? 0) || 1;
    const scope = String(item.scope ?? '').trim();
    push(symbols, relPath, lineNumber, kind, name, {
      qualifiedName: scope && scope !== name ? `${scope}.${name}` : name,
      signature: String(item.signature ?? item.pattern ?? '').slice(0, 220),
      exported: !/^(static|private)$/i.test(String(item.access ?? '')),
      doc: '',
    });
    symbols[symbols.length - 1].path = String(item.path ?? relPath).replace(/\\/g, '/');
  }
  return symbols;
}
