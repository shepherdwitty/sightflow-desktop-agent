// 真人节奏：把一条回复拆成可执行的键入步骤。
// 发出去的正文必须等于原文。错字只出现在步骤中间，并且马上退格改正。

export type PacingSpeed = 'steady' | 'natural' | 'slow'
export type TypoLevel = 'off' | 'low' | 'mid'

export interface PacingPolicy {
  enabled: boolean
  readBeforeType: boolean
  segmentLong: boolean
  speed: PacingSpeed
  typo: TypoLevel
}

export const DEFAULT_PACING: PacingPolicy = {
  enabled: true,
  readBeforeType: true,
  segmentLong: true,
  speed: 'natural',
  typo: 'low'
}

export type TypeAction =
  | { op: 'wait'; ms: number }
  | { op: 'paste'; text: string }
  | { op: 'backspace'; count: number }
  | { op: 'enter' }

const SPEED_MS: Record<PacingSpeed, { read: number; between: number }> = {
  steady: { read: 500, between: 400 },
  natural: { read: 800, between: 700 },
  slow: { read: 1400, between: 1200 }
}

const HOMOPHONES: Record<string, string> = {
  的: '得',
  得: '的',
  地: '的',
  在: '再',
  再: '在',
  做: '作',
  作: '做',
  他: '她',
  她: '他',
  是: '事'
}

export function typoForbidden(text: string): boolean {
  return /[0-9０-９]/.test(text) || /[￥¥$]/.test(text) || /https?:\/\//i.test(text) || /元|块|地址|路|街|号|区|点|分钟|小时/.test(text)
}

export function splitMessage(text: string, enabled: boolean): string[] {
  const trimmed = text.replace(/\r\n/g, '\n').trim()
  if (!trimmed) return []
  if (!enabled || trimmed.length <= 40) return [trimmed]

  const parts = trimmed.split(/(?<=[。！？!?；;\n])/u).map((part) => part.trim()).filter(Boolean)
  const chunks: string[] = []
  let buffer = ''
  const push = (piece: string): void => {
    const chars = Array.from(piece)
    if (chars.length <= 40) {
      chunks.push(piece)
      return
    }
    for (let index = 0; index < chars.length; index += 40) {
      chunks.push(chars.slice(index, index + 40).join(''))
    }
  }
  for (const part of parts) {
    if (part.length > 40) {
      if (buffer) push(buffer)
      buffer = ''
      push(part)
      continue
    }
    if (buffer && (buffer + part).length > 40) {
      push(buffer)
      buffer = part
    } else {
      buffer = buffer ? buffer + part : part
    }
  }
  if (buffer) push(buffer)
  return chunks.length > 0 ? chunks : [trimmed]
}

export function buildTypeScript(
  text: string,
  policy: PacingPolicy,
  rng: () => number = Math.random
): TypeAction[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (!policy.enabled) {
    return [
      { op: 'paste', text: trimmed },
      { op: 'enter' }
    ]
  }

  const timing = SPEED_MS[policy.speed] ?? SPEED_MS.natural
  const chunks = splitMessage(trimmed, policy.segmentLong)
  const actions: TypeAction[] = []
  if (policy.readBeforeType) actions.push({ op: 'wait', ms: timing.read })

  chunks.forEach((chunk, index) => {
    actions.push(...typeChunk(chunk, policy, rng))
    actions.push({ op: 'enter' })
    if (index < chunks.length - 1) actions.push({ op: 'wait', ms: timing.between })
  })
  return actions
}

function typeChunk(chunk: string, policy: PacingPolicy, rng: () => number): TypeAction[] {
  if (policy.typo === 'off' || typoForbidden(chunk)) {
    return [{ op: 'paste', text: chunk }]
  }
  const threshold = policy.typo === 'low' ? 0.35 : 0.7
  if (rng() > threshold) return [{ op: 'paste', text: chunk }]

  const indexes: number[] = []
  for (let i = 0; i < chunk.length; i += 1) {
    if (HOMOPHONES[chunk[i]]) indexes.push(i)
  }
  if (indexes.length === 0) return [{ op: 'paste', text: chunk }]

  const at = indexes[Math.min(indexes.length - 1, Math.floor(rng() * indexes.length))]
  const wrong = HOMOPHONES[chunk[at]]
  return [
    { op: 'paste', text: chunk.slice(0, at) + wrong },
    { op: 'backspace', count: 1 },
    { op: 'paste', text: chunk.slice(at) }
  ]
}

/** 把步骤还原成将要发出的各条消息，用来确认错字没有留在正文里。 */
export function previewTyped(actions: TypeAction[]): string[] {
  const messages: string[] = []
  let buffer = ''
  for (const action of actions) {
    if (action.op === 'paste') buffer += action.text
    else if (action.op === 'backspace') buffer = buffer.slice(0, Math.max(0, buffer.length - action.count))
    else if (action.op === 'enter') {
      messages.push(buffer)
      buffer = ''
    }
  }
  if (buffer) messages.push(buffer)
  return messages
}
