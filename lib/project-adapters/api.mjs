// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
/**
 * API contract readers: OpenAPI/Swagger (JSON + YAML) and GraphQL SDL.
 * These are the authoritative API shapes when present; code-inferred routes
 * are marked separately so the two never look equally trustworthy.
 */

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);

function normRoute(value) {
  let route = String(value ?? '').trim();
  if (!route) route = '/';
  if (!route.startsWith('/')) route = `/${route}`;
  return route.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
}

function s(value, max = 260) {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  return text.replace(/\s+/g, ' ').slice(0, max);
}

function refText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => refText(item)).filter(Boolean).join(' | ');
  if (value.$ref) return value.$ref;
  if (value.type) return String(value.type);
  if (value.schema) return refText(value.schema);
  if (value.content) {
    return Object.entries(value.content).map(([type, body]) => `${type}:${refText(body)}`).join(' | ');
  }
  if (value.items) return `array<${refText(value.items)}>`;
  return Object.keys(value).slice(0, 4).join(',');
}

function openApiSchemaSymbols(schemas, rel, kind = 'schema') {
  const out = [];
  for (const [name, schema] of Object.entries(schemas || {})) {
    const fields = schema && typeof schema === 'object'
      ? Object.entries(schema.properties || {}).slice(0, 12).map(([key, value]) => `${key}:${refText(value)}`)
      : [];
    out.push({
      kind,
      name,
      qualifiedName: name,
      signature: fields.length ? fields.join(', ').slice(0, 220) : s(schema?.type ?? schema, 120),
      startLine: 0,
      endLine: 0,
      exported: true,
      doc: s(schema?.description ?? '', 240),
      sourceRef: `spec:${rel}#/components/schemas/${name}`,
    });
  }
  return out;
}

