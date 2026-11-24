// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
/**
 * Bundled semantic embedder.
 *
 * The whole point of this module is that the user installs nothing: a quantised
 * BGE-small-zh model and an ONNX Runtime Web WASM build travel with the plugin.
 * Inference runs in this process, offline; no Ollama, no LM Studio, no API key.
 *
 * The model is BAAI/bge-small-zh-v1.5 (MIT), exported to int8 ONNX by Xenova.
 * CLS pooling + L2 normalisation, with the query instruction recommended by the
 * model card. Documents are embedded without the instruction.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tokenizer } from './vendor/tokenizers.min.mjs';
import * as ort from './vendor/ort.wasm.bundle.min.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODEL_DIR = path.resolve(HERE, '..', 'models', 'bge-small-zh-v1.5');

export const SEMANTIC_MODEL_ID = 'bge-small-zh-v1.5';
export const SEMANTIC_DIM = 512;
export const SEMANTIC_SIGNATURE = `local:${SEMANTIC_MODEL_ID}:int8:${SEMANTIC_DIM}`;
export const SEMANTIC_QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';
const MAX_LEN = 256;

let runtime = null;
let loadPromise = null;

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Files needed for one inference run. */
function modelFiles(dir) {
  return {
    model: path.join(dir, 'model_int8.onnx'),
    tokenizer: path.join(dir, 'tokenizer.json'),
    tokenizerConfig: path.join(dir, 'tokenizer_config.json'),
  };
}

/**
 * Resolve the semantic backend. It is on by default when the bundled model is
 * present; `OMNI_DISABLE_SEMANTIC=1` or the diagnostic `OMNI_DISABLE_VECTOR=1`
 * turns it off. A missing model degrades to lexical + hashed rather than
 * failing the plugin.
 */
export function semanticConfig(env = process.env) {
  const model = String(env.OMNI_SEMANTIC_MODEL ?? SEMANTIC_MODEL_ID).trim() || SEMANTIC_MODEL_ID;
  const dir = String(env.OMNI_SEMANTIC_MODEL_DIR ?? DEFAULT_MODEL_DIR).trim() || DEFAULT_MODEL_DIR;
  const files = modelFiles(dir);
  // The signature must follow the configured model name. A custom directory
  // with a different model must not reuse vectors written for the default one.
  const signature = `local:${model}:int8:${SEMANTIC_DIM}`;
  if (env.OMNI_DISABLE_SEMANTIC === '1' || env.OMNI_DISABLE_VECTOR === '1') {
    return { enabled: false, reason: 'disabled', kind: 'local', model, dir, dim: SEMANTIC_DIM, signature };
  }
  if (!existsSync(files.model) || !existsSync(files.tokenizer) || !existsSync(files.tokenizerConfig)) {
    return { enabled: false, reason: 'missing-model', kind: 'local', model, dir, dim: SEMANTIC_DIM, signature };
  }
  return {
    enabled: true,
    kind: 'local',
    model,
    dir,
    dim: SEMANTIC_DIM,
    signature,
    batch: Math.max(1, Math.min(64, Number(env.OMNI_SEMANTIC_BATCH ?? 8))),
    maxLen: MAX_LEN,
  };
}

function loadRuntime(config) {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const files = modelFiles(config.dir);
    const json = readJson(files.tokenizer);
    const tokenizerConfig = readJson(files.tokenizerConfig);
    const tokenizer = new Tokenizer(json, tokenizerConfig);
    // The WASM binary sits next to the vendored runtime. Set the path before
    // creating a session; ORT Web resolves it once per process.
    ort.env.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
    ort.env.wasm.numThreads = 1;
    const modelBytes = new Uint8Array(readFileSync(files.model));
    const session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    runtime = { session, tokenizer, output: session.outputNames[0] };
    return runtime;
  })().catch(error => {
    loadPromise = null;
    throw error;
  });
  return loadPromise;
}

/** Warm the model without blocking the caller. */
export function warmSemantic(config = semanticConfig()) {
  if (!config.enabled) return Promise.resolve(false);
  return loadRuntime(config).then(() => true, () => false);
}

function normalise(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  return vector;
}

function encodeBatch(texts, tokenizer, prefix) {
  const encodings = texts.map(text => tokenizer.encode(prefix + text, { return_token_type_ids: true }));
  const length = Math.min(MAX_LEN, Math.max(1, ...encodings.map(encoding => encoding.ids.length)));
  const count = texts.length;
  const ids = new BigInt64Array(count * length);
  const mask = new BigInt64Array(count * length);
  const types = new BigInt64Array(count * length);
  for (let row = 0; row < count; row += 1) {
    const encoding = encodings[row];
    for (let column = 0; column < length; column += 1) {
      const at = row * length + column;
      ids[at] = BigInt(encoding.ids[column] ?? 0);
      mask[at] = BigInt(encoding.attention_mask[column] ?? 0);
      types[at] = BigInt(encoding.token_type_ids?.[column] ?? 0);
    }
  }
  return { ids, mask, types, length, count };
}

/**
 * Embed a batch of texts. Query texts get the BGE instruction; documents do
 * not. Returns unit-length Float32Array vectors in input order.
 */
export async function embedSemantic(texts, config = semanticConfig(), options = {}) {
  if (!config.enabled) return [];
  if (!Array.isArray(texts) || !texts.length) return [];
  const { session, tokenizer, output } = await loadRuntime(config);
  const prefix = options.query ? SEMANTIC_QUERY_PREFIX : '';
  const out = [];
  const batch = Math.max(1, Number(config.batch ?? 8));
  for (let offset = 0; offset < texts.length; offset += batch) {
    const slice = texts.slice(offset, offset + batch).map(text => String(text ?? ''));
    const { ids, mask, types, length, count } = encodeBatch(slice, tokenizer, prefix);
    const feeds = {
      input_ids: new ort.Tensor('int64', ids, [count, length]),
      attention_mask: new ort.Tensor('int64', mask, [count, length]),
    };
    if (session.inputNames.includes('token_type_ids')) {
      feeds.token_type_ids = new ort.Tensor('int64', types, [count, length]);
    }
    const result = await session.run(feeds);
    const tensor = result[output];
    const hidden = tensor.dims[2];
    for (let row = 0; row < count; row += 1) {
      // BGE uses CLS pooling: the first token is the sentence representation.
      const start = row * length * hidden;
      out.push(normalise(Float32Array.from(tensor.data.slice(start, start + hidden))));
    }
  }
  return out;
}
