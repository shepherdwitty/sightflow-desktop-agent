import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseBubbles, parseIdentity } from './vision-parse.ts'

test('能从模型夹杂说明的输出里取出身份和气泡', () => {
  const identity = parseIdentity('```json\n{"title":"家庭群 (8)","kind":"group","confidence":"high"}\n```')
  assert.equal(identity?.kind, 'group')
  assert.equal(identity?.confidence, 'high')
  const bubbles = parseBubbles('{"mentionedMe":null,"bubbles":[{"side":"in","text":"在吗"},{"side":"nope","text":"丢"}]}')
  assert.equal(bubbles.mentionedMe, null)
  assert.deepEqual(bubbles.bubbles, [{ side: 'in', text: '在吗' }])
})
