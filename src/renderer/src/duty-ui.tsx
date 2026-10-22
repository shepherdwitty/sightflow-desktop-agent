import { useCallback, useEffect, useState } from 'react'

type Kind = 'single' | 'group' | 'window'
type PacingSpeed = 'steady' | 'natural' | 'slow'
type TypoLevel = 'off' | 'low' | 'mid'

interface MaterialRule {
  keyword: string
  text: string
  imagePath: string
}

interface AgentProfile {
  id: string
  name: string
  template: 'store' | 'course' | 'team' | 'custom'
  prompt: string
  groupReply: 'all' | 'mention'
  blacklist: string[]
  whitelistEnabled: boolean
  whitelist: string[]
  handoffKeywords: string[]
  webhookUrl: string
  webhookKind: 'wecom' | 'feishu'
  mode: 'assist' | 'auto'
  historyLimit: number
  pacing: {
    enabled: boolean
    readBeforeType: boolean
    segmentLong: boolean
    speed: PacingSpeed
    typo: TypoLevel
  }
  hourlyLimit: number
  workHoursEnabled: boolean
  workStart: string
  workEnd: string
  materialRules: MaterialRule[]
}

interface ColdEntry {
  key: string
  title: string
  kind: Kind
  note: string
}

interface Identity {
  key: string
  title: string
  kind: Kind
  stable: boolean
}

interface DraftPayload {
  key: string
  title: string
  text: string
  knowledgeTitles: string[]
}

interface DutySnapshot {
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
  usbReady: boolean
  mode: 'assist' | 'auto'
  current: Identity | null
}

interface ReportRow {
  key: string
  title: string
  status: 'pending' | 'handoff' | 'done'
  reason: string
  at: number
}

interface TurnRow {
  side: 'in' | 'out' | 'system'
  text: string
  at: number
}

const STATUS_LABEL = { pending: '待处理', handoff: '已转人工', done: '已处理' }
const KIND_LABEL: Record<Kind, string> = { single: '单聊', group: '群', window: '当前窗口' }
const BAD_REASONS = ['事实错误', '语气不像', '不该发', '其他']

async function dutyInvoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return (await window.electron?.invoke(channel, ...args)) as T
}

function useSnapshot(reloadKey = 0): {
  snapshot: DutySnapshot | null
  reload: () => void
} {
  const [snapshot, setSnapshot] = useState<DutySnapshot | null>(null)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((value) => value + 1), [])
  useEffect(() => {
    let cancelled = false
    void dutyInvoke<DutySnapshot>('duty:snapshot').then((next) => {
      if (!cancelled && next) setSnapshot(next)
    })
    return () => {
      cancelled = true
    }
  }, [tick, reloadKey])
  return { snapshot, reload }
}

type UsbBannerState = 'checking' | 'absent' | 'plugged' | 'active'

export function UsbStatusBanner(): React.JSX.Element {
  const [ready, setReady] = useState<boolean | null>(null)
  const [backend, setBackend] = useState<'software' | 'usb' | null>(null)

  useEffect(() => {
    let stopped = false
    let pending = false
    const apply = (next: { usbReady?: boolean; inputBackend?: 'software' | 'usb' } | null | undefined): void => {
      if (!next || stopped) return
      if (typeof next.usbReady === 'boolean') setReady(next.usbReady)
      if (next.inputBackend === 'usb' || next.inputBackend === 'software') setBackend(next.inputBackend)
    }
    const tick = async (): Promise<void> => {
      if (pending) return
      pending = true
      try {
        const next = await dutyInvoke<{ usbReady: boolean; inputBackend: 'software' | 'usb' }>('duty:refreshUsb')
        apply(next)
      } catch {
        // 下一轮再探，避免把一次失败画成没插上。
      } finally {
        pending = false
      }
    }
    void tick()
    const timer = setInterval(() => {
      void tick()
    }, 4000)
    const off = window.electron?.on(
      'duty:input',
      (payload: { usbReady: boolean; inputBackend: 'software' | 'usb' }) => {
        apply(payload)
      }
    )
    return () => {
      stopped = true
      clearInterval(timer)
      off?.()
    }
  }, [])

  const selected = backend === 'usb'
  const state: UsbBannerState = ready == null ? 'checking' : !ready ? 'absent' : selected ? 'active' : 'plugged'
  const title =
    state === 'checking'
      ? '正在确认 USB'
      : state === 'absent'
        ? 'USB 没插上'
        : state === 'plugged'
          ? 'USB 已插上，未激活'
          : 'USB 已插上，已激活'
  const detail =
    state === 'checking'
      ? '稍等一下就知道设备在不在。'
      : state === 'absent' && selected
        ? 'USB 助理刚断开，这一条不会改用软件键鼠。'
        : state === 'absent'
          ? '当前使用软件键鼠。'
          : state === 'plugged'
            ? '设备已识别，当前仍使用软件键鼠。'
            : '鼠标和文字回复走 USB 助理。'

  return (
    <div className={`usb-status ${state}${state === 'absent' && selected ? ' held' : ''}`} role="status">
      <span className="usb-status-dot" />
      <span className="usb-status-copy">
        <span className="usb-status-title">{title}</span>
        <span className="usb-status-detail">{detail}</span>
      </span>
    </div>
  )
}

