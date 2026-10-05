import * as GoodMemoryPlugin from '../../src/index.ts'
import { createAgent, createHarness, ScriptedAdapter, send, textResponse } from './dsh.ts'

// Run by Node, outside the Vitest process, to prove a full host/sidecar restart.
interface WorkerInput {
  cwd: string
  databasePath: string
  messages: string[]
  sessionId: string
}

const input = JSON.parse(process.argv[2] ?? '') as WorkerInput
const adapter = new ScriptedAdapter(input.messages.map(() => textResponse('Acknowledged.')))
const ctx = await createHarness(adapter)
const diagnostics: Record<string, unknown>[] = []
ctx.logger.exporter({
  levels: { default: 3 },
  export(message) {
    const text: unknown = message.args[0]
    if (typeof text !== 'string' || !text.startsWith('{')) return
    const entry = JSON.parse(text) as Record<string, unknown>
    if (entry.component === 'dsh-goodmemory') diagnostics.push(entry)
  },
})
try {
  await ctx.plugin(GoodMemoryPlugin, {
    databasePath: input.databasePath,
    mode: 'managed',
    scope: { userId: 'restart-decision-user' },
    startupTimeoutMs: 15_000,
  })
  const agent = createAgent(ctx, input.sessionId, input.cwd)
  for (const message of input.messages) {
    send(agent, message)
    await agent.whenIdle()
    await ctx.sessions.flush(agent.session)
  }
  const recallText = (messages: typeof adapter.requests[number]['messages']) => messages
    .filter(message => message.source.kind === 'goodmemory')
    .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
  const output = {
    diagnostics,
    pid: process.pid,
    completedTurns: agent.session.events.filter(event =>
      event.type === 'turn/end' && event.data.reason.kind === 'completed'
    ).length,
    requests: adapter.requests.map(request => recallText(request.messages)),
    loggedRecall: agent.session.events.flatMap(event =>
      event.type === 'user/message' ? recallText([event.data]) : []
    ),
  }
  console.log(`DSH_RESTART_RESULT=${JSON.stringify(output)}`)
} finally {
  await ctx.fiber.dispose()
}
