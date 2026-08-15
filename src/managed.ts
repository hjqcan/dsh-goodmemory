import { randomBytes } from 'node:crypto'
import { chmod, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

import {
  GOODMEMORY_HTTP_CONTRACT_VERSION,
  GoodMemoryHttpClient,
} from './client.ts'

const SHUTDOWN_TIMEOUT_MS = 5_000

interface ManagedOptions {
  databasePath?: string
  requestTimeoutMs: number
  startupTimeoutMs: number
}

export interface ManagedBridge {
  client: GoodMemoryHttpClient
  processId: number
  dispose(): Promise<void>
}

interface ReadyLine {
  contractVersion: string
  event: 'ready'
  url: string
}

function parseReadyLine(line: string): ReadyLine | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (
    value === null
    || typeof value !== 'object'
    || !('event' in value)
    || value.event !== 'ready'
    || !('url' in value)
    || typeof value.url !== 'string'
    || !('contractVersion' in value)
    || typeof value.contractVersion !== 'string'
  ) return undefined
  return value as ReadyLine
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()))
  child.kill('SIGTERM')
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>(resolveTimeout => setTimeout(() => resolveTimeout(false), SHUTDOWN_TIMEOUT_MS)),
  ])
  if (graceful) return
  child.kill('SIGKILL')
  await exited
}

function safeLine(line: string, token: string): string {
  return line.replaceAll(token, '[redacted]')
}

/** Start the published GoodMemory launcher and wait for its exact ready/health boundary. */
export async function startManagedBridge(
  logger: Context['logger'],
  options: ManagedOptions,
): Promise<ManagedBridge> {
  const databasePath = options.databasePath ?? dshHomePath('goodmemory', 'memory.sqlite')
  const storageDirectory = dirname(databasePath)
  await mkdir(storageDirectory, { mode: 0o700, recursive: true })
  if (options.databasePath === undefined) await chmod(storageDirectory, 0o700)

  const require = createRequire(import.meta.url)
  const packagePath = require.resolve('goodmemory/package.json')
  const launcher = resolve(dirname(packagePath), 'scripts/goodmemory-http-bridge.js')
  const token = randomBytes(32).toString('base64url')
  const child = spawn(process.execPath, [
    launcher,
    '--host', '127.0.0.1',
    '--port', '0',
    '--recommended',
  ], {
    env: {
      ...process.env,
      GOODMEMORY_HTTP_BRIDGE_TOKEN: token,
      GOODMEMORY_STORAGE_PROVIDER: 'sqlite',
      GOODMEMORY_STORAGE_URL: databasePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const stdout = createInterface({ input: child.stdout })
  const stderr = createInterface({ input: child.stderr })
  let ready = false
  let stopping = false
  let readyLine: ReadyLine

  const readiness = new Promise<ReadyLine>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      rejectReady(new Error(`dsh-goodmemory: managed bridge did not become ready within ${options.startupTimeoutMs}ms`))
    }, options.startupTimeoutMs)

    stdout.on('line', (line) => {
      if (!ready) {
        const parsed = parseReadyLine(line)
        if (parsed !== undefined) {
          ready = true
          clearTimeout(timer)
          resolveReady(parsed)
          return
        }
      }
      logger.info(`dsh-goodmemory bridge stdout: ${safeLine(line, token)}`)
    })
    stderr.on('line', line => {
      logger.warn(`dsh-goodmemory bridge stderr: ${safeLine(line, token)}`)
    })
    child.once('error', (error) => {
      if (!ready) {
        clearTimeout(timer)
        rejectReady(new Error(`dsh-goodmemory: failed to start managed bridge: ${error.message}`))
      }
    })
    child.on('exit', (code, signal) => {
      if (!ready) {
        clearTimeout(timer)
        rejectReady(new Error(
          `dsh-goodmemory: managed bridge exited before ready (code=${code ?? 'none'}, signal=${signal ?? 'none'})`,
        ))
      } else if (!stopping) {
        logger.error(`dsh-goodmemory managed bridge exited unexpectedly (code=${code ?? 'none'}, signal=${signal ?? 'none'})`)
      }
    })
  })

  try {
    readyLine = await readiness
    if (readyLine.contractVersion !== GOODMEMORY_HTTP_CONTRACT_VERSION) {
      throw new Error(
        `dsh-goodmemory: managed bridge contract mismatch; expected ${GOODMEMORY_HTTP_CONTRACT_VERSION}, received ${readyLine.contractVersion}`,
      )
    }
    const client = new GoodMemoryHttpClient({
      baseUrl: readyLine.url,
      timeoutMs: options.requestTimeoutMs,
      token,
    })
    await client.health()

    return {
      client,
      processId: child.pid ?? -1,
      async dispose() {
        stopping = true
        stdout.close()
        stderr.close()
        await stopChild(child)
      },
    }
  } catch (error) {
    stopping = true
    stdout.close()
    stderr.close()
    await stopChild(child)
    throw error
  }
}
