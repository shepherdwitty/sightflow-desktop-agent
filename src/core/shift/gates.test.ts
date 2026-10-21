import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultAgents, type AgentProfile } from './agents.ts'
import { decideTurn, effectiveMode } from './decide-turn.ts'
import { evaluateGate, withinWorkHours } from './gates.ts'
import type { KnowledgeChunk } from '../knowledge/search.ts'

const agent: AgentProfile = { ...defaultAgents()[0], blacklist: ['广告号'], handoffKeywords: ['退款'] }

function base(overrides: Partial<Parameters<typeof evaluateGate>[0]> = {}): ReturnType<typeof evaluateGate> {
  return evaluateGate({
    title: '张三',
    kind: 'single',
    cold: false,
    handedOff: false,
    mentionedMe: null,
    config: {
      blacklist: ['广告号'],
      whitelistEnabled: false,
      whitelist: [],
      groupReply: 'mention',
      workHoursEnabled: false,
      workStart: '09:00',
      workEnd: '18:00',
      hourlyLimit: 30,
      handoffKeywords: ['退款']
    },
    sentThisHour: 0,
    now: new Date('2026-10-21T12:00:00'),
    ...overrides
  })
}

test('冷处理在回复前拦住', () => {
  const result = base({ cold: true })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, '冷处理')
})

test('群里读不到 @ 就不回复', () => {
  const result = base({ kind: 'group', title: '家庭群', mentionedMe: null })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, '群里没有 @')
})

test('超过每小时上限后不再发送', () => {
  const result = base({ sentThisHour: 30 })
  assert.equal(result.ok, false)
})

test('上班时段支持跨夜', () => {
  assert.equal(withinWorkHours(new Date('2026-10-21T23:30:00'), '22:00', '02:00'), true)
  assert.equal(withinWorkHours(new Date('2026-10-21T12:00:00'), '22:00', '02:00'), false)
})

test('冷处理的会话不会进入回复', () => {
  const action = decideTurn({
    screen: {
      boxSelect: false,
      appType: 'wechat',
      identity: { title: '张三', kind: 'single', confidence: 'high' },
      bubbles: [{ side: 'in', text: '在吗' }],
      mentionedMe: null
    },
    stored: [],
    coldKeys: ['single:张三'],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now: new Date('2026-10-21T12:00:00'),
    recentOut: [],
    badCount: 0,
    knowledge: []
  })
  assert.equal(action.type, 'skip')
  if (action.type === 'skip') assert.equal(action.reason, '冷处理')
})

test('没确认身份时不写记忆也不回复', () => {
  const action = decideTurn({
    screen: {
      boxSelect: false,
      appType: 'wechat',
      identity: { title: '', kind: 'single', confidence: 'low' },
      bubbles: [{ side: 'in', text: '在吗' }],
      mentionedMe: null
    },
    stored: [{ side: 'in', text: '旧消息' }],
    coldKeys: [],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now: new Date('2026-10-21T12:00:00'),
    recentOut: [],
    badCount: 0,
    knowledge: []
  })
  assert.equal(action.type, 'skip')
  if (action.type === 'skip') assert.equal(action.added.length, 0)
})

test('记录对不齐时，退款仍然转人工，并且不写入看走眼的气泡', () => {
  const action = decideTurn({
    screen: {
      boxSelect: false,
      appType: 'wechat',
      identity: { title: '李四', kind: 'single', confidence: 'high' },
      bubbles: [
        { side: 'out', text: '刚还在翻新花絮' },
        { side: 'in', text: '退款' }
      ],
      mentionedMe: null
    },
    stored: [
      { side: 'out', text: '哈哈我在呢' },
      { side: 'out', text: '刚还在翻谭卓的新花絮来着，这才反应过来回你' }
    ],
    coldKeys: [],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now: new Date('2026-10-21T12:00:00'),
    recentOut: [],
    badCount: 0,
    knowledge: []
  })
  assert.equal(action.type, 'handoff')
  if (action.type === 'handoff') {
    assert.equal(action.reason, '提到「退款」')
    assert.equal(action.added.length, 0)
  }
})