function jsonOpenApi(doc, rel) {
  const apis = [];
  const paths = doc?.paths && typeof doc.paths === 'object' ? doc.paths : {};
  for (const [route, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const [method, op] of Object.entries(pathItem)) {
      if (!METHODS.has(String(method).toLowerCase()) || !op || typeof op !== 'object') continue;
      const responses = op.responses && typeof op.responses === 'object' ? op.responses : {};
      const statuses = Object.keys(responses);
      const schemaRefs = Object.values(responses).map(body => refText(body)).filter(Boolean);
      const request = refText(op.requestBody) || refText(op.parameters);
      const security = op.security ?? doc.security;
      apis.push({
        kind: 'openapi',
        method: String(method).toUpperCase(),
        route: normRoute(route),
        handler: s(op.operationId ?? '', 120),
        line: 0,
        auth: s(security, 120),
        summary: s(op.summary ?? op.description ?? ''),
        request: s(request, 320),
        response: s(statuses.join(', ') + (schemaRefs.length ? ` · ${schemaRefs.join(' | ')}` : ''), 320),
        errors: s(statuses.filter(code => Number(code) >= 400).join(', '), 120),
        tags: s(op.tags, 120),
        specRef: `spec:${rel}#/paths/${String(route).replace(/~1/g, '~0').replace(/\//g, '~1')}/${method}`,
      });
    }
  }
  return { apis, schemas: openApiSchemaSymbols(doc?.components?.schemas, rel) };
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function keyValue(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const match = trimmed.match(/^['"]?([^'":]+)['"]?\s*:\s*(.*)$/);
  if (!match) return null;
  return { key: match[1].trim(), value: match[2].trim() };
}

function lineOfKey(lines, key, start = 0) {
  for (let i = start; i < lines.length; i += 1) {
    const item = keyValue(lines[i]);
    if (item?.key === key) return i;
  }
  return -1;
}

function yamlList(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('[')) return raw.replace(/[\[\]"']/g, '').trim();
  return raw;
}

function yamlSchemas(lines, rel) {
  const schemas = [];
  const start = lineOfKey(lines, 'schemas');
  if (start < 0) return schemas;
  const baseIndent = indentOf(lines[start]);
  let current = '';
  let fields = [];
  const flush = () => {
    if (!current) return;
    schemas.push({
      kind: 'schema', name: current, qualifiedName: current,
      signature: fields.slice(0, 12).join(', ').slice(0, 220),
      startLine: 0, endLine: 0, exported: true, doc: '',
      sourceRef: `spec:${rel}#/components/schemas/${current}`,
    });
  };
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = indentOf(line);
    if (indent <= baseIndent && /^[A-Za-z]/.test(line.trim())) break;
    const item = keyValue(line);
    if (indent === baseIndent + 2 && item) {
      flush();
      current = item.key;
      fields = [];
      continue;
    }
    if (current && indent === baseIndent + 4 && item) fields.push(`${item.key}:${s(item.value, 24)}`);
  }
  flush();
  return schemas;
}

/** A line-oriented OpenAPI YAML reader; enough for paths, operations and errors. */
function yamlOpenApi(text, rel) {
  const lines = String(text ?? '').split('\n');
  const apis = [];
  const pathsLine = lineOfKey(lines, 'paths');
  if (pathsLine < 0) return { apis, schemas: yamlSchemas(lines, rel) };
  const pathsIndent = indentOf(lines[pathsLine]);
  let currentPath = '';
  let currentMethod = '';
  let block = [];

  const flush = () => {
    if (!currentPath || !currentMethod) { block = []; return; }
    const joined = block.join('\n');
    const summary = joined.match(/^[ \t]*summary:\s*(.+)$/m)?.[1]
      ?? joined.match(/^[ \t]*operationId:\s*(.+)$/m)?.[1]
      ?? '';
    const tags = yamlList(joined.match(/^[ \t]*tags:\s*(.+)$/m)?.[1] ?? '');
    const authBlock = joined.match(/^[ \t]*security:\s*\n((?:[ \t]+-[^\n]*\n?)+)/m)?.[1] ?? '';
    const auth = authBlock.split('\n').map(item => item.trim().replace(/^-/, '').replace(/:\s*.*/, '').replace(/^['"]|['"]$/g, '')).filter(Boolean).join(', ');
    const requestRef = joined.match(/\$ref:\s*['"]?([^'"\n]+)/g)?.map(item => item.replace(/\$ref:\s*['"]?/, '').trim()).join(' | ') ?? '';
    const responseCodes = joined.match(/^[ \t]*(?:'|")?([1-5][0-9][0-9])(?:'|")?:\s*/gm)?.map(item => item.match(/([1-5][0-9][0-9])/)?.[1]).filter(Boolean) ?? [];
    apis.push({
      kind: 'openapi',
      method: currentMethod.toUpperCase(),
      route: normRoute(currentPath),
      handler: summary ? '' : '',
      line: 0,
      auth: auth.slice(0, 120),
      summary: s(summary, 240),
      request: s(requestRef, 320),
      response: s(responseCodes.join(', '), 120),
      errors: s(responseCodes.filter(code => Number(code) >= 400).join(', '), 120),
      tags: s(tags, 120),
      specRef: `spec:${rel}#/paths/${currentPath.replace(/~/g, '~0').replace(/\//g, '~1')}/${currentMethod}`,
    });
    block = [];
  };

  for (let i = pathsLine + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = indentOf(line);
    if (indent <= pathsIndent && /^[A-Za-z]/.test(line.trim())) break;

    if (indent === pathsIndent + 2 && /^\s+(?:['"]?\/|['"]?\$ref)/.test(line)) {
      flush();
      currentPath = String(line.trim().replace(/^['"]|['"]:\s*$/g, '').replace(/:\s*$/, '')).trim();
      currentMethod = '';
      continue;
    }
    const method = line.trim().match(/^([a-z]+)\s*:/);
    if (method && METHODS.has(method[1]) && indent === pathsIndent + 4) {
      flush();
      currentMethod = method[1];
      continue;
    }
    if (currentMethod) block.push(line);
  }
  flush();
  return { apis, schemas: yamlSchemas(lines, rel) };
}

export function parseOpenApi(text, relPath) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  if (source.trim().startsWith('{')) {
    try {
      return jsonOpenApi(JSON.parse(source), relPath);
    } catch { /* fall through to the line reader */ }
  }
  return yamlOpenApi(source, relPath);
}

function matchingBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** GraphQL SDL reader: object types, fields and root operation contracts. */
export function parseGraphQL(text, relPath) {
  const source = String(text ?? '').replace(/\uFEFF/g, '');
  const lines = source.split('\n');
  const symbols = [];
  const apis = [];
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') starts.push(i + 1);
  const lineAt = index => {
    let lo = 0, hi = starts.length - 1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= index) lo = mid + 1; else hi = mid - 1; }
    return Math.max(1, lo);
  };

  const blockRe = /(?:^|\n)\s*(?:extend\s+)?(type|input|interface|enum|union|scalar)\s+([A-Za-z_]\w*)[^\n{]*\{(?=\s|$)/g;
  for (const match of source.matchAll(blockRe)) {
    const kind = match[1];
    const name = match[2];
    const open = source.indexOf('{', match.index);
    const close = matchingBrace(source, open);
    if (open < 0 || close < 0) continue;
    const body = source.slice(open + 1, close);
    const startLine = lineAt(open);
    const endLine = lineAt(close);
    const fields = [];
    const fieldRe = /\b([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:\s*([\[\]!A-Za-z0-9_]+)/g;
    for (const field of body.matchAll(fieldRe)) {
      const fieldName = field[1];
      const fieldType = field[3].replace(/[!\[\]]/g, '').trim();
      const line = lineAt(open + 1 + field.index);
      fields.push(`${fieldName}:${fieldType}`);
      if (['Query', 'Mutation', 'Subscription'].includes(name)) {
        apis.push({
          kind: 'graphql',
          method: name.toUpperCase(),
          route: fieldName,
          handler: `${name}.${fieldName}`,
          line,
          auth: '',
          summary: '',
          request: s(field[2] ?? '', 260),
          response: s(fieldType, 120),
          errors: '',
          tags: name.toLowerCase(),
          specRef: `spec:${relPath}#${name}.${fieldName}`,
        });
      } else {
        symbols.push({
          kind: 'field',
          name: fieldName,
          qualifiedName: `${name}.${fieldName}`,
          signature: `${fieldName}(${field[2] ?? ''}): ${fieldType}`,
          startLine: line,
          endLine: line,
          exported: true,
          doc: '',
          sourceRef: `code:${relPath}#L${line}:field:${name}.${fieldName}`,
        });
      }
    }
    if (!['Query', 'Mutation', 'Subscription'].includes(name)) {
      symbols.unshift({
        kind,
        name,
        qualifiedName: name,
        signature: `${kind} ${name} { ${fields.slice(0, 8).join(', ')} }`.slice(0, 240),
        startLine,
        endLine,
        exported: true,
        doc: '',
        sourceRef: `code:${relPath}#L${startLine}:${kind}:${name}`,
      });
    }
  }
  return { apis, symbols };
}
