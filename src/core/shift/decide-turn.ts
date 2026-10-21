import { conversationKey, windowConversationKey, type ConversationKind } from '../memory/conversation-key'
import type { ConversationIdentity } from '../memory/conversation-key'
import {
  formatHistory,
  mergeVisible,
  normalizeBubbleText,
  selectHistory,
  type StoredTurn,
  type VisibleBubble
} from '../memory/transcript-merge'
import { matchMaterial, type AgentProfile } from './agents'
import { blacklisted, evaluateGate, hitKeyword, repliesLooped } from './gates'
import { formatKnowledge, isPureAck, needsKnowledge, searchChunks, type KnowledgeChunk } from '../knowledge/search'

export interface ObservedScreen {
  boxSelect: boolean
  appType: string
  identity: ConversationIdentity | null
  bubbles: VisibleBubble[]
  mentionedMe: boolean | null
}

export type TurnAction =
  | { type: 'legacy' }
  | {
      type: 'skip'
      reason: string
      key?: string
      title?: string
      kind?: ConversationKind
      added: VisibleBubble[]
      /** 看屏失败时不要把当前画面当成已处理。 */
      retry?: boolean
    }
  | {
      type: 'review'
      reason: string
      key: string
      title: string
      kind: ConversationKind
    }
  | {
      type: 'handoff'
      key: string
      title: string
      kind: ConversationKind
      reason: string
      added: VisibleBubble[]
      /** 记录对不齐时，这些对方原句已经处理过，恢复后不要再通知一次。 */
      anchor?: string[]
    }
  | {
      type: 'fixed'
      key: string
      title: string
      kind: ConversationKind
      text: string
      imagePath: string
      added: VisibleBubble[]
    }
  | {
      type: 'reply'
      key: string
      title: string
      kind: ConversationKind
      historyText: string
      knowledgeText: string
      knowledgeTitles: string[]
      incoming: string
      added: VisibleBubble[]
    }

