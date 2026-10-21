export type WebhookKind = 'wecom' | 'feishu'

export function webhookPayload(kind: WebhookKind, text: string): Record<string, unknown> {
  if (kind === 'feishu') {
    return { msg_type: 'text', content: { text } }
  }
  return { msgtype: 'text', text: { content: text } }
}

export function handoffNotice(title: string, reason: string, at: Date): string {
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  return `ChatBuddy 转人工\n会话：${title}\n原因：${reason}\n时间：${clock}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** HTTP 成功还不够。企业微信 errcode、飞书 code / StatusCode 非 0 都算没发出去。 */
export function webhookAccepted(status: number, body: unknown): { ok: boolean; error?: string } {
  if (status < 200 || status >= 300) return { ok: false, error: `通知失败 ${status}` }
  if (!body || typeof body !== 'object') return { ok: true }
  const record = body as { errcode?: unknown; code?: unknown; StatusCode?: unknown }
  const code = rejectionCode(record.errcode, record.code, record.StatusCode)
  if (code !== null) return { ok: false, error: `通知失败 ${code}` }
  return { ok: true }
}

function rejectionCode(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && value !== 0) return value
  }
  return null
}

export async function postWebhook(url: string, kind: WebhookKind, text: string): Promise<{ ok: boolean; error?: string }> {
  const target = url.trim()
  if (!target) return { ok: false, error: '没有通知地址' }
  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload(kind, text)),
      signal: AbortSignal.timeout(8000)
    })
    const body: unknown = await response.json().catch(() => null)
    return webhookAccepted(response.status, body)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message || '通知失败' }
  }
}
