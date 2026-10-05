import { access, chmod, mkdir, mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

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
const execFileAsync = promisify(execFile)

interface WorkerResult {
  pid: number
  completedTurns: number
  requests: string[][]
  loggedRecall: string[]
  diagnostics: Array<Record<string, unknown>>
}

async function runWorker(home: string, sessionId: string, cwd: string, messages: string[]): Promise<WorkerResult> {
  // Keep this deterministic even on a workstation with assisted extraction configured.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('GOODMEMORY_') || key === 'GOODMEMORY_BUN_BINARY'
  ))
  const { stdout } = await execFileAsync(process.execPath, [
    '--experimental-transform-types',
    fileURLToPath(new URL('./helpers/managed-worker.ts', import.meta.url)),
    JSON.stringify({ cwd, databasePath: join(home, 'memory.sqlite'), messages, sessionId }),
  ], { env: { ...env, DSH_HOME: join(home, 'dsh-home') }, timeout: 45_000 })
  const result = stdout.split('\n').find(line => line.startsWith('DSH_RESTART_RESULT='))
  if (result === undefined) throw new Error('Managed worker exited without its verification result')
  return JSON.parse(result.slice('DSH_RESTART_RESULT='.length)) as WorkerResult
}

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
  const decisionBody = 'When SQLite reports SQLITE_BUSY_SNAPSHOT, roll back the transaction, begin again and recompute from a fresh read before writing.'

  bunIt.each([
    { name: 'Project decision: is durable', statement: `Project decision: ${decisionBody}`, accepted: true },
    { name: 'We decided is durable', statement: 'We decided that when SQLite reports SQLITE_BUSY_SNAPSHOT, we roll back the transaction, begin again and recompute from a fresh read before writing.', accepted: true },
    { name: 'Project policy: is durable', statement: `Project policy: ${decisionBody}`, accepted: true },
    { name: 'an unresolved decision remains source-only', statement: 'Project decision: When SQLite reports SQLITE_BUSY_SNAPSHOT, what should we do?', accepted: false },
  ])('verifies extraction, full process restart and scope: $name', async ({ statement, accepted }) => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-goodmemory-decision-'))
    const cwd = join(home, 'project-a')
    const questions = ['Which package manager do I prefer?', 'What is the project decision for SQLITE_BUSY_SNAPSHOT?']
    const first = await runWorker(home, 'decision-a', cwd, [
      'I prefer pnpm for package management.', statement,
    ])
    expect(first.completedTurns).toBe(2)
    expect(first.requests[0]).toEqual([])
    const receipts = first.diagnostics.filter(entry => entry.event === 'writeback_result')
    expect(receipts).toHaveLength(2)
    expect(receipts[1]).toMatchObject({
      accepted: accepted ? 1 : 0,
      outcome: accepted ? 'committed' : 'no_admissible_candidate',
      resolvedExtractionStrategy: 'rules-only',
    })

    const database = new DatabaseSync(join(home, 'memory.sqlite'), { readOnly: true })
    try {
      const rows = database.prepare("SELECT collection FROM documents WHERE instr(json, 'SQLITE_BUSY_SNAPSHOT') > 0").all()
      expect(rows.filter(row => row.collection === 'source_messages_v1')).toHaveLength(1)
      expect(rows.some(row => row.collection === 'facts')).toBe(accepted)
      if (!accepted) expect(rows.every(row => row.collection === 'source_messages_v1')).toBe(true)
    } finally {
      database.close()
    }

    const restarted = await runWorker(home, 'decision-b', cwd, questions)
    const isolated = await runWorker(home, 'decision-c', join(home, 'project-b'), questions)
    expect(new Set([first.pid, restarted.pid, isolated.pid]).size).toBe(3)
    expect(restarted.completedTurns).toBe(2)
    expect(restarted.requests[0]?.join('\n')).toContain('pnpm')
    expect(restarted.loggedRecall.join('\n')).toContain('pnpm')
    expect(restarted.requests[1]?.join('\n').includes('SQLITE_BUSY_SNAPSHOT')).toBe(accepted)
    expect(restarted.loggedRecall.join('\n').includes('SQLITE_BUSY_SNAPSHOT')).toBe(accepted)
    expect(isolated.completedTurns).toBe(2)
    expect(isolated.requests).toEqual([[], []])
    expect(isolated.loggedRecall).toEqual([])
    for (const worker of [first, restarted, isolated]) {
      expect(processExists(worker.pid)).toBe(false)
      expect(worker.diagnostics.filter(entry => entry.event === 'writeback_failed' || entry.event === 'recall_failed')).toEqual([])
    }
  }, 120_000)

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
