export interface ScopeConfig {
  userId?: string
  workspaceId?: string | null
  agentId?: string | null
}

export interface CommonConfig {
  recall?: boolean
  writeback?: boolean
  maxRecallTokens?: number
  requestTimeoutMs?: number
  scope?: ScopeConfig
}

export interface ManagedConfig extends CommonConfig {
  mode?: 'managed'
  databasePath?: string
  startupTimeoutMs?: number
}

export interface ExternalConfig extends CommonConfig {
  mode: 'external'
  baseUrl: string
  tokenEnv?: string
}

export type Config = ManagedConfig | ExternalConfig

export interface GoodMemoryRecallSource {
  readonly kind: 'goodmemory'
  readonly form: 'recall'
  readonly version: 1
  readonly queryMessageIds: readonly string[]
  readonly itemCount: number
  readonly estimatedTokens: number
  readonly traceId?: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    goodmemory: GoodMemoryRecallSource
  }
}

export interface MemoryScope {
  userId: string
  workspaceId?: string
  agentId?: string
  sessionId: string
}

export interface RememberMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  observedAt: string
}