export function decideTurn(input: {
  screen: ObservedScreen
  stored: StoredTurn[]
  coldKeys: string[]
  handedOff: boolean
  agent: AgentProfile
  sentThisHour: number
  now: Date
  recentOut: string[]
  badCount: number
  knowledge: KnowledgeChunk[]
  /** 上次因记录对不齐而转人工时，屏幕上已经见过的对方原句。 */
  handledInbound?: string[]
}): TurnAction {
  const bound = bindIdentity(input.screen)
  if (!bound) {
    return { type: 'skip', reason: '没确认对方是谁', added: [] }
  }

  const merge = mergeVisible(input.stored, input.screen.bubbles)
  const added = merge.status === 'append' || merge.status === 'aligned' ? merge.added : []
  const cold = input.coldKeys.includes(bound.key)

  // 记录对不齐时不覆盖记忆，但冷处理、已转人工、黑名单和还没处理过的转人工词仍要生效。
  if (cold) {
    return {
      type: 'skip',
      reason: '冷处理',
      key: bound.key,
      title: bound.title,
      kind: bound.kind,
      added
    }
  }
  if (input.handedOff) {
    return {
      type: 'skip',
      reason: '已转人工',
      key: bound.key,
      title: bound.title,
      kind: bound.kind,
      added
    }
  }
  if (blacklisted(bound.title, bound.kind, input.agent.blacklist)) {
    return {
      type: 'skip',
      reason: '黑名单',
      key: bound.key,
      title: bound.title,
      kind: bound.kind,
      added
    }
  }
  if (merge.status === 'reject') {
    const visibleIn = inboundTexts(input.screen.bubbles)
    const handled = new Set(input.handledInbound ?? [])
    const unseen = visibleIn.filter((text) => !handled.has(text))
    const keyword = firstKeyword(unseen, input.agent.handoffKeywords)
    if (keyword) {
      return {
        type: 'handoff',
        key: bound.key,
        title: bound.title,
        kind: bound.kind,
        reason: `提到「${keyword}」`,
        added: [],
        anchor: visibleIn
      }
    }
    return {
      type: 'review',
      reason: '这条会话的记录对不齐，先不自动写记忆',
      key: bound.key,
      title: bound.title,
      kind: bound.kind
    }
  }

  const freshIn = inboundTexts(added)
  const keyword = firstKeyword(freshIn, input.agent.handoffKeywords)
  if (keyword) {
    return {
      type: 'handoff',
      key: bound.key,
      title: bound.title,
      kind: bound.kind,
      reason: `提到「${keyword}」`,
      added
    }
  }

  const gate = evaluateGate({
    title: bound.title,
    kind: bound.kind,
    cold,
    handedOff: input.handedOff,
    mentionedMe: input.screen.mentionedMe,
    config: {
      blacklist: input.agent.blacklist,
      whitelistEnabled: input.agent.whitelistEnabled,
      whitelist: input.agent.whitelist,
      groupReply: input.agent.groupReply,
      workHoursEnabled: input.agent.workHoursEnabled,
      workStart: input.agent.workStart,
      workEnd: input.agent.workEnd,
      hourlyLimit: input.agent.hourlyLimit,
      handoffKeywords: input.agent.handoffKeywords
    },
    sentThisHour: input.sentThisHour,
    now: input.now
  })
  if (!gate.ok) {
    return {
      type: 'skip',
      reason: gate.reason,
      key: bound.key,
      title: bound.title,
      kind: bound.kind,
      added
    }
  }

  if (repliesLooped(input.recentOut) || input.badCount >= 2) {
    return {
      type: 'handoff',
      key: bound.key,
      title: bound.title,
      kind: bound.kind,
      reason: input.badCount >= 2 ? '连续否定' : '回复重复',
      added
    }
  }

  // 屏幕上没有新的对方消息时，不发素材，也不再调用回复模型。
  // 转人工词已经在上面处理过，所以没处理的「退款」仍会暂停一次。
  if (!added.some((bubble) => bubble.side === 'in')) {
    return {
      type: 'skip',
      reason: '没有新的对方消息',
      key: bound.key,
      title: bound.title,
      kind: bound.kind,
      added
    }
  }

  if (freshIn.every((text) => isPureAck(text))) {
    return {
      type: 'skip',
      reason: '对方只是应了一声',
      key: bound.key,
      title: bound.title,
      kind: bound.kind,
      added
    }
  }

  const materialText = freshIn.find((text) => matchMaterial(text, input.agent.materialRules))
  const material = materialText ? matchMaterial(materialText, input.agent.materialRules) : null
  if (material) {
    return {
      type: 'fixed',
      key: bound.key,
      title: bound.title,
      kind: bound.kind,
      text: material.text,
      imagePath: material.imagePath,
      added
    }
  }

  const factual = freshIn.filter((text) => needsKnowledge(text))
  const missed = factual.find((text) => topHits(text, input.knowledge).length === 0)
  if (missed) {
    return {
      type: 'handoff',
      key: bound.key,
      title: bound.title,
      kind: bound.kind,
      reason: '资料里没有',
      added
    }
  }
  const hits = factual.length > 0 ? topHits(factual.join('\n'), input.knowledge) : []

  const history = formatHistory(selectHistory(input.stored, input.screen.bubbles, input.agent.historyLimit))
  return {
    type: 'reply',
    key: bound.key,
    title: bound.title,
    kind: bound.kind,
    historyText: history,
    knowledgeText: formatKnowledge(hits),
    knowledgeTitles: hits.map((hit) => hit.title),
    incoming: freshIn.join('\n'),
    added
  }
}

function inboundTexts(bubbles: VisibleBubble[]): string[] {
  return bubbles
    .filter((bubble) => bubble.side === 'in')
    .map((bubble) => normalizeBubbleText(bubble.text))
    .filter((text) => text.length > 0)
}

function firstKeyword(texts: string[], words: string[]): string | null {
  for (const text of texts) {
    const hit = hitKeyword(text, words)
    if (hit) return hit
  }
  return null
}

function topHits(query: string, chunks: KnowledgeChunk[]): KnowledgeChunk[] {
  return searchChunks(query, chunks)
}

function bindIdentity(
  screen: ObservedScreen
): { key: string; title: string; kind: ConversationKind } | null {
  if (screen.boxSelect) {
    return { key: windowConversationKey(screen.appType), title: '当前窗口', kind: 'window' }
  }
  const identity = screen.identity
  if (!identity || identity.confidence !== 'high') return null
  const key = conversationKey(identity.kind, identity.title)
  if (!key) return null
  return { key, title: identity.title, kind: identity.kind }
}

export function effectiveMode(
  agent: AgentProfile,
  allowAuto: boolean,
  nameCheckPassed = false
): 'assist' | 'auto' {
  if (agent.mode === 'auto' && allowAuto && nameCheckPassed) return 'auto'
  return 'assist'
}
