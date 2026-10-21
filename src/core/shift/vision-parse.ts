import type { ConversationIdentity } from '../memory/conversation-key'
import type { BubbleSide, VisibleBubble } from '../memory/transcript-merge'

export function extractJsonObject(raw: string): unknown | null {
  const trimmed = raw.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const body = fenced ? fenced[1] : trimmed
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}

export function parseIdentity(raw: string): ConversationIdentity | null {
  const value = extractJsonObject(raw)
  if (!value || typeof value !== 'object') return null
  const record = value as { title?: unknown; kind?: unknown; confidence?: unknown }
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const kind = record.kind === 'group' ? 'group' : record.kind === 'single' ? 'single' : null
  const confidence = record.confidence === 'high' ? 'high' : 'low'
  if (!kind) return null
  return { title, kind, confidence: title ? confidence : 'low' }
}

export function parseBubbles(raw: string): { bubbles: VisibleBubble[]; mentionedMe: boolean | null } {
  const value = extractJsonObject(raw)
  if (!value || typeof value !== 'object') return { bubbles: [], mentionedMe: null }
  const record = value as { bubbles?: unknown; mentionedMe?: unknown }
  const mentionedMe = record.mentionedMe === true ? true : record.mentionedMe === false ? false : null
  const bubbles = Array.isArray(record.bubbles)
    ? record.bubbles.flatMap((item) => {
        if (!item || typeof item !== 'object') return []
        const bubble = item as { side?: unknown; text?: unknown }
        const side: BubbleSide | null =
          bubble.side === 'in' || bubble.side === 'out' || bubble.side === 'system' ? bubble.side : null
        const text = typeof bubble.text === 'string' ? bubble.text.trim() : ''
        if (!side || !text) return []
        return [{ side, text }]
      })
    : []
  return { bubbles, mentionedMe }
}

export const IDENTITY_PROMPT = `这是微信或企业微信聊天窗口顶部标题栏的截图。只输出 JSON，不要解释。
{"title":"标题栏上的名称","kind":"single 或 group","confidence":"high 或 low"}
群聊通常带成员人数。看不清时 confidence 用 low，title 用空字符串。不要猜测。`

export const BUBBLE_PROMPT = `这是聊天记录区域的截图。右侧气泡是我发出的，左侧气泡是对方发的，灰色系统提示是 system。
只输出 JSON，不要解释。
{"mentionedMe":true 或 false 或 null,"bubbles":[{"side":"in 或 out 或 system","text":"气泡正文"}]}
bubbles 按从上到下。看不清的气泡不要编。无法判断有没有 @ 我时 mentionedMe 用 null。`
