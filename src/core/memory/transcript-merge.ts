// 屏幕上只能看见最后一段气泡。合并时只追加新尾巴，对不齐就不覆盖旧记录。

export type BubbleSide = 'in' | 'out' | 'system'

export interface VisibleBubble {
  side: BubbleSide
  text: string
}

export interface StoredTurn {
  side: BubbleSide
  text: string
}

export function normalizeBubbleText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

export type MergeResult =
  | { status: 'append'; added: VisibleBubble[] }
  | { status: 'aligned'; added: VisibleBubble[] }
  | { status: 'unchanged' }
  | { status: 'reject' }

function visibleBubbles(visible: VisibleBubble[]): VisibleBubble[] {
  return visible
    .map((bubble) => ({ side: bubble.side, text: normalizeBubbleText(bubble.text) }))
    .filter((bubble) => bubble.text.length > 0)
}

/**
 * 一条已发出的长回复会变成连续几条气泡。
 * 只有超过约四十个字的存档，才允许用同侧连续气泡拼回去；短句必须一条对一条。
 */
function consumeStoredTail(storedTail: StoredTurn[], visible: VisibleBubble[]): number {
  let index = 0
  for (const turn of storedTail) {
    const want = normalizeBubbleText(turn.text)
    if (!want || index >= visible.length || visible[index].side !== turn.side) return -1
    let taken = 0
    let joined = ''
    let matched = false
    while (index + taken < visible.length && visible[index + taken].side === turn.side) {
      taken += 1
      joined = normalizeBubbleText(visible.slice(index, index + taken).map((bubble) => bubble.text).join(''))
      if (joined === want) {
        if (taken > 1 && Array.from(want).length <= 40) return -1
        matched = true
        break
      }
      if (Array.from(joined).length > Array.from(want).length) break
    }
    if (!matched) return -1
    index += taken
  }
  return index
}

function bestOverlap(
  stored: StoredTurn[],
  incoming: VisibleBubble[]
): { start: number; visible: number } | null {
  let best: { start: number; visible: number } | null = null
  for (let start = 0; start < stored.length; start += 1) {
    const consumed = consumeStoredTail(stored.slice(start), incoming)
    if (consumed <= 0) continue
    if (!best || consumed > best.visible || (consumed === best.visible && start < best.start)) {
      best = { start, visible: consumed }
    }
  }
  return best
}

function containsFold(stored: StoredTurn[], visible: VisibleBubble[]): boolean {
  for (let start = 0; start < stored.length; start += 1) {
    for (let end = start + 1; end <= stored.length; end += 1) {
      if (consumeStoredTail(stored.slice(start, end), visible) === visible.length) return true
    }
  }
  return false
}

export function mergeVisible(stored: StoredTurn[], visible: VisibleBubble[]): MergeResult {
  const incoming = visibleBubbles(visible)

  if (incoming.length === 0) {
    return stored.length === 0 ? { status: 'unchanged' } : { status: 'reject' }
  }
  if (stored.length === 0) {
    return { status: 'append', added: incoming }
  }

  const overlap = bestOverlap(stored, incoming)
  if (!overlap) {
    if (containsFold(stored, incoming)) return { status: 'unchanged' }
    return { status: 'reject' }
  }

  const added = incoming.slice(overlap.visible)
  if (added.length === 0) return { status: 'unchanged' }
  return { status: 'aligned', added }
}

/** 屏幕上已经能看见的尾巴不必再送进模型。 */
export function selectHistory(
  stored: StoredTurn[],
  visible: VisibleBubble[],
  limit: number
): StoredTurn[] {
  const cap = Math.max(0, Math.min(50, Math.floor(limit)))
  if (cap === 0 || stored.length === 0) return []

  const incoming = visibleBubbles(visible)
  const overlap = incoming.length === 0 ? null : bestOverlap(stored, incoming)
  const older = overlap ? stored.slice(0, overlap.start) : stored
  return older.slice(-cap)
}

export function formatHistory(turns: StoredTurn[]): string {
  if (turns.length === 0) return ''
  const lines = turns
    .filter((turn) => turn.side !== 'system')
    .map((turn) => `${turn.side === 'out' ? '我' : '对方'}：${normalizeBubbleText(turn.text)}`)
  if (lines.length === 0) return ''
  return `以下是这个会话里更早的文字记录，屏幕上可能已经滚走。不要重复已经说过的话。\n${lines.join('\n')}`
}

export function latestIncoming(bubbles: VisibleBubble[]): string {
  const incoming = bubbles.filter((bubble) => bubble.side === 'in' && normalizeBubbleText(bubble.text))
  return incoming.length ? normalizeBubbleText(incoming[incoming.length - 1].text) : ''
}
