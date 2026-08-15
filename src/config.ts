import { isAbsolute } from 'node:path'

import z from '@deepseek-ai/schemastery'

import type {
  Config as ConfigShape,
  ExternalConfig,
  ManagedConfig,
  ScopeConfig,
} from './types.ts'

const DEFAULT_MAX_RECALL_TOKENS = 256
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_TOKEN_ENV = 'GOODMEMORY_HTTP_BRIDGE_TOKEN'
const MAX_TIMEOUT_MS = 2_147_483_647

const Scope = (z.object({
  agentId: z.union([z.string(), z.const(null)]),
  userId: z.string(),
  workspaceId: z.union([z.string(), z.const(null)]),
}) as unknown as z<ScopeConfig>).default({})

const commonFields = {
  maxRecallTokens: z.number().step(1).min(1).default(DEFAULT_MAX_RECALL_TOKENS),
  recall: z.boolean().default(true),
  requestTimeoutMs: z.number().step(1).min(1).max(MAX_TIMEOUT_MS).default(DEFAULT_REQUEST_TIMEOUT_MS),
  scope: Scope,
  writeback: z.boolean().default(true),
}

/** Cordis configuration schema. */
export type Config = ConfigShape

export const Config = z.union([
  z.object({
    ...commonFields,
    baseUrl: z.never(),
    databasePath: z.string(),
    mode: z.const('managed').default('managed'),
    startupTimeoutMs: z.number().step(1).min(1).max(MAX_TIMEOUT_MS).default(DEFAULT_STARTUP_TIMEOUT_MS),
    tokenEnv: z.never(),
  }),
  z.object({
    ...commonFields,
    baseUrl: z.string().required(),
    databasePath: z.never(),
    mode: z.const('external'),
    startupTimeoutMs: z.never(),
    tokenEnv: z.string().default(DEFAULT_TOKEN_ENV),
  }),
]) as unknown as z<ConfigShape>

interface ResolvedCommonConfig {
  recall: boolean
  writeback: boolean
  maxRecallTokens: number
  requestTimeoutMs: number
  scope: ScopeConfig
}

export type ResolvedConfig = ResolvedCommonConfig & (
  | {
      mode: 'managed'
      databasePath?: string
      startupTimeoutMs: number
    }
  | {
      mode: 'external'
      baseUrl: string
      tokenEnv: string
    }
)

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`dsh-goodmemory: ${field} must be a positive integer`)
  }
}

function resolveCommon(config: ConfigShape): ResolvedCommonConfig {
  const recall = config.recall ?? true
  const writeback = config.writeback ?? true
  const maxRecallTokens = config.maxRecallTokens ?? DEFAULT_MAX_RECALL_TOKENS
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

  assertPositiveInteger(maxRecallTokens, 'maxRecallTokens')
  assertPositiveInteger(requestTimeoutMs, 'requestTimeoutMs')

  return {
    maxRecallTokens,
    recall,
    requestTimeoutMs,
    scope: config.scope ?? {},
    writeback,
  }
}

function resolveExternal(config: ExternalConfig): ResolvedConfig {
  let url: URL
  try {
    url = new URL(config.baseUrl)
  } catch {
    throw new Error('dsh-goodmemory: external baseUrl must be a valid http or https URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('dsh-goodmemory: external baseUrl must be a valid http or https URL')
  }
  const tokenEnv = config.tokenEnv?.trim() || DEFAULT_TOKEN_ENV

  return {
    ...resolveCommon(config),
    baseUrl: config.baseUrl.replace(/\/+$/, ''),
    mode: 'external',
    tokenEnv,
  }
}

function resolveManaged(config: ManagedConfig): ResolvedConfig {
  const startupTimeoutMs = config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
  assertPositiveInteger(startupTimeoutMs, 'startupTimeoutMs')
  if (config.databasePath !== undefined && !isAbsolute(config.databasePath)) {
    throw new Error('dsh-goodmemory: managed databasePath must be absolute')
  }

  return {
    ...resolveCommon(config),
    ...(config.databasePath === undefined ? {} : { databasePath: config.databasePath }),
    mode: 'managed',
    startupTimeoutMs,
  }
}

/** Resolve defaults and preserve validation for direct programmatic use. */
export function resolveConfig(input: ConfigShape = {}): ResolvedConfig {
  return input.mode === 'external'
    ? resolveExternal(input)
    : resolveManaged(input)
}
