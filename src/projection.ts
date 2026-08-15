import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import type { GoodMemoryRecallSource, RememberMessage } from './types.ts'

export interface RecallQuery {
  messageIds: string[]
  text: string
}

export interface RecallContext {
  contextText: string
  estimatedTokens: number
  itemCount: number
  traceId?: string
}

export interface CompletedTurnProjection {
  messages: RememberMessage[]
}

function textFromBlocks(blocks: readonly ContentBlock[]): string | undefined {
  const text = blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
  return text.length === 0 ? undefined : text
}

/** Select only human-authored text from the final pre-step batch. */
export function buildRecallQuery(messages: readonly UserMessage[]): RecallQuery | undefined {
  const direct = messages.flatMap((message) => {
    if (message.source.kind !== 'user') return []
    const text = textFromBlocks(message.content)
    return text === undefined ? [] : [{ id: message.id, text }]
  })
  if (direct.length === 0) return undefined

  return {
    messageIds: direct.map(message => message.id),
    text: direct.map(message => message.text).join('\n\n'),
  }
}

/** Insert one logged GoodMemory recall message immediately before the direct prompt. */
export function injectRecallContext(
  messages: readonly UserMessage[],
  queryMessageIds: readonly string[],
  context: RecallContext,
): UserMessage[] {
  const source: GoodMemoryRecallSource = {
    estimatedTokens: context.estimatedTokens,
    form: 'recall',
    itemCount: context.itemCount,
    kind: 'goodmemory',
    queryMessageIds: [...queryMessageIds],
    ...(context.traceId === undefined ? {} : { traceId: context.traceId }),
    version: 1,
  }
  const recalled = createUserMessage({
    content: [{ text: context.contextText, type: 'text' }],
    source,
  })
  const directIndex = messages.findIndex(message => message.source.kind === 'user')
  if (directIndex < 0) return [...messages]

  return [
    ...messages.slice(0, directIndex),
    recalled,
    ...messages.slice(directIndex),
  ]
}

function currentTurnSlice(events: readonly SessionEvent[], turn: number): readonly SessionEvent[] | undefined {
  const endIndex = events.findLastIndex(event =>
    event.type === 'turn/end' && event.data.turn === turn,
  )
  if (endIndex < 0) return undefined
  const end = events[endIndex]
  if (end?.type !== 'turn/end' || end.data.reason.kind !== 'completed') return undefined

  let startIndex = endIndex - 1
  while (startIndex >= 0) {
    const event = events[startIndex]
    if (event?.type === 'turn/start' && event.data.turn === turn) break
    startIndex -= 1
  }
  if (startIndex < 0) return undefined
  return events.slice(startIndex + 1, endIndex)
}

/** Project the completed human/assistant exchange accepted by GoodMemory. */
export function projectCompletedTurn(
  events: readonly SessionEvent[],
  turn: number,
): CompletedTurnProjection | undefined {
  const slice = currentTurnSlice(events, turn)
  if (slice === undefined) return undefined

  const messages: RememberMessage[] = []
  for (const event of slice) {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const content = textFromBlocks(event.data.content)
    if (content === undefined) continue
    messages.push({
      content,
      id: event.data.id,
      observedAt: new Date(event.time).toISOString(),
      role: 'user',
    })
  }
  if (messages.length === 0) return undefined

  let finalAssistant: { content: string; id: string; time: number } | undefined
  for (let index = slice.length - 1; index >= 0; index -= 1) {
    const event = slice[index]
    if (event?.type !== 'assistant/message') continue
    const content = textFromBlocks(event.data.message.content)
    if (content === undefined) continue
    finalAssistant = { content, id: event.data.message.id, time: event.time }
    break
  }
  if (finalAssistant === undefined) return undefined
  messages.push({
    content: finalAssistant.content,
    id: finalAssistant.id,
    observedAt: new Date(finalAssistant.time).toISOString(),
    role: 'assistant',
  })

  return { messages }
}
