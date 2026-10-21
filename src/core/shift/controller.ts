import type { ConversationKind } from '../memory/conversation-key'
import type { AppType } from '../rpa/types'
import type { TurnAction } from './decide-turn'
import type { PacingPolicy } from './pacing'

export interface DraftPayload {
  key: string
  title: string
  text: string
  knowledgeTitles: string[]
  imagePath?: string
}

export type DraftAnswer =
  | { action: 'send'; text: string }
  | { action: 'discard' }
  | { action: 'handoff' }
  | { action: 'bad'; reason: string }

export interface ShiftController {
  prepare(appType: AppType): Promise<TurnAction>
  confirmDraft(draft: DraftPayload): Promise<DraftAnswer>
  /** 发送前再读一次标题。读失败或已经换人时返回 false，调用方不得发送。 */
  stillOn(key: string): Promise<boolean>
  cancelPending(): void
  recordSent(key: string, title: string, kind: ConversationKind, text: string): void
  noteBad(key: string, title: string, kind: ConversationKind, reply: string, reason: string): void
  noteIdle(key: string, title: string, reason: string): void
  handOff(key: string, title: string, kind: ConversationKind, reason: string): Promise<void>
  pacing(): PacingPolicy
  mode(): 'assist' | 'auto'
  inputBackend(): 'software' | 'usb'
  sanitizeError(message: string): string
}
