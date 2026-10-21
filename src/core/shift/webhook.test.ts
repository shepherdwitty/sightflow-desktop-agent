import assert from 'node:assert/strict'
import { test } from 'node:test'
import { webhookAccepted } from './webhook.ts'

test('企业微信和飞书的业务错误码不算发送成功', () => {
  assert.equal(webhookAccepted(200, { errcode: 0, errmsg: 'ok' }).ok, true)
  assert.equal(webhookAccepted(200, { errcode: 93000 }).ok, false)
  assert.equal(webhookAccepted(200, { code: 0, StatusCode: 0 }).ok, true)
  assert.equal(webhookAccepted(200, { StatusCode: 19001 }).ok, false)
  assert.equal(webhookAccepted(500, null).ok, false)
  assert.equal(webhookAccepted(200, null).ok, true)
})
