import { dialog, IpcMain, BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { AIClient } from '../core/ai-client'
import { activateLicense, capabilityFromConfig, mapUpstreamFailure } from '../core/gateway/capability'
import { readKnowledgeFile } from '../core/knowledge/read-file'
import { ExperienceStore } from '../core/memory/experience-store'
import { conversationKey, type ConversationKind } from '../core/memory/conversation-key'
import { AppType } from '../core/rpa/types'
import { detectWechatLayout, getLayoutCache } from '../core/rpa/vision-utils'
import type { AgentProfile } from '../core/shift/agents'
import type { DraftAnswer, DraftPayload, ShiftController } from '../core/shift/controller'
import { decideTurn, effectiveMode, type TurnAction } from '../core/shift/decide-turn'
import { DEFAULT_PACING, type PacingPolicy } from '../core/shift/pacing'
import { applyHandedOff, buildShiftReport, endOfLocalDay, reportToCsv, startOfLocalDay } from '../core/shift/report'
import { readScreen } from '../core/shift/screen-reader'
import { ColdEntry, ShiftStore, type TurnRow } from '../core/shift/store'
import { handoffNotice, postWebhook } from '../core/shift/webhook'
import { isCommercialBuild } from './commercial'

const QUIET_SKIP_REASONS = new Set(['已转人工', '没有新的对方消息', '对方只是应了一声'])

export interface DutySettingsView {
  licenseCode: string
  gatewayUrl: string
  allowAuto: boolean
  inputBackend: 'software' | 'usb'
  appType: AppType
  visionApiKey: string
  replyApiKey: string
  systemPrompt: string
}

interface DutyHost {
  getSettings(): DutySettingsView
  patchSettings(partial: Partial<Pick<DutySettingsView, 'licenseCode' | 'gatewayUrl' | 'allowAuto' | 'inputBackend'>>): void
  experience(): ExperienceStore
}

export class DutyService implements ShiftController {
  private readonly store: ShiftStore
  /** undefined：还没启动引擎，看屏时按设置现造一个客户端。null：这一轮明确没有看屏密钥。 */
  private pinnedVision: AIClient | null | undefined = undefined
  private pendingConfirm: ((answer: DraftAnswer) => void) | null = null
  private lastIdentity: { key: string; title: string; kind: ConversationKind; stable: boolean } | null = null
  private nameCheckPassed = false

  constructor(
    dbPath: string,
    private readonly host: DutyHost
  ) {
    this.store = ShiftStore.open(dbPath)
    this.store.seedAgents(host.getSettings().systemPrompt)
  }

  register(ipc: IpcMain): void {
    ipc.handle('duty:snapshot', () => this.snapshot())
    ipc.handle('duty:saveAgent', (_event, agent: AgentProfile) => {
      this.store.saveAgent(agent)
      return this.snapshot()
    })
    ipc.handle('duty:enableAgent', (_event, id: string) => {
      this.store.enableAgent(id)
      return this.snapshot()
    })
    ipc.handle('duty:createAgent', () => {
      const created = this.store.createAgent()
      return { ok: true, id: created.id, snapshot: this.snapshot() }
    })
    ipc.handle('duty:copyAgent', (_event, id: string) => {
      const copied = this.store.copyAgent(id)
      return { ...copied, snapshot: this.snapshot() }
    })
    ipc.handle('duty:disableAgent', (_event, id: string) => {
      const disabled = this.store.disableAgent(id)
      return { ...disabled, snapshot: this.snapshot() }
    })
    ipc.handle('duty:deleteAgent', (_event, id: string) => {
      const removed = this.store.deleteAgent(id)
      return { ...removed, snapshot: this.snapshot() }
    })
    ipc.handle('duty:addCold', (_event, input: { title?: string; kind?: ConversationKind; note?: string }) => {
      const kind = input.kind === 'group' ? 'group' : 'single'
      const key = conversationKey(kind, input.title || '')
      if (!key) return { ok: false, message: '名称是空的' }
      const entry: ColdEntry = {
        key,
        title: input.title?.trim() || key,
        kind,
        note: input.note?.trim() || '',
        createdAt: Date.now()
      }
      this.store.addCold(entry)
      return { ok: true, snapshot: this.snapshot() }
    })
    ipc.handle('duty:coldCurrent', () => {
      const current = this.lastIdentity
      if (!current?.stable) return { ok: false, message: '还没确认当前会话是谁' }
      this.store.addCold({
        key: current.key,
        title: current.title,
        kind: current.kind,
        note: '',
        createdAt: Date.now()
      })
      return { ok: true, snapshot: this.snapshot() }
    })
    ipc.handle('duty:removeCold', (_event, key: string) => {
      this.store.removeCold(key)
      return this.snapshot()
    })
    ipc.handle('duty:confirm', (_event, answer: DraftAnswer) => {
      this.pendingConfirm?.(answer)
      this.pendingConfirm = null
      return { ok: true }
    })
    ipc.handle('duty:allowAuto', (_event, allow: boolean) => {
      if (allow === true && !this.nameCheckPassed) {
        return { ok: false, message: '先核对当前窗口，确认名称无误后再允许自动发送' }
      }
      this.host.patchSettings({ allowAuto: allow === true })
      const agent = this.store.activeAgent()
      this.store.saveAgent({ ...agent, mode: allow === true ? 'auto' : 'assist' }, false)
      return { ok: true, snapshot: this.snapshot() }
    })
    ipc.handle('duty:setConnection', (_event, input: { licenseCode?: string; gatewayUrl?: string }) => {
      const licenseCode = input.licenseCode?.trim() || ''
      if (licenseCode) {
        const activated = activateLicense(licenseCode)
        if (!activated.ok) return { ok: false, message: activated.message }
      }
      this.host.patchSettings({ licenseCode, gatewayUrl: input.gatewayUrl?.trim() || '' })
      return { ok: true, snapshot: this.snapshot() }
    })
    ipc.handle('duty:setInputBackend', (_event, backend: 'software' | 'usb') => {
      this.host.patchSettings({ inputBackend: backend === 'usb' ? 'usb' : 'software' })
      return this.snapshot()
    })
    ipc.handle('duty:probe', async () => this.probe())
    ipc.handle('duty:pickKnowledge', async () => this.pickKnowledge())
    ipc.handle('duty:removeKnowledge', (_event, fileName: string) => {
      this.store.removeKnowledgeFile(this.store.activeAgent().id, fileName)
      return this.snapshot()
    })
    ipc.handle('duty:resume', (_event, key: string) => {
      this.store.resume(key)
      return this.report()
    })
    ipc.handle('duty:turns', (_event, key: string) => this.store.listTurns(key))
    ipc.handle('duty:clearTurns', (_event, key: string) => {
      this.store.clearTurns(key)
      return { ok: true }
    })
    ipc.handle('duty:pickImage', async () => {
      const picked = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
      })
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, message: '已取消' }
      return { ok: true, path: picked.filePaths[0] }
    })
    ipc.handle('duty:report', () => this.report())
    ipc.handle('duty:exportReport', async () => this.exportReport())
  }

  setVisionClient(client: AIClient | null): void {
    this.pinnedVision = client
  }

  activeAgent(): AgentProfile {
    return this.store.activeAgent()
  }

  async prepare(appType: AppType): Promise<TurnAction> {
    const vision = this.visionClient()
    if (!vision) return { type: 'legacy' }
    const agent = this.store.activeAgent()
    let screen
    try {
      screen = await readScreen(vision, appType)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { type: 'skip', reason: this.sanitizeError(message || '看屏失败'), added: [], retry: true }
    }

    const action = decideTurn({
      screen,
      stored: this.storedFor(screen),
      coldKeys: this.store.listCold().map((entry) => entry.key),
      handedOff: this.handedOffFor(screen),
      agent,
      sentThisHour: this.store.sentCountSince(startOfHour(new Date())),
      now: new Date(),
      recentOut: this.recentOutFor(screen),
      badCount: this.badCountFor(screen),
      knowledge: this.store.knowledgeChunks(agent.id),
      handledInbound: this.handledFor(screen)
    })

    this.rememberIdentity(action, screen.boxSelect)
    if (action.type === 'reply' || action.type === 'skip' || action.type === 'handoff' || action.type === 'fixed') {
      if (action.key && action.added.length > 0 && action.kind) {
        this.store.appendTurns(action.key, action.title || action.key, action.kind, action.added, 'vision')
      }
    }
    if (action.type === 'skip' && action.key && !action.retry && !QUIET_SKIP_REASONS.has(action.reason)) {
      this.store.addEvent({
        key: action.key,
        title: action.title || action.key,
        at: Date.now(),
        kind: action.reason === '冷处理' ? 'cold' : 'skipped',
        reason: action.reason
      })
    }
    if (action.type === 'review') {
      this.store.addEvent({
        key: action.key,
        title: action.title,
        at: Date.now(),
        kind: 'pending',
        reason: action.reason
      })
    }
    if (action.type === 'handoff') {
      if (action.anchor && action.anchor.length > 0) {
        this.store.setHandledInbound(action.key, action.title, action.kind, action.anchor)
      }
      await this.finishHandoff(action.key, action.title, action.kind, action.reason)
    }
    return action
  }

  confirmDraft(draft: DraftPayload): Promise<DraftAnswer> {
    if (this.mode() === 'auto') return Promise.resolve({ action: 'send', text: draft.text })
    this.broadcast('duty:draft', draft)
    return new Promise((resolve) => {
      this.pendingConfirm = resolve
    })
  }

  async stillOn(key: string): Promise<boolean> {
    const vision = this.visionClient()
    if (!vision) return false
    try {
      const screen = await readScreen(vision, this.host.getSettings().appType)
      return this.keyOf(screen) === key
    } catch {
      return false
    }
  }

  cancelPending(): void {
    this.pendingConfirm?.({ action: 'discard' })
    this.pendingConfirm = null
  }

  recordSent(key: string, title: string, kind: ConversationKind, text: string): void {
    this.store.appendTurns(key, title, kind, [{ side: 'out', text }], 'sent')
    this.store.resetBad(key)
    this.store.addEvent({ key, title, at: Date.now(), kind: 'replied', reason: '已回复' })
  }

  noteIdle(key: string, title: string, reason: string): void {
    this.store.addEvent({ key, title, at: Date.now(), kind: 'pending', reason })
  }

  async handOff(key: string, title: string, kind: ConversationKind, reason: string): Promise<void> {
    await this.finishHandoff(key, title, kind, reason)
  }

  noteBad(key: string, title: string, kind: ConversationKind, reply: string, reason: string): void {
    const count = this.store.bumpBad(key, title, kind)
    this.host.experience().addCards([
      {
        scenario: `会话「${title}」里这种回复不合适`,
        guidance: `不要再这样回复：${reply}`,
        rationale: reason,
        source: 'human_takeover'
      }
    ])
    this.store.addEvent({ key, title, at: Date.now(), kind: 'pending', reason: `这条不行：${reason}` })
    if (count >= 2) {
      void this.finishHandoff(key, title, kind, '连续否定').catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        try {
          this.store.addEvent({
            key,
            title,
            at: Date.now(),
            kind: 'pending',
            reason: `转人工没有完成：${message}`
          })
        } catch (writeError: unknown) {
          const detail = writeError instanceof Error ? writeError.message : String(writeError)
          console.error('[noteBad] 转人工没有完成', message, detail)
        }
      })
    }
  }

  pacing(): PacingPolicy {
    return this.store.activeAgent().pacing ?? DEFAULT_PACING
  }

  mode(): 'assist' | 'auto' {
    return effectiveMode(this.store.activeAgent(), this.host.getSettings().allowAuto, this.nameCheckPassed)
  }

  inputBackend(): 'software' | 'usb' {
    return this.host.getSettings().inputBackend === 'usb' ? 'usb' : 'software'
  }

  sanitizeError(message: string): string {
    const status = /failed:\s*(\d+)/i.exec(message)
    const mapped = mapUpstreamFailure({
      httpStatus: status ? Number(status[1]) : undefined,
      message,
      activated: this.licenseActive(),
      commercial: isCommercialBuild()
    })
    if (!isCommercialBuild() && mapped.state === 'unavailable' && !status) return message
    return mapped.text
  }

  private async finishHandoff(key: string, title: string, kind: ConversationKind, reason: string): Promise<void> {
    this.store.setHandedOff(key, title, kind, true)
    const agent = this.store.activeAgent()
    let noticeReason = reason
    if (agent.webhookUrl.trim()) {
      const posted = await postWebhook(agent.webhookUrl, agent.webhookKind, handoffNotice(title, reason, new Date()))
      if (!posted.ok) noticeReason = `${reason}（通知没发出去，会话仍暂停）`
    }
    this.store.addEvent({ key, title, at: Date.now(), kind: 'handoff', reason: noticeReason })
  }

  private async probe(): Promise<{ ok: boolean; message: string; detail?: string }> {
    const vision = this.visionClient()
    if (!vision) {
      this.nameCheckPassed = false
      return { ok: false, message: '看屏还不可用' }
    }
    const appType = this.host.getSettings().appType
    try {
      const cached = getLayoutCache(appType)
      const boxed = cached?.chatMainArea?.source === 'box-select'
      if (!boxed) {
        const layout = await detectWechatLayout(vision, appType)
        if (!layout.success) {
          this.nameCheckPassed = false
          return { ok: false, message: this.sanitizeError(layout.error || '没有框到标题栏') }
        }
      }
      const screen = await readScreen(vision, appType)
      const lines = screen.bubbles.map((bubble) => `${bubble.side}: ${bubble.text}`).join('\n')
      if (screen.boxSelect) {
        this.nameCheckPassed = false
        return {
          ok: false,
          message: '框选模式只有一份「当前窗口」记忆',
          detail: lines || '没有读到气泡'
        }
      }
      const title = screen.identity?.title || '没读到名称'
      const confidence = screen.identity?.confidence || 'low'
      const ok = confidence === 'high'
      this.nameCheckPassed = ok
      return {
        ok,
        message: `读到「${title}」，${screen.identity?.kind === 'group' ? '群' : '单聊'}，${confidence === 'high' ? '置信' : '不确定'}`,
        detail: lines || '没有读到气泡'
      }
    } catch (error) {
      this.nameCheckPassed = false
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message: this.sanitizeError(message) }
    }
  }

  private async pickKnowledge(): Promise<{ ok: boolean; message?: string; snapshot?: ReturnType<DutyService['snapshot']> }> {
    const agent = this.store.activeAgent()
    if (this.store.knowledgeFileNames(agent.id).length >= 30) {
      return { ok: false, message: '一个知识包最多 30 个文件' }
    }
    const picked = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '资料', extensions: ['md', 'txt', 'markdown', 'pdf'] }]
    })
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, message: '已取消' }
    try {
      const loaded = await readKnowledgeFile(picked.filePaths[0])
      if (loaded.chunks.length === 0) return { ok: false, message: '文件里没有可用文字' }
      this.store.addKnowledgeFile(agent.id, loaded.fileName, loaded.chunks)
      return { ok: true, snapshot: this.snapshot() }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  private todayRows(): ReturnType<typeof buildShiftReport> {
    const now = new Date()
    return applyHandedOff(
      buildShiftReport(this.store.eventsBetween(startOfLocalDay(now), endOfLocalDay(now))),
      this.store.listHandedOff()
    )
  }

  private report(): { rows: ReturnType<typeof buildShiftReport> } {
    return { rows: this.todayRows() }
  }

  private async exportReport(): Promise<{ ok: boolean; message?: string }> {
    const rows = this.todayRows()
    const picked = await dialog.showSaveDialog({ defaultPath: 'shift-report.csv' })
    if (picked.canceled || !picked.filePath) return { ok: false, message: '已取消' }
    await writeFile(picked.filePath, reportToCsv(rows), 'utf8')
    return { ok: true }
  }

  private snapshot(): {
    agents: AgentProfile[]
    activeAgentId: string
    cold: ColdEntry[]
    allowAuto: boolean
    commercial: boolean
    licenseCode: string
    gatewayUrl: string
    seeText: string
    replyText: string
    knowledgeFiles: string[]
    hourlySent: number
    hourlyLimit: number
    inputBackend: 'software' | 'usb'
    usbReady: false
    mode: 'assist' | 'auto'
    current: { key: string; title: string; kind: ConversationKind; stable: boolean } | null
  } {
    const settings = this.host.getSettings()
    const agents = this.store.listAgents()
    const active = this.store.activeAgent()
    const status = capabilityFromConfig({
      commercial: isCommercialBuild(),
      activated: this.licenseActive(),
      hasVisionKey: Boolean(settings.visionApiKey),
      hasReplyKey: Boolean(settings.replyApiKey || settings.visionApiKey || settings.gatewayUrl),
      gatewayUrl: settings.gatewayUrl
    })
    return {
      agents,
      activeAgentId: active.id,
      cold: this.store.listCold(),
      allowAuto: settings.allowAuto,
      commercial: isCommercialBuild(),
      licenseCode: settings.licenseCode,
      gatewayUrl: settings.gatewayUrl,
      seeText: status.seeText,
      replyText: status.replyText,
      knowledgeFiles: this.store.knowledgeFileNames(active.id),
      hourlySent: this.store.sentCountSince(startOfHour(new Date())),
      hourlyLimit: active.hourlyLimit,
      inputBackend: settings.inputBackend,
      usbReady: false,
      mode: this.mode(),
      current: this.lastIdentity
    }
  }

  private licenseActive(): boolean {
    return activateLicense(this.host.getSettings().licenseCode).ok
  }

  private visionClient(): AIClient | null {
    if (this.pinnedVision !== undefined) return this.pinnedVision
    return this.buildFromSettings()
  }

  private buildFromSettings(): AIClient | null {
    const settings = this.host.getSettings()
    const gateway = settings.gatewayUrl.trim()
    const key = gateway
      ? settings.licenseCode.trim() || settings.visionApiKey.trim()
      : settings.visionApiKey.trim()
    if (!key) return null
    return new AIClient({ apiKey: key, baseURL: gateway || undefined })
  }

  private storedFor(screen: { boxSelect: boolean; appType: string; identity: { title: string; kind: 'single' | 'group'; confidence: 'high' | 'low' } | null }): TurnRow[] {
    const key = this.keyOf(screen)
    return key ? this.store.listTurns(key) : []
  }

  private handedOffFor(screen: { boxSelect: boolean; appType: string; identity: { title: string; kind: 'single' | 'group'; confidence: 'high' | 'low' } | null }): boolean {
    const key = this.keyOf(screen)
    return key ? this.store.isHandedOff(key) : false
  }

  private recentOutFor(screen: { boxSelect: boolean; appType: string; identity: { title: string; kind: 'single' | 'group'; confidence: 'high' | 'low' } | null }): string[] {
    const key = this.keyOf(screen)
    return key ? this.store.recentOut(key, 2) : []
  }

  private handledFor(screen: { boxSelect: boolean; appType: string; identity: { title: string; kind: 'single' | 'group'; confidence: 'high' | 'low' } | null }): string[] {
    const key = this.keyOf(screen)
    return key ? this.store.handledInbound(key) : []
  }

  private badCountFor(screen: { boxSelect: boolean; appType: string; identity: { title: string; kind: 'single' | 'group'; confidence: 'high' | 'low' } | null }): number {
    const key = this.keyOf(screen)
    return key ? this.store.badCount(key) : 0
  }

  private keyOf(screen: { boxSelect: boolean; appType: string; identity: { title: string; kind: 'single' | 'group'; confidence: 'high' | 'low' } | null }): string | null {
    if (screen.boxSelect) return `window:${screen.appType}`
    if (!screen.identity || screen.identity.confidence !== 'high') return null
    return conversationKey(screen.identity.kind, screen.identity.title)
  }

  private rememberIdentity(action: TurnAction, boxSelect: boolean): void {
    if (action.type === 'legacy' || !('key' in action) || !action.key) {
      this.lastIdentity = null
      this.broadcast('duty:identity', null)
      return
    }
    const kind = 'kind' in action && action.kind ? action.kind : boxSelect ? 'window' : 'single'
    this.lastIdentity = {
      key: action.key,
      title: 'title' in action && action.title ? action.title : action.key,
      kind,
      stable: true
    }
    this.broadcast('duty:identity', this.lastIdentity)
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }
}

function startOfHour(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours()).getTime()
}

export function applyAgentPrompt(config: Record<string, unknown>, agent: AgentProfile): Record<string, unknown> {
  const next = { ...config }
  if (agent.prompt.trim()) next.systemPrompt = agent.prompt
  return next
}
