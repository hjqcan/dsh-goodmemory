import type { Context } from '@deepseek-ai/cordis'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'

import {
  Config,
  resolveConfig,
} from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { GoodMemoryHttpClient } from './client.ts'
import { startManagedBridge } from './managed.ts'
import {
  buildRecallQuery,
  injectRecallContext,
  projectCompletedTurn,
} from './projection.ts'
import { createScopeResolver, durableScopeKey } from './scope.ts'
import type { MemoryScope } from './types.ts'
import { WriteCoordinator } from './write-coordinator.ts'

export { Config, resolveConfig }
export type {
  CommonConfig,
  Config as ConfigShape,
  ExternalConfig,
  GoodMemoryRecallSource,
  ManagedConfig,
  ScopeConfig,
} from './types.ts'

export const name = 'goodmemory'
export const inject = ['sessions']

interface RuntimeBackend {
  client: GoodMemoryHttpClient
  dispose(): Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function warning(
  ctx: Context,
  event: 'recall_failed' | 'writeback_failed',
  error: unknown,
  sessionId: string,
  turn: number,
): void {
  ctx.logger.warn(JSON.stringify({
    component: 'dsh-goodmemory',
    error: errorMessage(error),
    event,
    sessionId,
    turn,
  }))
}

async function createBackend(ctx: Context, config: ResolvedConfig): Promise<RuntimeBackend> {
  if (config.mode === 'managed') {
    return startManagedBridge(ctx.logger, {
      ...(config.databasePath === undefined ? {} : { databasePath: config.databasePath }),
      requestTimeoutMs: config.requestTimeoutMs,
      startupTimeoutMs: config.startupTimeoutMs,
    })
  }

  const token = process.env[config.tokenEnv]?.trim()
  if (!token) {
    throw new Error(`dsh-goodmemory: external bridge token environment variable ${config.tokenEnv} is missing`)
  }
  const client = new GoodMemoryHttpClient({
    baseUrl: config.baseUrl,
    timeoutMs: config.requestTimeoutMs,
    token,
  })
  await client.health()
  return { client, dispose: () => Promise.resolve() }
}

function scopeFor(
  resolver: ReturnType<typeof createScopeResolver>,
  session: Session,
): MemoryScope {
  return resolver({
    ...(session.header.cwd === undefined ? {} : { cwd: session.header.cwd }),
    sessionId: session.id,
  })
}

/** Install automatic GoodMemory recall and completed-turn writeback. */
export async function apply(ctx: Context, input: Config = {}): Promise<void> {
  const config = resolveConfig(input)
  const userId = config.scope.userId === undefined
    ? getOrCreateAnonymousUserId()
    : config.scope.userId
  const resolveScope = createScopeResolver({
    ...config.scope,
    userId,
  })
  const backend = await createBackend(ctx, config)
  if (config.mode === 'external') {
    await backend.client.recall({
      maxTokens: 1,
      query: 'dsh-goodmemory startup authorization check',
      scope: resolveScope({ sessionId: 'dsh-goodmemory-startup' }),
    })
  }
  const writes = new WriteCoordinator()

  // Register teardown first: Cordis removes later event effects before this drain.
  ctx.effect(() => async () => {
    await writes.drain()
    await backend.dispose()
  }, 'dsh-goodmemory lifecycle')

  ctx.on('agent/pre-step', async ({ agent, signal, turn }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (!config.recall || signal.aborted || decision.kind !== 'enter') return decision
    const query = buildRecallQuery(decision.messages)
    if (query === undefined) return decision

    const scope = scopeFor(resolveScope, agent.session)
    await writes.wait(durableScopeKey(scope))
    if (signal.aborted) return decision

    try {
      const recalled = await backend.client.recall({
        maxTokens: config.maxRecallTokens,
        query: query.text,
        scope,
        signal,
      })
      if (recalled === undefined || signal.aborted) return decision
      return {
        kind: 'enter',
        messages: injectRecallContext(decision.messages, query.messageIds, recalled),
      }
    } catch (error) {
      if (!signal.aborted) warning(ctx, 'recall_failed', error, agent.session.id, turn)
      return decision
    }
  })

  ctx.on('session/event', (session, event) => {
    if (
      !config.writeback
      || event.type !== 'turn/end'
      || event.data.reason.kind !== 'completed'
    ) return
    const projection = projectCompletedTurn(session.events, event.data.turn)
    if (projection === undefined) return

    const scope = scopeFor(resolveScope, session)
    writes.enqueue(
      durableScopeKey(scope),
      () => backend.client.remember({
        idempotencyKey: `dsh:${session.id}:turn:${event.data.turn}`,
        messages: projection.messages,
        scope,
      }),
      error => warning(ctx, 'writeback_failed', error, session.id, event.data.turn),
    )
  })

  ctx.on('session/flush', async (session) => {
    const scope = scopeFor(resolveScope, session)
    await writes.wait(durableScopeKey(scope))
  })
}
