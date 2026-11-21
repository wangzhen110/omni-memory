# 3.10.2 修复单：DSH 冷启动路由丢失 & 项目键分裂

- 日期：2026-11-21
- 环境：DSH 0.2.2-rc.3（Desktop，Windows 11），Node 24.17.0，插件 3.10.1
- 来源：3.10.1 安装验收时实测发现的两个缺陷
- 性质：修复指引，**本文件不改代码**；文中标注了「已复现 / 静态确认 / 未定位」
- 实施状态（2026-11-21）：A/B 代码与回归测试已落到 `3.10.2`；`npm test` 362/362；真实库已备份并完成启动自愈（旧键 `767039` 的 10 条转录并入 canonical `604dba`，旧键 0 行）。A 的真实 DSH 重启验收仍需在客户端侧完成。
- 发布状态（3.10.3）：3.10.2 的 Git 发布曾只含 `ctx.inject` 分支，缺少轮询段；3.10.3 已把 `not ready at apply; polling` 的 250ms/60s 轮询纳入发布。另实测 DSH Desktop 固定 `--port 0`，9230 是 inspector、59273 是旧 GUI，验收不要写死这两个端口；详见 `docs/HOST-ADAPTERS.md` 的「DSH Desktop 的端口与验收」。

---

## 摘要

| 编号 | 问题 | 严重度 | 状态 |
|---|---|---|---|
| A | DSH 冷启动时插件先于 `webServer` 激活，`registerRoutes` 静默返回，全部 `/omni-memory/*` 路由 404，直到手动重载插件 | 高（功能不可用，且重启后随机出现） | **已复现**，根因已定位 |
| B | 同一工作目录出现两个项目键；旧键仍有数据；`ensureProjectAlias` 与 `migrateScopeAlias` 都无法再迁移，CLI `--apply` 也是空操作 | 高（项目记忆分裂、旧数据在项目视图不可见） | **已复现**，根因链已定位 |

---

## A. 冷启动后 HTTP 路由全部 404

### A.1 现象（本机时间线）

1. 20:42:36 DSH 重启，进程 PID 37144，监听 `127.0.0.1:9230`（API）与 `127.0.0.1:59273`（Web GUI）。
2. 重启后立即探测：

```
GET  http://127.0.0.1:59273/omni-memory/status      -> 404
GET  http://127.0.0.1:9230/omni-memory/status       -> 404
POST http://127.0.0.1:59273/omni-memory/forget      -> 405
```

3. 但客户端半边是正常的：`sidebar.panellist` 里 `id=omni-memory`、`order=20`、`active:true`；`memory_*` 工具也已注册（`memory_profile` 能正常返回画像）。
4. 执行一次 `plugin_manager set_plugin include:memory-core enabled=false` → `enabled=true` 后，同一个端口立即恢复：

```
GET  /omni-memory/status                            -> 200（含新版 semantic 字段）
POST /omni-memory/forget（伪造 Host/Origin）        -> 403
POST /omni-memory/forget（合法 Host/Origin）        -> 200
```

结论：**工具面正常、路由面丢失**；重载插件（重新 apply）后恢复。

### A.2 代码定位