test('问价格但资料没有时转人工', () => {
  const action = decideTurn({
    screen: {
      boxSelect: false,
      appType: 'wechat',
      identity: { title: '李四', kind: 'single', confidence: 'high' },
      bubbles: [{ side: 'in', text: '这个多少钱' }],
      mentionedMe: null
    },
    stored: [],
    coldKeys: [],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now: new Date('2026-10-21T12:00:00'),
    recentOut: [],
    badCount: 0,
    knowledge: []
  })
  assert.equal(action.type, 'handoff')
  if (action.type === 'handoff') assert.equal(action.reason, '资料里没有')
})

test('资料命中后才允许回复，并带上更早的历史', () => {
  const knowledge: KnowledgeChunk[] = [
    { id: '1', fileName: '价目.md', title: '价格', text: '玫瑰一束 20 元，不含运费。' }
  ]
  const action = decideTurn({
    screen: {
      boxSelect: false,
      appType: 'wechat',
      identity: { title: '李四', kind: 'single', confidence: 'high' },
      bubbles: [
        { side: 'out', text: '在的' },
        { side: 'in', text: '玫瑰多少钱' }
      ],
      mentionedMe: null
    },
    stored: [
      { side: 'in', text: '你好' },
      { side: 'out', text: '在的' }
    ],
    coldKeys: [],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now: new Date('2026-10-21T12:00:00'),
    recentOut: [],
    badCount: 0,
    knowledge
  })
  assert.equal(action.type, 'reply')
  if (action.type === 'reply') {
    assert.match(action.knowledgeText, /20 元/)
    assert.match(action.historyText, /你好/)
  }
})

test('没通过名称核对时不会进入自动发送', () => {
  const autoAgent = { ...agent, mode: 'auto' as const }
  assert.equal(effectiveMode(autoAgent, true, false), 'assist')
  assert.equal(effectiveMode(autoAgent, false, true), 'assist')
  assert.equal(effectiveMode(autoAgent, true, true), 'auto')
})

test('没有新的对方消息时不发素材', () => {
  const action = decideTurn({
    screen: {
      boxSelect: false,
      appType: 'wechat',
      identity: { title: '李四', kind: 'single', confidence: 'high' },
      bubbles: [{ side: 'in', text: '地址发我' }],
      mentionedMe: null
    },
    stored: [{ side: 'in', text: '地址发我' }],
    coldKeys: [],
    handedOff: false,
    agent: { ...agent, materialRules: [{ keyword: '地址', text: '中山路 18 号', imagePath: '' }] },
    sentThisHour: 0,
    now: new Date('2026-10-21T12:00:00'),
    recentOut: [],
    badCount: 0,
    knowledge: []
  })
  assert.equal(action.type, 'skip')
  if (action.type === 'skip') assert.equal(action.reason, '没有新的对方消息')
})

test('新来的素材消息仍给出固定回复', () => {
  const action = decideTurn({
    screen: {
      boxSelect: false,
      appType: 'wechat',
      identity: { title: '李四', kind: 'single', confidence: 'high' },
      bubbles: [{ side: 'in', text: '地址发我' }],
      mentionedMe: null
    },
    stored: [],
    coldKeys: [],
    handedOff: false,
    agent: { ...agent, materialRules: [{ keyword: '地址', text: '中山路 18 号', imagePath: '' }] },
    sentThisHour: 0,
    now: new Date('2026-10-21T12:00:00'),
    recentOut: [],
    badCount: 0,
    knowledge: []
  })
  assert.equal(action.type, 'fixed')
  if (action.type === 'fixed') assert.equal(action.text, '中山路 18 号')
})

test('整句只是应一声时不调用回复', () => {
  const action = decideTurn({
    screen: {
      boxSelect: false,
      appType: 'wechat',
      identity: { title: '李四', kind: 'single', confidence: 'high' },
      bubbles: [{ side: 'in', text: '好的' }],
      mentionedMe: null
    },
    stored: [],
    coldKeys: [],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now: new Date('2026-10-21T12:00:00'),
    recentOut: [],
    badCount: 0,
    knowledge: []
  })
  assert.equal(action.type, 'skip')
  if (action.type === 'skip') assert.equal(action.reason, '对方只是应了一声')
})

test('黑名单里的人说退款也不发通知', () => {
  const action = decideTurn({
    screen: {
      boxSelect: false,
      appType: 'wechat',
      identity: { title: '广告号', kind: 'single', confidence: 'high' },
      bubbles: [{ side: 'in', text: '退款' }],
      mentionedMe: null
    },
    stored: [],
    coldKeys: [],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now: new Date('2026-10-21T12:00:00'),
    recentOut: [],
    badCount: 0,
    knowledge: []
  })
  assert.equal(action.type, 'skip')
  if (action.type === 'skip') assert.equal(action.reason, '黑名单')
})

