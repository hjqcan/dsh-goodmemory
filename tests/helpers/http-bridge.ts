import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

interface BridgeState {
  callOrder: string[]
  failRecall: boolean
  recallCount: number
  rememberBodies: Record<string, unknown>[]
  remembered: boolean
  rememberDelayMs: number
}

export interface TestBridge {
  baseUrl: string
  close(): Promise<void>
  state: BridgeState
}

async function readJson(request: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function sendJson(response: import('node:http').ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

export async function createTestBridge(options: {
  contractVersion?: string
  rememberDelayMs?: number
  token?: string
} = {}): Promise<TestBridge> {
  const contractVersion = options.contractVersion ?? 'phase-39.http-memory.v1'
  const token = options.token ?? 'test-token'
  const state: BridgeState = {
    callOrder: [],
    failRecall: false,
    recallCount: 0,
    rememberBodies: [],
    remembered: false,
    rememberDelayMs: options.rememberDelayMs ?? 0,
  }
  const server = createServer(async (request, response) => {
    if (request.url === '/healthz') {
      sendJson(response, {
        contractVersion,
        ok: true,
        status: 'ok',
      })
      return
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, { error: { code: 'caller_required', message: 'unauthorized' }, ok: false }, 401)
      return
    }
    if (request.url === '/memory/recall-context') {
      state.callOrder.push('recall')
      state.recallCount += 1
      if (state.failRecall) {
        sendJson(response, { error: { code: 'unavailable', message: 'offline' }, ok: false }, 503)
        return
      }
      const contextText = state.remembered ? '## Relevant memory\n- Use pnpm in this repository.' : ''
      sendJson(response, {
        context: {
          content: contextText,
          estimatedTokens: state.remembered ? 10 : 0,
          omittedSections: [],
          output: 'system_prompt_fragment',
        },
        contextText,
        contractVersion,
        hasContext: state.remembered,
        itemCount: state.remembered ? 1 : 0,
        items: [],
        ok: true,
        operation: 'recall-context',
        routing: {},
      })
      return
    }
    if (request.url === '/memory/remember') {
      state.callOrder.push('remember')
      state.rememberBodies.push(await readJson(request))
      if (state.rememberDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, state.rememberDelayMs))
      }
      state.remembered = true
      sendJson(response, {
        contractVersion,
        mode: 'sync',
        ok: true,
        operation: 'remember',
        result: { accepted: 1, events: [], rejected: 0 },
      })
      return
    }
    sendJson(response, { error: { code: 'not_found', message: 'not found' }, ok: false }, 404)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error === undefined ? resolve() : reject(error))
    }),
    state,
  }
}
