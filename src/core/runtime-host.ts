import {
  ChannelContext,
  ChannelSession,
  ProviderAdapter,
  ProviderEvent,
  ProviderInput,
  RuntimeHostControls,
  SessionEvent
} from './session-types'
import { prefixUsbAction, UsbInputError } from './rpa/ch9329'
import { AppType } from './rpa/types'
import { markUsbTraceStep } from './trace/trace-mark'
import { MemoryCardBrief, TraceStepInput } from './trace/trace-types'

interface RuntimeHostOptions<TState> {
  appType: AppType
  channel: ChannelSession<TState>
  provider: ProviderAdapter
  initialState: TState
  onLog?: (type: 'thinking' | 'reply' | 'skip' | 'error', content: string) => void
  /** 当前输入是否走 USB 助理。只给鼠标和已发出的回复打标记。 */
  usbActive?: () => boolean
  /** work-trace 落点：channel 通过 host.trace() 提交的每条轨迹都会回调到这里 */
  onTrace?: (step: TraceStepInput) => void
  /** 每轮 provider 调用前取当前启用的经验卡片，注入 ProviderInput */
  getMemoryCards?: () => MemoryCardBrief[]
  /** 会话结束（含内部错误停止）时回调，用于收尾轨迹会话 */
  onSessionEnd?: () => void
}

export class RuntimeHost<TState> {
  private running = false
  private stopping = false
  private processingQueue = false
  private readonly queue: SessionEvent[] = []
  private readonly timers = new Set<NodeJS.Timeout>()
  private readonly context: ChannelContext<TState>
  /** 最近一轮 provider 调用注入的卡片，用于给 think/act 轨迹自动补 memoryRefs */
  private lastInjectedCardIds: string[] = []

  constructor(private readonly options: RuntimeHostOptions<TState>) {
    this.context = {
      appType: options.appType,
      state: options.initialState,
      host: this.createControls()
    }
  }

  async startSession(): Promise<void> {
    if (this.running) return

    this.running = true
    this.stopping = false
    this.log('reply', '引擎已启动')

    try {
      await this.options.channel.onStart(this.context)
    } catch (error: unknown) {
      this.log('error', this.formatError(error))
      await this.stopSession('start_failed')
      throw error
    }
  }

  async stopSession(_reason?: string): Promise<void> {
    if (!this.running || this.stopping) return

    this.stopping = true
    this.running = false

    for (const timer of this.timers) {
      clearTimeout(timer)
    }
    this.timers.clear()
    this.queue.length = 0

    try {
      await this.options.channel.onStop(this.context)
    } finally {
      this.processingQueue = false
      this.stopping = false
      this.log('skip', '引擎已停止')
      this.options.onSessionEnd?.()
    }
  }

  isRunning(): boolean {
    return this.running
  }

  updateAppType(appType: AppType): void {
    this.context.appType = appType
  }

  private createControls(): RuntimeHostControls {
    return {
      enqueue: (event) => this.enqueue(event),
      schedule: (event, delayMs) => this.schedule(event, delayMs),
      runProvider: (input: ProviderInput) => this.runProviderWithMemory(input),
      log: (type, content) => this.log(type, content),
      logInput: (type, content) =>
        this.log(type, prefixUsbAction(content, this.options.usbActive?.() === true)),
      trace: (step) => this.trace(step),
      isRunning: () => this.running,
      stopSession: async (reason?: string) => this.stopSession(reason)
    }
  }

  /** provider 调用前注入工作记忆（经验卡片），并记下卡片 id 供轨迹引用标记 */
  private runProviderWithMemory(input: ProviderInput): AsyncIterable<ProviderEvent> {
    const cards = this.options.getMemoryCards?.() ?? []
    this.lastInjectedCardIds = cards.map((card) => card.cardId)
    return this.options.provider.run(cards.length ? { ...input, memoryCards: cards } : input)
  }

  private trace(step: TraceStepInput): void {
    if (!this.options.onTrace) return

    // 模型判断 / 动作类步骤自动标记本轮引用的经验卡片
    const needsRefs =
      (step.phase === 'think' || step.phase === 'act') &&
      this.lastInjectedCardIds.length > 0 &&
      !step.reasoning?.memoryRefs
    const enriched = needsRefs
      ? {
          ...step,
          reasoning: {
            content: step.reasoning?.content ?? step.summary,
            memoryRefs: [...this.lastInjectedCardIds]
          }
        }
      : step

    try {
      this.options.onTrace(markUsbTraceStep(enriched, this.options.usbActive?.() === true))
    } catch (error) {
      console.error('[RuntimeHost] onTrace 回调失败:', error)
    }
  }

  private enqueue(event: SessionEvent): void {
    if (!this.running) return

    this.queue.push(event)
    void this.drainQueue()
  }

  private schedule(event: SessionEvent, delayMs: number): void {
    if (!this.running) return

    const timer = setTimeout(() => {
      this.timers.delete(timer)
      this.enqueue(event)
    }, delayMs)

    this.timers.add(timer)
  }

  private async drainQueue(): Promise<void> {
    if (this.processingQueue || !this.running) return

    this.processingQueue = true
    try {
      while (this.queue.length > 0 && this.running) {
        const event = this.queue.shift()
        if (!event) continue

        await this.options.channel.onEvent(event, this.context)
      }
    } catch (error: unknown) {
      this.log('error', this.formatError(error))
      await this.stopSession('runtime_error')
    } finally {
      this.processingQueue = false
    }
  }

  private formatError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    if (
      error instanceof UsbInputError ||
      (error instanceof Error && error.name === 'UsbInputError')
    ) {
      return prefixUsbAction(message, true)
    }
    return message
  }

  private log(type: 'thinking' | 'reply' | 'skip' | 'error', content: string): void {
    if (this.options.onLog) {
      this.options.onLog(type, content)
    } else {
      console.log(`[RuntimeHost] [${type}] ${content}`)
    }
  }
}
