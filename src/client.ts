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

type ExtractionStrategy = 'auto' | 'rules-only' | 'llm-assisted'

export interface RememberReceipt {
  accepted: number
  rejected: number
  outcome: 'committed' | 'no_admissible_candidate' | 'failed' | 'unknown'
  rejectionReasons: string[]
  warningCount: number
  requestedExtractionStrategy?: ExtractionStrategy
  resolvedExtractionStrategy?: ExtractionStrategy
}

const REJECTION_REASONS = new Set([
  'assistant_policy_blocked', 'below_threshold', 'explicit_opt_out',
  'invalid_after_redaction', 'invalid_payload', 'noise', 'note_too_large',
  'policy_blocked', 'storage_unsafe', 'unattributed_personal_claim', 'unsupported_kind',
])

function extractionStrategy(value: unknown): ExtractionStrategy | undefined {
  return value === 'auto' || value === 'rules-only' || value === 'llm-assisted' ? value : undefined
}

function rememberReceipt(value: unknown): RememberReceipt {
  if (
    !isRecord(value)
    || typeof value.accepted !== 'number'
    || !Number.isSafeInteger(value.accepted)
    || value.accepted < 0
    || typeof value.rejected !== 'number'
    || !Number.isSafeInteger(value.rejected)
    || value.rejected < 0
    || !Array.isArray(value.events)
    || !value.events.every(isRecord)
  ) {
    throw new Error('dsh-goodmemory: GoodMemory remember result is malformed')
  }
  const metadata = isRecord(value.metadata) ? value.metadata : {}
  const requested = extractionStrategy(metadata.requestedExtractionStrategy)
  const resolved = extractionStrategy(metadata.resolvedExtractionStrategy)
  return {
    accepted: value.accepted,
    rejected: value.rejected,
    outcome: value.outcome === 'committed' || value.outcome === 'no_admissible_candidate' || value.outcome === 'failed'
      ? value.outcome : 'unknown',
    // Only known codes enter logs; never forward free-form bridge data or content.
    rejectionReasons: [...new Set(value.events
      .filter(event => event.outcome === 'rejected')
      .map(event => typeof event.reason === 'string' && REJECTION_REASONS.has(event.reason) ? event.reason : 'other'))],
    warningCount: Array.isArray(value.warnings) ? value.warnings.length : 0,
    ...(requested === undefined ? {} : { requestedExtractionStrategy: requested }),
    ...(resolved === undefined ? {} : { resolvedExtractionStrategy: resolved }),
  }
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

  async remember(input: RememberInput): Promise<RememberReceipt> {
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
    return rememberReceipt(body.result)
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
