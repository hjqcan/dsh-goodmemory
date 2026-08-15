import { describe, expect, it, vi } from 'vitest'

import { GoodMemoryHttpClient } from '../src/client.ts'
import type { MemoryScope, RememberMessage } from '../src/types.ts'

const scope: MemoryScope = {
  agentId: 'dsh',
  sessionId: 'session-a',
  userId: 'user-a',
  workspaceId: 'workspace-a',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  })
}

describe('GoodMemoryHttpClient', () => {
  it('verifies the exact bridge health contract', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({
      contractVersion: 'phase-39.http-memory.v1',
      ok: true,
      status: 'ok',
    }))
    const client = new GoodMemoryHttpClient({
      baseUrl: 'http://127.0.0.1:8739/',
      fetch,
      timeoutMs: 100,
      token: 'secret-token',
    })

    await expect(client.health()).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8739/healthz',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('sends scoped recall with least-privilege caller headers', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({
      context: {
        content: '## Relevant memory\n- prefers pnpm',
        estimatedTokens: 12,
        omittedSections: [],
        output: 'system_prompt_fragment',
      },
      contextText: '## Relevant memory\n- prefers pnpm',
      contractVersion: 'phase-39.http-memory.v1',
      hasContext: true,
      itemCount: 1,
      items: [],
      ok: true,
      operation: 'recall-context',
      routing: {},
      traceId: 'trace-a',
    }))
    const client = new GoodMemoryHttpClient({
      baseUrl: 'http://memory.test',
      fetch,
      timeoutMs: 100,
      token: 'secret-token',
    })

    await expect(client.recall({
      maxTokens: 256,
      query: 'Which package manager?',
      scope,
    })).resolves.toEqual({
      contextText: '## Relevant memory\n- prefers pnpm',
      estimatedTokens: 12,
      itemCount: 1,
      traceId: 'trace-a',
    })

    const [, init] = fetch.mock.calls[0] ?? []
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer secret-token')
    expect(headers.get('x-goodmemory-user-id')).toBe('user-a')
    expect(headers.get('x-goodmemory-workspace-id')).toBe('workspace-a')
    expect(headers.get('x-goodmemory-operations')).toBe('recall-context')
    expect(JSON.parse(String(init?.body))).toEqual({
      maxTokens: 256,
      output: 'system_prompt_fragment',
      query: 'Which package manager?',
      referenceTime: expect.any(String),
      retrievalProfile: 'coding_agent',
      scope,
      strategy: 'auto',
    })
  })

  it('returns undefined for an explicit empty recall', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({
      context: {
        content: '',
        estimatedTokens: 0,
        omittedSections: [],
        output: 'system_prompt_fragment',
      },
      contextText: '',
      contractVersion: 'phase-39.http-memory.v1',
      hasContext: false,
      itemCount: 0,
      items: [],
      ok: true,
      operation: 'recall-context',
      routing: {},
    }))
    const client = new GoodMemoryHttpClient({
      baseUrl: 'http://memory.test', fetch, timeoutMs: 100, token: 'secret-token',
    })

    await expect(client.recall({ maxTokens: 256, query: 'hello', scope })).resolves.toBeUndefined()
  })

  it('writes only the selected message pair with synchronous provenance', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({
      contractVersion: 'phase-39.http-memory.v1',
      idempotency: { handledBy: 'consumer_provenance_only', key: 'turn-1' },
      mode: 'sync',
      ok: true,
      operation: 'remember',
      result: { accepted: 1, rejected: 0, events: [] },
    }))
    const client = new GoodMemoryHttpClient({
      baseUrl: 'http://memory.test', fetch, timeoutMs: 100, token: 'secret-token',
    })
    const messages: RememberMessage[] = [
      { content: 'Use pnpm.', id: 'user-1', observedAt: '2026-08-15T00:00:00.000Z', role: 'user' },
      { content: 'I will.', id: 'assistant-1', observedAt: '2026-08-15T00:00:01.000Z', role: 'assistant' },
    ]

    await client.remember({ idempotencyKey: 'turn-1', messages, scope })

    const [, init] = fetch.mock.calls[0] ?? []
    const headers = new Headers(init?.headers)
    expect(headers.get('x-goodmemory-operations')).toBe('remember')
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body).toEqual({ idempotencyKey: 'turn-1', messages, mode: 'sync', scope })
    expect(body).not.toHaveProperty('annotations')
    expect(body).not.toHaveProperty('extractionStrategy')
  })

  it('fails closed on contract mismatch without exposing the token', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({
      contractVersion: 'future-contract',
      ok: true,
      status: 'ok',
    }))
    const client = new GoodMemoryHttpClient({
      baseUrl: 'http://memory.test', fetch, timeoutMs: 100, token: 'do-not-log-this',
    })

    const error = await client.health().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('contract mismatch')
    expect(String(error)).not.toContain('do-not-log-this')
  })

  it('surfaces the bridge error code but not its raw response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({
      error: { code: 'scope_not_authorized', message: 'Caller scope mismatch.' },
      ok: false,
    }, 403))
    const client = new GoodMemoryHttpClient({
      baseUrl: 'http://memory.test', fetch, timeoutMs: 100, token: 'secret-token',
    })

    await expect(client.recall({ maxTokens: 32, query: 'hello', scope })).rejects.toThrow(
      /scope_not_authorized/,
    )
  })
})
