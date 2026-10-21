import type { DraftAnswer } from './controller'
import type { TurnAction } from './decide-turn'

export type ObservePlan =
  | { kind: 'legacy' }
  | { kind: 'advance'; logType: 'thinking' | 'skip'; message: string }
  | { kind: 'sendFixed' }
  | { kind: 'generate' }

export type ConfirmPlan =
  | { kind: 'send'; text: string }
  | {
      kind: 'advance'
      logType: 'thinking' | 'skip'
      message: string
      handoff: boolean
      bad: string
      idle: boolean
    }

/** 看屏结论决定这一轮要不要调用回复模型。冷处理停在 advance，不会进入 generate。 */
export function planObserve(action: TurnAction): ObservePlan {
  switch (action.type) {
    case 'legacy':
      return { kind: 'legacy' }
    case 'skip':
      return {
        kind: 'advance',
        logType: 'skip',
        message: action.reason === '冷处理' ? '冷处理，这一轮不回复' : action.reason
      }
    case 'review':
      return { kind: 'advance', logType: 'thinking', message: action.reason }
    case 'handoff':
      return { kind: 'advance', logType: 'thinking', message: `转人工：${action.reason}` }
    case 'fixed':
      return { kind: 'sendFixed' }
    case 'reply':
      return { kind: 'generate' }
  }
}

export function planConfirm(answer: DraftAnswer): ConfirmPlan {
  switch (answer.action) {
    case 'send':
      return { kind: 'send', text: answer.text }
    case 'discard':
      return { kind: 'advance', logType: 'skip', message: '草稿已丢弃', handoff: false, bad: '', idle: true }
    case 'handoff':
      return { kind: 'advance', logType: 'thinking', message: '已转人工', handoff: true, bad: '', idle: false }
    case 'bad':
      return {
        kind: 'advance',
        logType: 'skip',
        message: `这条不行：${answer.reason}`,
        handoff: false,
        bad: answer.reason,
        idle: false
      }
  }
}
