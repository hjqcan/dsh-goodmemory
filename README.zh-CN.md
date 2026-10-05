# dsh-goodmemory

[English](./README.md)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供由 [GoodMemory](https://github.com/hjqcan/GoodMemory) 支撑的自动、持久、跨会话记忆。

插件会在 DSH 模型步骤前召回相关记忆，并在成功完成一个 turn 后写回用户与助手的最终对话。召回内容会成为带明确来源身份的 DSH `user/message`，因此模型看到的内容可以从 session log 完整重建。

```text
完成的 DSH turn -> GoodMemory remember -> 后续 DSH pre-step
                 -> GoodMemory recall -> 持久 user/message -> 模型
```

## 兼容性

| 包/运行时 | 支持版本 |
| --- | --- |
| `@deepseek-ai/dsh` | `0.1.0-rc.8` |
| `goodmemory` | `0.8.3` |
| Node.js | `^22.19.0` 或 `>=24.0.0` |
| Bun，仅 managed 模式 | `>=1.3.14` |

DSH 仍处于 RC。本包故意精确锁定 DSH peer；新的 RC 必须重新通过集成测试后才算支持。

## 安装

从 npm 安装：

```sh
dsh plugin --profile web add dsh-goodmemory@0.1.2
dsh --profile web --dump-config
dsh --profile web
```

本地仓库验证：

```sh
pnpm install
pnpm pack
dsh plugin --profile web add ./dsh-goodmemory-0.1.2.tgz
```

无头模式将 `web` 换成 `headless`。bundle 只插入一个 `goodmemory` row；后续 profile、home 或命令行 patch 可以完整覆盖它的 config。

## Managed 模式

默认使用 managed 模式。插件会在随机回环端口启动发布包内的 `goodmemory-http-bridge`，生成仅存于进程内的 bearer token，启用 recommended retrieval preset，并把 SQLite 存在 `$DSH_HOME/goodmemory/memory.sqlite`。

先安装 Bun。非默认 Bun 路径可通过 `GOODMEMORY_BUN_BINARY` 指定。自定义数据库路径时，在 profile 的 `cordis.patch.yml` 覆盖整个 row：

```yaml
- id: goodmemory
  name: dsh-goodmemory
  config:
    mode: managed
    databasePath: /absolute/path/to/memory.sqlite
```

正常 HMR 或进程退出时，插件会先等待在途写回，再终止侧车。首版不会自动重启激活后崩溃的侧车；DSH 会继续运行并记录故障，重新加载插件后恢复。

## External 模式

External 模式连接已有 GoodMemory HTTP bridge。token 只放环境变量，不写入 DSH 配置：

```sh
export GOODMEMORY_HTTP_BRIDGE_TOKEN='replace-with-a-secret'
goodmemory-http-bridge --recommended
```

```yaml
- id: goodmemory
  name: dsh-goodmemory
  config:
    mode: external
    baseUrl: http://127.0.0.1:8739
    tokenEnv: GOODMEMORY_HTTP_BRIDGE_TOKEN
```

激活时会核验健康状态、精确的 `phase-39.http-memory.v1` 协议以及带鉴权的召回。配置错误、token 缺失、鉴权失败或协议不匹配都会拒绝激活。

## 行为与配置

```ts
type Config = {
  recall?: boolean              // 默认 true
  writeback?: boolean           // 默认 true
  maxRecallTokens?: number      // 默认 256
  requestTimeoutMs?: number     // 默认 10000
  scope?: {
    userId?: string
    workspaceId?: string | null
    agentId?: string | null
  }
} & (
  | { mode?: 'managed'; databasePath?: string; startupTimeoutMs?: number }
  | { mode: 'external'; baseUrl: string; tokenEnv?: string }
)
```

- 只有最终 `agent/pre-step` 批次含直接的 `source.kind === "user"` 文本时才召回；纯工具 continuation 和插件上下文不会重复查询。
- 完成轮次写回只包含全部直接用户文本与最后一条 assistant 文本；工具调用/结果、reasoning、图片、召回记忆与其他注入上下文都会排除。
- 写回使用 GoodMemory 正常的提取与策略边界；插件不发送 annotations，也不强制任何文本成为长期记忆。
- 运行期召回/写回失败会记录阶段、session 与 turn 后继续 DSH 对话；启动错误仍然是致命错误。
- 同一 durable scope 的下一次召回会等待在途写回，包括上一个 turn 完成后立即创建的新 session。

### 项目决策与写回回执

GoodMemory 0.8.3 支持直接用户声明，无需 annotations。以下原句会形成长期事实，并在同一作用域的进程重启后召回：

```text
Project decision: When SQLite reports SQLITE_BUSY_SNAPSHOT, roll back the transaction, begin again and recompute from a fresh read before writing.
```

`We decided that ...` 和有明确内容的 `Project policy: ...` 也支持；问句和待定占位语句不属于已确认决策。GoodMemory 0.8.2 对上述原句只保留来源文本，没有生成长期事实。升级不会自动重新提取旧对话；需要重新发送此前只保留原文的决策。

每次完成写回都会记录 `writeback_result`，包含 session、turn、耗时、接受/拒绝数量、结果、提取策略及已知拒绝原因码。`no_admissible_candidate` 表示没有候选被接纳为长期记忆；HTTP 请求成功并不等于形成记忆。诊断日志不包含对话正文、原始 bridge 错误或凭据。debug 级别的 `recall_result` 可查看召回数量；提取警告或失败结果使用 warning 级别。

决策回归测试使用独立 Node 进程执行写入、重启及不同目录的作用域对照，连接真实 Bun/SQLite bridge，同时检查模型请求和 session 日志。CI 也在 Windows 上运行这组测试；脚本模型测试不代表回答质量或编码收益。

## Scope

默认与其他 host 隔离：

- `userId`：持久化在 `$DSH_HOME` 下的 DSH anonymous user id；
- `workspaceId`：规范化 session 工作目录后的 SHA-256；无工作目录时为 `dsh-workspace:global`；
- `agentId`：`dsh`；
- `sessionId`：当前 DSH session id。

GoodMemory 的 durable scope 不包含 `sessionId`，因此相同 user/workspace/agent 下的不同 DSH session 会共享长期记忆。如需与其他 GoodMemory host 共享，必须显式配置完全相同的 `userId`、`workspaceId`、`agentId`；当对方省略 workspace/agent 时，把对应 nullable 字段设为 `null`。

## 隐私与管理

插件不会复制 DSH JSONL，也不会建立第二份 memory schema；只把直接用户文本和最终 assistant 文本发送给 GoodMemory。GoodMemory 始终是唯一的记忆与存储真相源。

首版不增加模型工具、MCP server、DSH 命令或管理 UI。健康检查、审阅、修订、导出与遗忘继续使用 GoodMemory 现有 CLI/Inspector：

```sh
goodmemory inspector serve
```

## 开发验证

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm test:e2e   # 真实 Bun + GoodMemory SQLite 重启闭环
pnpm pack
```

确定性集成测试使用脚本化 DSH 模型 adapter，覆盖召回内容落入 session log、仅 completed 写回、工具/reasoning 排除、scope 隔离、写后读顺序、运行期降级和严格启动校验。本项目不声明 benchmark 提升。
