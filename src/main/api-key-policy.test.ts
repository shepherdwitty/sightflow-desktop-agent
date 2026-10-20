import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  explicitVisionApiKey,
  omitApiKeyIfSchemaOmitsIt,
  resolveChatKey,
  resolveVisionApiKey,
  shouldDeleteLegacyApiKey
} from './api-key-policy.ts'

test('空的默认视觉密钥回退到顶层 legacy key', () => {
  assert.equal(
    resolveVisionApiKey({
      apiKey: 'sk-only',
      vision: { apiKey: '' }
    }),
    'sk-only'
  )
})

test('已经保存的视觉密钥优先于过期的顶层 key', () => {
  assert.equal(
    resolveVisionApiKey({
      apiKey: 'sk-old',
      vision: { apiKey: 'sk-current' }
    }),
    'sk-current'
  )
})

test('空白视觉密钥视为没填', () => {
  assert.equal(
    resolveVisionApiKey({
      apiKey: ' sk-only ',
      vision: { apiKey: '   ' }
    }),
    'sk-only'
  )
})

test('视觉密钥迁移成功后才删除 legacy；单纯的空视觉且这次没改视觉字段则保留', () => {
  assert.equal(
    shouldDeleteLegacyApiKey({
      hasLegacy: true,
      nextVisionApiKey: 'sk-only',
      explicitVisionApiKey: null
    }),
    true
  )
  assert.equal(
    shouldDeleteLegacyApiKey({
      hasLegacy: true,
      nextVisionApiKey: '',
      explicitVisionApiKey: null
    }),
    false
  )
  assert.equal(
    shouldDeleteLegacyApiKey({
      hasLegacy: true,
      nextVisionApiKey: '',
      explicitVisionApiKey: '   '
    }),
    true
  )
})

test('explicitVisionApiKey 只在这次补丁写了字符串时返回', () => {
  assert.equal(explicitVisionApiKey({ appType: 'wechat' }), null)
  assert.equal(explicitVisionApiKey({ vision: { apiKey: '' } }), '')
  assert.equal(explicitVisionApiKey({ vision: {} }), null)
})

test('空白聊天密钥回退视觉密钥，非空则去掉首尾空白', () => {
  assert.equal(resolveChatKey('   ', 'sk-vision'), 'sk-vision')
  assert.equal(resolveChatKey(' sk-chat ', 'sk-vision'), 'sk-chat')
  assert.equal(resolveChatKey(undefined, ' sk-vision '), 'sk-vision')
})

test('schema 没有 apiKey 时不把豆包密钥交给第三方 bundle', () => {
  const kept = omitApiKeyIfSchemaOmitsIt(
    { apiKey: 'sk-chat', model: 'm' },
    { apiKey: {}, model: {} }
  )
  assert.equal(kept.apiKey, 'sk-chat')

  const stripped = omitApiKeyIfSchemaOmitsIt({ apiKey: 'sk-chat', model: 'm' }, { model: {} })
  assert.equal('apiKey' in stripped, false)
  assert.equal(stripped.model, 'm')

  const unknownSchema = omitApiKeyIfSchemaOmitsIt({ apiKey: 'sk-chat' }, null)
  assert.equal(unknownSchema.apiKey, 'sk-chat')
})
