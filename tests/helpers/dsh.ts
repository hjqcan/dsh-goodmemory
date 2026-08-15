import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  CallId,
  createUserMessage,
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

export function textResponse(text: string, finish: 'stop' | 'max-tokens' = 'stop'): StreamChunk[] {
  return [
    { blockType: 'text', index: 0, type: 'block-start' },
    { index: 0, text, type: 'text-delta' },
    { block: { text, type: 'text' }, index: 0, type: 'block-end' },
    { reason: { kind: finish }, type: 'finish' },
  ]
}

export function toolResponse(name: string): StreamChunk[] {
  const callId = CallId('call-1')
  return [
    { blockType: 'tool-call', index: 0, type: 'block-start' },
    {
      argumentsDelta: '{"value":"tool payload"}',
      id: callId,
      index: 0,
      name,
      type: 'tool-call-delta',
    },
    {
      block: {
        arguments: '{"value":"tool payload"}',
        id: callId,
        name,
        type: 'tool-call',
      },
      index: 0,
      type: 'block-end',
    },
    { reason: { kind: 'tool-calls' }, type: 'finish' },
  ]
}

export class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly responses: StreamChunk[][]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ id: model, name: model, provider })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('ScriptedAdapter response exhausted')
    for (const chunk of response) yield chunk
  }
}

export async function createHarness(adapter: ScriptedAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

export function createAgent(ctx: Context, id: string, cwd = '/tmp/dsh-goodmemory-project'): Agent {
  return ctx.agentLoop.create(SessionId(id), {
    model: 'mock',
    provider: 'mock',
  }, { cwd })
}

export function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({
    content: [{ text, type: 'text' }],
    source: { kind: 'user' },
  }))
}
