// 模型用量账本：逐次记录 token 与费用，追加写入 JSONL
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

export type UsagePurpose = 'reply' | 'vision' | 'learn' | 'text' | 'test'

/** 供应商 /chat/completions 返回的 usage 片段（OpenAI 兼容字段 + 火山扩展字段） */
export interface ApiUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  input_tokens?: number
  output_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

export interface UsageRecord {
  ts: string
  purpose: UsagePurpose | string
  source: string
  model: string
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  totalTokens: number
  tier: string
  /** 模型在计价表内时为 true；false 表示仅记录 token，费用按 0 占位 */
  priced: boolean
  inputPrice: number // 元 / 百万 token
  outputPrice: number
  inputCost: number // 元
  outputCost: number
  cost: number
  requestId?: string
}

interface PricingTier {
  max: number
  label: string
  input: number
  output: number
}

// doubao-seed-2-0-lite 分段计价（按本次输入长度定档，输出同档）。
// 换默认模型时需同步：本价格表、PRICED_MODEL_PREFIX，
// 以及 manifest.json / provider.bundle.js / README 中的模型名。
const PRICED_MODEL_PREFIX = 'doubao-seed-2-0-lite'
const TIERS: PricingTier[] = [
  { max: 32_000, label: '0-32k', input: 0.6, output: 3.6 },
  { max: 128_000, label: '32k-128k', input: 0.9, output: 5.4 },
  { max: 256_000, label: '128k-256k', input: 1.8, output: 10.8 }
]
// 缓存命中部分按输入档位价的 20% 计费（doubao-seed 系列官方折扣）
const CACHE_HIT_DISCOUNT = 0.2

/** 模型不在计价表内时返回 null（该条只记 token，费用按 0 占位） */
export function priceFor(inputTokens: number, model: string): PricingTier | null {
  if (!model.startsWith(PRICED_MODEL_PREFIX)) return null
  return TIERS.find((t) => inputTokens <= t.max) ?? TIERS[TIERS.length - 1]
}

let usageDir: string | null = null

// reply 调用在 provider 返回后才记到 pending，由「模型调用结束」的那条轨迹显式取走。
// vision 不进这个全局队列：它必须包在 captureUsage() 里，跟紧接着的那一步走。
// 没有对应轨迹的检测（未读轮询未命中、会话外的 VLM 测试）只留在账本里。
const pending: UsageRecord[] = []
const usageScope = new AsyncLocalStorage<UsageRecord[]>()

// learn / test / text 只入账本。vision 仅在 captureUsage 作用域内归属到步骤。
const STEP_ATTRIBUTABLE_PURPOSES = new Set(['reply', 'vision'])

export interface StepUsageItem {
  purpose: string
  inputTokens: number
  outputTokens: number
  tier: string
  cost: number
  priced?: boolean
}

export interface StepUsage {
  calls: number
  inputTokens: number
  outputTokens: number
  cost: number
  priced?: boolean
  items: StepUsageItem[]
}

function toStepUsage(list: UsageRecord[]): StepUsage | undefined {
  if (!list.length) return undefined
  return {
    calls: list.length,
    inputTokens: list.reduce((sum, record) => sum + record.inputTokens, 0),
    outputTokens: list.reduce((sum, record) => sum + record.outputTokens, 0),
    cost: list.reduce((sum, record) => sum + record.cost, 0),
    priced: list.every((record) => record.priced),
    items: list.map((record) => ({
      purpose: record.purpose,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      tier: record.tier,
      cost: record.cost,
      priced: record.priced
    }))
  }
}

export function takePendingUsage(): StepUsage | undefined {
  if (!pending.length) return undefined
  return toStepUsage(pending.splice(0, pending.length))
}

/** 会话开始、结束时丢掉还没归属的 reply，避免算进下一次会话。 */
export function discardPendingUsage(): void {
  pending.length = 0
}

/**
 * 把作用域内的 vision（以及同一次 await 里的模型调用）收成一步用量。
 * 作用域里的记录不会进入全局 pending。
 */
export async function captureUsage<T>(
  fn: () => Promise<T>
): Promise<{ value: T; usage?: StepUsage }> {
  const bucket: UsageRecord[] = []
  const value = await usageScope.run(bucket, fn)
  return { value, usage: toStepUsage(bucket) }
}

export function mergeStepUsage(parts: Array<StepUsage | undefined>): StepUsage | undefined {
  const present = parts.filter((part): part is StepUsage => !!part && part.calls > 0)
  if (!present.length) return undefined
  return {
    calls: present.reduce((sum, part) => sum + part.calls, 0),
    inputTokens: present.reduce((sum, part) => sum + part.inputTokens, 0),
    outputTokens: present.reduce((sum, part) => sum + part.outputTokens, 0),
    cost: present.reduce((sum, part) => sum + part.cost, 0),
    priced: present.every((part) => part.priced !== false),
    items: present.flatMap((part) => part.items)
  }
}

export function setUsageDir(dir: string): void {
  usageDir = dir
  mkdirSync(dir, { recursive: true })
}

function usageFile(): string | null {
  return usageDir ? join(usageDir, 'usage.jsonl') : null
}

// 读取缓存：路径 + mtime + size 都一致才复用，避免换文件或同大小覆盖时读到旧结果。
// 用量页 5s 轮询在文件没变时只 stat，不重复解析整个 JSONL。
let readCache: { file: string; mtimeMs: number; size: number; records: UsageRecord[] } | null = null

