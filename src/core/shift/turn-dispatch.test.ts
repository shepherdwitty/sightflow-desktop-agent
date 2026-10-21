import assert from 'node:assert/strict'
import test from 'node:test'
import { planConfirm, planObserve } from './turn-dispatch'

test('冷处理在生成回复之前就停住', () => {
  const plan = planObserve({
    type: 'skip',
    reason: '冷处理',
    key: 'single:张三',
    title: '张三',
    kind: 'single',
    added: []
  })
  assert.deepEqual(plan, { kind: 'advance', logType: 'skip', message: '冷处理，这一轮不回复' })
})

test('没认出会话时不走回复模型', () => {
  const plan = planObserve({ type: 'skip', reason: '没确认对方是谁', added: [] })
  assert.equal(plan.kind, 'advance')
})

test('确认层的四个结果互不重叠', () => {
  const sent = planConfirm({ action: 'send', text: '在的' })
  const discarded = planConfirm({ action: 'discard' })
  const handed = planConfirm({ action: 'handoff' })
  const bad = planConfirm({ action: 'bad', reason: '事实错误' })
  assert.equal(sent.kind, 'send')
  assert.equal(discarded.kind, 'advance')
  assert.equal(handed.kind, 'advance')
  assert.equal(bad.kind, 'advance')
  if (discarded.kind === 'advance') assert.equal(discarded.idle, true)
  if (handed.kind === 'advance') assert.equal(handed.handoff, true)
  if (bad.kind === 'advance') assert.equal(bad.bad, '事实错误')
})
