import { describe, expect, it } from 'vitest'
import {
  createAssistantMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

import {
  buildRecallQuery,
  injectRecallContext,
  projectCompletedTurn,
} from '../src/projection.ts'

describe('recall projection', () => {
  it('queries only direct user text and inserts recalled context before the first direct prompt', () => {
    const plugin = createUserMessage({
      content: [{ type: 'text', text: 'workspace instructions' }],
      source: { kind: 'plugin', plugin: 'instructions' },
    })
    const direct = createUserMessage({
      content: [
        { type: 'text', text: 'first question' },
        { type: 'reasoning', text: 'private reasoning' },
      ],
      source: { kind: 'user' },
    })

    const query = buildRecallQuery([plugin, direct])
    expect(query).toEqual({ messageIds: [direct.id], text: 'first question' })
    if (query === undefined) throw new Error('expected a recall query')

    const result = injectRecallContext([plugin, direct], query.messageIds, {
      contextText: '## Relevant memory\n- prefers pnpm',
      estimatedTokens: 12,
      itemCount: 1,
      traceId: 'trace-1',
    })
    expect(result.map(message => message.source.kind)).toEqual(['plugin', 'goodmemory', 'user'])
    expect(result[1]?.source).toMatchObject({
      form: 'recall',
      itemCount: 1,
      kind: 'goodmemory',
      queryMessageIds: [direct.id],
      version: 1,
    })
  })

  it('returns no query for a pure tool or plugin continuation', () => {
    const plugin = createUserMessage({
      content: [{ type: 'text', text: 'tool continuation' }],
      source: { kind: 'plugin', plugin: 'tool-context' },
    })
    expect(buildRecallQuery([plugin])).toBeUndefined()
  })
})

describe('completed-turn writeback projection', () => {
  it('keeps direct user text and only the final assistant text', () => {
    const session = Session.create(SessionId('session-a'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Use pnpm in this repository.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'recalled private context' }],
      source: {
        kind: 'goodmemory', form: 'recall', version: 1,
        queryMessageIds: [], itemCount: 1, estimatedTokens: 4,
      },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'hidden chain' },
          { type: 'text', text: 'intermediate text' },
        ],
        source: { provider: 'mock', model: 'mock' },
      }),
      step: 1,
      turn: 1,
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'I will use pnpm.' }],
        source: { provider: 'mock', model: 'mock' },
      }),
      step: 2,
      turn: 1,
    }, { surfaceOp: 'append' })
    session.append('turn/end', { reason: { kind: 'completed' }, turn: 1 })

    const projection = projectCompletedTurn(session.events, 1)
    expect(projection?.messages.map(message => ({ content: message.content, role: message.role }))).toEqual([
      { content: 'Use pnpm in this repository.', role: 'user' },
      { content: 'I will use pnpm.', role: 'assistant' },
    ])
  })

  it('skips turns without a final assistant text', () => {
    const session = Session.create(SessionId('session-a'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Run the tool.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      message: createAssistantMessage({
        content: [{ type: 'reasoning', text: 'no visible answer' }],
        source: { provider: 'mock', model: 'mock' },
      }),
      step: 1,
      turn: 1,
    }, { surfaceOp: 'append' })
    session.append('turn/end', { reason: { kind: 'completed' }, turn: 1 })

    expect(projectCompletedTurn(session.events, 1)).toBeUndefined()
  })

  it('uses the last non-empty assistant text when a later assistant record has no visible text', () => {
    const session = Session.create(SessionId('session-a'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Keep the visible answer.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'This is the final visible answer.' }],
        source: { provider: 'mock', model: 'mock' },
      }),
      step: 1,
      turn: 1,
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      message: createAssistantMessage({
        content: [{ type: 'reasoning', text: 'usage host without visible text' }],
        source: { provider: 'mock', model: 'mock' },
      }),
      step: 1,
      turn: 1,
    }, { surfaceOp: 'append' })
    session.append('turn/end', { reason: { kind: 'completed' }, turn: 1 })

    expect(projectCompletedTurn(session.events, 1)?.messages.at(-1)?.content).toBe(
      'This is the final visible answer.',
    )
  })
})
