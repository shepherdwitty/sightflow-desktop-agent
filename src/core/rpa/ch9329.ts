/** 串口帧。不依赖 Electron，也不打开串口。 */

export class UsbInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsbInputError'
  }
}

export const USB_INPUT_MESSAGE = {
  missing: '没有找到 USB 助理',
  connect: 'USB 助理没有连上',
  timeout: 'USB 助理没有应答',
  rejected: 'USB 助理没有执行这一步',
  offscreen: '副屏这次不点',
  cursor: '读不到鼠标位置，这一条没有发出去'
} as const

/** 运行日志里鼠标动作和文字回复的前缀。界面上的同名判断要和这串字一致。 */
export const USB_ACTION_MARK = '［USB］'

export function prefixUsbAction(content: string, usbActive: boolean): string {
  if (!usbActive) return content
  const prefix = `${USB_ACTION_MARK} `
  return content.startsWith(prefix) ? content : `${prefix}${content}`
}

const KEY_CODE: Record<string, number> = {
  a: 0x04,
  v: 0x19,
  enter: 0x28,
  return: 0x28,
  backspace: 0x2a
}

const MOD_BIT: Record<string, number> = {
  control: 0x01,
  ctrl: 0x01,
  shift: 0x02,
  alt: 0x04,
  option: 0x04,
  command: 0x08,
  cmd: 0x08,
  meta: 0x08,
  win: 0x08,
  super: 0x08
}

export interface PortHint {
  path?: string
  vendorId?: string
  productId?: string
}

export interface ParsedFrame {
  cmd: number
  data: Buffer
}

export interface CursorAxis {
  originX: number
  originY: number
  width: number
  height: number
}

export function checksum(bytes: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < bytes.length; i += 1) sum = (sum + bytes[i]) & 0xff
  return sum
}

export function buildFrame(cmd: number, data: number[] = []): Buffer {
  const frame = Buffer.alloc(6 + data.length)
  frame[0] = 0x57
  frame[1] = 0xab
  frame[2] = 0x00
  frame[3] = cmd & 0xff
  frame[4] = data.length & 0xff
  for (let i = 0; i < data.length; i += 1) frame[5 + i] = data[i] & 0xff
  frame[frame.length - 1] = checksum(frame.subarray(0, frame.length - 1))
  return frame
}

export function extractFrames(buffer: Uint8Array): { frames: ParsedFrame[]; rest: Uint8Array } {
  const frames: ParsedFrame[] = []
  let index = 0
  while (index + 6 <= buffer.length) {
    if (buffer[index] !== 0x57 || buffer[index + 1] !== 0xab) {
      index += 1
      continue
    }
    const length = buffer[index + 4]
    if (length > 64) {
      index += 1
      continue
    }
    const total = 6 + length
    if (index + total > buffer.length) break
    const body = buffer.subarray(index, index + total - 1)
    if (checksum(body) !== buffer[index + total - 1]) {
      index += 1
      continue
    }
    frames.push({
      cmd: buffer[index + 3],
      data: Buffer.from(buffer.subarray(index + 5, index + 5 + length))
    })
    index += total
  }
  return { frames, rest: buffer.subarray(index) }
}

/** 动作应答看状态字节。读信息的第 2 个数据字节为 0x01 才表示 USB 已经枚举。 */
export function frameStatus(frame: ParsedFrame, requestCmd: number): 'ok' | 'fail' | 'other' {
  const okCmd = (requestCmd | 0x80) & 0xff
  const errCmd = (requestCmd | 0xc0) & 0xff
  if (frame.cmd === errCmd) return 'fail'
  if (frame.cmd !== okCmd) return 'other'
  if (requestCmd === 0x01) return frame.data.length >= 2 && frame.data[1] === 0x01 ? 'ok' : 'fail'
  if (frame.data.length < 1 || frame.data[0] !== 0x00) return 'fail'
  return 'ok'
}

/**
 * 这一帧要不要当成当前事务的应答。
 * 串口写完成之前到达的字节属于上一次超时，不能拿来确认下一条相同命令。
 */
export function gateAck(armed: boolean, status: 'ok' | 'fail' | 'other'): 'ignore' | 'ok' | 'fail' {
  if (!armed || status === 'other') return 'ignore'
  return status
}

/** 与这次实机对准的整数除法：hid = (4096 * 坐标) / 轴长，再夹到 0–4095。 */
export function absoluteHid(pos: number, axis: number): number {
  if (!Number.isFinite(pos) || !Number.isFinite(axis) || axis <= 0) return 0
  const hid = Math.floor((4096 * pos) / axis)
  if (hid < 0) return 0
  if (hid > 4095) return 4095
  return hid
}

export function cursorAxis(
  bounds: { x: number; y: number; width: number; height: number },
  scaleFactor: number,
  platform: string
): CursorAxis {
  const scale = platform === 'win32' ? scaleFactor || 1 : 1
  return {
    originX: Math.round(bounds.x * scale),
    originY: Math.round(bounds.y * scale),
    width: Math.max(1, Math.round(bounds.width * scale)),
    height: Math.max(1, Math.round(bounds.height * scale))
  }
}

export function hidForPoint(x: number, y: number, axis: CursorAxis): { x: number; y: number } | null {
  if (x < axis.originX || y < axis.originY || x >= axis.originX + axis.width || y >= axis.originY + axis.height) {
    return null
  }
  return {
    x: absoluteHid(x - axis.originX, axis.width),
    y: absoluteHid(y - axis.originY, axis.height)
  }
}

export function hidKeyCode(name: string): number | null {
  return KEY_CODE[name.toLowerCase()] ?? null
}

export function modifierBit(name: string): number | null {
  return MOD_BIT[name.toLowerCase()] ?? null
}

export function keyboardFrame(modifiers: number, keyCode: number): Buffer {
  return buildFrame(0x02, [modifiers & 0xff, 0x00, keyCode & 0xff, 0x00, 0x00, 0x00, 0x00, 0x00])
}

export function absoluteMouseFrame(x: number, y: number, buttons: number, wheel = 0): Buffer {
  const hx = Math.max(0, Math.min(4095, x)) | 0
  const hy = Math.max(0, Math.min(4095, y)) | 0
  return buildFrame(0x04, [0x02, buttons & 0xff, hx & 0xff, (hx >> 8) & 0xff, hy & 0xff, (hy >> 8) & 0xff, wheel & 0xff])
}

function normalizeUsbId(value?: string): string {
  return (value || '').replace(/^0x/i, '').trim().toLowerCase()
}

/** macOS 上 tty.* 会等载波，打开 cu.* 才不会卡住。 */
export function preferCalloutPath(path: string, platform: string): string {
  if (platform !== 'darwin') return path
  return path.replace('/tty.', '/cu.')
}

/** CH340 串口：厂商 1a86 产品 7523，或路径里带 usbserial / wchusbserial。蓝牙口排除。 */
export function isAssistantPort(port: PortHint): boolean {
  const path = port.path || ''
  if (/bluetooth/i.test(path)) return false
  const vendor = normalizeUsbId(port.vendorId)
  const product = normalizeUsbId(port.productId)
  if (vendor === '1a86' && product === '7523') return true
  return /usbserial|wchusbserial/i.test(path)
}
