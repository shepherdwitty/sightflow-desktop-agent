// src/core/generic-channel-session.ts
// 通用 ChannelSession — 驱动 DesktopDevice，具体位置来源由设备测量后写入 LayoutCache。
//
// 设计原则：本文件只依赖 DesktopDevice 接口。所有微信特定的行为（如 layoutCache 清理、
// VLM bbox 状态同步）都封装到具体设备的 onSessionStart / onSessionStop / clearUnreadCache
// 里，使 channel session 在不同设备之间真正可复用。

import { DesktopDevice } from './device'
import type { ConversationKind } from './memory/conversation-key'
import { ChannelContext, ChannelSession, ProviderEvent, SessionEvent } from './session-types'
import type { ShiftController } from './shift/controller'
import type { TurnAction } from './shift/decide-turn'
import { planConfirm, planObserve } from './shift/turn-dispatch'
import { captureUsage, mergeStepUsage, type StepUsage } from './usage/usage-ledger'

export interface GenericChannelState {
  measuredAt: number | null
  latestChatBaseline: number | null
}

export function createInitialGenericChannelState(): GenericChannelState {
  return {
    measuredAt: null,
    latestChatBaseline: null
  }
}

export class GenericChannelSession implements ChannelSession<GenericChannelState> {
  private readonly retryDelayMs = 5000
  private consecutiveUnreadFailures = 0
  /** provider 在请求发出前就 yield 的「正在分析」。等调用返回后再落轨迹，用量才能挂在这一步上。 */
  private deferredThink: string | null = null
  private replyFailed = false

  constructor(
    private readonly device: DesktopDevice,
    private readonly shift?: ShiftController
  ) {}

  async onStart(ctx: ChannelContext<GenericChannelState>): Promise<void> {
    this.device.setAppType(ctx.appType)
    this.device.clearChatBaseline()
    this.consecutiveUnreadFailures = 0
    this.deferredThink = null
    this.resetState(ctx.state)
    await this.device.onSessionStart?.()
    ctx.host.enqueue({ type: 'bootstrap' })
  }

  async onStop(ctx: ChannelContext<GenericChannelState>): Promise<void> {
    this.shift?.cancelPending()
    this.device.clearChatBaseline()
    this.consecutiveUnreadFailures = 0
    this.deferredThink = null
    await this.device.onSessionStop?.()
    this.resetState(ctx.state)
  }

