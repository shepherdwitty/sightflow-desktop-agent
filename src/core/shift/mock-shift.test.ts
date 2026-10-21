import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readKnowledgeFile } from '../knowledge/read-file.ts'
import { decideTurn, type ObservedScreen } from './decide-turn.ts'
import { buildTypeScript, previewTyped } from './pacing.ts'
import { buildShiftReport } from './report.ts'
import { ShiftStore } from './store.ts'

const PRICE_LIST = `# 价格

红玫瑰 11 枝 99 元，19 枝 168 元。
向日葵一扎 59 元。
满天星一小束 39 元。

# 地址

门店在中山路 18 号，近人民广场地铁站。

# 营业

每天 9:00 到 21:00 开门。

# 配送

市区满 99 元免运费，否则运费 12 元。

# 课程

花艺体验课 2 小时 199 元，含花材。不包含证书。
`

const now = new Date('2026-10-22T14:00:00')

function screen(partial: Partial<ObservedScreen> & Pick<ObservedScreen, 'bubbles'>): ObservedScreen {
  return {
    boxSelect: false,
    appType: 'wechat',
    identity: { title: '李四', kind: 'single', confidence: 'high' },
    mentionedMe: null,
    ...partial
  }
}

test('模拟门店资料能回答价目，答不上就转人工', async () => {
  const store = ShiftStore.memory()
  store.seedAgents('你是这家花店的客服。')
  const agent = store.activeAgent()
  const dir = await mkdtemp(path.join(tmpdir(), 'sightflow-mock-'))
  const filePath = path.join(dir, '价目.md')
  await writeFile(filePath, PRICE_LIST, 'utf8')
  await writeFile(path.join(dir, '说明.docx'), '这不是支持的格式', 'utf8')

  await assert.rejects(readKnowledgeFile(path.join(dir, '说明.docx')), /只支持 Markdown、TXT 和 PDF/)
  const pdfPath = path.join(dir, '补充.pdf')
  await writeFile(
    pdfPath,
    `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 55>>stream
BT /F1 12 Tf 20 100 Td (Rose bunch 99 yuan) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`,
    'utf8'
  )
  const pdf = await readKnowledgeFile(pdfPath)
  assert.match(pdf.chunks.map((chunk) => chunk.text).join('\n'), /99 yuan/)

  const loaded = await readKnowledgeFile(filePath)
  assert.ok(loaded.chunks.length >= 4)
  store.addKnowledgeFile(agent.id, loaded.fileName, loaded.chunks)
  const knowledge = store.knowledgeChunks(agent.id)
  assert.equal(store.knowledgeFileNames(agent.id).join(','), '价目.md')

  const stored = [
    { side: 'in' as const, text: '在吗' },
    { side: 'out' as const, text: '在的，看花可以直接问' }
  ]

  const price = decideTurn({
    screen: screen({
      bubbles: [...stored, { side: 'in', text: '红玫瑰 11 枝多少钱' }]
    }),
    stored,
    coldKeys: [],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now,
    recentOut: ['在的，看花可以直接问'],
    badCount: 0,
    knowledge
  })
  assert.equal(price.type, 'reply')
  if (price.type === 'reply') {
    assert.match(price.knowledgeText, /99 元/)
    assert.equal(price.historyText, '')
    assert.equal(price.added.length, 1)
    assert.equal(price.added[0].text, '红玫瑰 11 枝多少钱')
    const sentence = '红玫瑰 11 枝 99 元。'
    assert.equal(previewTyped(buildTypeScript(sentence, agent.pacing)).join(''), sentence)
  }

  const remembered = decideTurn({
    screen: screen({
      bubbles: [
        { side: 'out', text: '在的，看花可以直接问' },
        { side: 'in', text: '红玫瑰 11 枝多少钱' }
      ]
    }),
    stored: [
      { side: 'in', text: '在吗' },
      { side: 'out', text: '在的，看花可以直接问' }
    ],
    coldKeys: [],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now,
    recentOut: ['在的，看花可以直接问'],
    badCount: 0,
    knowledge
  })
  assert.equal(remembered.type, 'reply')
  if (remembered.type === 'reply') assert.match(remembered.historyText, /在吗/)

  const address = decideTurn({
    screen: screen({ bubbles: [{ side: 'in', text: '你们店在哪' }] }),
    stored: [],
    coldKeys: [],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now,
    recentOut: [],
    badCount: 0,
    knowledge
  })
  assert.equal(address.type, 'reply')
  if (address.type === 'reply') assert.match(address.knowledgeText, /中山路 18 号/)

  const hours = decideTurn({
    screen: screen({ bubbles: [{ side: 'in', text: '几点开门' }] }),
    stored: [],
    coldKeys: [],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now,
    recentOut: [],
    badCount: 0,
    knowledge
  })
  assert.equal(hours.type, 'reply')
  if (hours.type === 'reply') assert.match(hours.knowledgeText, /9:00/)

  const shipping = decideTurn({
    screen: screen({ bubbles: [{ side: 'in', text: '运费怎么算' }] }),
    stored: [],
    coldKeys: [],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now,
    recentOut: [],
    badCount: 0,
    knowledge
  })
  assert.equal(shipping.type, 'reply')
  if (shipping.type === 'reply') assert.match(shipping.knowledgeText, /12 元/)

  const course = decideTurn({
    screen: screen({ bubbles: [{ side: 'in', text: '花艺课多少钱' }] }),
    stored: [],
    coldKeys: [],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now,
    recentOut: [],
    badCount: 0,
    knowledge
  })
  assert.equal(course.type, 'reply')
  if (course.type === 'reply') assert.match(course.knowledgeText, /199 元/)

  const missing = decideTurn({
    screen: screen({ bubbles: [{ side: 'in', text: '百合多少钱' }] }),
    stored: [],
    coldKeys: [],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now,
    recentOut: [],
    badCount: 0,
    knowledge
  })
  assert.equal(missing.type, 'handoff')
  if (missing.type === 'handoff') assert.equal(missing.reason, '资料里没有')

  const chat = decideTurn({
    screen: screen({ bubbles: [{ side: 'in', text: '好的，那我明天过去' }] }),
    stored: [],
    coldKeys: [],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now,
    recentOut: [],
    badCount: 0,
    knowledge
  })
  assert.equal(chat.type, 'reply')
  if (chat.type === 'reply') assert.equal(chat.knowledgeText, '')
})

