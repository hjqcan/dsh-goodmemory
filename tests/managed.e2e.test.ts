import { access, chmod, mkdir, mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as GoodMemoryPlugin from '../src/index.ts'
import { startManagedBridge } from '../src/managed.ts'
import type { MemoryScope } from '../src/types.ts'
import { createAgent, createHarness, ScriptedAdapter, send, textResponse } from './helpers/dsh.ts'

const bunAvailable = spawnSync(
  process.env.GOODMEMORY_BUN_BINARY ?? 'bun',
  ['--version'],
  { stdio: 'ignore' },
).status === 0
const bunIt = bunAvailable ? it : it.skip

afterEach(() => {
  vi.unstubAllEnvs()
})

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function childProcessIds(pid: number): number[] {
  const result = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
  if (result.status !== 0) return []
  return result.stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
}

describe('managed GoodMemory sidecar', () => {
  bunIt('enforces owner-only permissions on the default managed storage directory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-goodmemory-permissions-'))
    const storageDirectory = join(home, 'goodmemory')
    await mkdir(storageDirectory, { mode: 0o755 })
    await chmod(storageDirectory, 0o755)
    vi.stubEnv('DSH_HOME', home)
    const ctx = new Context()
    const bridge = await startManagedBridge(ctx.logger, {
      requestTimeoutMs: 10_000,
      startupTimeoutMs: 15_000,
    })
    try {
      expect((await stat(storageDirectory)).mode & 0o777).toBe(0o700)
    } finally {
      await bridge.dispose()
      await ctx.fiber.dispose()
    }
  }, 60_000)

  bunIt('uses a random loopback port, persists SQLite, and exits cleanly', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-goodmemory-managed-'))
    const databasePath = join(home, 'memory.sqlite')
    const ctx = new Context()
    const scope: MemoryScope = {
      agentId: 'dsh',
      sessionId: 'session-a',
      userId: 'e2e-user',
      workspaceId: 'e2e-workspace',
    }
    const first = await startManagedBridge(ctx.logger, {
      databasePath,
      requestTimeoutMs: 10_000,
      startupTimeoutMs: 15_000,
    })
    const firstPid = first.processId
    const descendantPids = childProcessIds(firstPid)
    try {
      expect(new URL(first.client.baseUrl).hostname).toBe('127.0.0.1')
      expect(new URL(first.client.baseUrl).port).not.toBe('8739')
      expect(descendantPids.length).toBeGreaterThan(0)
      const command = spawnSync('ps', ['-p', String(firstPid), '-o', 'command='], { encoding: 'utf8' }).stdout
      expect(command).not.toContain('--token')
      await first.client.remember({
        idempotencyKey: 'managed-turn-a',
        messages: [
          {
            content: 'I prefer pnpm for package management.',
            id: 'user-a',
            observedAt: '2026-08-15T00:00:00.000Z',
            role: 'user',
          },
          {
            content: 'I will use pnpm.',
            id: 'assistant-a',
            observedAt: '2026-08-15T00:00:01.000Z',
            role: 'assistant',
          },
        ],
        scope,
      })
    } finally {
      await first.dispose()
    }
    expect(processExists(firstPid)).toBe(false)
    expect(descendantPids.every(pid => !processExists(pid))).toBe(true)
    await expect(access(databasePath)).resolves.toBeUndefined()

    const second = await startManagedBridge(ctx.logger, {
      databasePath,
      requestTimeoutMs: 10_000,
      startupTimeoutMs: 15_000,
    })
    try {
      await expect(second.client.recall({
        maxTokens: 256,
        query: 'Which package manager do I prefer?',
        scope: { ...scope, sessionId: 'session-b' },
      })).resolves.toMatchObject({ contextText: expect.stringContaining('pnpm') })
    } finally {
      await second.dispose()
      await ctx.fiber.dispose()
    }
  }, 60_000)

  bunIt('recalls session A from a fresh DSH process composition in session B', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-goodmemory-restart-'))
    const databasePath = join(home, 'memory.sqlite')
    vi.stubEnv('DSH_HOME', home)

    const firstAdapter = new ScriptedAdapter([textResponse('I will keep using pnpm.')])
    const first = await createHarness(firstAdapter)
    await first.plugin(GoodMemoryPlugin, {
      databasePath,
      mode: 'managed',
      scope: { userId: 'restart-user' },
    })
    const sessionA = createAgent(first, 'restart-session-a', join(home, 'workspace'))
    send(sessionA, 'I prefer pnpm for package management.')
    await sessionA.whenIdle()
    await first.sessions.flush(sessionA.session)
    await first.fiber.dispose()

    const secondAdapter = new ScriptedAdapter([textResponse('You prefer pnpm.')])
    const second = await createHarness(secondAdapter)
    try {
      await second.plugin(GoodMemoryPlugin, {
        databasePath,
        mode: 'managed',
        scope: { userId: 'restart-user' },
      })
      const sessionB = createAgent(second, 'restart-session-b', join(home, 'workspace'))
      send(sessionB, 'Which package manager do I prefer?')
      await sessionB.whenIdle()

      expect(secondAdapter.requests[0]?.messages.some(message =>
        message.source.kind === 'goodmemory'
        && message.content.some(block => block.type === 'text' && block.text.includes('pnpm'))
      )).toBe(true)
    } finally {
      await second.fiber.dispose()
    }
  }, 60_000)
})
