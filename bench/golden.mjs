/**
 * Golden-set evaluation for hybrid retrieval (FR-17 evidence).
 *
 * Builds a fixed corpus, asks paraphrased questions, and measures recall@10 of
 * the lexical route alone versus lexical + vector fusion. Prints a JSON report
 * so the numbers can be pasted into the changelog.
 *
 * Run: node bench/golden.mjs
 */
import { boot } from '../test/helpers.mjs';

const CORPUS = [
  '不要对正在显示的会话调用 sessionQuery.inspectSession，它会顶掉实时投影导致聊天区空白',
  '不要替换 conversation.chat.flow 这个单例槽位，替换后默认聊天流会消失',
  'DSH 的 webServer 路由请求体可能已被宿主读空，参数要放查询串',
  '记忆插件的转录层只订阅 session/event 提交后事件流，不读投影',
  '事实冲突时把旧行 valid_to 置为当前时间，不做物理删除',
  '遗忘操作写 deleted_at 墓碑，检索与注入都会过滤掉它',
  'SQLite 使用 WAL 模式与 synchronous=NORMAL，保证崩溃后仍可打开',
  'FTS5 的 trigram 分词器让中文子串检索不需要空格分词',
  '中文查询按二元组切分，能够命中连续汉字片段',
  '系统提示注入预算控制在 1200 字，超出按重要性裁剪',
  '画像缓存 30 秒，写入后立即失效以便马上反映变更',
  '插件只依赖 tools、systemPrompt、webServer、slots 这些公开服务',
  '左栏导航用 sidebar.panellist 与 main 槽位按同一 id 配对',
  '迁移使用 schema_version 与顺序迁移，旧库就地升级不丢数据',
  '向量索引是派生数据，重建不会影响事实来源',
  'RRF 融合把词面排名与向量排名相加，常数取 60',
  'embedding 使用哈希字符 n-gram，确定性且零依赖',
  '测试用 node:test 编写，覆盖单元、集成与契约三层',
  '性能预算要求一万行数据检索 p95 低于 300 毫秒',
  '插件卸载后不残留监听，数据文件由用户决定是否保留',
];

const QUESTIONS = [
  ['inspectSession 会让聊天变空白吗', 0],
  ['替换 chat.flow 会怎样', 1],
  ['请求体被读空了怎么办', 2],
  ['转录层订阅哪个事件', 3],
  ['事实冲突时怎么处理旧数据', 4],
  ['遗忘之后还能搜到吗', 5],
  ['数据库崩溃后能否打开', 6],
  ['中文检索需要分词吗', 7],
  ['汉字片段怎么匹配', 8],
  ['注入长度上限是多少', 9],
  ['画像多久刷新一次', 10],
  ['插件允许依赖哪些服务', 11],
  ['左栏入口和面板怎么配对', 12],
  ['旧数据库如何升级', 13],
  ['向量索引重建安全吗', 14],
  ['两个排名怎么融合', 15],
  ['embedding 是语义模型吗', 16],
  ['测试覆盖哪些层次', 17],
  ['延迟预算定在多少', 18],
  ['卸载会残留什么', 19],
  // Paraphrases with lower lexical overlap.
  ['会话投影被顶掉的风险', 0],
  ['单例槽位缺失的后果', 1],
  ['宿主预读请求的影响', 2],
  ['墓碑机制的意义', 5],
];

const app = await boot({ semantic: true });
await app.call('memory_profile');

const ids = [];
for (const [index, text] of CORPUS.entries()) {
  const written = await app.call('memory_write', { kind: 'note', text, importance: 0.8, source: `golden:${index}` });
  ids.push(written.value.id);
}

// The local semantic index is asynchronous by design. Fill it once so the
// benchmark measures retrieval quality, not worker scheduling.
const semanticIndex = await app.call('memory_reindex', { semantic: true, limit: CORPUS.length });
if (semanticIndex.value.semantic?.enabled !== true) {
  console.error('local semantic model is not available; refusing to report a false gate');
  process.exit(1);
}

async function evaluate(mode) {
  // mode: 'lexical' | 'vector' | 'semantic' | 'full'
  process.env.OMNI_DISABLE_VECTOR = mode === 'lexical' ? '1' : '';
  process.env.OMNI_DISABLE_HASHED = mode === 'semantic' || mode === 'lexical' ? '1' : '';
  // OMNI_DISABLE_VECTOR closes the semantic route too (historical switch), so
  // 'vector' also needs the semantic flag; 'semantic' keeps semantic on.
  process.env.OMNI_DISABLE_SEMANTIC = mode === 'lexical' || mode === 'vector' ? '1' : '';
  process.env.OMNI_DISABLE_GRAPH = mode === 'full' ? '' : '1';
  let hits = 0;
  let mrr = 0;
  const misses = [];
  for (const [question, goldIndex] of QUESTIONS) {
    const result = await app.call('memory_search', { query: question, limit: 10 });
    const position = result.value.hits.findIndex(hit => hit.kind === 'note' && hit.id === ids[goldIndex]);
    if (position >= 0) {
      hits += 1;
      mrr += 1 / (position + 1);
    } else {
      misses.push(question);
    }
  }
  const total = QUESTIONS.length;
  return {
    hits,
    total,
    recall: Number((hits / total).toFixed(3)),
    mrr: Number((mrr / total).toFixed(3)),
    misses,
  };
}

const lexical = await evaluate('lexical');
const vector = await evaluate('vector');
const semantic = await evaluate('semantic');
const full = await evaluate('full');

const targets = { recall: 0.85, mrr: 0.9 };
const pass = full.recall >= targets.recall && full.mrr >= targets.mrr && semantic.mrr >= 0.95;

console.log(JSON.stringify({
  corpus: CORPUS.length,
  questions: QUESTIONS.length,
  lexicalOnly: lexical,
  lexicalPlusHashedVector: vector,
  lexicalPlusSemanticNoHashed: semantic,
  full_semanticFirst_withHashedFallback: full,
  delta: {
    hashedVectorVsLexical: Number((vector.mrr - lexical.mrr).toFixed(3)),
    semanticVsHashed: Number((semantic.mrr - vector.mrr).toFixed(3)),
    semanticFirstVsFull: Number((full.mrr - semantic.mrr).toFixed(3)),
  },
  targets: { ...targets, semanticMrr: 0.95 },
  pass,
}, null, 2));

// This benchmark is a release gate, not a report. A silent MRR regression is
// exactly how retrieval quality rots while every unit test stays green.
if (!pass) process.exitCode = 1;
