// 会话键：用看屏读到的标题栏名称区分「这是谁」。
// 只有群标题末尾的人数会变，键里去掉，避免同一个群被拆成两份记忆。
// 单聊里的「张三(2)」是名字的一部分，不能去掉。

export type ConversationKind = 'single' | 'group' | 'window'

export interface ConversationIdentity {
  title: string
  kind: Exclude<ConversationKind, 'window'>
  confidence: 'high' | 'low'
}

export function normalizeTitle(raw: string, kind?: ConversationKind): string {
  const base = raw.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (kind !== 'group') return base
  return base.replace(/[(（]\d{1,5}[)）]\s*$/u, '').trim()
}

/** 稳定身份才返回键。空名称返回 null。 */
export function conversationKey(kind: ConversationKind, title: string): string | null {
  const name = normalizeTitle(title, kind)
  if (!name) return null
  return `${kind}:${name}`
}

export function windowConversationKey(appType: string): string {
  return `window:${appType || 'unknown'}`
}
