# dsh-goodmemory

[中文](./README.zh-CN.md)

Automatic, durable, cross-session memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), backed by [GoodMemory](https://github.com/hjqcan/GoodMemory).

The plugin recalls relevant memory before a DSH model step and writes the completed human/assistant exchange after a successful turn. Recalled context is an identified DSH `user/message`, so everything visible to the model remains reconstructable from the session log.

```text
completed DSH turn -> GoodMemory remember -> later DSH pre-step
                   -> GoodMemory recall -> durable user/message -> model
```

## Compatibility

| Package/runtime | Supported version |
| --- | --- |
| `@deepseek-ai/dsh` | `0.1.0-rc.8` |
| `goodmemory` | `0.8.3` |
| Node.js | `^22.19.0` or `>=24.0.0` |
| Bun, managed mode only | `>=1.3.14` |

DSH is still an RC. This package deliberately pins its DSH peers; a new RC is unsupported until the integration suite passes against it.

## Install

Install from npm:

```sh
dsh plugin --profile web add dsh-goodmemory@0.1.2
dsh --profile web --dump-config
dsh --profile web
```

For a local checkout:

```sh
pnpm install
pnpm pack
dsh plugin --profile web add ./dsh-goodmemory-0.1.2.tgz
```

Use `--profile headless` instead of `web` for the headless composition. The bundle inserts one `goodmemory` row; later profile, home, and CLI patch layers can replace its complete config.

## Managed mode

Managed mode is the default. It starts the published `goodmemory-http-bridge` on a random loopback port, creates an in-memory bearer token, enables the recommended retrieval preset, and stores SQLite data at `$DSH_HOME/goodmemory/memory.sqlite`.

Install Bun first. `GOODMEMORY_BUN_BINARY` may name a non-default Bun executable. To choose a different database path, override the row in the profile's `cordis.patch.yml`:

```yaml
- id: goodmemory
  name: dsh-goodmemory
  config:
    mode: managed
    databasePath: /absolute/path/to/memory.sqlite
```

The plugin waits for in-flight writeback during normal HMR or process teardown, then terminates the managed sidecar. It does not automatically restart a sidecar that crashes after activation; DSH keeps running without memory and logs the failure until the plugin is reloaded.

## External mode

External mode connects to an existing GoodMemory HTTP bridge. Keep the token in an environment variable, not in DSH config:

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

Activation verifies health, the exact `phase-39.http-memory.v1` contract, and authenticated recall. Invalid config, a missing token, failed authorization, or a contract mismatch fails plugin activation.

## Behavior and configuration

```ts
type Config = {
  recall?: boolean              // default true
  writeback?: boolean           // default true
  maxRecallTokens?: number      // default 256
  requestTimeoutMs?: number     // default 10000
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

- Recall runs only when the final `agent/pre-step` batch contains direct `source.kind === "user"` text. Tool-only continuations and plugin context do not trigger another lookup.
- Completed-turn writeback contains all direct user text and the final assistant text. Tool calls/results, reasoning, images, recalled memory, and other injected context are excluded.
- Writeback uses GoodMemory's normal extraction and policy. The plugin sends no annotations and does not force content to become durable memory.
- Runtime recall/writeback failures are logged with phase, session, and turn identity, then the DSH turn continues. Startup failures remain fatal.
- The next recall for the same durable scope waits for pending writeback, including a new session created immediately after the preceding turn.

### Project decisions and writeback receipts

With GoodMemory 0.8.3, a direct user statement such as the following is accepted
without annotations and recalled after a process restart in the same scope:

```text
Project decision: When SQLite reports SQLITE_BUSY_SNAPSHOT, roll back the transaction, begin again and recompute from a fresh read before writing.
```

`We decided that ...` and substantive `Project policy: ...` declarations also
work. Questions and undecided placeholders are not confirmed decisions.
GoodMemory 0.8.2 retained the example above as source text but did not create a
durable fact. Re-send previously source-only decisions after upgrading; the
upgrade does not re-extract old transcripts automatically.

Every completed writeback logs a `writeback_result` receipt with the session,
turn, duration, accepted/rejected counts, outcome, extraction strategy, and
known rejection reason codes. `no_admissible_candidate` means no durable
candidate was admitted; HTTP success alone does not mean the text became a
memory. These diagnostics omit conversation text, raw bridge errors, and
credentials. Recall counts are available through debug-level `recall_result`
logs. Extraction warnings or a failed outcome produce warning-level receipts.

## Scope

Defaults are deliberately DSH-isolated:

- `userId`: DSH's persisted anonymous user id under `$DSH_HOME`;
- `workspaceId`: SHA-256 of the normalized session working directory, or `dsh-workspace:global` without a working directory;
- `agentId`: `dsh`;
- `sessionId`: the current DSH session id.

GoodMemory's durable scope excludes `sessionId`, so different DSH sessions in the same user/workspace/agent scope share long-term memory. To share with another GoodMemory host, explicitly configure the same `userId`, `workspaceId`, and `agentId`; set nullable workspace/agent fields to `null` when the other host omits them.

## Privacy and management

The plugin does not copy DSH JSONL logs or create a second memory schema. It sends only selected text to GoodMemory: direct human text plus the final assistant text. GoodMemory remains the sole memory/storage truth.

The first release intentionally adds no model tools, MCP server, DSH command, or management UI. Use GoodMemory's existing CLI and Inspector for health, review, revision, export, and forgetting:

```sh
goodmemory inspector serve
```

## Development

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm test:e2e   # real Bun + GoodMemory SQLite restart proof
pnpm pack
```

The deterministic integration suite uses a scripted DSH model adapter. It verifies logged recall context, completed-only writeback, tool/reasoning exclusion, scope isolation, write-after-read ordering, runtime degradation, and strict startup validation. The decision regression runs write, restart, and different-directory phases in separate Node processes with a real managed Bun/SQLite bridge, inspecting both the model request and session log. CI also runs that regression on Windows. No benchmark uplift or answer-quality claim is made.
