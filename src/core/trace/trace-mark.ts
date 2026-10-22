import type { TraceStepInput } from './trace-types'

/**
 * USB 助理正在执行时，给点击和发送打上 inputDevice。
 * 观察、判断、验证，以及测量、等待，一律不打。
 */
export function markUsbTraceStep(step: TraceStepInput, usbActive: boolean): TraceStepInput {
  if (!usbActive || step.phase !== 'act') return step
  const kind = step.action?.kind
  if (kind !== 'click' && kind !== 'send') return step
  return step.inputDevice === 'usb' ? step : { ...step, inputDevice: 'usb' }
}
