import { normalizeTitle, type ConversationKind } from '../memory/conversation-key'

export interface GateConfig {
  blacklist: string[]
  whitelistEnabled: boolean
  whitelist: string[]
  groupReply: 'all' | 'mention'
  workHoursEnabled: boolean
  workStart: string
  workEnd: string
  hourlyLimit: number
  handoffKeywords: string[]
}

export interface GateInput {
  title: string
  kind: ConversationKind
  cold: boolean
  handedOff: boolean
  mentionedMe: boolean | null
  config: GateConfig
  sentThisHour: number
  now: Date
}

export type GateOutcome = { ok: true } | { ok: false; reason: string }

export function evaluateGate(input: GateInput): GateOutcome {
  if (input.cold) return { ok: false, reason: '冷处理' }
  if (input.handedOff) return { ok: false, reason: '已转人工' }

  if (blacklisted(input.title, input.kind, input.config.blacklist)) return { ok: false, reason: '黑名单' }

  const title = normalizeTitle(input.title, input.kind)
  if (input.config.whitelistEnabled && input.kind === 'single') {
    const allowed = input.config.whitelist.map((name) => normalizeTitle(name, input.kind)).filter(Boolean)
    if (!title || !allowed.includes(title)) return { ok: false, reason: '不在白名单' }
  }

  if (input.kind === 'group' && input.config.groupReply === 'mention' && input.mentionedMe !== true) {
    return { ok: false, reason: '群里没有 @' }
  }

  if (input.config.workHoursEnabled && !withinWorkHours(input.now, input.config.workStart, input.config.workEnd)) {
    return { ok: false, reason: '不在上班时段' }
  }

  const limit = input.config.hourlyLimit
  if (limit > 0 && input.sentThisHour >= limit) {
    return { ok: false, reason: '超过每小时上限' }
  }

  return { ok: true }
}

export function withinWorkHours(now: Date, start: string, end: string): boolean {
  const startMin = parseClock(start)
  const endMin = parseClock(end)
  if (startMin === null || endMin === null) return true
  const current = now.getHours() * 60 + now.getMinutes()
  if (startMin <= endMin) return current >= startMin && current <= endMin
  return current >= startMin || current <= endMin
}

function parseClock(value: string): number | null {
  const matched = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!matched) return null
  const hour = Number(matched[1])
  const minute = Number(matched[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

export function blacklisted(title: string, kind: ConversationKind, names: string[]): boolean {
  const normalized = normalizeTitle(title, kind)
  if (!normalized) return false
  return names.some((name) => normalizeTitle(name, kind) === normalized)
}

export function hitKeyword(text: string, words: string[]): string | null {
  const haystack = text.normalize('NFKC')
  for (const word of words) {
    const needle = word.normalize('NFKC').trim()
    if (needle && haystack.includes(needle)) return needle
  }
  return null
}

export function repliesLooped(recentOut: string[]): boolean {
  const last = recentOut.map((text) => text.normalize('NFKC').replace(/\s+/g, ' ').trim()).filter(Boolean)
  if (last.length < 2) return false
  return last[last.length - 1] === last[last.length - 2]
}