test('前面一句提到退款，不因为最后一句是别的就放过', () => {
  const action = decideTurn({
    screen: {
      boxSelect: false,
      appType: 'wechat',
      identity: { title: '李四', kind: 'single', confidence: 'high' },
      bubbles: [
        { side: 'in', text: '我要' },
        { side: 'in', text: '退款' },
        { side: 'in', text: '好的' }
      ],
      mentionedMe: null
    },
    stored: [],
    coldKeys: [],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now: new Date('2026-10-21T12:00:00'),
    recentOut: [],
    badCount: 0,
    knowledge: []
  })
  assert.equal(action.type, 'handoff')
  if (action.type === 'handoff') assert.equal(action.reason, '提到「退款」')
})

test('这句退款已经处理过，恢复后同一屏不再通知', () => {
  const screen = {
    boxSelect: false,
    appType: 'wechat',
    identity: { title: '李四', kind: 'single' as const, confidence: 'high' as const },
    bubbles: [
      { side: 'out' as const, text: '刚还在翻新花絮' },
      { side: 'in' as const, text: '退款' }
    ],
    mentionedMe: null
  }
  const stored = [
    { side: 'out' as const, text: '哈哈我在呢' },
    { side: 'out' as const, text: '刚还在翻谭卓的新花絮来着，这才反应过来回你' }
  ]
  const again = decideTurn({
    screen,
    stored,
    coldKeys: [],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now: new Date('2026-10-21T12:00:00'),
    recentOut: [],
    badCount: 0,
    knowledge: [],
    handledInbound: ['退款']
  })
  assert.equal(again.type, 'review')

  const newer = decideTurn({
    screen: {
      ...screen,
      bubbles: [...screen.bubbles, { side: 'in', text: '我还是要退款' }]
    },
    stored,
    coldKeys: [],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now: new Date('2026-10-21T12:00:00'),
    recentOut: [],
    badCount: 0,
    knowledge: [],
    handledInbound: ['退款']
  })
  assert.equal(newer.type, 'handoff')
  if (newer.type === 'handoff') assert.equal(newer.added.length, 0)
})

test('已经写进记忆的退款，恢复后不再当成新消息', () => {
  const action = decideTurn({
    screen: {
      boxSelect: false,
      appType: 'wechat',
      identity: { title: '李四', kind: 'single', confidence: 'high' },
      bubbles: [{ side: 'in', text: '退款' }],
      mentionedMe: null
    },
    stored: [{ side: 'in', text: '退款' }],
    coldKeys: [],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now: new Date('2026-10-21T12:00:00'),
    recentOut: [],
    badCount: 0,
    knowledge: []
  })
  assert.equal(action.type, 'skip')
  if (action.type === 'skip') assert.equal(action.reason, '没有新的对方消息')
})

test('新来的地址不在最后一句也发素材', () => {
  const action = decideTurn({
    screen: {
      boxSelect: false,
      appType: 'wechat',
      identity: { title: '李四', kind: 'single', confidence: 'high' },
      bubbles: [
        { side: 'in', text: '地址发我' },
        { side: 'in', text: '好的' }
      ],
      mentionedMe: null
    },
    stored: [],
    coldKeys: [],
    handedOff: false,
    agent: { ...agent, materialRules: [{ keyword: '地址', text: '中山路 18 号', imagePath: '' }] },
    sentThisHour: 0,
    now: new Date('2026-10-21T12:00:00'),
    recentOut: [],
    badCount: 0,
    knowledge: []
  })
  assert.equal(action.type, 'fixed')
  if (action.type === 'fixed') assert.equal(action.text, '中山路 18 号')
})

test('应一声里夹着价格仍然查资料', () => {
  const action = decideTurn({
    screen: {
      boxSelect: false,
      appType: 'wechat',
      identity: { title: '李四', kind: 'single', confidence: 'high' },
      bubbles: [{ side: 'in', text: '好的，多少钱' }],
      mentionedMe: null
    },
    stored: [],
    coldKeys: [],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now: new Date('2026-10-21T12:00:00'),
    recentOut: [],
    badCount: 0,
    knowledge: []
  })
  assert.equal(action.type, 'handoff')
  if (action.type === 'handoff') assert.equal(action.reason, '资料里没有')
})
