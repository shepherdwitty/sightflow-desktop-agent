import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conversationKey, normalizeTitle } from './conversation-key.ts'

test('群标题去掉人数后用同一个键', () => {
  assert.equal(normalizeTitle('家庭群 (23)', 'group'), '家庭群')
  assert.equal(normalizeTitle('家庭群（24）', 'group'), '家庭群')
  assert.equal(conversationKey('group', '家庭群 (23)'), conversationKey('group', '家庭群'))
})

test('单聊名称里的括号人数留在键里', () => {
  assert.equal(normalizeTitle('张三(2)', 'single'), '张三(2)')
  assert.equal(conversationKey('single', '张三(2)'), 'single:张三(2)')
})

test('同名的单聊和群不是一把键', () => {
  assert.notEqual(conversationKey('single', '张三'), conversationKey('group', '张三'))
})

test('空名称没有键', () => {
  assert.equal(conversationKey('single', '   '), null)
  assert.equal(conversationKey('group', '(12)'), null)
})
