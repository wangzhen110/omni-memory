# 公开 QA 与基线

这是一套**不依赖网络、不依赖模型、不依赖你的真实记忆库**的可复现检查。任何人在 clone 后都能跑，用来判断检索与存储是否正常，而不是用来给不同项目排名。

## 一键跑

```bash
npm ci
npm run qa
```

默认跑：

1. `bench/golden.mjs` — 20 条中文语料、24 个改写问题，比较词面、哈希向量、语义+图谱三档的 recall@10 与 MRR。
2. `bench/quality.mjs 120` — 120 个合成用例，覆盖知识更新、冲突、作用域隔离、遗忘/恢复。

机器可读：

```bash
npm run qa -- --json
```

只跑其中一项：

```bash
npm run bench:golden
npm run bench:quality -- 120
```

## 4.0.1 基线

Windows x64、Node 22.13+、本机 SQLite，2026-11-24：

```text
golden:
  corpus 20 / questions 24
  lexicalOnly                 recall 1.000  MRR 0.776
  lexical + hashed vector     recall 1.000  MRR 0.927
  full + semantic + graph     recall 1.000  MRR 0.979
  pass true

quality 120:
  passed 120 / failed 0
  p50 2 ms
  knowledge-update 30/30
  conflict          30/30
  scope-isolation   30/30
  forget-restore    30/30
```

这些数字是**功能基线**，不是性能承诺。不同 CPU、磁盘、Node 版本会改变耗时；语料只有 20 条，recall 1.000 不代表大规模开放域检索也满分。大规模与 1M 行边界见 [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md)。

## 结果怎么读

- `golden` 失败：先看 `misses`，通常是语料没写入、FTS 不可用或查询被作用域过滤。`npm run demo` 能定位最基础的写入/召回链。
- `quality` 失败：会打印 `failures` 的分类与用例。合成用例失败通常意味着状态机、冲突处理或 scope 过滤退化，不是“模型不够聪明”。
- 两项都过但真实库不好用：跑 `npm run doctor`，再看 `docs/QUICKSTART.md` 的语义排查段。

## 提交你的结果

欢迎在 Issue 里贴 `npm run qa -- --json` 的输出，注明：

- 操作系统、CPU、Node 版本、文件系统（本地盘/网络盘）。
- 是否改动过 `bench/` 或 `lib/`。
- 完整 JSON，不要只贴一个总数。

如果是性能问题，另附 `npm run bench:scale` 的输出；如果是真实数据质量问题，先脱敏，不要贴原始记忆。

## 不做什么

- 不把 QA 分数当“模型能力”比较；这里没有调用任何大模型。
- 不把 120 个合成用例当安全审计；安全问题走 [`SECURITY.md`](../SECURITY.md)。
- 不承诺 CI 之外的硬件结果。CI 只验证代码与契约，不验证你的磁盘。
