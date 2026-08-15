import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

import * as GoodMemoryPlugin from '../src/index.ts'
import { createAgent, createHarness, ScriptedAdapter, send, textResponse, toolResponse } from './helpers/dsh.ts'
import { createTestBridge } from './helpers/http-bridge.ts'
import type { TestBridge } from './helpers/http-bridge.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

async function installExternal(
  ctx: Awaited<ReturnType<typeof createHarness>>,
  bridge: TestBridge,
): Promise<void> {
  vi.stubEnv('DSH_GOODMEMORY_TEST_TOKEN', 'test-token')
  await ctx.plugin(GoodMemoryPlugin, {
    baseUrl: bridge.baseUrl,
    mode: 'external',
    scope: { userId: 'test-user' },
    tokenEnv: 'DSH_GOODMEMORY_TEST_TOKEN',
  })
  bridge.state.callOrder.length = 0
  bridge.state.recallCount = 0
}

describe('DSH lifecycle integration', () => {
  it('rejects an explicitly blank user id instead of falling back to anonymous identity', async () => {
    const bridge = await createTestBridge()
    const ctx = await createHarness(new ScriptedAdapter([]))
    vi.stubEnv('DSH_HOME', await mkdtemp(join(tmpdir(), 'dsh-goodmemory-blank-user-')))
    vi.stubEnv('DSH_GOODMEMORY_TEST_TOKEN', 'test-token')
    try {
      await expect(ctx.plugin(GoodMemoryPlugin, {
        baseUrl: bridge.baseUrl,
        mode: 'external',
        scope: { userId: ' ' },
        tokenEnv: 'DSH_GOODMEMORY_TEST_TOKEN',
      })).rejects.toThrow(/scope.userId must be non-empty/)
    } finally {
      await ctx.fiber.dispose()
      await bridge.close()
    }
  })

  it('fails activation on an incompatible bridge contract', async () => {
    const bridge = await createTestBridge({ contractVersion: 'future-contract' })
    const ctx = await createHarness(new ScriptedAdapter([]))
    vi.stubEnv('DSH_GOODMEMORY_TEST_TOKEN', 'test-token')
    try {
      await expect(ctx.plugin(GoodMemoryPlugin, {
        baseUrl: bridge.baseUrl,
        mode: 'external',
        scope: { userId: 'test-user' },
        tokenEnv: 'DSH_GOODMEMORY_TEST_TOKEN',
      })).rejects.toThrow(/contract mismatch/)
    } finally {
      await ctx.fiber.dispose()
      await bridge.close()
    }
  })

  it('fails activation when the external token cannot authorize recall', async () => {
    const bridge = await createTestBridge()
    const ctx = await createHarness(new ScriptedAdapter([]))
    vi.stubEnv('DSH_GOODMEMORY_TEST_TOKEN', 'wrong-token')
    try {
      await expect(ctx.plugin(GoodMemoryPlugin, {
        baseUrl: bridge.baseUrl,
        mode: 'external',
        scope: { userId: 'test-user' },
        tokenEnv: 'DSH_GOODMEMORY_TEST_TOKEN',
      })).rejects.toThrow(/HTTP 401 caller_required/)
    } finally {
      await ctx.fiber.dispose()
      await bridge.close()
    }
  })

  it('writes a completed turn before recalling it into a new session', async () => {
    const bridge = await createTestBridge({ rememberDelayMs: 50 })
    const adapter = new ScriptedAdapter([
      textResponse('I will use pnpm.'),
      textResponse('Your preference is pnpm.'),
    ])
    const ctx = await createHarness(adapter)
    try {
      await installExternal(ctx, bridge)
      const first = createAgent(ctx, 'session-a')
      send(first, 'Use pnpm in this repository.')
      await first.whenIdle()

      const second = createAgent(ctx, 'session-b')
      send(second, 'Which package manager should I use?')
      await second.whenIdle()
      await ctx.sessions.flush(second.session)

      expect(bridge.state.callOrder).toEqual(['recall', 'remember', 'recall', 'remember'])
      const secondRequest = adapter.requests[1]
      expect(secondRequest?.messages.map(message => message.source.kind)).toContain('goodmemory')
      expect(second.session.events.some(event =>
        event.type === 'user/message' && event.data.source.kind === 'goodmemory'
      )).toBe(true)
    } finally {
      await ctx.fiber.dispose()
      await bridge.close()
    }
  })

  it('does not recall on a tool-only continuation or write tool payloads', async () => {
    const bridge = await createTestBridge()
    const adapter = new ScriptedAdapter([
      toolResponse('echo'),
      textResponse('Tool finished.'),
    ])
    const ctx = await createHarness(adapter)
    try {
      ctx.tools.register(defineContentToolFixture({
        description: 'Echo a value',
        execute: async ({ value }) => [{ text: String(value), type: 'text' }],
        name: 'echo',
        parameters: { value: { required: true, type: 'string' } },
      }))
      await installExternal(ctx, bridge)
      const agent = createAgent(ctx, 'session-tool')
      send(agent, 'Run the echo tool.')
      await agent.whenIdle()
      await ctx.sessions.flush(agent.session)

      expect(bridge.state.recallCount).toBe(1)
      const body = bridge.state.rememberBodies[0]
      const messages = body?.messages as Array<{ content: string; role: string }>
      expect(messages).toEqual([
        expect.objectContaining({ content: 'Run the echo tool.', role: 'user' }),
        expect.objectContaining({ content: 'Tool finished.', role: 'assistant' }),
      ])
      expect(JSON.stringify(body)).not.toContain('tool payload')
    } finally {
      await ctx.fiber.dispose()
      await bridge.close()
    }
  })

  it('does not write max-token turns', async () => {
    const bridge = await createTestBridge()
    const adapter = new ScriptedAdapter([textResponse('truncated', 'max-tokens')])
    const ctx = await createHarness(adapter)
    try {
      await installExternal(ctx, bridge)
      const agent = createAgent(ctx, 'session-max')
      send(agent, 'Produce a long answer.')
      await agent.whenIdle()
      await ctx.sessions.flush(agent.session)

      expect(bridge.state.rememberBodies).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
      await bridge.close()
    }
  })

  it('keeps the turn running when recall fails after activation', async () => {
    const bridge = await createTestBridge()
    const adapter = new ScriptedAdapter([textResponse('Still available.')])
    const ctx = await createHarness(adapter)
    const warn = vi.spyOn(ctx.logger, 'warn')
    try {
      await installExternal(ctx, bridge)
      bridge.state.failRecall = true
      const agent = createAgent(ctx, 'session-failure')
      send(agent, 'Continue without memory.')
      await agent.whenIdle()

      expect(adapter.requests).toHaveLength(1)
      expect(agent.session.events.findLast(event => event.type === 'turn/end')).toMatchObject({
        data: { reason: { kind: 'completed' } },
      })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('recall_failed'))
    } finally {
      await ctx.fiber.dispose()
      await bridge.close()
    }
  })
})
