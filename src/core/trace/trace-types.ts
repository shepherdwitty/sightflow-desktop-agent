// src/core/trace/trace-types.ts
// Work-trace 数据模型 — 「学」能力的地基
//
// 每次引擎执行的每个有意义步骤都落成一条 TraceStep（五元组：时间戳 / 界面状态 /
// 判断依据 / 动作 / 结果），按 session 聚合，append-only 持久化到本地。
// schema 字段与 docs/plan/learn-work-memory-plan.md 第三节一一对应。

import { AppType } from '../rpa/types'
import type { StepUsage } from '../usage/usage-ledger'

export type TraceActor = 'agent' | 'human'
export type TracePhase = 'observe' | 'think' | 'act' | 'verify'
export type TraceOutcomeStatus = 'ok' | 'fail' | 'skip'
export type TraceActionKind = 'click' | 'send' | 'measure' | 'wait'

export interface TraceSessionMeta {
  sessionId: string
  appType: AppType
  startedAt: number
  endedAt?: number
  engineVersion: string
  providerId?: string
  model?: string
  stepCount: number
}

export interface TraceReasoning {
  content: string
  /** 本步引用了哪些经验卡片（cardId），用于继承闭环度量 */
  memoryRefs?: string[]
}

export interface TraceAction {
  kind: TraceActionKind
  /** 屏幕坐标（click 类动作） */
  target?: [number, number]
  /** 动作负载（send 的文本等） */
  payload?: string
}

export interface TraceOutcome {
  status: TraceOutcomeStatus
  detail?: string
  latencyMs?: number
}

export interface TraceStep {
  stepId: string
  sessionId: string
  seq: number
  ts: number
  actor: TraceActor
  phase: TracePhase
  /** 一句话概述，时间轴 UI 直接展示 */
  summary: string
  screen?: { screenshotPath: string }
  reasoning?: TraceReasoning
  action?: TraceAction
  outcome?: TraceOutcome
  /** 本步归属的模型算力消耗（token + 计费模拟），结构见 usage-ledger 的 StepUsage */
  usage?: StepUsage
  /**
   * 这一步的点击或发送由 USB 助理执行。
   * 缺省表示走软件键鼠，或这条轨迹记下来时还没有这个字段。
   * 只出现在 phase=act 且 action.kind 为 click / send 的步骤上。
   */
  inputDevice?: 'usb'
}

/**
 * 业务层（session / host）提交轨迹时的输入。
 * stepId / sessionId / seq / ts 由 TraceRecorder 填充；
 * 截图以 base64 传入，由 recorder 落盘并替换为相对路径。
 */
export interface TraceStepInput {
  actor?: TraceActor
  phase: TracePhase
  summary: string
  screenshotBase64?: string
  reasoning?: TraceReasoning
  action?: TraceAction
  outcome?: TraceOutcome
  /**
   * 这一步已经算好的模型用量（视觉检测包在 captureUsage 里）。
   * 与 claimPendingUsage 同时存在时，用这个，不再去拿全局 pending。
   */
  usage?: StepUsage
  /**
   * 取走尚未归属的 reply pending。只给「模型调用已经返回」的那条轨迹设。
   */
  claimPendingUsage?: boolean
  /** 由 RuntimeHost 在落盘前写入。业务层不用自己填。 */
  inputDevice?: 'usb'
}

/** 注入给 Provider 的经验卡片摘要（完整卡片定义见 memory/experience-store.ts） */
export interface MemoryCardBrief {
  cardId: string
  scenario: string
  guidance: string
  rationale?: string
}
