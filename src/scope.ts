import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import type { MemoryScope, ScopeConfig } from './types.ts'

interface ScopeResolverInput {
  cwd?: string
  sessionId: string
}

interface ScopeResolverConfig extends ScopeConfig {
  userId: string
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) {
    throw new Error(`dsh-goodmemory: ${field} must be non-empty`)
  }
  return normalized
}

function defaultWorkspaceId(cwd: string | undefined): string {
  if (cwd === undefined) return 'dsh-workspace:global'
  const normalized = resolve(cwd)
  const digest = createHash('sha256').update(normalized).digest('hex')
  return `dsh-workspace:${digest}`
}

/** Build the exact GoodMemory scope for one DSH session. */
export function createScopeResolver(config: ScopeResolverConfig) {
  const userId = nonEmpty(config.userId, 'scope.userId')
  const agentId = config.agentId === undefined
    ? 'dsh'
    : config.agentId === null
      ? undefined
      : nonEmpty(config.agentId, 'scope.agentId')

  return ({ cwd, sessionId }: ScopeResolverInput): MemoryScope => {
    const workspaceId = config.workspaceId === undefined
      ? defaultWorkspaceId(cwd)
      : config.workspaceId === null
        ? undefined
        : nonEmpty(config.workspaceId, 'scope.workspaceId')

    return {
      ...(agentId === undefined ? {} : { agentId }),
      ...(workspaceId === undefined ? {} : { workspaceId }),
      sessionId: nonEmpty(sessionId, 'sessionId'),
      userId,
    }
  }
}

/** Key for writes that must be visible to later sessions in the same durable scope. */
export function durableScopeKey(scope: MemoryScope): string {
  return JSON.stringify([
    scope.userId,
    scope.workspaceId ?? '',
    scope.agentId ?? '',
  ])
}