function isUsageRecord(value: unknown): value is UsageRecord {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<UsageRecord>
  return (
    typeof row.ts === 'string' &&
    typeof row.purpose === 'string' &&
    typeof row.inputTokens === 'number' &&
    Number.isFinite(row.inputTokens) &&
    typeof row.outputTokens === 'number' &&
    Number.isFinite(row.outputTokens) &&
    typeof row.cost === 'number' &&
    Number.isFinite(row.cost)
  )
}

export function readUsage(): UsageRecord[] {
  const file = usageFile()
  if (!file) return []
  try {
    const st = statSync(file)
    if (
      readCache &&
      readCache.file === file &&
      readCache.mtimeMs === st.mtimeMs &&
      readCache.size === st.size
    ) {
      return readCache.records.slice()
    }
    const records = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown
        } catch {
          return null
        }
      })
      .filter((row): row is UsageRecord => isUsageRecord(row))
    readCache = { file, mtimeMs: st.mtimeMs, size: st.size, records }
    return records.slice()
  } catch {
    return []
  }
}

function finiteCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return Math.floor(parsed)
}

export function recordUsage(params: {
  purpose: string
  source: string
  model: string
  usage: ApiUsage | null | undefined
  requestId?: string
  /** 是否归属到轨迹步骤；缺省按 purpose 推断（reply / vision 归属，其余只入账本） */
  attributable?: boolean
}): UsageRecord | null {
  const u = params.usage
  if (!u) return null
  const inputTokens = finiteCount(u.prompt_tokens ?? u.input_tokens)
  const outputTokens = finiteCount(u.completion_tokens ?? u.output_tokens)
  // 防御：cached_tokens 可能缺失或大于输入总量
  const cachedTokens = Math.min(finiteCount(u.prompt_tokens_details?.cached_tokens), inputTokens)
  const tier = priceFor(inputTokens, params.model)
  const priced = tier !== null
  // 缓存命中部分按折扣价计费，其余按档位输入价
  const inputCost = tier
    ? ((inputTokens - cachedTokens) * tier.input + cachedTokens * tier.input * CACHE_HIT_DISCOUNT) /
      1_000_000
    : 0
  const outputCost = tier ? (outputTokens * tier.output) / 1_000_000 : 0
  const rec: UsageRecord = {
    ts: new Date().toISOString(),
    purpose: params.purpose,
    source: params.source,
    model: params.model,
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens: finiteCount(u.total_tokens) || inputTokens + outputTokens,
    tier: priced ? tier.label : 'unknown',
    priced,
    inputPrice: tier ? tier.input : 0,
    outputPrice: tier ? tier.output : 0,
    inputCost,
    outputCost,
    cost: inputCost + outputCost,
    requestId: params.requestId
  }
  console.log(
    `[Usage] ${rec.purpose} in=${inputTokens} out=${outputTokens} tier=${rec.tier} cost=${
      priced ? `¥${rec.cost.toFixed(6)}` : '未计价'
    }`
  )
  const attributable = params.attributable ?? STEP_ATTRIBUTABLE_PURPOSES.has(params.purpose)
  if (attributable) {
    const scope = usageScope.getStore()
    if (scope) {
      scope.push(rec)
    } else if (params.purpose === 'reply') {
      // 只有回复走全局队列，并且要由后续轨迹显式 claim。vision 没有作用域就只入账本。
      pending.push(rec)
    }
  }
  const file = usageFile()
  if (file) {
    try {
      appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8')
    } catch (e) {
      console.error('[Usage] 写入失败', e)
    }
  }
  return rec
}

export interface UsageAgg {
  calls: number
  inputTokens: number
  outputTokens: number
  cost: number
}

function agg(list: UsageRecord[]): UsageAgg {
  return list.reduce(
    (a, r) => ({
      calls: a.calls + 1,
      inputTokens: a.inputTokens + r.inputTokens,
      outputTokens: a.outputTokens + r.outputTokens,
      cost: a.cost + r.cost
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 }
  )
}

export interface UsageSummary {
  total: UsageAgg
  today: UsageAgg
  byPurpose: Record<string, UsageAgg>
  byDay: Record<string, UsageAgg>
  recent: UsageRecord[]
  file: string | null
}

export function summarizeUsage(limit = 100): UsageSummary {
  const safeLimit = Math.max(0, Math.floor(limit))
  const all = readUsage()
  const today = new Date().toDateString()
  const byPurpose: Record<string, UsageAgg> = {}
  for (const p of [...new Set(all.map((r) => r.purpose))]) {
    byPurpose[p] = agg(all.filter((r) => r.purpose === p))
  }
  const byDay: Record<string, UsageAgg> = {}
  for (const r of all) {
    const d = new Date(r.ts).toLocaleDateString('zh-CN')
    byDay[d] ||= { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 }
    byDay[d].calls++
    byDay[d].inputTokens += r.inputTokens
    byDay[d].outputTokens += r.outputTokens
    byDay[d].cost += r.cost
  }
  return {
    total: agg(all),
    today: agg(all.filter((r) => new Date(r.ts).toDateString() === today)),
    byPurpose,
    byDay,
    recent: safeLimit === 0 ? [] : all.slice(-safeLimit).reverse(),
    file: usageFile()
  }
}