  async onEvent(event: SessionEvent, ctx: ChannelContext<GenericChannelState>): Promise<void> {
    this.device.setAppType(ctx.appType)

    switch (event.type) {
      case 'bootstrap': {
        ctx.host.log('thinking', '正在识别聊天窗口布局...')
        const measureStart = Date.now()
        const measured = await captureUsage(() => this.device.measureLayout())
        const result = measured.value

        if (!result.success) {
          ctx.host.log('error', `${result.error || '界面识别失败'}，引擎无法启动`)
          ctx.host.trace({
            phase: 'observe',
            summary: '识别聊天窗口布局',
            action: { kind: 'measure' },
            outcome: {
              status: 'fail',
              detail: result.error || '界面识别失败',
              latencyMs: Date.now() - measureStart
            },
            usage: measured.usage
          })
          await ctx.host.stopSession('bootstrap_failed')
          return
        }

        ctx.state.measuredAt = Date.now()
        ctx.host.log('thinking', '聊天窗口识别完成')
        ctx.host.trace({
          phase: 'observe',
          summary: '识别聊天窗口布局',
          action: { kind: 'measure' },
          outcome: { status: 'ok', latencyMs: Date.now() - measureStart },
          usage: measured.usage
        })
        ctx.host.enqueue({ type: 'observe_chat' })
        break
      }

      case 'observe_chat': {
        const screenshot = await this.device.screenshot()
        ctx.host.trace({
          phase: 'observe',
          summary: '截取当前聊天窗口',
          screenshotBase64: screenshot
        })
        if (!this.shift) {
          await this.forwardProviderEvents(screenshot, ctx)
          break
        }
        const action = await this.shift.prepare(ctx.appType)
        if (!ctx.host.isRunning()) break
        await this.handleTurn(action, screenshot, ctx)
        break
      }

      case 'provider.thinking':
        ctx.host.log('thinking', event.content)
        this.deferredThink = event.content
        break

      case 'provider.reply_text': {
        const claimedByThink = this.traceDeferredThink(ctx)
        const sendStart = Date.now()
        await this.device.sendMessage(event.content)
        ctx.host.logInput('reply', event.content)
        ctx.host.trace({
          phase: 'act',
          summary: '发送回复',
          action: { kind: 'send', payload: event.content },
          outcome: { status: 'ok', latencyMs: Date.now() - sendStart },
          claimPendingUsage: !claimedByThink
        })
        await this.device.setChatBaseline()
        ctx.state.latestChatBaseline = Date.now()
        ctx.host.enqueue({ type: 'check_unread' })
        break
      }

      case 'provider.skip':
        ctx.host.log('skip', '本轮无需回复')
        {
          const claimedByThink = this.traceDeferredThink(ctx)
          ctx.host.trace({
            phase: 'think',
            summary: '判断本轮无需回复',
            outcome: { status: 'skip' },
            claimPendingUsage: !claimedByThink
          })
        }
        await this.device.setChatBaseline()
        ctx.state.latestChatBaseline = Date.now()
        ctx.host.enqueue({ type: 'check_unread' })
        break

      case 'provider.error': {
        const text = this.shift?.sanitizeError(event.error) ?? event.error
        ctx.host.log('error', `回复服务异常：${text}`)
        {
          const claimedByThink = this.traceDeferredThink(ctx)
          ctx.host.trace({
            phase: 'think',
            summary: '回复服务异常',
            outcome: { status: 'fail', detail: text },
            claimPendingUsage: !claimedByThink
          })
        }
        if (text === '额度用尽' || text === '请先激活许可证') {
          await ctx.host.stopSession('quota')
          return
        }
        ctx.host.enqueue({
          type: 'wait_retry',
          reason: 'provider_error',
          delayMs: this.retryDelayMs
        })
        break
      }

      case 'check_unread': {
        const diffResult = await this.device.hasChatAreaChanged()
        if (diffResult.hasDiff) {
          ctx.host.log('thinking', '检测到当前对话有新消息')
          ctx.host.trace({
            phase: 'verify',
            summary: '检测到当前对话有新消息',
            outcome: { status: 'ok' }
          })
          ctx.host.enqueue({ type: 'observe_chat' })
          break
        }

        const unread = await captureUsage(() => this.device.hasUnreadMessage())
        const unreadResult = unread.value
        if (!unreadResult.hasUnread) {
          ctx.host.enqueue({
            type: 'wait_retry',
            reason: 'no_unread',
            delayMs: this.retryDelayMs
          })
          break
        }

        const chatEntranceCoords = unreadResult.chatEntranceArea?.coordinates
        if (!chatEntranceCoords) {
          ctx.host.log('error', '检测到未读消息，但未找到聊天入口位置')
          ctx.host.enqueue({
            type: 'wait_retry',
            reason: 'missing_chat_entrance',
            delayMs: this.retryDelayMs
          })
          break
        }

        ctx.host.logInput('thinking', '检测到未读消息，正在尝试打开会话')
        ctx.host.trace({
          phase: 'act',
          summary: '点击未读会话入口',
          action: { kind: 'click', target: chatEntranceCoords },
          outcome: { status: 'ok' },
          usage: unread.usage
        })
        await this.device.activeUnreadByClick(chatEntranceCoords)
        await this.sleep(150 + Math.random() * 100)

        const openResult = await this.tryOpenUnreadConversation(ctx)
        if (openResult === 'opened') {
          ctx.host.enqueue({ type: 'observe_chat' })
          break
        }

        ctx.host.enqueue({
          type: 'wait_retry',
          reason: openResult,
          delayMs: this.retryDelayMs
        })
        break
      }

      case 'wait_retry':
        ctx.host.log('skip', '等待下一轮未读检测')
        ctx.host.schedule(
          event.reason === 'provider_error' ? { type: 'observe_chat' } : { type: 'check_unread' },
          event.delayMs ?? this.retryDelayMs
        )
        break
    }
  }

