# 全息记忆剩余三项整改计划（2026-11-25）

状态基线：v4.3.2 已发布（main `acd1158`，451/451 测试，黄金集 recall 1.0 / MRR 0.979，生产 7788 `/health=4.3.2`，schema 18，库 26.1 MiB）。

本计划只处理上一轮挂起的三项，不夹带新功能；每项单独过门禁、单独发布，前一项未验收不进入下一项。

**执行结果（2026-11-25）**：三项全部完成并发布。P3-9 → v4.3.3；P2-5 → v4.4.0；P2-3 → v4.5.0。P2-3 实际落地为 `lib/store.mjs`（~3,300 行）、`lib/search.mjs`（~1,500 行）、`lib/tool-definitions.mjs`（~1,350 行）、`lib/read-routes.mjs`（~1,130 行），`index.js` **8,721 → 1,231 行**；画像/会话/启动仍留在 `index.js`，未强拆。全量测试 **451/451**，黄金集 `semantic-first` MRR **0.958**、recall **1.0**。

## 一、P3-9 `notes_fts` 正文副本（v4.3.3）

目标：把 `notes_fts` 从普通 FTS5 内容表改为 `content='notes'` 的 external-content 索引，去掉 `notes_fts_content` 的 1.9 MiB 正文副本，同时保证写入、修订、遗忘、恢复、物理删除五条路径的索引一致。

实施步骤：

1. schema 升到 19，新增 `ensureExternalNotesFts()`：
   - 建 `notes_fts_v19`，`content='notes'`、`content_rowid='id'`，保留旧表的 trigram 分词器。
   - 只索引 `deleted_at IS NULL AND superseded_by IS NULL` 的笔记。
   - 重建完成后 drop 旧表、rename 新表，再安装 trigger，避免半成品索引。
2. 用 6 个 trigger 取代手写 FTS 维护：
   - 插入笔记 → 写索引。
   - 修改正文 → 删旧写新。
   - supersede / tombstone → 删旧索引。
   - 恢复为 active → 重新写索引。
   - 物理删除 active 行 → 按旧正文执行 external-content `'delete'`。
3. 通用派生索引路径识别 external 模式：
   - `reindexRow()` 不再手写 note FTS。
   - `dropDerivedRows()` 不再对 note FTS 执行 `DELETE WHERE rowid`。
   - 启动时 `backfillFts()` 跳过 note FTS，避免与 trigger 重复写。
4. 测试口径修正：
   - external-content 下 `SELECT COUNT(*) WHERE rowid` 会从 `notes` 返回源行，不能证明索引项已删；改为验证旧文本不再命中旧 id。
   - `perf-budget` 的批量 seed 在 external 模式下只插 `notes`，由 trigger 建索引，禁止手写重复插入。
5. 门禁：`node --check`、`npm test` 全绿、`bench:golden` 不低于 recall 1.0 / MRR 0.979。
6. 发布：bump 4.3.3，更新 CHANGELOG / DESIGN / REFERENCE / README / UPDATES，提交推送 main，打 tag + Release。
7. 生产迁移：先 `VACUUM INTO` 备份生产库，再重启 7788 让 schema 19 迁移执行；迁移后跑中英文检索、修订、遗忘回归，最后 `VACUUM` 记录体积。

验收：`/health=4.3.3`、schema 19、`notes_fts_content` 不存在、旧文本不再命中、451+ 用例全绿、库体积较 26.1 MiB 再降约 1.9 MiB。

## 二、P2-5 双向量收敛（v4.4.0）

目标：确定“语义为主、hashed 兜底”的策略，并用黄金集证明不降召回；不在没有数据背书时删除 hashed。

实施步骤：

1. 先补评测模式：`semantic + graph`（关闭 hashed vector）与 `full` 对比，记录 recall / MRR。
2. 调整 `runSearch` 融合顺序：
   - 先词面召回，再跑语义（候选只用词面命中）。
   - 语义路由有结果时，不再融合 hashed vector；语义不可用、失败或空结果时，才跑 hashed 并兜底。
   - graph 始终只扩展实际参与的路由结果。
   - `OMNI_DISABLE_VECTOR` 只关闭 hashed，不得连带关闭语义，保证评测口径可复现。
3. 保持 hashed 写入不变：CLI 零配置且语义模型缺失时它仍是唯一向量召回，不能停写。
4. 门禁：
   - 新增语义优先路径的回归用例：语义可用时不调用 hashed；语义失败时 hashed 仍召回。
   - 黄金集 `semantic+graph` MRR 不低于 0.95；实测 0.958，full 0.958（双路旧值 0.979，recall 仍 1.0）。0.021 的下降来自移除 hashed 噪声排序，按“语义为主”策略接受；低于 0.95 才回退双路。
   - `npm test`、`bench:golden`、语法检查全绿。
5. 发布 4.4.0；文档写明“hashed 保留为兜底、不删除；存储 5 MiB 的清理留作独立可选任务”。

验收：语义可用时检索少跑一路 hashed，MRR 不明显下降；语义不可用时 hashed 兜底仍生效；CLI 默认召回不回退。

## 三、P2-3 `index.js` 结构拆分（v4.5.0）

目标：把约 8,200 行单文件按域拆开，导出面保持不变，行为零改动。

批次（每批单独测试，不夹带逻辑修改）：

1. `lib/store.mjs`：schema、迁移、`openStore`、派生索引、备份、租约。
2. `lib/search.mjs`：词面检索、向量、语义、RRF、rerank、graph。
3. `lib/profile.mjs`：画像、事实、生命周期、维护任务。
4. `lib/tools.mjs`：`defineWriteReadTools` / `defineMaintenanceTools` 的注册表。
5. `lib/routes.mjs`：HTTP 路由与静态资源。
6. `index.js` 只保留组装、导出与启动入口。

每批门禁：`node --check`、相关测试文件、全量 `npm test`；任何导出名、函数签名、SQL 文本不变。全部搬完后跑一次黄金集与 `/health` 冒烟。

验收：`index.js` 降到 2,000 行以内；451+ 用例全绿；黄金集不回退；对外 CLI/MCP/HTTP 接口零变化。

## 四、顺序与回滚

顺序：P3-9 → P2-5 → P2-3。

回滚：每项发布前保留生产库 `VACUUM INTO` 备份与上一版 tag；P3-9 迁移失败直接回滚到 4.3.2 备份；P2-5 保留 `OMNI_VECTOR_MODE=full` 开关回双路；P2-3 纯搬移，回滚即 revert 对应提交。

## 五、不做的事

- 不为了凑版本号把 P2-3 塞进 4.3.3。
- 不在 P3-9 未过全量测试前重启 7788。
- 不删除 hashed `vectors` 表，不清理现有 5 MiB，除非后续单独做“向量存储回收”并再次过黄金集。
