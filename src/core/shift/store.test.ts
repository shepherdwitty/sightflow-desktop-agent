import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ShiftStore } from './store.ts'

test('冷名单和回合按会话键分开保存', () => {
  const store = ShiftStore.memory()
  store.seedAgents('沿用旧提示词')
  const active = store.activeAgent()
  assert.equal(active.prompt, '沿用旧提示词')

  store.addCold({ key: 'single:张三', title: '张三', kind: 'single', note: '', createdAt: 1 })
  assert.equal(store.isCold('single:张三'), true)
  store.removeCold('single:张三')
  assert.equal(store.isCold('single:张三'), false)

  store.appendTurns('single:李四', '李四', 'single', [{ side: 'in', text: '在吗' }], 'vision')
  store.appendTurns('group:家庭群', '家庭群', 'group', [{ side: 'in', text: '大家看一下' }], 'vision')
  assert.equal(store.listTurns('single:李四').length, 1)
  assert.equal(store.listTurns('group:家庭群')[0].text, '大家看一下')
  store.clearTurns('single:李四')
  assert.equal(store.listTurns('single:李四').length, 0)
  assert.equal(store.listTurns('group:家庭群').length, 1)

  store.saveAgent({ ...active, mode: 'auto', prompt: '新提示' }, false)
  store.saveAgent({ ...store.activeAgent(), prompt: '再改一句', mode: 'assist' })
  assert.equal(store.activeAgent().mode, 'auto')
  assert.equal(store.activeAgent().prompt, '再改一句')
})

test('复制和删除岗位不动会话记录，恢复自动会清掉连续否定', () => {
  const store = ShiftStore.memory()
  store.seedAgents()
  const active = store.activeAgent()
  store.addKnowledgeFile(active.id, '价目.md', [{ id: '1', fileName: '价目.md', title: '价格', text: '99 元' }])
  store.appendTurns('single:李四', '李四', 'single', [{ side: 'in', text: '在吗' }], 'vision')
  store.setHandedOff('single:李四', '李四', 'single', true)
  assert.equal(store.bumpBad('single:李四', '李四', 'single'), 1)
  assert.equal(store.bumpBad('single:李四', '李四', 'single'), 2)

  const copied = store.copyAgent(active.id)
  assert.equal(copied.ok, true)
  const copy = store.listAgents().find((agent) => agent.id === copied.id)
  assert.equal(copy?.mode, 'assist')
  assert.equal(copy?.name.endsWith('副本'), true)
  assert.notEqual(store.activeAgent().id, copied.id)
  assert.equal(store.knowledgeChunks(copied.id || '').length, 1)

  const created = store.createAgent()
  assert.equal(created.ok, true)
  assert.equal(store.listAgents().some((agent) => agent.id === created.id), true)

  assert.equal(store.disableAgent(active.id).ok, true)
  assert.notEqual(store.activeAgent().id, active.id)
  assert.equal(store.deleteAgent(active.id).ok, true)
  assert.equal(store.listTurns('single:李四').length, 1)
  assert.equal(store.knowledgeChunks(active.id).length, 0)

  store.appendTurns(
    'single:李四',
    '李四',
    'single',
    [
      { side: 'out', text: '同样的话' },
      { side: 'out', text: '同样的话' }
    ],
    'sent'
  )
  assert.deepEqual(store.recentOut('single:李四', 2), ['同样的话', '同样的话'])
  store.setHandledInbound('single:李四', '李四', 'single', ['退款'])
  store.resume('single:李四')
  assert.equal(store.isHandedOff('single:李四'), false)
  assert.equal(store.badCount('single:李四'), 0)
  assert.deepEqual(store.recentOut('single:李四', 2), [])
  assert.deepEqual(store.handledInbound('single:李四'), ['退款'])

  while (store.listAgents().length > 1) {
    const victim = store.listAgents().find((agent) => agent.id !== store.activeAgent().id)
    if (!victim) break
    assert.equal(store.deleteAgent(victim.id).ok, true)
  }
  assert.equal(store.deleteAgent(store.activeAgent().id).ok, false)
})
