import type { GateConfig } from './gates'
import { DEFAULT_PACING, type PacingPolicy, type PacingSpeed, type TypoLevel } from './pacing'
import type { WebhookKind } from './webhook'

export interface MaterialRule {
  keyword: string
  text: string
  imagePath: string
}

export interface AgentProfile {
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
  webhookKind: WebhookKind
  mode: 'assist' | 'auto'
  historyLimit: number
  pacing: PacingPolicy
  hourlyLimit: number
  workHoursEnabled: boolean
  workStart: string
  workEnd: string
  materialRules: MaterialRule[]
}

export function defaultAgents(existingPrompt = ''): AgentProfile[] {
  const store = templateAgent('store', '门店咨询', STORE_PROMPT, 'natural')
  const course = templateAgent('course', '课程售前', COURSE_PROMPT, 'slow')
  const team = templateAgent('team', '团队答疑', TEAM_PROMPT, 'natural')
  if (existingPrompt.trim()) store.prompt = existingPrompt.trim()
  return [store, course, team]
}

function templateAgent(
  template: AgentProfile['template'],
  name: string,
  prompt: string,
  speed: PacingSpeed
): AgentProfile {
  return {
    id: template,
    name,
    template,
    prompt,
    groupReply: 'mention',
    blacklist: [],
    whitelistEnabled: false,
    whitelist: [],
    handoffKeywords: ['投诉', '退款'],
    webhookUrl: '',
    webhookKind: 'wecom',
    mode: 'assist',
    historyLimit: 20,
    pacing: { ...DEFAULT_PACING, speed, typo: speed === 'slow' ? 'low' : 'low' },
    hourlyLimit: 30,
    workHoursEnabled: false,
    workStart: '09:00',
    workEnd: '21:00',
    materialRules: []
  }
}

const STORE_PROMPT = `你是这家店的当班客服。用短句先回答事实。约时间、改期、投诉和退款不要自己答应，告诉对方需要同事来处理。不知道的价格和地址不要编。`

const COURSE_PROMPT = `你用作者本人的语气做课程售前。只讲资料里写过的内容。购买方式用资料里的原句。资料没有的承诺、价格和赠品不要编。`

const TEAM_PROMPT = `你替号的主人回答重复的用法、发货和报名问题。语气像本人。例外、投诉和退款交给本人，不要自己承诺。`

export function gateConfigOf(agent: AgentProfile): GateConfig {
  return {
    blacklist: agent.blacklist,
    whitelistEnabled: agent.whitelistEnabled,
    whitelist: agent.whitelist,
    groupReply: agent.groupReply,
    workHoursEnabled: agent.workHoursEnabled,
    workStart: agent.workStart,
    workEnd: agent.workEnd,
    hourlyLimit: agent.hourlyLimit,
    handoffKeywords: agent.handoffKeywords
  }
}

export function coerceAgent(raw: unknown, fallback: AgentProfile): AgentProfile {
  if (!raw || typeof raw !== 'object') return fallback
  const value = raw as Partial<AgentProfile>
  const pacing = coercePacing(value.pacing, fallback.pacing)
  return {
    ...fallback,
    ...value,
    id: stringOr(value.id, fallback.id),
    name: stringOr(value.name, fallback.name),
    prompt: stringOr(value.prompt, fallback.prompt),
    template: isTemplate(value.template) ? value.template : fallback.template,
    groupReply: value.groupReply === 'all' ? 'all' : 'mention',
    blacklist: stringList(value.blacklist),
    whitelistEnabled: value.whitelistEnabled === true,
    whitelist: stringList(value.whitelist),
    handoffKeywords: stringList(value.handoffKeywords),
    webhookUrl: stringOr(value.webhookUrl, ''),
    webhookKind: value.webhookKind === 'feishu' ? 'feishu' : 'wecom',
    mode: value.mode === 'auto' ? 'auto' : 'assist',
    historyLimit: clamp(Number(value.historyLimit), 5, 50, fallback.historyLimit),
    pacing,
    hourlyLimit: clamp(Number(value.hourlyLimit), 0, 500, fallback.hourlyLimit),
    workHoursEnabled: value.workHoursEnabled === true,
    workStart: clockOr(value.workStart, fallback.workStart),
    workEnd: clockOr(value.workEnd, fallback.workEnd),
    materialRules: coerceMaterials(value.materialRules)
  }
}

function coercePacing(raw: PacingPolicy | undefined, fallback: PacingPolicy): PacingPolicy {
  if (!raw) return { ...fallback }
  const speed: PacingSpeed = raw.speed === 'steady' || raw.speed === 'slow' ? raw.speed : 'natural'
  const typo: TypoLevel = raw.typo === 'off' || raw.typo === 'mid' ? raw.typo : 'low'
  return {
    enabled: raw.enabled !== false,
    readBeforeType: raw.readBeforeType !== false,
    segmentLong: raw.segmentLong !== false,
    speed,
    typo
  }
}

function coerceMaterials(raw: unknown): MaterialRule[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const rule = item as Partial<MaterialRule>
    const keyword = stringOr(rule.keyword, '')
    if (!keyword) return []
    return [{ keyword, text: stringOr(rule.text, ''), imagePath: stringOr(rule.imagePath, '') }]
  })
}

function isTemplate(value: unknown): value is AgentProfile['template'] {
  return value === 'store' || value === 'course' || value === 'team' || value === 'custom'
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
}

function clockOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^\d{1,2}:\d{2}$/.test(value.trim()) ? value.trim() : fallback
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

export function matchMaterial(text: string, rules: MaterialRule[]): MaterialRule | null {
  const haystack = text.normalize('NFKC')
  for (const rule of rules) {
    const keyword = rule.keyword.normalize('NFKC').trim()
    if (!keyword || !haystack.includes(keyword)) continue
    if (!rule.text.trim() && !rule.imagePath.trim()) continue
    return rule
  }
  return null
}