  private async handleTurn(
    action: TurnAction,
    screenshot: string,
    ctx: ChannelContext<GenericChannelState>
  ): Promise<void> {
    const plan = planObserve(action)
    if (plan.kind === 'legacy') {
      await this.forwardProviderEvents(screenshot, ctx)
      return
    }
    if (plan.kind === 'advance') {
      ctx.host.log(plan.logType, plan.message)
      ctx.host.trace({
        phase: 'think',
        summary: plan.message,
        outcome: { status: plan.logType === 'skip' ? 'skip' : 'ok' }
      })
      if (action.type === 'skip' && action.retry) {
        if (action.reason === '额度用尽' || action.reason === '请先激活许可证') {
          await ctx.host.stopSession('quota')
          return
        }
        ctx.host.enqueue({
          type: 'wait_retry',
          reason: 'vision_error',
          delayMs: this.retryDelayMs
        })
        return
      }
      await this.advance(ctx)
      return
    }
    if (plan.kind === 'sendFixed' && action.type === 'fixed') {
      const body = action.text.trim()
      const answer = await this.shift!.confirmDraft({
        key: action.key,
        title: action.title,
        text: body || (action.imagePath ? '［图片］' : ''),
        knowledgeTitles: [],
        imagePath: action.imagePath
      })
      if (!ctx.host.isRunning()) return
      await this.finishConfirmed(planConfirm(answer), ctx, {
        key: action.key,
        title: action.title,
        kind: action.kind,
        imagePath: action.imagePath,
        originalText: body
      }, (sent) => {
        ctx.host.logInput('reply', sent || '已发送图片')
        ctx.host.trace({
          phase: 'act',
          summary: '发送指定素材',
          action: { kind: 'send', payload: sent || action.imagePath },
          outcome: { status: 'ok' }
        })
      })
      return
    }
    if (plan.kind === 'generate' && action.type === 'reply') {
      await this.generateAndConfirm(action, screenshot, ctx)
    }
  }

  private async generateAndConfirm(
    action: Extract<TurnAction, { type: 'reply' }>,
    screenshot: string,
    ctx: ChannelContext<GenericChannelState>
  ): Promise<void> {
    const text = await this.collectReply(action, screenshot, ctx)
    if (!ctx.host.isRunning()) return
    if (text == null) {
      if (!this.replyFailed) {
        ctx.host.log('skip', '本轮无需回复')
        this.traceDeferredThink(ctx)
        await this.advance(ctx)
      }
      return
    }

    const answer = await this.shift!.confirmDraft({
      key: action.key,
      title: action.title,
      text,
      knowledgeTitles: action.knowledgeTitles
    })
    if (!ctx.host.isRunning()) return
    await this.finishConfirmed(planConfirm(answer), ctx, {
      key: action.key,
      title: action.title,
      kind: action.kind,
      imagePath: '',
      originalText: text
    }, (sent) => {
      ctx.host.logInput('reply', sent)
      const claimedByThink = this.traceDeferredThink(ctx)
      ctx.host.trace({
        phase: 'act',
        summary: '发送回复',
        action: { kind: 'send', payload: sent },
        outcome: { status: 'ok' },
        claimPendingUsage: !claimedByThink
      })
    })
  }

  private async finishConfirmed(
    plan: ReturnType<typeof planConfirm>,
    ctx: ChannelContext<GenericChannelState>,
    target: {
      key: string
      title: string
      kind: ConversationKind
      imagePath: string
      originalText: string
    },
    onSent: (text: string) => void
  ): Promise<void> {
    if (plan.kind === 'send') {
      const text = plan.text === '［图片］' && !target.originalText ? '' : plan.text
      const ok = await this.sendComposed(text, target.imagePath, target.key, target.title, ctx)
      if (!ok || !ctx.host.isRunning()) return
      this.shift?.recordSent(target.key, target.title, target.kind, text || '［图片］')
      onSent(text)
      await this.advance(ctx)
      return
    }

    if (plan.handoff) {
      await this.shift?.handOff(target.key, target.title, target.kind, '人在确认层转人工')
    }
    if (plan.bad) {
      this.shift?.noteBad(target.key, target.title, target.kind, target.originalText, plan.bad)
    }
    if (plan.idle) {
      this.shift?.noteIdle(target.key, target.title, plan.message)
    }
    ctx.host.log(plan.logType, plan.message)
    await this.advance(ctx)
  }

