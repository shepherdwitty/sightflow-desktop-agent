// 渲染端共享的用量展示工具：用途文案、金额/数字格式化、汇总类型。
// 渲染端约定不跨层 import core，这里的类型与 src/core/usage/usage-ledger.ts 对齐。

export const PURPOSE_LABEL: Record<string, string> = {
  reply: '生成回复',
  vision: '视觉定位',
  learn: '经验学习',
  test: '连接测试',
  text: '文本调用'
}

export interface UsageAgg {
  calls: number
  inputTokens: number
  outputTokens: number
  cost: number
}

export interface UsageRecordRow {
  ts: string
  purpose: string
  tier: string
  inputTokens: number
  outputTokens: number
  cost: number
  /** 旧账本无此字段；false = 模型不在内置计价表内，cost 为 0 仅占位 */
  priced?: boolean
}

export interface UsageSummary {
  total?: UsageAgg
  today?: UsageAgg
  byPurpose?: Record<string, UsageAgg>
  recent?: UsageRecordRow[]
}

export const fmtYuan = (n?: number): string => `¥${(n || 0).toFixed(6)}`
export const fmtNum = (n?: number): string => (n || 0).toLocaleString('zh-CN')
