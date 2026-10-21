import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunkText, isPureAck, needsKnowledge, searchChunks } from './search.ts'

test('价目表能按本机段落命中，无关问题没有结果', () => {
  const chunks = chunkText(
    '价目.md',
    '# 价格\n\n玫瑰一束 20 元。\n\n# 地址\n\n门店在中山路 18 号。'
  )
  const price = searchChunks('玫瑰多少钱', chunks)
  assert.ok(price.length > 0)
  assert.match(price[0].text, /20 元/)
  assert.equal(searchChunks('航天飞机怎么发射', chunks).length, 0)
  assert.equal(needsKnowledge('这个多少钱'), true)
  assert.equal(needsKnowledge('贵不贵'), true)
  assert.equal(needsKnowledge('怎么卖'), true)
  assert.equal(needsKnowledge('好的收到'), false)
  assert.equal(isPureAck('好的'), true)
  assert.equal(isPureAck('收到'), true)
  assert.equal(isPureAck('好的，多少钱'), false)
})
