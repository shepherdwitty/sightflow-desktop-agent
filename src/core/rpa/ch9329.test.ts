import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  absoluteHid,
  absoluteMouseFrame,
  buildFrame,
  checksum,
  prefixUsbAction,
  USB_ACTION_MARK,
  cursorAxis,
  extractFrames,
  frameStatus,
  gateAck,
  hidForPoint,
  isAssistantPort,
  keyboardFrame,
  preferCalloutPath
} from './ch9329.ts'

test('校验和与读信息帧', () => {
  const info = buildFrame(0x01)
  assert.deepEqual([...info], [0x57, 0xab, 0x00, 0x01, 0x00, 0x03])
  assert.equal(checksum(info.subarray(0, info.length - 1)), info[info.length - 1])
})

test('读信息应答里的枚举位', () => {
  const reply = Buffer.from([0x57, 0xab, 0x00, 0x81, 0x08, 0x38, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0xc5])
  const { frames, rest } = extractFrames(reply)
  assert.equal(rest.length, 0)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].cmd, 0x81)
  assert.equal(frames[0].data[0], 0x38)
  assert.equal(frames[0].data[1], 0x01)
  assert.equal(frameStatus(frames[0], 0x01), 'ok')

  const offline = Buffer.from(frames[0].data)
  offline[1] = 0x00
  assert.equal(frameStatus({ cmd: 0x81, data: offline }, 0x01), 'fail')
})

test('脏字节后面的半帧会留下来', () => {
  const release = keyboardFrame(0, 0)
  const split = Buffer.concat([Buffer.from([0x00, 0x11]), release.subarray(0, 4)])
  const first = extractFrames(split)
  assert.equal(first.frames.length, 0)
  const second = extractFrames(Buffer.concat([first.rest, release.subarray(4)]))
  assert.equal(second.frames.length, 1)
  assert.equal(second.rest.length, 0)
  assert.deepEqual([...release], [0x57, 0xab, 0x00, 0x02, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0c])
})

test('绝对坐标按主屏轴长做整数除法', () => {
  assert.equal(absoluteHid(120, 1800), 273)
  assert.equal(absoluteHid(80, 1169), 280)
  const axis = cursorAxis({ x: 0, y: 0, width: 1800, height: 1169 }, 2, 'darwin')
  assert.deepEqual(hidForPoint(120, 80, axis), { x: 273, y: 280 })
  assert.equal(hidForPoint(1800, 10, axis), null)
  assert.equal(hidForPoint(-1, 10, axis), null)

  const windows = cursorAxis({ x: 0, y: 0, width: 1800, height: 1169 }, 2, 'win32')
  assert.equal(windows.width, 3600)
  assert.equal(windows.height, 2338)
  assert.deepEqual(hidForPoint(240, 160, windows), { x: 273, y: 280 })
})

test('Command+V 带左修饰键和 V 键码', () => {
  const frame = keyboardFrame(0x08, 0x19)
  assert.equal(frame[3], 0x02)
  assert.equal(frame[4], 0x08)
  assert.equal(frame[5], 0x08)
  assert.equal(frame[6], 0x00)
  assert.equal(frame[7], 0x19)
  assert.equal(frame[frame.length - 1], checksum(frame.subarray(0, frame.length - 1)))
})

test('绝对鼠标帧是报告 2 和小端坐标', () => {
  const frame = absoluteMouseFrame(273, 280, 0x01)
  assert.equal(frame[5], 0x02)
  assert.equal(frame[6], 0x01)
  assert.equal(frame[7], 273 & 0xff)
  assert.equal(frame[8], (273 >> 8) & 0xff)
  assert.equal(frame[9], 280 & 0xff)
  assert.equal(frame[10], (280 >> 8) & 0xff)
})

test('只认 CH340 串口，不认蓝牙', () => {
  assert.equal(isAssistantPort({ vendorId: '1A86', productId: '7523', path: '/dev/cu.usbserial-11140' }), true)
  assert.equal(isAssistantPort({ vendorId: '0x1a86', productId: '0x7523', path: '/dev/cu.usbmodem' }), true)
  assert.equal(isAssistantPort({ path: '/dev/cu.wchusbserial123' }), true)
  assert.equal(isAssistantPort({ path: '/dev/cu.usbserial-1' }), true)
  assert.equal(isAssistantPort({ vendorId: '1a86', productId: '7523', path: '/dev/cu.Bluetooth-Incoming-Port' }), false)
  assert.equal(isAssistantPort({ vendorId: '1a86', productId: 'e129', path: '/dev/cu.usbmodem1101' }), false)
  assert.equal(isAssistantPort({ path: '/dev/cu.debug-console' }), false)
  assert.equal(preferCalloutPath('/dev/tty.usbserial-11140', 'darwin'), '/dev/cu.usbserial-11140')
  assert.equal(preferCalloutPath('/dev/cu.usbserial-11140', 'darwin'), '/dev/cu.usbserial-11140')
  assert.equal(preferCalloutPath('COM3', 'win32'), 'COM3')
})

test('动作状态字节不是 0 就算没执行', () => {
  const ack = buildFrame(0x84, [0x00])
  const { frames } = extractFrames(ack)
  assert.equal(frameStatus(frames[0], 0x04), 'ok')
  const bad = buildFrame(0x84, [0x01])
  assert.equal(frameStatus(extractFrames(bad).frames[0], 0x04), 'fail')
  const err = buildFrame(0xc4, [0x00])
  assert.equal(frameStatus(extractFrames(err).frames[0], 0x04), 'fail')
})

test('写完成之前的应答不能算成下一条', () => {
  assert.equal(gateAck(false, 'ok'), 'ignore')
  assert.equal(gateAck(false, 'fail'), 'ignore')
  assert.equal(gateAck(true, 'other'), 'ignore')
  assert.equal(gateAck(true, 'ok'), 'ok')
  assert.equal(gateAck(true, 'fail'), 'fail')
})

test('只有 USB 动作日志才加标记', () => {
  assert.equal(prefixUsbAction('正在打开未读会话', false), '正在打开未读会话')
  assert.equal(prefixUsbAction('正在打开未读会话', true), `${USB_ACTION_MARK} 正在打开未读会话`)
  assert.equal(prefixUsbAction(`${USB_ACTION_MARK} 已发出`, true), `${USB_ACTION_MARK} 已发出`)
})
