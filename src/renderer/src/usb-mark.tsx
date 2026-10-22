import { useId } from 'react'

/** 运行日志和工作记忆共用的 USB 助理标记。U 盘造型。不要从 App 再导出，避免和 MemoryWindow 循环引用。 */
export function UsbLogIcon(): React.JSX.Element {
  const maskId = `usb-stick${useId().replace(/:/g, '')}`
  const show = { fill: '#fff' }
  const cut = { fill: '#000' }
  return (
    <svg className="log-usb" viewBox="0 0 24 24" aria-label="USB 助理" role="img">
      <title>USB 助理</title>
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <rect width="24" height="24" style={cut} />
        <rect x="4.7" y="6.35" width="14.6" height="16.55" rx="2.7" style={show} />
        <rect x="7.7" y="0.7" width="8.6" height="6.5" rx="0.75" style={show} />
        <rect x="8.7" y="1.55" width="6.6" height="4.5" rx="0.4" style={cut} />
        <rect x="9.45" y="2.15" width="1.7" height="1.7" rx="0.2" style={show} />
        <rect x="12.85" y="2.15" width="1.7" height="1.7" rx="0.2" style={show} />
        <circle cx="12" cy="21.05" r="1.05" style={cut} />
        <circle cx="12" cy="17.15" r="2.05" style={cut} />
        <circle cx="8.15" cy="12.05" r="1.55" style={cut} />
        <rect x="14.35" y="10.55" width="2.9" height="2.9" rx="0.35" style={cut} />
        <rect x="11.15" y="10.15" width="1.7" height="6" style={cut} />
        <rect x="8.9" y="11.35" width="2.4" height="1.45" style={cut} />
        <rect x="12.7" y="11.35" width="1.85" height="1.45" style={cut} />
        <path d="M12 8.15 L10.35 10.85 H13.65 Z" style={cut} />
        <circle cx="12" cy="17.15" r="0.95" style={show} />
        <circle cx="8.15" cy="12.05" r="0.62" style={show} />
        <rect x="14.95" y="11.15" width="1.7" height="1.7" rx="0.15" style={show} />
      </mask>
      <rect width="24" height="24" mask={`url(#${maskId})`} style={{ fill: 'currentColor' }} />
    </svg>
  )
}
