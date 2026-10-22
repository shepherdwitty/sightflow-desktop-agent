import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markUsbTraceStep } from './trace-mark.ts'
import type { TraceStepInput } from './trace-types.ts'

function step(
  partial: Partial<TraceStepInput> & Pick<TraceStepInput, 'phase' | 'summary'>
): TraceStepInput {
  return partial
}

test('USB 助理只标记点击和发送', () => {
  const send = step({
    phase: 'act',
    summary: '发送回复',
    action: { kind: 'send', payload: '你好' }
  })
  const click = step({
    phase: 'act',
    summary: '打开未读会话',
    action: { kind: 'click', target: [1, 2] }
  })
  const measure = step({ phase: 'act', summary: '量一下', action: { kind: 'measure' } })
  const observe = step({ phase: 'observe', summary: '截取当前聊天窗口' })
  const think = step({ phase: 'think', summary: '正在分析聊天内容...' })

  assert.equal(markUsbTraceStep(send, true).inputDevice, 'usb')
  assert.equal(markUsbTraceStep(click, true).inputDevice, 'usb')
  assert.equal(markUsbTraceStep(measure, true).inputDevice, undefined)
  assert.equal(markUsbTraceStep(observe, true).inputDevice, undefined)
  assert.equal(markUsbTraceStep(think, true).inputDevice, undefined)
  assert.equal(markUsbTraceStep(send, false).inputDevice, undefined)
})

test('已经标过的步骤不会再包一层', () => {
  const send = step({
    phase: 'act',
    summary: '发送回复',
    action: { kind: 'send' },
    inputDevice: 'usb'
  })
  assert.equal(markUsbTraceStep(send, true), send)
})