  private async collectReply(
    action: Extract<TurnAction, { type: 'reply' }>,
    screenshot: string,
    ctx: ChannelContext<GenericChannelState>
  ): Promise<string | null> {
    this.replyFailed = false
    let text: string | null = null
    try {
      for await (const event of ctx.host.runProvider({
        screenshot,
        appType: ctx.appType,
        currentContact: action.title,
        historyText: action.historyText,
        knowledgeText: action.knowledgeText
      })) {
        if (!ctx.host.isRunning()) return null
        if (event.type === 'thinking') {
          ctx.host.log('thinking', event.content)
          this.deferredThink = event.content
        } else if (event.type === 'reply_text') {
          text = event.content
        } else if (event.type === 'skip') {
          text = null
        } else if (event.type === 'error') {
          this.replyFailed = true
          ctx.host.enqueue({ type: 'provider.error', error: event.error })
          return null
        }
      }
    } catch (error: unknown) {
      this.replyFailed = true
      const message = error instanceof Error ? error.message : String(error)
      ctx.host.enqueue({ type: 'provider.error', error: message })
      return null
    }
    return text
  }

  private async sendComposed(
    text: string,
    imagePath: string,
    key: string,
    title: string,
    ctx: ChannelContext<GenericChannelState>
  ): Promise<boolean> {
    if (!text && !imagePath) return true
    if (this.shift) {
      const same = await this.shift.stillOn(key)
      if (!ctx.host.isRunning()) return false
      if (!same) {
        ctx.host.log('thinking', '窗口已经换了人，这条先不发')
        ctx.host.enqueue({ type: 'observe_chat' })
        return false
      }
    }
    const policy = this.shift?.pacing()
    const alive = (): boolean => ctx.host.isRunning()
    try {
      if (imagePath) {
        if (!this.device.sendImage) throw new Error('当前方式发不了图片')
        await this.device.sendImage(imagePath, policy, alive)
      }
      if (text) await this.device.sendMessage(text, policy, alive)
      return true
    } catch (error: unknown) {
      if (!ctx.host.isRunning() || (error instanceof Error && error.name === 'SendAborted')) return false
      const message = error instanceof Error ? error.message : String(error)
      ctx.host.logInput('error', `发送没有完成：${message}`)
      this.shift?.noteIdle(key, title, '发送没有完成')
      await this.advance(ctx)
      return false
    }
  }

  private async advance(ctx: ChannelContext<GenericChannelState>): Promise<void> {
    await this.device.setChatBaseline()
    ctx.state.latestChatBaseline = Date.now()
    ctx.host.enqueue({ type: 'check_unread' })
  }