- [`export const inject = ['tools']`](../index.js#L6072) —— 只声明了 `tools` 强依赖。
- [`registerRoutes(ctx)`](../index.js#L6181-L6190)：

```js
let web;
try { web = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer; } catch { web = undefined; }
if (!web || typeof web.register !== 'function') return undefined;   // 静默放弃，之后不再尝试
```

- [`apply()`](../index.js#L7224-L7240) 里只调用一次：

```js
ctx.effect(() => {
  const cleanup = registerRoutes(ctx);
  return () => { try { cleanup?.(); } catch { /* ignore */ } };
}, 'omni-memory: routes');
```

### A.3 根因

DSH 冷启动时 `webServer` 的激活晚于插件激活。插件 apply 时 `ctx.get('webServer')` 为 `undefined`，`registerRoutes` 直接返回，**没有等待、没有重试、没有可观测信号**；而 `tools` 已注入，所以工具正常。之前的进程在 18:41 启动时恰好是 `webServer` 先就绪，所以没有暴露。

同类风险不只这一处：`systemPrompt` 也是可选服务（`apply` 中 `ctx.get('systemPrompt')`），如果它晚于插件就绪，常驻画像注入同样会静默丢失，需要一并检查。

Dsh 官方实践（本机 `dsh-doc` 技能 `references/practices.md:20`）：**可选服务应放进 `inject` 或 `ctx.inject([...], ...)`**，让插件在服务可用时再激活。

### A.4 修复建议

**不要**把 `webServer` 直接加进 `inject = ['tools', 'webServer']`：MCP/CLI/headless 宿主没有 `webServer`，插件会永远不激活。

推荐方案（按 Cordis 的可选注入语义）：

```js
// apply() 中替换原来的 routes effect
ctx.effect(() => {
  let disposeRoutes;
  const off = ctx.inject(['webServer'], inner => {
    disposeRoutes = registerRoutes(inner);
  });
  return () => {
    try { off?.(); } catch { /* ignore */ }
    try { disposeRoutes?.(); } catch { /* ignore */ }
  };
}, 'omni-memory: routes');
```

同时把 `systemPrompt` 的注入改成同样的按需注册（或显式声明为可选服务），避免同一类竞态。

要点：
- 用 `ctx.inject([...], cb)` 后，`registerRoutes` 的 `ctx.get('webServer')` 可以从回调参数取，也可以保持原样（回调上下文已含该服务）。
- 保留 disposer，插件卸载时要移除路由。
- 如果当前 Cordis 版本对 `inject` 的对象写法（`{ required, optional }`）支持更稳，也可以声明 `optional: ['webServer']` 后仍用一次性注册；以 `cordis_inspect_query`/`practices.md` 为准，**不要只加进数组**。

### A.5 回归测试

1. **冷启动路由**：在测试宿主里先注册 `tools`、后注册 `webServer`，调用 `apply`，断言 `/omni-memory/list` 已注册；再反向顺序重复一次。若测试宿主无法模拟延迟，用真实 DSH 冒烟：重启 → 2 秒内 `GET /omni-memory/status` 必须 200，重复 3 次。
2. **不可观测检查**：`registerRoutes` 在拿不到 `webServer` 时至少写一次诊断（例如 `lastInjection`/`/status` 暴露 `routes: 'pending'`），不要让失败完全静默。

### A.6 验收

- 冷启动 3 次，每次 `/omni-memory/status` 均 200，无需手动重载。
- MCP/CLI 宿主仍然正常（没有 `webServer` 时插件照常提供工具）。

---

## B. 同一路径两个项目键，旧键数据无法迁移

### B.1 现象（实测数据）

同一工作目录 `C:\Users\64627\Desktop\项目\全息记忆`：

```text
canonical = proj:全息记忆#604dba   （当前）
legacy    = proj:全息记忆#767039   （旧键）

chunks: proj:全息记忆#604dba = 2   | proj:全息记忆#767039 = 10
notes : proj:全息记忆#604dba = 1   | proj:全息记忆#767039 = 0

scope_aliases:
  767039 -> 604dba    （映射已存在）
  a5a8bd -> e228ca    （历史遗留）
```

精确项目键视图只显示 `604dba`，那 10 条旧转录在项目视图里看不到；`scope=all` 能看到。

### B.2 代码定位与根因链

1. **alias 记录早于数据**：`ensureProjectAlias` 在旧键还没有行时，走 [`index.js:381-388`](../index.js#L381-L388) 只写 `scope_aliases`、不迁移。
2. **有入口绕过 alias 解析**：多处直接调用 `projectKeyFromCwd`，只有 `ensureProjectAlias`、`scopeForSession`、`attachSession` 走了解析：

```
已解析：
  363  ensureProjectAlias（canonical 计算）
  4735 scopeForSession
  7210 attachSession（随后 7211 解析）

未解析（直接使用原始键）：
  2375 resolveTranscriptScope(cwd 分支)
  2465 candidateScope(cwd 分支)
  4614 projectForAgentId(cwd 分支)
  4641 projectForScope(exact 分支)
  4653 projectForScope(prefix 匹配)
  4669 rememberUserMessage（写 projectByAgent + meta.agent_project）
  6209 /omni-memory/packet 的 cwd → scope
```

其中 `rememberUserMessage` 每个用户回合都会把**原始键**写回 `meta.agent_project:<session>`，`projectForAgentId` 又原样返回缓存/持久化的键。只要有一次入口拿到旧键，后续写入就会落在旧键上。

3. **alias 一旦存在，`ensureProjectAlias` 永远跳过迁移**：

```js
const canonical = resolveScopeAlias(db, projectKeyFromCwd(raw));       // 604dba
const legacy    = resolveScopeAlias(db, legacyProjectKeyFromCwd(raw)); // 767039 -> 604dba
if (legacy !== canonical) candidates.add(legacy);                      // 相等，不加入
```

`legacy` 先被解析，和 `canonical` 相等，于是旧键不会进入迁移候选；`scopeHasRows(767039) === true` 也永远不会被检查。

4. **`migrateScopeAlias` 同样先解析 from**，所以对已存在的 alias 是空操作：

```js
const source = resolveScopeAlias(db, from);   // 767039 -> 604dba
if (source === target) return { migrated: false };   // 直接返回
```

5. **CLI `--apply` 因此也无效**。在真实库副本上实测：

```
before old chunks: 10
migrate result: {"migrated":false,"from":"proj:全息记忆#604dba","to":"proj:全息记忆#604dba"}
after old chunks: 10
```

（`node hosts/cli.mjs scope-alias --from ... --to ...` 的预检却会打印 `fromHasRows: true`，更容易误导。）

### B.3 修复建议

**B-1 统一项目键入口（根因）**

新增一个函数并替换所有未解析的调用点：

```js
function resolveProjectKey(db, cwd) {
  const key = projectKeyFromCwd(cwd);
  return key === SCOPE_GLOBAL ? key : resolveScopeAlias(db, key);
}
```

替换：`resolveTranscriptScope`、`candidateScope`、`projectForAgentId`、`projectForScope`、`rememberUserMessage`、`/omni-memory/packet`。`scopeForSession`/`attachSession` 已解析，可保留或改用同一函数。

**B-2 允许按字面键迁移（数据修复）**

给 `migrateScopeAlias` 增加 `literal` 选项，`source` 不参与解析：

```js
function migrateScopeAlias(db, from, to, options = {}) {
  const source = options.literal ? String(from) : resolveScopeAlias(db, from);
  const target = resolveScopeAlias(db, to);
  ...
}
```

`ensureProjectAlias` 改为：

- 始终把 `legacyProjectKeyFromCwd(raw)` 的**原始键**加入候选；
- 再遍历 `scope_aliases WHERE canonical = canonical`，把仍有行的 alias 加入候选；
- 对每个候选：有行则 `migrateScopeAlias(db, candidate, canonical, { literal: true, path })`，无行则只补/保留 alias。

**B-3 启动自愈（一次性）**

在 `openStore` 拿到维护租约、`migrate()` 之后，遍历所有 `scope_aliases`：`alias !== canonical && scopeHasRows(alias)` → 按字面键迁移；用 `meta.scope_alias_repair_version` 记录已执行，失败写错误并暴露到 `/status`。

**B-4 现有数据修复步骤**

1. 备份：先 `PRAGMA wal_checkpoint(TRUNCATE)`，复制 `omni.db` 到安全位置（DSH 运行中复制会带上 WAL，建议停库或至少打包 db/wal/shm）。
2. 代码修复后执行（先 dry-run，再 apply）：

```bash
node hosts/cli.mjs scope-alias --from 'proj:全息记忆#767039' --to 'proj:全息记忆#604dba'
node hosts/cli.mjs scope-alias --from 'proj:全息记忆#767039' --to 'proj:全息记忆#604dba' --apply
```

3. 验证：

```sql
SELECT scope, COUNT(*) FROM chunks WHERE scope LIKE 'proj:全息记忆%' GROUP BY scope;
SELECT scope, COUNT(*) FROM notes  WHERE scope LIKE 'proj:全息记忆%' GROUP BY scope;
SELECT alias, canonical FROM scope_aliases;
```

期望：旧键 0 行，新键包含原有全部行；alias 保留；`/omni-memory/list?scope=all` 的 projects 只剩一个 `604dba`。

> 注意：如果两键存在同 hash 的活跃 chunk，迁移逻辑会把来源行墓碑化（保留审计），这是预期行为。

### B.5 回归测试

1. `test/scope-alias-leftover.test.mjs`
   - 临时库写入 `scope_aliases(a→b)`，再向 `a` 插入 notes/facts/chunks；
   - 以真实 cwd 打开/attach，断言旧键行数变 0、新键包含全部；
   - 直接调用 `migrateScopeAlias(db, a, b, { literal: true })`，断言能迁移。
2. `test/project-key-resolution.test.mjs`
   - `rememberUserMessage` 之后 `currentProject()` 必须返回 canonical（不是 legacy）；
   - `/packet?cwd=<cwd>` 返回 canonical；
   - 同一路径的大小写/斜杠变体返回同一个 key。
3. 迁移幂等：重复执行 B-3 自愈不产生重复行、不改变 alias 时间戳。

### B.6 验收

- 同一工作目录只有 1 个 `proj:` 键；`scope_aliases` 中的 alias 对应 0 行。
- 重启、切换大小写路径、MCP/CLI 同时写，键保持不变。
- 旧数据在精确项目键视图可见（12 条转录全部回到 `604dba`）。

---

## C. 3.10.2 修复顺序（建议）

1. **A（30 分钟）**：`ctx.inject(['webServer'], ...)` + `systemPrompt` 同类检查；冷启动回归。
2. **B-1（30 分钟）**：统一 `resolveProjectKey` 入口，先止住新的分裂。
3. **B-2/B-3（1 小时）**：literal 迁移 + 启动自愈；补测试。
4. **数据修复**：备份 → dry-run → apply → 验证（见 B-4）。
5. **文档**：更新 ADR-031 与 REFERENCE 的「项目键稳定/迁移」描述，说明 alias 一旦记录仍可能残留数据、以及自愈机制。

## D. 本次安装验收记录（证据）

```
20:42:36  DSH 重启（PID 37144，端口 9230 / 59273）
20:43     GET /omni-memory/status -> 404（客户端 slot active、memory_* 工具可用）
20:44     set_plugin include:memory-core false -> true
20:44     GET /omni-memory/status -> 200，字段含 semantic
          POST /forget 伪造 Host/Origin -> 403
          POST /forget 合法 Host/Origin -> 200
          GET /list?limit=abc -> 400
21:00     项目键检查：
          proj:全息记忆#604dba chunks=2  notes=1
          proj:全息记忆#767039 chunks=10 notes=0
          scope_aliases: 767039 -> 604dba
          migrateScopeAlias(literal 未支持) -> migrated:false，行数不变
npm test  356/356 pass（3.10.1 代码）
```

## E. 边界

- A 的根因由「404 + 重载后恢复 + 代码早退」三方证据支撑，但没有在干净机器上做多次冷启动统计；修复后必须用真实 DSH 重启验证，不能只靠单元测试。
- B 的「旧键 10 条转录由哪个入口写入」没有逐条追溯（可能是历史版本 + 多入口混合），但「alias 已存在 → 两个迁移函数都空转」已用真实库副本复现。
- 本文件不修改代码；执行 B-4 前必须备份数据库。
