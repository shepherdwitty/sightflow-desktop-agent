// 聊天密钥与视觉密钥的纯函数策略。
// 旧版只在 settings.json 顶层存一把 apiKey；electron-store 构造时会把
// defaults.vision.apiKey = '' 写进磁盘。空串不能当成「用户清空了视觉密钥」。

export function readLegacyApiKey(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return ''
  const value = (raw as { apiKey?: unknown }).apiKey
  return typeof value === 'string' ? value.trim() : ''
}

/** 视觉位有非空内容就用它；否则用尚未删除的顶层 legacy key。 */
export function resolveVisionApiKey(raw: unknown): string {
  const vision =
    raw && typeof raw === 'object' ? (raw as { vision?: { apiKey?: unknown } }).vision : undefined
  const stored = typeof vision?.apiKey === 'string' ? vision.apiKey.trim() : ''
  if (stored) return stored
  return readLegacyApiKey(raw)
}

/**
 * 本次 settings:set 是否显式写了 vision.apiKey。
 * 没写返回 null；写了返回原始字符串（调用方再用 trim 判断是不是清空）。
 */
export function explicitVisionApiKey(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const vision = (data as { vision?: unknown }).vision
  if (!vision || typeof vision !== 'object') return null
  const apiKey = (vision as { apiKey?: unknown }).apiKey
  return typeof apiKey === 'string' ? apiKey : null
}

/**
 * 视觉密钥已经落到非空值，或用户这次明确保存了空视觉密钥时，删掉顶层 legacy key。
 * 视觉仍为空且这次没动视觉字段时保留，避免一次无关保存把唯一副本删掉。
 */
export function shouldDeleteLegacyApiKey(options: {
  hasLegacy: boolean
  nextVisionApiKey: string
  explicitVisionApiKey: string | null
}): boolean {
  if (!options.hasLegacy) return false
  if (options.nextVisionApiKey.trim()) return true
  return options.explicitVisionApiKey !== null && options.explicitVisionApiKey.trim() === ''
}

/** 聊天密钥：显式非空 config.apiKey 优先，空白视为没填，回退视觉密钥。 */
export function resolveChatKey(configApiKey: unknown, visionApiKey: string): string {
  const explicit = typeof configApiKey === 'string' ? configApiKey.trim() : ''
  return explicit || visionApiKey.trim()
}

/**
 * 第三方 provider 的 schema 没有 apiKey 字段时，不要把豆包聊天密钥交给它的 bundle。
 * schema 缺失时不动（无法判断）；字段存在时保留，由表单展示并覆盖。
 */
export function omitApiKeyIfSchemaOmitsIt<T extends Record<string, unknown>>(
  config: T | undefined,
  schemaProperties: object | null | undefined
): T {
  const source = { ...(config || {}) } as T
  if (!schemaProperties || Object.prototype.hasOwnProperty.call(schemaProperties, 'apiKey')) {
    return source
  }
  delete (source as { apiKey?: unknown }).apiKey
  return source
}
