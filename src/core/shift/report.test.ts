import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyHandedOff, buildShiftReport, reportToCsv } from './report.ts'

test('班报按最后一条事件归类，冷处理留在待处理', () => {
  const rows = buildShiftReport([
    { key: 'single:张三', title: '张三', at: 1, kind: 'cold', reason: '冷处理' },
    { key: 'single:李四', title: '李四', at: 2, kind: 'replied', reason: '已回复' },
    { key: 'single:李四', title: '李四', at: 3, kind: 'handoff', reason: '提到「退款」' }
  ])
  const zhang = rows.find((row) => row.key === 'single:张三')
  const li = rows.find((row) => row.key === 'single:李四')
  assert.equal(zhang?.status, 'pending')
  assert.equal(zhang?.reason, '冷处理')
  assert.equal(li?.status, 'handoff')
  assert.match(reportToCsv(rows), /已转人工/)
})

test('已经恢复自动的会话不再显示成已转人工', () => {
  const rows = applyHandedOff(
    buildShiftReport([{ key: 'single:李四', title: '李四', at: 2, kind: 'handoff', reason: '提到「退款」' }]),
    []
  )
  assert.equal(rows[0]?.status, 'pending')
  assert.equal(rows[0]?.reason, '已恢复自动')
})

test('暂停中的会话不会被后面的跳过改成待处理', () => {
  const rows = applyHandedOff(
    buildShiftReport([
      { key: 'single:李四', title: '李四', at: 2, kind: 'handoff', reason: '提到「退款」' },
      { key: 'single:李四', title: '李四', at: 3, kind: 'skipped', reason: '已转人工' }
    ]),
    [
      { key: 'single:李四', title: '李四' },
      { key: 'single:王五', title: '王五' }
    ]
  )
  assert.equal(rows.find((row) => row.key === 'single:李四')?.status, 'handoff')
  assert.equal(rows.find((row) => row.key === 'single:王五')?.status, 'handoff')
  assert.equal(rows.find((row) => row.key === 'single:王五')?.reason, '已转人工')
})
