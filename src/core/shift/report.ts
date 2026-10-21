export type ShiftStatus = 'pending' | 'handoff' | 'done'

export interface ShiftEvent {
  key: string
  title: string
  at: number
  kind: 'replied' | 'skipped' | 'cold' | 'handoff' | 'pending'
  reason: string
}

export interface ReportRow {
  key: string
  title: string
  status: ShiftStatus
  reason: string
  at: number
}

export function buildShiftReport(events: ShiftEvent[]): ReportRow[] {
  const grouped = new Map<string, ShiftEvent[]>()
  for (const event of events) {
    if (!event.key) continue
    const list = grouped.get(event.key) ?? []
    list.push(event)
    grouped.set(event.key, list)
  }

  const rows: ReportRow[] = []
  for (const [key, list] of grouped) {
    const ordered = [...list].sort((a, b) => a.at - b.at)
    const last = ordered[ordered.length - 1]
    const status: ShiftStatus =
      last.kind === 'handoff' ? 'handoff' : last.kind === 'replied' ? 'done' : 'pending'
    rows.push({
      key,
      title: last.title || key,
      status,
      reason: last.reason,
      at: last.at
    })
  }
  return rows.sort((a, b) => b.at - a.at)
}

/**
 * 暂停中的会话以 conv_state 为准。后面的跳过，或隔天没有新事件，都不能把它显示成待处理。
 * 已经恢复自动的会话，最后一条事件可能仍是转人工，这时改回待处理。
 */
export function applyHandedOff(
  rows: ReportRow[],
  paused: Array<{ key: string; title: string }>
): ReportRow[] {
  const pausedKeys = new Set(paused.map((item) => item.key).filter(Boolean))
  const next = rows.map((row) => {
    if (row.status === 'handoff' && !pausedKeys.has(row.key)) {
      return { ...row, status: 'pending' as const, reason: '已恢复自动' }
    }
    return { ...row }
  })
  const byKey = new Map(next.map((row) => [row.key, row]))
  for (const item of paused) {
    if (!item.key) continue
    const existing = byKey.get(item.key)
    if (existing) {
      existing.status = 'handoff'
      continue
    }
    const row: ReportRow = {
      key: item.key,
      title: item.title || item.key,
      status: 'handoff',
      reason: '已转人工',
      at: 0
    }
    next.push(row)
    byKey.set(item.key, row)
  }
  return next.sort((a, b) => b.at - a.at)
}

export function reportToCsv(rows: ReportRow[]): string {
  const header = '名称,状态,原因,时间'
  const lines = rows.map((row) =>
    [row.title, statusLabel(row.status), row.reason, new Date(row.at).toISOString()]
      .map(csvCell)
      .join(',')
  )
  return [header, ...lines].join('\n')
}

function statusLabel(status: ShiftStatus): string {
  if (status === 'handoff') return '已转人工'
  if (status === 'done') return '已处理'
  return '待处理'
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

export function startOfLocalDay(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

export function endOfLocalDay(now: Date): number {
  return startOfLocalDay(now) + 24 * 60 * 60 * 1000
}
