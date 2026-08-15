import { describe, expect, it } from 'vitest'

import { Config, resolveConfig } from '../src/config.ts'

describe('Config', () => {
  it('fills the managed defaults', () => {
    expect(new Config({})).toEqual({
      maxRecallTokens: 256,
      mode: 'managed',
      recall: true,
      requestTimeoutMs: 10_000,
      scope: {},
      startupTimeoutMs: 15_000,
      writeback: true,
    })
  })

  it('requires an external base URL and defaults the token environment name', () => {
    expect(new Config({
      baseUrl: 'http://127.0.0.1:8739',
      mode: 'external',
    })).toMatchObject({
      baseUrl: 'http://127.0.0.1:8739',
      mode: 'external',
      tokenEnv: 'GOODMEMORY_HTTP_BRIDGE_TOKEN',
    })

    expect(() => new Config({ mode: 'external' } as never)).toThrow()
  })

  it('rejects mode-specific fields on the other mode', () => {
    expect(() => new Config({
      baseUrl: 'http://127.0.0.1:8739',
      mode: 'managed',
    } as never)).toThrow()
    expect(() => new Config({
      databasePath: '/tmp/memory.sqlite',
      mode: 'external',
      baseUrl: 'http://127.0.0.1:8739',
    } as never)).toThrow()
  })

  it('rejects invalid runtime values even when direct construction bypasses the schema', () => {
    expect(() => resolveConfig({ mode: 'external', baseUrl: 'ftp://memory.test' })).toThrow(
      /http or https/,
    )
    expect(() => resolveConfig({ mode: 'managed', databasePath: 'relative.sqlite' })).toThrow(
      /absolute/,
    )
    expect(() => resolveConfig({ maxRecallTokens: 0 })).toThrow(/maxRecallTokens/)
  })
})
