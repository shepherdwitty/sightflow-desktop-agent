import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatHistory, mergeVisible, selectHistory } from './transcript-merge.ts'

test('只追加屏幕上新出现的尾巴', () => {
  const stored = [
    { side: 'in' as const, text: '你好' },
    { side: 'out' as const, text: '在的' }
  ]
  const merged = mergeVisible(stored, [
    { side: 'in', text: '你好' },
    { side: 'out', text: '在的' },
    { side: 'in', text: '多少钱' }
  ])
  assert.equal(merged.status, 'aligned')
  if (merged.status === 'aligned') {
    assert.deepEqual(merged.added, [{ side: 'in', text: '多少钱' }])
  }
})

test('对不齐时不覆盖旧记录', () => {
  const merged = mergeVisible(
    [
      { side: 'in', text: '你好' },
      { side: 'out', text: '在的' }
    ],
    [{ side: 'in', text: '完全是另一段话' }]
  )
  assert.equal(merged.status, 'reject')
})

test('一条长回复拆成多条气泡后仍能接上新消息', () => {
  const head = `${'花'.repeat(25)}。`
  const tail = '束'.repeat(20)
  const storedText = head + tail
  assert.ok(Array.from(storedText).length > 40)
  assert.equal(head + tail, storedText)
  const stored = [
    { side: 'in' as const, text: '在吗' },
    { side: 'out' as const, text: storedText }
  ]
  const visible = [
    { side: 'out' as const, text: head },
    { side: 'out' as const, text: tail },
    { side: 'in' as const, text: '好的' }
  ]
  const merged = mergeVisible(stored, visible)
  assert.equal(merged.status, 'aligned')
  if (merged.status === 'aligned') {
    assert.deepEqual(merged.added, [{ side: 'in', text: '好的' }])
  }
  assert.deepEqual(selectHistory(stored, visible.slice(0, 2), 20), [{ side: 'in', text: '在吗' }])
})

test('短句不会被两个半截气泡拼回去', () => {
  const merged = mergeVisible(
    [{ side: 'out', text: '你好' }],
    [
      { side: 'out', text: '你' },
      { side: 'out', text: '好' }
    ]
  )
  assert.equal(merged.status, 'reject')
})

test('历史只带走屏幕外的更早回合', () => {
  const stored = [
    { side: 'in' as const, text: '第一句' },
    { side: 'out' as const, text: '第二句' },
    { side: 'in' as const, text: '第三句' }
  ]
  const visible = [
    { side: 'out' as const, text: '第二句' },
    { side: 'in' as const, text: '第三句' }
  ]
  const history = selectHistory(stored, visible, 20)
  assert.deepEqual(history, [{ side: 'in', text: '第一句' }])
  assert.match(formatHistory(history), /对方：第一句/)
})
