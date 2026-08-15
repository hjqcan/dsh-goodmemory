import type { RecallContext } from './projection.ts'
import type { MemoryScope, RememberMessage } from './types.ts'

export const GOODMEMORY_HTTP_CONTRACT_VERSION = 'phase-39.http-memory.v1'

type MemoryOperation = 'recall-context' | 'remember'

interface ClientOptions {
  baseUrl: string
  token: string
  timeoutMs: number
  fetch?: typeof globalThis.fetch
}

interface RecallInput {
  maxTokens: number
  query: string
  scope: MemoryScope
  signal?: AbortSignal
}

interface RememberInput {
  idempotencyKey: string
  messages: RememberMessage[]
  scope: MemoryScope
  signal?: AbortSignal
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function contractVersion(body: Record<string, unknown>): string | undefined {
  return typeof body.contractVersion === 'string' ? body.contractVersion : undefined
}

function assertContract(body: Record<string, unknown>): void {
  const actual = contractVersion(body)
  if (actual !== GOODMEMORY_HTTP_CONTRACT_VERSION) {
    throw new Error(
      `dsh-goodmemory: GoodMemory HTTP contract mismatch; expected ${GOODMEMORY_HTTP_CONTRACT_VERSION}, received ${actual ?? 'missing'}`,
    )
  }
}

/** Minimal client for the two GoodMemory operations owned by this plugin. */
export class GoodMemoryHttpClient {
  readonly baseUrl: string

  private readonly fetch: typeof globalThis.fetch
  private readonly timeoutMs: number
  private readonly token: string

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.fetch = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs
    this.token = options.token
  }

  async health(signal?: AbortSignal): Promise<void> {
    const body = await this.request('/healthz', { method: 'GET' }, signal)
    assertContract(body)
    if (body.ok !== true || body.status !== 'ok') {
      throw new Error('dsh-goodmemory: GoodMemory health response is malformed')
    }
  }

  async recall(input: RecallInput): Promise<RecallContext | undefined> {
    const body = await this.operation('recall-context', {
      maxTokens: input.maxTokens,
      output: 'system_prompt_fragment',
      query: input.query,
      referenceTime: new Date().toISOString(),
      retrievalProfile: 'coding_agent',
      scope: input.scope,
      strategy: 'auto',
    }, input.scope, input.signal)
    assertContract(body)

    if (body.ok !== true || body.operation !== 'recall-context' || typeof body.hasContext !== 'boolean') {
      throw new Error('dsh-goodmemory: GoodMemory recall response is malformed')
    }
    if (body.hasContext === false) return undefined
    if (
      typeof body.contextText !== 'string'
      || body.contextText.trim().length === 0
      || !Number.isSafeInteger(body.itemCount)
      || typeof body.itemCount !== 'number'
      || !isRecord(body.context)
      || !Number.isSafeInteger(body.context.estimatedTokens)
      || typeof body.context.estimatedTokens !== 'number'
    ) {
      throw new Error('dsh-goodmemory: GoodMemory recall context is malformed')
    }

    return {
      contextText: body.contextText,
      estimatedTokens: body.context.estimatedTokens,
      itemCount: body.itemCount,
      ...(typeof body.traceId === 'string' ? { traceId: body.traceId } : {}),
    }
  }

  async remember(input: RememberInput): Promise<void> {
    const body = await this.operation('remember', {
      idempotencyKey: input.idempotencyKey,
      messages: input.messages,
      mode: 'sync',
      scope: input.scope,
    }, input.scope, input.signal)
    assertContract(body)
    if (body.ok !== true || body.operation !== 'remember' || body.mode !== 'sync') {
      throw new Error('dsh-goodmemory: GoodMemory remember response is malformed')
    }
  }

  private async operation(
    operation: MemoryOperation,
    body: Record<string, unknown>,
    scope: MemoryScope,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const headers = new Headers({
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
      'x-goodmemory-operations': operation,
      'x-goodmemory-user-id': scope.userId,
    })
    if (scope.workspaceId !== undefined) {
      headers.set('x-goodmemory-workspace-id', scope.workspaceId)
    }

    return this.request(`/memory/${operation}`, {
      body: JSON.stringify(body),
      headers,
      method: 'POST',
    }, signal)
  }

  private async request(
    path: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const requestSignal = signal === undefined
      ? timeout
      : AbortSignal.any([signal, timeout])
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: requestSignal,
    })

    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new Error(`dsh-goodmemory: GoodMemory returned non-JSON HTTP ${response.status}`)
    }
    if (!isRecord(body)) {
      throw new Error(`dsh-goodmemory: GoodMemory returned malformed HTTP ${response.status}`)
    }
    if (!response.ok) {
      const error = isRecord(body.error) ? body.error : undefined
      const code = typeof error?.code === 'string' ? ` ${error.code}` : ''
      throw new Error(`dsh-goodmemory: GoodMemory request failed with HTTP ${response.status}${code}`)
    }
    return body
  }
}
