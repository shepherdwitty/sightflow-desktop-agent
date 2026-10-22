import { existsSync } from 'node:fs'
import { screen } from 'electron'
import {
  USB_INPUT_MESSAGE,
  UsbInputError,
  absoluteMouseFrame,
  type CursorAxis,
  cursorAxis,
  extractFrames,
  frameStatus,
  gateAck,
  hidForPoint,
  hidKeyCode,
  isAssistantPort,
  keyboardFrame,
  modifierBit,
  preferCalloutPath,
  type ParsedFrame,
  type PortHint,
  buildFrame
} from './ch9329'
import { delay, getRobot } from './util'

const FRAME_GAP_MS = 20
const KEY_HOLD_MS = 40
const CLICK_HOLD_MS = 40
const ACK_TIMEOUT_MS = 450

export interface InputDriver {
  getMousePos(): { x: number; y: number }
  moveMouse(x: number, y: number): Promise<void>
  mouseToggle(state: 'down' | 'up', button?: 'left' | 'right' | 'middle'): Promise<void>
  mouseClick(button?: 'left' | 'right' | 'middle'): Promise<void>
  keyTap(key: string, modifiers?: string[] | string): Promise<void>
  keyToggle(key: string, state: 'down' | 'up'): Promise<void>
}

interface SerialLike {
  write(data: Buffer, callback: (error: Error | null) => void): void
  drain(callback: (error: Error | null) => void): void
  close(callback: (error: Error | null) => void): void
  on(event: 'data', listener: (chunk: Buffer) => void): void
  on(event: 'close', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

interface SerialCtor {
  list(): Promise<PortHint[]>
  new (options: Record<string, unknown>): SerialLike
}

interface PendingFrame {
  cmd: number
  /** 本次 write 回调之后才接受应答，避免把上一次超时的迟到帧认成这一次。 */
  armed: boolean
  settled: boolean
  timer: NodeJS.Timeout
  resolve: (frame: ParsedFrame) => void
  reject: (error: Error) => void
}

class HidLink {
  private rx: Uint8Array = new Uint8Array(0)
  private pending: PendingFrame | null = null
  private open = true
  private closing = false
  private lastSentAt = 0

  constructor(
    private readonly port: SerialLike,
    readonly path: string
  ) {}

  isOpen(): boolean {
    return this.open
  }

  markClosed(): void {
    this.open = false
    if (!this.closing) cachedReady = false
    this.failPending(new UsbInputError(USB_INPUT_MESSAGE.connect))
  }

  failPending(error: Error): void {
    const pending = this.pending
    if (!pending || pending.settled) return
    pending.settled = true
    clearTimeout(pending.timer)
    this.pending = null
    pending.reject(error)
  }

  onData(chunk: Buffer): void {
    const merged = new Uint8Array(this.rx.length + chunk.length)
    merged.set(this.rx, 0)
    merged.set(chunk, this.rx.length)
    const parsed = extractFrames(merged)
    this.rx = parsed.rest
    const pending = this.pending
    if (!pending || pending.settled) return
    for (const frame of parsed.frames) {
      const gate = gateAck(pending.armed, frameStatus(frame, pending.cmd))
      if (gate === 'ignore') continue
      pending.settled = true
      clearTimeout(pending.timer)
      this.pending = null
      if (gate === 'ok') pending.resolve(frame)
      else {
        pending.reject(
          new UsbInputError(pending.cmd === 0x01 ? USB_INPUT_MESSAGE.connect : USB_INPUT_MESSAGE.rejected)
        )
      }
      return
    }
  }

  async transact(cmd: number, data: number[]): Promise<ParsedFrame> {
    if (!this.open) throw new UsbInputError(USB_INPUT_MESSAGE.connect)
    const elapsed = this.lastSentAt === 0 ? FRAME_GAP_MS : Date.now() - this.lastSentAt
    if (elapsed < FRAME_GAP_MS) await delay(FRAME_GAP_MS - elapsed)
    const packet = buildFrame(cmd, data)
    return new Promise((resolve, reject) => {
      const pending: PendingFrame = {
        cmd,
        armed: false,
        settled: false,
        timer: setTimeout(() => {
          if (pending.settled) return
          pending.settled = true
          if (this.pending === pending) this.pending = null
          this.rx = new Uint8Array(0)
          reject(new UsbInputError(USB_INPUT_MESSAGE.timeout))
        }, ACK_TIMEOUT_MS),
        resolve,
        reject
      }
      this.pending = pending
      this.lastSentAt = Date.now()
      this.port.write(packet, (error) => {
        if (this.pending !== pending || pending.settled) return
        if (error) {
          this.failPending(new UsbInputError(USB_INPUT_MESSAGE.connect))
          return
        }
        pending.armed = true
        this.port.drain(() => undefined)
      })
    })
  }

  close(): Promise<void> {
    this.closing = true
    this.open = false
    this.failPending(new UsbInputError(USB_INPUT_MESSAGE.connect))
    return new Promise((resolve) => {
      this.port.close(() => resolve())
    })
  }
}

let inputMode: 'software' | 'usb' = 'software'
let cachedReady = false
let verifiedPath: string | null = null
let live: HidLink | null = null
let tail: Promise<void> = Promise.resolve()
/** 一条移动或点击还没走完时，探测不要插进来把光标停住。 */
let gestureDepth = 0
const readyListeners = new Set<() => void>()

function emitReady(): void {
  for (const listener of readyListeners) {
    try {
      listener()
    } catch (error) {
      console.error('[input] 状态通知失败', error instanceof Error ? error.name : 'error')
    }
  }
}

export function onUsbReadyChange(listener: () => void): () => void {
  readyListeners.add(listener)
  return () => readyListeners.delete(listener)
}

export function holdUsbGesture(): () => void {
  gestureDepth += 1
  return () => {
    gestureDepth = Math.max(0, gestureDepth - 1)
  }
}

function lock<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(job, job)
  tail = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

function loadSerialPort(): { SerialPort: SerialCtor } {
  // 运行时 require，避免打包器把原生串口模块编进主进程。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require('serialport') as { SerialPort?: SerialCtor }
  if (!loaded.SerialPort) throw new UsbInputError(USB_INPUT_MESSAGE.connect)
  return { SerialPort: loaded.SerialPort }
}

function rankPort(port: PortHint): number {
  const vendor = (port.vendorId || '').replace(/^0x/i, '').toLowerCase()
  const product = (port.productId || '').replace(/^0x/i, '').toLowerCase()
  return vendor === '1a86' && product === '7523' ? 0 : 1
}

async function findAssistantPath(): Promise<string | null> {
  try {
    const { SerialPort } = loadSerialPort()
    const ports = await SerialPort.list()
    const matched = ports.filter((port) => isAssistantPort(port) && port.path)
    matched.sort((a, b) => rankPort(a) - rankPort(b))
    const found = matched[0]?.path
    if (!found) return null
    const callout = preferCalloutPath(found, process.platform)
    if (callout !== found && existsSync(callout)) return callout
    return found
  } catch (error) {
    console.error('[input] 没有列出串口', error)
    return null
  }
}

function readPrimaryAxis(): CursorAxis {
  const display = screen.getPrimaryDisplay()
  return cursorAxis(display.bounds, display.scaleFactor || 1, process.platform)
}

async function closePort(): Promise<void> {
  const current = live
  live = null
  verifiedPath = null
  if (!current) return
  await current.close()
}

async function openPort(path: string): Promise<void> {
  let port: SerialLike
  try {
    const { SerialPort } = loadSerialPort()
    port = new SerialPort({
      path,
      baudRate: 9600,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      // 关闭时不要拉低 DTR，避免把已经枚举好的键鼠复位。
      hupcl: false,
      autoOpen: false
    })
    await new Promise<void>((resolve, reject) => {
      const opener = port as SerialLike & { open(callback: (error: Error | null) => void): void }
      opener.open((error) => (error ? reject(error) : resolve()))
    })
  } catch (error) {
    console.error('[input] 串口没有打开', error)
    throw new UsbInputError(USB_INPUT_MESSAGE.connect)
  }
  const link = new HidLink(port, path)
  port.on('data', (chunk) => link.onData(chunk))
  port.on('close', () => {
    const wasReady = cachedReady
    link.markClosed()
    if (live === link) {
      live = null
      verifiedPath = null
    }
    if (wasReady !== cachedReady) emitReady()
  })
  port.on('error', (error) => {
    console.error('[input] 串口中断', error instanceof Error ? error.name : 'error')
    cachedReady = false
    verifiedPath = null
    if (live === link) live = null
    if (link.isOpen()) void link.close()
    else link.failPending(new UsbInputError(USB_INPUT_MESSAGE.connect))
    emitReady()
  })
  live = link
}

async function ensurePort(): Promise<HidLink> {
  if (live?.isOpen()) return live
  const path = await findAssistantPath()
  if (!path) throw new UsbInputError(USB_INPUT_MESSAGE.missing)
  await openPort(path)
  if (!live) throw new UsbInputError(USB_INPUT_MESSAGE.connect)
  return live
}

async function openMatched(path: string): Promise<HidLink> {
  if (live?.isOpen() && live.path === path) return live
  await closePort()
  await openPort(path)
  if (!live) throw new UsbInputError(USB_INPUT_MESSAGE.connect)
  return live
}

async function transact(cmd: number, data: number[]): Promise<ParsedFrame> {
  const link = await ensurePort()
  try {
    return await link.transact(cmd, data)
  } catch (error) {
    if (!link.isOpen()) {
      if (live === link) live = null
      verifiedPath = null
      cachedReady = false
    }
    throw error
  }
}

async function ensureEnumerated(): Promise<void> {
  const link = await ensurePort()
  if (cachedReady && verifiedPath === link.path) return
  const info = await link.transact(0x01, [])
  if (frameStatus(info, 0x01) !== 'ok') {
    await closePort()
    cachedReady = false
    throw new UsbInputError(USB_INPUT_MESSAGE.connect)
  }
  cachedReady = true
  verifiedPath = link.path
}

function buttonBit(button: 'left' | 'right' | 'middle'): number {
  if (button === 'right') return 0x02
  if (button === 'middle') return 0x04
  return 0x01
}

function modifierMask(modifiers?: string[] | string): number {
  const names = !modifiers ? [] : Array.isArray(modifiers) ? modifiers : [modifiers]
  let mask = 0
  for (const name of names) {
    const bit = modifierBit(name)
    if (bit == null) throw new UsbInputError(USB_INPUT_MESSAGE.rejected)
    mask |= bit
  }
  return mask
}

class SoftwareDriver implements InputDriver {
  getMousePos(): { x: number; y: number } {
    const robot = getRobot()
    if (!robot) return { x: 0, y: 0 }
    return robot.getMousePos()
  }

  async moveMouse(x: number, y: number): Promise<void> {
    getRobot()?.moveMouse(Math.round(x), Math.round(y))
  }

  async mouseToggle(state: 'down' | 'up', button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    getRobot()?.mouseToggle(state, button)
  }

  async mouseClick(button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    getRobot()?.mouseClick(button)
  }

  async keyTap(key: string, modifiers?: string[] | string): Promise<void> {
    const robot = getRobot()
    if (!robot) return
    const names = !modifiers ? [] : Array.isArray(modifiers) ? modifiers : [modifiers]
    if (names.length) robot.keyTap(key, names)
    else robot.keyTap(key)
  }

  async keyToggle(key: string, state: 'down' | 'up'): Promise<void> {
    getRobot()?.keyToggle(key, state)
  }
}

class UsbDriver implements InputDriver {
  private buttons = 0
  private hidX: number | null = null
  private hidY: number | null = null
  private mods = 0
  /** 松开帧没成功，下一次拿到锁先发全 0，避免 Command 或左键粘住。 */
  private keysUnsynced = false
  private buttonsUnsynced = false

  getMousePos(): { x: number; y: number } {
    const robot = getRobot()
    if (!robot) throw new UsbInputError(USB_INPUT_MESSAGE.cursor)
    return robot.getMousePos()
  }

  async moveMouse(x: number, y: number): Promise<void> {
    this.assertSelected()
    const hid = hidForPoint(Math.round(x), Math.round(y), readPrimaryAxis())
    if (!hid) throw new UsbInputError(USB_INPUT_MESSAGE.offscreen)
    await lock(async () => {
      this.assertSelected()
      await this.recover()
      await ensureEnumerated()
      await transact(0x04, mouseData(hid.x, hid.y, this.buttons))
      this.hidX = hid.x
      this.hidY = hid.y
    })
  }

  async mouseToggle(state: 'down' | 'up', button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    await lock(async () => {
      this.assertSelected()
      await this.recover()
      await this.placeAtCursor()
      const bit = buttonBit(button)
      const next = state === 'down' ? this.buttons | bit : this.buttons & ~bit
      this.buttonsUnsynced = true
      await transact(0x04, mouseData(this.hidX || 0, this.hidY || 0, next))
      this.buttons = next
      this.buttonsUnsynced = false
    })
  }

  async mouseClick(button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    await lock(async () => {
      this.assertSelected()
      await this.recover()
      await this.placeAtCursor()
      const bit = buttonBit(button)
      this.buttons |= bit
      this.buttonsUnsynced = true
      let failure: unknown = null
      try {
        await transact(0x04, mouseData(this.hidX || 0, this.hidY || 0, this.buttons))
        await delay(CLICK_HOLD_MS)
      } catch (error) {
        failure = error
      }
      this.buttons &= ~bit
      try {
        await transact(0x04, mouseData(this.hidX || 0, this.hidY || 0, this.buttons))
        this.buttonsUnsynced = false
      } catch (error) {
        if (!failure) failure = error
      }
      if (failure) throw failure
    })
  }

  async keyTap(key: string, modifiers?: string[] | string): Promise<void> {
    const code = hidKeyCode(key)
    if (code == null) throw new UsbInputError(USB_INPUT_MESSAGE.rejected)
    const tapMods = modifierMask(modifiers)
    await lock(async () => {
      this.assertSelected()
      await this.recover()
      await ensureEnumerated()
      this.keysUnsynced = true
      let failure: unknown = null
      try {
        await transact(0x02, keyData(this.mods | tapMods, code))
        await delay(KEY_HOLD_MS)
      } catch (error) {
        failure = error
      }
      try {
        await transact(0x02, keyData(this.mods, 0))
        this.keysUnsynced = false
      } catch (error) {
        if (!failure) failure = error
      }
      if (failure) throw failure
    })
  }

  async keyToggle(key: string, state: 'down' | 'up'): Promise<void> {
    const bit = modifierBit(key)
    if (bit == null) throw new UsbInputError(USB_INPUT_MESSAGE.rejected)
    await lock(async () => {
      this.assertSelected()
      await this.recover()
      await ensureEnumerated()
      const next = state === 'down' ? this.mods | bit : this.mods & ~bit
      this.keysUnsynced = true
      await transact(0x02, keyData(next, 0))
      this.mods = next
      this.keysUnsynced = false
    })
  }

  /** 关口前把键和按键都松开。此时输入模式可能已经切回软件键鼠。 */
  async releaseAll(): Promise<void> {
    if (!live?.isOpen()) {
      this.mods = 0
      this.buttons = 0
      this.keysUnsynced = false
      this.buttonsUnsynced = false
      return
    }
    await transact(0x02, keyData(0, 0))
    this.mods = 0
    this.keysUnsynced = false
    if (this.hidX != null && this.hidY != null) {
      await transact(0x04, mouseData(this.hidX, this.hidY, 0))
    }
    this.buttons = 0
    this.buttonsUnsynced = false
  }

  private assertSelected(): void {
    if (currentInputMode() !== 'usb') throw new UsbInputError(USB_INPUT_MESSAGE.connect)
  }

  private async recover(): Promise<void> {
    if (!this.keysUnsynced && !this.buttonsUnsynced) return
    await ensureEnumerated()
    if (this.keysUnsynced) {
      await transact(0x02, keyData(0, 0))
      this.mods = 0
      this.keysUnsynced = false
    }
    if (this.buttonsUnsynced) {
      await this.placeAtCursor()
      await transact(0x04, mouseData(this.hidX || 0, this.hidY || 0, 0))
      this.buttons = 0
      this.buttonsUnsynced = false
    }
  }

  private async placeAtCursor(): Promise<void> {
    if (this.hidX != null && this.hidY != null) {
      await ensureEnumerated()
      return
    }
    const pos = this.getMousePos()
    const hid = hidForPoint(Math.round(pos.x), Math.round(pos.y), readPrimaryAxis())
    if (!hid) throw new UsbInputError(USB_INPUT_MESSAGE.offscreen)
    await ensureEnumerated()
    this.hidX = hid.x
    this.hidY = hid.y
  }
}

function mouseData(x: number, y: number, buttons: number): number[] {
  return [...absoluteMouseFrame(x, y, buttons).subarray(5, 12)]
}

function keyData(modifiers: number, keyCode: number): number[] {
  return [...keyboardFrame(modifiers, keyCode).subarray(5, 13)]
}

const softwareDriver = new SoftwareDriver()
const usbDriver = new UsbDriver()

export function currentInputMode(): 'software' | 'usb' {
  return inputMode
}

export function usbReadyCached(): boolean {
  return cachedReady
}

export function activeInput(): InputDriver {
  return inputMode === 'usb' ? usbDriver : softwareDriver
}

export function onPrimaryScreen(x: number, y: number): boolean {
  return hidForPoint(Math.round(x), Math.round(y), readPrimaryAxis()) !== null
}

export function clampToPrimary(x: number, y: number): { x: number; y: number } {
  const axis = readPrimaryAxis()
  return {
    x: Math.min(axis.originX + axis.width - 1, Math.max(axis.originX, Math.round(x))),
    y: Math.min(axis.originY + axis.height - 1, Math.max(axis.originY, Math.round(y)))
  }
}

export function syncInputBackend(backend: 'software' | 'usb'): void {
  const next = backend === 'usb' ? 'usb' : 'software'
  if (next === inputMode) return
  inputMode = next
  if (next === 'software') void closeUsbLink()
}

export async function refreshUsbReady(): Promise<boolean> {
  if (gestureDepth > 0) return cachedReady
  try {
    return await lock(async () => {
      const path = await findAssistantPath()
      if (!path) {
        await closePort()
        cachedReady = false
        return false
      }
      try {
        const link = await openMatched(path)
        const info = await link.transact(0x01, [])
        const ready = frameStatus(info, 0x01) === 'ok'
        cachedReady = ready
        verifiedPath = ready ? path : null
        if (!ready) await closePort()
        return ready
      } catch (error) {
        console.error('[input] 探测失败', error)
        await closePort()
        cachedReady = false
        return false
      }
    })
  } catch (error) {
    console.error('[input] 探测失败', error)
    cachedReady = false
    return false
  }
}

export async function acceptUsbBackend(): Promise<{ ok: boolean; message?: string }> {
  try {
    return await lock(async () => {
      try {
        const path = await findAssistantPath()
        if (!path) {
          await closePort()
          cachedReady = false
          return { ok: false, message: USB_INPUT_MESSAGE.missing }
        }
        const link = await openMatched(path)
        const info = await link.transact(0x01, [])
        if (frameStatus(info, 0x01) !== 'ok') {
          await closePort()
          cachedReady = false
          return { ok: false, message: USB_INPUT_MESSAGE.connect }
        }
        cachedReady = true
        verifiedPath = path
        inputMode = 'usb'
        return { ok: true }
      } catch (error) {
        console.error('[input] 无法启用 USB 助理', error)
        await closePort()
        cachedReady = false
        const message = error instanceof UsbInputError ? error.message : USB_INPUT_MESSAGE.connect
        return { ok: false, message }
      }
    })
  } catch (error) {
    const message = error instanceof UsbInputError ? error.message : USB_INPUT_MESSAGE.connect
    return { ok: false, message }
  }
}

export async function closeUsbLink(): Promise<void> {
  await lock(async () => {
    try {
      await usbDriver.releaseAll()
    } catch {
      // 松不开也要把口关掉，避免退出卡住。
    }
    await closePort()
  })
}

export { UsbInputError }