test('模拟真机那一轮：气泡对不齐时退款仍转人工，冷处理优先', () => {
  const store = ShiftStore.memory()
  store.seedAgents()
  const agent = store.activeAgent()
  const stored = [
    { side: 'out' as const, text: '哈哈我在呢！' },
    {
      side: 'out' as const,
      text: '刚还在翻谭卓的新花絮来着，这才反应过来回你~咋啦这会儿找我是有啥新鲜事要唠呀？'
    }
  ]
  const drifted = decideTurn({
    screen: screen({
      bubbles: [
        { side: 'out', text: '哈哈我在呢' },
        { side: 'out', text: '刚还在翻新花絮' },
        { side: 'in', text: '退款' },
        { side: 'in', text: '退款' }
      ]
    }),
    stored,
    coldKeys: [],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now,
    recentOut: [stored[1].text],
    badCount: 0,
    knowledge: []
  })
  assert.equal(drifted.type, 'handoff')
  if (drifted.type === 'handoff') {
    assert.equal(drifted.reason, '提到「退款」')
    assert.equal(drifted.added.length, 0)
    store.addEvent({
      key: drifted.key,
      title: drifted.title,
      at: now.getTime(),
      kind: 'handoff',
      reason: drifted.reason
    })
  }

  const again = decideTurn({
    screen: screen({ bubbles: [{ side: 'in', text: '那现在能退吗' }] }),
    stored,
    coldKeys: [],
    handedOff: true,
    agent,
    sentThisHour: 0,
    now,
    recentOut: [],
    badCount: 0,
    knowledge: []
  })
  assert.equal(again.type, 'skip')
  if (again.type === 'skip') assert.equal(again.reason, '已转人工')

  const cold = decideTurn({
    screen: screen({
      identity: { title: '花艺群 (23)', kind: 'group', confidence: 'high' },
      bubbles: [{ side: 'in', text: '红玫瑰多少钱' }],
      mentionedMe: true
    }),
    stored: [],
    coldKeys: ['group:花艺群'],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now,
    recentOut: [],
    badCount: 0,
    knowledge: []
  })
  assert.equal(cold.type, 'skip')
  if (cold.type === 'skip') {
    assert.equal(cold.reason, '冷处理')
    assert.equal(cold.key, 'group:花艺群')
  }

  const quiet = decideTurn({
    screen: screen({
      identity: { title: '花艺群 (24)', kind: 'group', confidence: 'high' },
      bubbles: [{ side: 'in', text: '红玫瑰多少钱' }],
      mentionedMe: false
    }),
    stored: [],
    coldKeys: [],
    handedOff: false,
    agent,
    sentThisHour: 0,
    now,
    recentOut: [],
    badCount: 0,
    knowledge: []
  })
  assert.equal(quiet.type, 'skip')
  if (quiet.type === 'skip') assert.equal(quiet.key, 'group:花艺群')

  const report = buildShiftReport(store.eventsBetween(now.getTime() - 1000, now.getTime() + 1000))
  assert.equal(report.length, 1)
  assert.equal(report[0].status, 'handoff')
  assert.match(report[0].reason, /退款/)
})