  private async forwardProviderEvents(
    screenshot: string,
    ctx: ChannelContext<GenericChannelState>
  ): Promise<void> {
    try {
      for await (const event of ctx.host.runProvider({
        screenshot,
        appType: ctx.appType
      })) {
        if (!ctx.host.isRunning()) break

        const sessionEvent = this.mapProviderEvent(event)
        if (sessionEvent) {
          ctx.host.enqueue(sessionEvent)
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.host.enqueue({ type: 'provider.error', error: message })
    }
  }

  private mapProviderEvent(event: ProviderEvent): SessionEvent | null {
    switch (event.type) {
      case 'thinking':
        return { type: 'provider.thinking', content: event.content }
      case 'reply_text':
        return { type: 'provider.reply_text', content: event.content }
      case 'skip':
        return { type: 'provider.skip' }
      case 'error':
        return { type: 'provider.error', error: event.error }
      default:
        return null
    }
  }

  private resetState(state: GenericChannelState): void {
    state.measuredAt = null
    state.latestChatBaseline = null
  }

  private async tryOpenUnreadConversation(
    ctx: ChannelContext<GenericChannelState>
  ): Promise<'opened' | 'contact_not_ready'> {
    const visionUsages: Array<StepUsage | undefined> = []
    const contact = await captureUsage(() => this.device.isChatContactUnread())
    visionUsages.push(contact.usage)
    let contactResult = contact.value

    if (!contactResult.isUnread) {
      ctx.host.log('thinking', '当前会话没有新消息，正在重新检测...')
      await this.sleep(1000)

      const recheck = await captureUsage(() => this.device.hasUnreadMessage())
      visionUsages.push(recheck.usage)
      const recheckResult = recheck.value
      const recheckCoords = recheckResult.chatEntranceArea?.coordinates

      if (!recheckResult.hasUnread || !recheckCoords) {
        ctx.host.log('skip', '重新检测后无未读消息，等待下一轮')
        return 'contact_not_ready'
      }

      ctx.host.logInput('thinking', '仍检测到未读消息，正在再次尝试打开会话')
      await this.device.activeUnreadByClick(recheckCoords)
      await this.sleep(500)
      const contactAgain = await captureUsage(() => this.device.isChatContactUnread())
      visionUsages.push(contactAgain.usage)
      contactResult = contactAgain.value
    }

    if (!contactResult.isUnread) {
      this.consecutiveUnreadFailures += 1

      if (this.consecutiveUnreadFailures >= 3) {
        ctx.host.log(
          'thinking',
          `连续 ${this.consecutiveUnreadFailures} 次检测失败，正在重置未读识别状态`
        )
        this.device.clearUnreadCache()
        this.consecutiveUnreadFailures = 0
        await this.sleep(500)

        const contactAfterReset = await captureUsage(() => this.device.isChatContactUnread())
        visionUsages.push(contactAfterReset.usage)
        contactResult = contactAfterReset.value
        if (!contactResult.isUnread) {
          ctx.host.logInput('thinking', '重置后仍未成功，正在再次尝试打开会话')
          const retryUnreadCaptured = await captureUsage(() => this.device.hasUnreadMessage())
          visionUsages.push(retryUnreadCaptured.usage)
          const retryUnread = retryUnreadCaptured.value
          const retryCoords = retryUnread.chatEntranceArea?.coordinates

          if (!retryUnread.hasUnread || !retryCoords) {
            ctx.host.log('skip', '重置后仍未找到可用会话入口，等待下一轮')
            return 'contact_not_ready'
          }

          await this.device.activeUnreadByClick(retryCoords)
          await this.sleep(500)
          const contactAfterRetry = await captureUsage(() => this.device.isChatContactUnread())
          visionUsages.push(contactAfterRetry.usage)
          contactResult = contactAfterRetry.value

          if (!contactResult.isUnread) {
            ctx.host.log('skip', '最终检测仍失败，放弃当前轮未读切换')
            return 'contact_not_ready'
          }
        }
      } else {
        ctx.host.log(
          'skip',
          `会话切换检测失败（第 ${this.consecutiveUnreadFailures} 次），等待下一轮`
        )
        return 'contact_not_ready'
      }
    }

    this.consecutiveUnreadFailures = 0

    if (!contactResult.firstContactCoords) {
      ctx.host.log('skip', '未找到联系人位置，等待下一轮')
      return 'contact_not_ready'
    }

    ctx.host.logInput('thinking', '正在打开未读会话')
    ctx.host.trace({
      phase: 'act',
      summary: '打开未读会话',
      action: { kind: 'click', target: contactResult.firstContactCoords },
      outcome: { status: 'ok' },
      usage: mergeStepUsage(visionUsages)
    })
    await this.device.clickUnreadContact(contactResult.firstContactCoords)
    await this.sleep(500 + Math.random() * 300)
    this.device.clearChatBaseline()
    ctx.state.latestChatBaseline = null
    return 'opened'
  }

  /** 把请求前的「正在分析」落成轨迹，并领走这次 reply 的用量。没有延迟中的分析步时返回 false。 */
  private traceDeferredThink(ctx: ChannelContext<GenericChannelState>): boolean {
    const summary = this.deferredThink
    if (!summary) return false
    this.deferredThink = null
    ctx.host.trace({
      phase: 'think',
      summary,
      reasoning: { content: summary },
      claimPendingUsage: true
    })
    return true
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
