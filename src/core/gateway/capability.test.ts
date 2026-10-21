import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activateLicense, capabilityFromConfig, mapUpstreamFailure } from './capability.ts'

test('商业构建不把上游模型错误透出', () => {
  const mapped = mapUpstreamFailure({
    message: 'model doubao-seed-2-0-lite not found',
    activated: true,
    commercial: true
  })
  assert.equal(mapped.text, '服务暂不可用')
  assert.equal(mapped.text.includes('doubao'), false)
})

test('未激活的商业包不能开始新的看屏和回复', () => {
  const status = capabilityFromConfig({
    commercial: true,
    activated: false,
    hasVisionKey: true,
    hasReplyKey: true,
    gatewayUrl: ''
  })
  assert.equal(status.see, 'inactive')
  assert.equal(status.reply, 'inactive')
  assert.equal(activateLicense('short').ok, false)
  assert.equal(activateLicense('ABCD1234').ok, true)
})
