export type CapabilityState = 'ready' | 'quota' | 'offline' | 'unavailable' | 'inactive'

export function activateLicense(code: string): { ok: boolean; message: string } {
  const trimmed = code.trim()
  if (trimmed.length < 8) return { ok: false, message: '兑换码至少 8 位' }
  return { ok: true, message: '已激活' }
}

export function mapUpstreamFailure(input: {
  httpStatus?: number
  message?: string
  activated: boolean
  commercial: boolean
}): { state: CapabilityState; text: string } {
  if (input.commercial && !input.activated) {
    return { state: 'inactive', text: '请先激活许可证' }
  }
  const status = input.httpStatus
  if (status === 401 || status === 402 || status === 429) {
    return { state: 'quota', text: '额度用尽' }
  }
  if (status === 0 || isOffline(input.message)) {
    return { state: 'offline', text: '网络不可用' }
  }
  if ((status && status >= 500) || (input.commercial && input.message)) {
    return { state: 'unavailable', text: '服务暂不可用' }
  }
  if (input.message) return { state: 'unavailable', text: input.message }
  return { state: 'ready', text: '可用' }
}

function isOffline(message: string | undefined): boolean {
  if (!message) return false
  return /network|fetch failed|enotfound|econnrefused|超时|timeout|socket/i.test(message)
}

export function capabilityFromConfig(input: {
  commercial: boolean
  activated: boolean
  hasVisionKey: boolean
  hasReplyKey: boolean
  gatewayUrl: string
}): { see: CapabilityState; reply: CapabilityState; seeText: string; replyText: string } {
  if (input.commercial && !input.activated) {
    return { see: 'inactive', reply: 'inactive', seeText: '请先激活许可证', replyText: '请先激活许可证' }
  }
  const viaGateway = input.gatewayUrl.trim().length > 0
  const seeReady = viaGateway || input.hasVisionKey
  const replyReady = viaGateway || input.hasReplyKey
  return {
    see: seeReady ? 'ready' : 'unavailable',
    reply: replyReady ? 'ready' : 'unavailable',
    seeText: seeReady ? '可用' : '服务暂不可用',
    replyText: replyReady ? '可用' : '服务暂不可用'
  }
}
