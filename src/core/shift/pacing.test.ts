import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildTypeScript, DEFAULT_PACING, previewTyped, splitMessage, typoForbidden } from './pacing.ts'

test('关掉节奏时整段一次粘贴', () => {
  const actions = buildTypeScript('你好，今天还营业到晚上九点，欢迎过来看花。', {
    ...DEFAULT_PACING,
    enabled: false
  })
  assert.deepEqual(
    actions.map((action) => action.op),
    ['paste', 'enter']
  )
  assert.deepEqual(previewTyped(actions), ['你好，今天还营业到晚上九点，欢迎过来看花。'])
})

test('长回复会分段，发出去的正文不变', () => {
  const text = '今天店里有玫瑰和百合。玫瑰适合送人。百合可以自己养。需要的话我让同事给你留一束。到店再说颜色。'
  const actions = buildTypeScript(text, { ...DEFAULT_PACING, typo: 'off' }, () => 0)
  const messages = previewTyped(actions)
  assert.ok(messages.length > 1)
  assert.equal(messages.join(''), text)
  assert.ok(actions.some((action) => action.op === 'wait'))
})

test('分段不会把表情切成半个', () => {
  const text = `${'啊'.repeat(39)}😀${'呀'.repeat(10)}`
  const parts = splitMessage(text, true)
  assert.equal(parts.join(''), text)
  assert.ok(parts.length > 1)
  assert.ok(parts.every((part) => Array.from(part).length <= 40))
  assert.ok(parts.every((part) => !/[\uD800-\uDBFF]$/.test(part) && !/^[\uDC00-\uDFFF]/.test(part)))
})

test('没有标点的长句也会拆开', () => {
  const text = '这是一段没有任何标点的说明文字用来确认超长内容不会一整段粘贴出去给对方看到机器一下打完'
  assert.ok(text.length > 40)
  const parts = splitMessage(text, true)
  assert.ok(parts.length > 1)
  assert.ok(parts.every((part) => part.length <= 40))
  assert.equal(parts.join(''), text)
})

test('错字会退格改正，含价格的句子不错字', () => {
  const text = '好的，我在店里等你过来看一看。'
  let rolls = 0
  const actions = buildTypeScript(text, { ...DEFAULT_PACING, segmentLong: false, typo: 'mid' }, () => {
    rolls += 1
    return rolls === 1 ? 0 : 0
  })
  assert.ok(actions.some((action) => action.op === 'backspace'))
  assert.equal(previewTyped(actions).join(''), text)
  assert.equal(typoForbidden('玫瑰 20 元'), true)
  const priced = buildTypeScript('玫瑰 20 元', { ...DEFAULT_PACING, typo: 'mid' }, () => 0)
  assert.equal(
    priced.some((action) => action.op === 'backspace'),
    false
  )
})