export function DutyCard({
  onToast
}: {
  onToast: (message: string, type: 'success' | 'error') => void
}): React.JSX.Element {
  const { snapshot, reload } = useSnapshot()
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [draft, setDraft] = useState<DraftPayload | null>(null)
  const [draftText, setDraftText] = useState('')
  const [badReason, setBadReason] = useState(BAD_REASONS[0])
  const [probeText, setProbeText] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const offIdentity = window.electron?.on('duty:identity', (next: Identity | null) => {
      setIdentity(next)
      reload()
    })
    const offDraft = window.electron?.on('duty:draft', (next: DraftPayload) => {
      setDraft(next)
      setDraftText(next.text)
      setBadReason(BAD_REASONS[0])
    })
    const offEngine = window.electron?.on('engine:state', (data: { status: string }) => {
      if (data.status !== 'running') setDraft(null)
    })
    return () => {
      offIdentity?.()
      offDraft?.()
      offEngine?.()
    }
  }, [reload])

  const current = identity ?? snapshot?.current ?? null
  const mode = snapshot?.mode === 'auto' ? '自动' : '辅助'

  const answer = async (payload: { action: string; text?: string; reason?: string }): Promise<void> => {
    await dutyInvoke('duty:confirm', payload)
    setDraft(null)
  }

  const coldCurrent = async (): Promise<void> => {
    const result = await dutyInvoke<{ ok: boolean; message?: string }>('duty:coldCurrent')
    if (!result?.ok) {
      onToast(result?.message || '还不能冷处理', 'error')
      return
    }
    onToast('这个会话已冷处理，AI 不再自动回复', 'success')
    reload()
  }

  const probe = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await dutyInvoke<{ ok: boolean; message: string; detail?: string }>('duty:probe')
      setProbeText([result?.message, result?.detail].filter(Boolean).join('\n'))
      onToast(result?.ok ? '名称核对通过' : result?.message || '没有核对通过', result?.ok ? 'success' : 'error')
      reload()
    } finally {
      setBusy(false)
    }
  }

  const toggleAuto = async (): Promise<void> => {
    const next = snapshot?.mode !== 'auto'
    if (next) {
      const agreed = window.confirm(
        '自动发送仍可能被平台限制。请先核对当前窗口里认出的名称。确认名称无误后，才允许自动发送。'
      )
      if (!agreed) return
    }
    const result = await dutyInvoke<{ ok: boolean; message?: string }>('duty:allowAuto', next)
    if (!result?.ok) {
      onToast(result?.message || '还不能自动发送', 'error')
      return
    }
    onToast(next ? '已允许自动发送' : '已回到辅助模式', 'success')
    reload()
  }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-title">当班</div>
      <div className="form-hint">
        {current?.stable ? `${KIND_LABEL[current.kind]} · ${current.title}` : '还没确认当前会话是谁'}
        {' · '}
        {mode}
        {' · 本小时 '}
        {snapshot?.hourlySent ?? 0}/{snapshot?.hourlyLimit ?? 30}
      </div>
      <div className="form-hint" style={{ marginTop: 6 }}>
        先用辅助模式核对认出的名称，确认无误后再允许自动发送。
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="btn btn-secondary" onClick={probe} disabled={busy}>
          {busy ? '核对中...' : '核对当前窗口'}
        </button>
        <button className="btn btn-secondary" onClick={toggleAuto}>
          {snapshot?.mode === 'auto' ? '改回辅助' : '允许自动发送'}
        </button>
        <button className="btn btn-secondary" onClick={coldCurrent} disabled={!current?.stable}>
          冷处理当前会话
        </button>
      </div>
      {probeText ? (
        <pre className="form-hint" style={{ marginTop: 8, whiteSpace: 'pre-wrap', maxHeight: 96, overflow: 'auto' }}>
          {probeText}
        </pre>
      ) : null}
      {draft ? (
        <div style={{ marginTop: 12 }}>
          <div className="form-label">给 {draft.title} 的草稿</div>
          {draft.knowledgeTitles.length > 0 ? (
            <div className="form-hint">用到的资料：{draft.knowledgeTitles.join('、')}</div>
          ) : null}
          <textarea
            className="form-input"
            rows={4}
            value={draftText}
            onChange={(event) => setDraftText(event.target.value)}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={() => answer({ action: 'send', text: draftText })}>
              发送
            </button>
            <button className="btn btn-secondary" onClick={() => answer({ action: 'discard' })}>
              丢弃
            </button>
            <button className="btn btn-secondary" onClick={() => answer({ action: 'handoff' })}>
              转人工
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <select className="form-input" value={badReason} onChange={(event) => setBadReason(event.target.value)}>
              {BAD_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {reason}
                </option>
              ))}
            </select>
            <button className="btn btn-secondary" onClick={() => answer({ action: 'bad', reason: badReason })}>
              这条不行
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function DutyShiftPage({
  onToast
}: {
  onToast: (message: string, type: 'success' | 'error') => void
}): React.JSX.Element {
  const { snapshot, reload } = useSnapshot()
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<Kind>('single')
  const [probeText, setProbeText] = useState('')

  useEffect(() => {
    let stopped = false
    let pending = false
    const tick = async (): Promise<void> => {
      if (pending) return
      pending = true
      try {
        await dutyInvoke('duty:refreshUsb')
        if (!stopped) reload()
      } finally {
        pending = false
      }
    }
    void tick()
    const timer = setInterval(() => {
      void tick()
    }, 4000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [reload])

  const addCold = async (): Promise<void> => {
    const result = await dutyInvoke<{ ok: boolean; message?: string }>('duty:addCold', { title, kind })
    if (!result?.ok) {
      onToast(result?.message || '名称是空的', 'error')
      return
    }
    setTitle('')
    reload()
  }

  const probe = async (): Promise<void> => {
    const result = await dutyInvoke<{ ok: boolean; message: string; detail?: string }>('duty:probe')
    setProbeText([result?.message, result?.detail].filter(Boolean).join('\n'))
    onToast(result?.ok ? '名称核对通过' : result?.message || '没有核对通过', result?.ok ? 'success' : 'error')
  }

  const setBackend = async (backend: 'software' | 'usb'): Promise<void> => {
    const result = await dutyInvoke<{ ok?: boolean; message?: string }>('duty:setInputBackend', backend)
    if (result && result.ok === false) onToast(result.message || '没有找到 USB 助理', 'error')
    reload()
  }

  return (
    <div className="settings-page slide-up">
      <div className="settings-page-header">
        <div>
          <h1>当班</h1>
          <p>冷处理只暂停你点名的会话。取消之后，原来的聊天记录还在，可以继续回复。</p>
        </div>
      </div>
      <div className="card">
        <div className="card-title">核对名称</div>
        <p className="form-hint">
          把微信放到前台，打开一个单聊，再打开一个标题里带人数的群。点核对后看读到的名称和气泡。这一步通过之前，自动发送保持关闭。
        </p>
        <button className="btn btn-primary" onClick={probe}>
          核对当前窗口
        </button>
        {probeText ? (
          <pre className="form-hint" style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>
            {probeText}
          </pre>
        ) : null}
      </div>
      <div className="card">
        <div className="card-title">冷处理名单</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="form-input"
            value={title}
            placeholder="微信标题，不含群人数"
            onChange={(event) => setTitle(event.target.value)}
          />
          <select className="form-input" value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
            <option value="single">单聊</option>
            <option value="group">群</option>
          </select>
          <button className="btn btn-secondary" onClick={addCold}>
            加入
          </button>
        </div>
        {(snapshot?.cold || []).map((entry) => (
          <div key={entry.key} style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
            <span>
              {KIND_LABEL[entry.kind]} · {entry.title}
            </span>
            <button
              className="btn btn-secondary"
              onClick={async () => {
                await dutyInvoke('duty:removeCold', entry.key)
                reload()
              }}
            >
              取消冷处理
            </button>
          </div>
        ))}
        {snapshot && snapshot.cold.length === 0 ? <div className="form-hint">还没有冷处理的会话。</div> : null}
      </div>
      <div className="card">
        <div className="card-title">输入</div>
        <p className="form-hint">
          USB 助理只更换输入设备，不改变发送频率。设备还没接上时，仍然用软件键鼠。云桌面没有物理 USB，这个选项保持不可用。
        </p>
        <label className="form-hint">
          <input
            type="radio"
            checked={snapshot?.inputBackend !== 'usb'}
            onChange={() => setBackend('software')}
          />{' '}
          软件键鼠
        </label>
        <label className="form-hint" style={{ marginLeft: 12 }}>
          <input
            type="radio"
            checked={snapshot?.inputBackend === 'usb'}
            disabled={!snapshot?.usbReady}
            onChange={() => {
              if (snapshot?.usbReady) void setBackend('usb')
            }}
          />{' '}
          {snapshot?.usbReady ? 'USB 助理' : 'USB 助理（未连接）'}
        </label>
        {snapshot?.inputBackend === 'usb' && !snapshot.usbReady ? (
          <p className="form-hint">USB 助理刚断开，这一条不会改用软件键鼠。</p>
        ) : null}
      </div>
    </div>
  )
}

export function DutyAgentPage({
  onToast
}: {
  onToast: (message: string, type: 'success' | 'error') => void
}): React.JSX.Element {
  const { snapshot, reload } = useSnapshot()
  const active = snapshot?.agents.find((agent) => agent.id === snapshot.activeAgentId) || snapshot?.agents[0]
  const [draft, setDraft] = useState<AgentProfile | null>(null)

  useEffect(() => {
    if (active) setDraft(active)
  }, [active])

  if (!snapshot || !draft) {
    return (
      <div className="settings-page">
        <p>正在读取岗位配置...</p>
      </div>
    )
  }

  const save = async (): Promise<void> => {
    await dutyInvoke('duty:saveAgent', { ...draft, mode: active?.mode || draft.mode })
    onToast('岗位已保存', 'success')
    reload()
  }

  const patch = (partial: Partial<AgentProfile>): void => setDraft({ ...draft, ...partial })

  return (
    <div className="settings-page slide-up">
      <div className="settings-page-header">
        <div>
          <h1>智能体</h1>
          <p>同一时间只启用一个岗位。提示词和资料都留在这台电脑上。</p>
        </div>
        <button className="btn btn-primary" onClick={save}>
          保存岗位
        </button>
      </div>
      <div className="card">
        <div className="card-title">启用哪一个</div>
        <button
          className="btn btn-secondary"
          style={{ marginBottom: 8 }}
          onClick={async () => {
            const result = await dutyInvoke<{ ok: boolean; message?: string }>('duty:createAgent')
            if (!result?.ok) onToast(result?.message || '没有建成', 'error')
            reload()
          }}
        >
          新建
        </button>
        {snapshot.agents.map((agent) => (
          <div key={agent.id} style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <button
              className="btn btn-secondary"
              onClick={async () => {
                await dutyInvoke('duty:enableAgent', agent.id)
                reload()
              }}
            >
              {agent.id === snapshot.activeAgentId ? '启用中 · ' : '启用 · '}
              {agent.name}
            </button>
            <button
              className="btn btn-secondary"
              onClick={async () => {
                const result = await dutyInvoke<{ ok: boolean; message?: string }>('duty:copyAgent', agent.id)
                if (!result?.ok) onToast(result?.message || '没有复制成', 'error')
                reload()
              }}
            >
              复制
            </button>
            <button
              className="btn btn-secondary"
              onClick={async () => {
                const result = await dutyInvoke<{ ok: boolean; message?: string }>('duty:disableAgent', agent.id)
                if (!result?.ok) onToast(result?.message || '没有停用', 'error')
                reload()
              }}
            >
              停用
            </button>
            <button
              className="btn btn-secondary"
              onClick={async () => {
                if (!window.confirm(`删除「${agent.name}」？会话记录会留下。`)) return
                const result = await dutyInvoke<{ ok: boolean; message?: string }>('duty:deleteAgent', agent.id)
                if (!result?.ok) onToast(result?.message || '没有删除', 'error')
                reload()
              }}
            >
              删除
            </button>
          </div>
        ))}
      </div>
      <div className="card">
        <div className="form-group">
          <label className="form-label">提示词</label>
          <textarea
            className="form-input"
            rows={5}
            value={draft.prompt}
            onChange={(event) => patch({ prompt: event.target.value })}
          />
        </div>
        <div className="form-group">
          <label className="form-label">群聊</label>
          <select
            className="form-input"
            value={draft.groupReply}
            onChange={(event) => patch({ groupReply: event.target.value as AgentProfile['groupReply'] })}
          >
            <option value="mention">只回复 @ 到本号的消息</option>
            <option value="all">回复全部群消息</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">黑名单（一行一个名称，命中后永不回复）</label>
          <textarea
            className="form-input"
            rows={3}
            value={draft.blacklist.join('\n')}
            onChange={(event) => patch({ blacklist: linesOf(event.target.value) })}
          />
        </div>
        <div className="form-group">
          <label className="form-label">
            <input
              type="checkbox"
              checked={draft.whitelistEnabled}
              onChange={(event) => patch({ whitelistEnabled: event.target.checked })}
            />{' '}
            只回复白名单里的单聊
          </label>
          <textarea
            className="form-input"
            rows={3}
            value={draft.whitelist.join('\n')}
            onChange={(event) => patch({ whitelist: linesOf(event.target.value) })}
          />
        </div>
        <div className="form-group">
          <label className="form-label">转人工词（一行一个）</label>
          <textarea
            className="form-input"
            rows={2}
            value={draft.handoffKeywords.join('\n')}
            onChange={(event) => patch({ handoffKeywords: linesOf(event.target.value) })}
          />
        </div>
        <div className="form-group">
          <label className="form-label">通知地址</label>
          <input
            className="form-input"
            value={draft.webhookUrl}
            placeholder="企业微信或飞书机器人地址"
            onChange={(event) => patch({ webhookUrl: event.target.value })}
          />
          <select
            className="form-input"
            style={{ marginTop: 8 }}
            value={draft.webhookKind}
            onChange={(event) => patch({ webhookKind: event.target.value as AgentProfile['webhookKind'] })}
          >
            <option value="wecom">企业微信群机器人</option>
            <option value="feishu">飞书自定义机器人</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">带上屏幕外的最近几条（5–50）</label>
          <input
            className="form-input"
            type="number"
            min={5}
            max={50}
            value={draft.historyLimit}
            onChange={(event) => patch({ historyLimit: Number(event.target.value) })}
          />
        </div>
        <div className="form-group">
          <label className="form-label">每小时最多发送（0 表示不限制）</label>
          <input
            className="form-input"
            type="number"
            min={0}
            max={500}
            value={draft.hourlyLimit}
            onChange={(event) => patch({ hourlyLimit: Number(event.target.value) })}
          />
        </div>
        <div className="form-group">
          <label className="form-label">
            <input
              type="checkbox"
              checked={draft.workHoursEnabled}
              onChange={(event) => patch({ workHoursEnabled: event.target.checked })}
            />{' '}
            只在这个时段回复
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="form-input"
              value={draft.workStart}
              onChange={(event) => patch({ workStart: event.target.value })}
            />
            <input className="form-input" value={draft.workEnd} onChange={(event) => patch({ workEnd: event.target.value })} />
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">节奏</label>
          <label className="form-hint">
            <input
              type="checkbox"
              checked={draft.pacing.enabled}
              onChange={(event) => patch({ pacing: { ...draft.pacing, enabled: event.target.checked } })}
            />{' '}
            分段输入。关掉后整段粘贴，只供调试。
          </label>
          <select
            className="form-input"
            value={draft.pacing.speed}
            onChange={(event) =>
              patch({ pacing: { ...draft.pacing, speed: event.target.value as PacingSpeed } })
            }
          >
            <option value="steady">稳</option>
            <option value="natural">自然</option>
            <option value="slow">慢</option>
          </select>
          <select
            className="form-input"
            style={{ marginTop: 8 }}
            value={draft.pacing.typo}
            onChange={(event) => patch({ pacing: { ...draft.pacing, typo: event.target.value as TypoLevel } })}
          >
            <option value="off">不错字</option>
            <option value="low">偶尔错字，马上改回</option>
            <option value="mid">多一些错字，马上改回</option>
          </select>
        </div>
      </div>
      <KnowledgeCard files={snapshot.knowledgeFiles} onToast={onToast} onChanged={reload} />
      <MaterialCard draft={draft} onChange={patch} />
    </div>
  )
}

function KnowledgeCard({
  files,
  onToast,
  onChanged
}: {
  files: string[]
  onToast: (message: string, type: 'success' | 'error') => void
  onChanged: () => void
}): React.JSX.Element {
  return (
    <div className="card">
      <div className="card-title">知识包</div>
      <p className="form-hint">只接受 Markdown、TXT 和 PDF。单个文件 10MB，最多 30 个。检索在本机完成。</p>
      <button
        className="btn btn-secondary"
        onClick={async () => {
          const result = await dutyInvoke<{ ok: boolean; message?: string }>('duty:pickKnowledge')
          if (!result?.ok) {
            onToast(result?.message || '没有加入', 'error')
            return
          }
          onChanged()
        }}
      >
        加入文件
      </button>
      {files.map((fileName) => (
        <div key={fileName} style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
          <span>{fileName}</span>
          <button
            className="btn btn-secondary"
            onClick={async () => {
              await dutyInvoke('duty:removeKnowledge', fileName)
              onChanged()
            }}
          >
            移除
          </button>
        </div>
      ))}
    </div>
  )
}

function MaterialCard({
  draft,
  onChange
}: {
  draft: AgentProfile
  onChange: (partial: Partial<AgentProfile>) => void
}): React.JSX.Element {
  const update = (index: number, partial: Partial<MaterialRule>): void => {
    const materialRules = draft.materialRules.map((rule, i) => (i === index ? { ...rule, ...partial } : rule))
    onChange({ materialRules })
  }
  return (
    <div className="card">
      <div className="card-title">当前会话素材</div>
      <p className="form-hint">对方这句话命中关键词时，只发你指定的文字或本机图片。不翻联系人，不群发。事实内容以知识包为准。</p>
      {draft.materialRules.map((rule, index) => (
        <div key={index} className="form-group">
          <input
            className="form-input"
            placeholder="关键词"
            value={rule.keyword}
            onChange={(event) => update(index, { keyword: event.target.value })}
          />
          <textarea
            className="form-input"
            rows={2}
            placeholder="要发送的文字"
            value={rule.text}
            onChange={(event) => update(index, { text: event.target.value })}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="form-input" value={rule.imagePath} placeholder="图片路径" readOnly />
            <button
              className="btn btn-secondary"
              onClick={async () => {
                const picked = await dutyInvoke<{ ok: boolean; path?: string }>('duty:pickImage')
                if (picked?.ok && picked.path) update(index, { imagePath: picked.path })
              }}
            >
              选图片
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => onChange({ materialRules: draft.materialRules.filter((_, i) => i !== index) })}
            >
              删除
            </button>
          </div>
        </div>
      ))}
      <button
        className="btn btn-secondary"
        onClick={() =>
          onChange({ materialRules: [...draft.materialRules, { keyword: '', text: '', imagePath: '' }] })
        }
      >
        加一条
      </button>
    </div>
  )
}

export function DutyRecordPage({
  onToast
}: {
  onToast: (message: string, type: 'success' | 'error') => void
}): React.JSX.Element {
  const [rows, setRows] = useState<ReportRow[]>([])
  const [filter, setFilter] = useState<'all' | ReportRow['status']>('all')
  const [turns, setTurns] = useState<TurnRow[]>([])
  const [selected, setSelected] = useState('')

  const load = useCallback(async () => {
    const report = await dutyInvoke<{ rows: ReportRow[] }>('duty:report')
    setRows(report?.rows || [])
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const visible = rows.filter((row) => filter === 'all' || row.status === filter)

  return (
    <div className="settings-page slide-up">
      <div className="settings-page-header">
        <div>
          <h1>记录</h1>
          <p>只列出今天有过动作的会话。没说话的联系人不会出现，也不会被追问。</p>
        </div>
        <button
          className="btn btn-secondary"
          onClick={async () => {
            const result = await dutyInvoke<{ ok: boolean; message?: string }>('duty:exportReport')
            onToast(result?.ok ? '已导出到本机' : result?.message || '没有导出', result?.ok ? 'success' : 'error')
          }}
        >
          导出今日 CSV
        </button>
      </div>
      <div className="card">
        <select
          className="form-input"
          value={filter}
          onChange={(event) => setFilter(event.target.value as typeof filter)}
        >
          <option value="all">全部</option>
          <option value="pending">待处理</option>
          <option value="handoff">已转人工</option>
          <option value="done">已处理</option>
        </select>
        {visible.map((row) => (
          <div key={row.key} style={{ marginTop: 10 }}>
            <div>
              {row.title} · {STATUS_LABEL[row.status]} · {row.reason}
            </div>
            <div className="form-hint">{new Date(row.at).toLocaleString('zh-CN')}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button
                className="btn btn-secondary"
                onClick={async () => {
                  setSelected(row.key)
                  setTurns((await dutyInvoke<TurnRow[]>('duty:turns', row.key)) || [])
                }}
              >
                看回合
              </button>
              {row.status === 'handoff' ? (
                <button
                  className="btn btn-secondary"
                  onClick={async () => {
                    await dutyInvoke('duty:resume', row.key)
                    await load()
                  }}
                >
                  恢复自动
                </button>
              ) : null}
              <button
                className="btn btn-secondary"
                onClick={async () => {
                  if (!window.confirm(`清空「${row.title}」的回合？其他会话不动。`)) return
                  await dutyInvoke('duty:clearTurns', row.key)
                  if (selected === row.key) setTurns([])
                  onToast('已清空这一会话', 'success')
                }}
              >
                清空回合
              </button>
            </div>
          </div>
        ))}
        {visible.length === 0 ? <div className="form-hint">今天还没有记录。</div> : null}
      </div>
      {selected ? (
        <div className="card">
          <div className="card-title">回合</div>
          {turns.map((turn, index) => (
            <div key={index} className="form-hint">
              {turn.side === 'out' ? '我' : turn.side === 'in' ? '对方' : '系统'}：{turn.text}
            </div>
          ))}
          {turns.length === 0 ? <div className="form-hint">这条会话还没有记下文字。</div> : null}
        </div>
      ) : null}
    </div>
  )
}

export function DutyConnectionPage({
  onToast
}: {
  onToast: (message: string, type: 'success' | 'error') => void
}): React.JSX.Element {
  const { snapshot, reload } = useSnapshot()
  const [licenseCode, setLicenseCode] = useState('')
  const [gatewayUrl, setGatewayUrl] = useState('')

  useEffect(() => {
    if (!snapshot) return
    setLicenseCode(snapshot.licenseCode)
    setGatewayUrl(snapshot.gatewayUrl)
  }, [snapshot])

  return (
    <div className="settings-page slide-up">
      <div className="settings-page-header">
        <div>
          <h1>连接</h1>
          <p>看屏和回复是两项能力。资料和聊天记录不会上传。</p>
        </div>
      </div>
      <div className="card">
        <div className="form-group">
          <label className="form-label">许可证</label>
          <input
            className="form-input"
            value={licenseCode}
            onChange={(event) => setLicenseCode(event.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="form-group">
          <label className="form-label">网关地址</label>
          <input
            className="form-input"
            value={gatewayUrl}
            placeholder="https://你的网关/v1"
            onChange={(event) => setGatewayUrl(event.target.value)}
          />
        </div>
        <button
          className="btn btn-primary"
          onClick={async () => {
            const result = await dutyInvoke<{ ok: boolean; message?: string }>('duty:setConnection', {
              licenseCode,
              gatewayUrl
            })
            if (!result?.ok) {
              onToast(result?.message || '没有激活', 'error')
              return
            }
            onToast('连接已保存', 'success')
            reload()
          }}
        >
          保存
        </button>
        <div className="form-hint" style={{ marginTop: 12 }}>
          看屏：{snapshot?.seeText || '—'}
          <br />
          回复：{snapshot?.replyText || '—'}
        </div>
      </div>
    </div>
  )
}

function linesOf(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}
