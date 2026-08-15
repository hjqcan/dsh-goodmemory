import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createScopeResolver, durableScopeKey } from '../src/scope.ts'

describe('scope resolution', () => {
  it('isolates the default DSH agent and hashes the normalized workspace path', () => {
    const resolver = createScopeResolver({ userId: 'user-1' })
    const first = resolver({ cwd: '/tmp/project/../project', sessionId: 'session-a' })
    const second = resolver({ cwd: resolve('/tmp/project'), sessionId: 'session-b' })

    expect(first.userId).toBe('user-1')
    expect(first.agentId).toBe('dsh')
    expect(first.workspaceId).toMatch(/^dsh-workspace:[a-f0-9]{64}$/)
    expect(first.sessionId).toBe('session-a')
    expect(durableScopeKey(first)).toBe(durableScopeKey(second))
  })

  it('supports explicit cross-host sharing and the global no-cwd scope', () => {
    const shared = createScopeResolver({
      agentId: null,
      userId: 'shared-user',
      workspaceId: null,
    })({ sessionId: 'session-a' })
    const global = createScopeResolver({ userId: 'user-1' })({ sessionId: 'session-b' })

    expect(shared).toEqual({ userId: 'shared-user', sessionId: 'session-a' })
    expect(global.workspaceId).toBe('dsh-workspace:global')
  })
})
