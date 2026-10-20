import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import {
  captureUsage,
  discardPendingUsage,
  priceFor,
  readUsage,
  recordUsage,
  setUsageDir,
  summarizeUsage,
  takePendingUsage
} from './usage-ledger.ts'

let dir = ''

beforeEach(() => {
  discardPendingUsage()
  dir = mkdtempSync(join(tmpdir(), 'usage-ledger-'))
  setUsageDir(dir)
})

afterEach(() => {
  discardPendingUsage()
  rmSync(dir, { recursive: true, force: true })
})

function usage(input: number, cached = 0, output = 0): void {
  recordUsage({
    purpose: 'test',
    source: 'test',
    model: 'doubao-seed-2-0-lite-260428',
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      prompt_tokens_details: { cached_tokens: cached }
    },
    attributable: false
  })
}

test('档位边界与缓存折扣跟文档算例一致', () => {
  assert.equal(priceFor(0, 'doubao-seed-2-0-lite-260428')?.label, '0-32k')
  assert.equal(priceFor(32_000, 'doubao-seed-2-0-lite-260428')?.label, '0-32k')
  assert.equal(priceFor(32_001, 'doubao-seed-2-0-lite-260428')?.label, '32k-128k')
  assert.equal(priceFor(128_000, 'doubao-seed-2-0-lite-260428')?.label, '32k-128k')
  assert.equal(priceFor(128_001, 'doubao-seed-2-0-lite-260428')?.label, '128k-256k')
  assert.equal(priceFor(256_001, 'doubao-seed-2-0-lite-260428')?.label, '128k-256k')
  assert.equal(priceFor(100, 'other-model'), null)

  usage(10_000, 8_000, 0)
  const [row] = readUsage()
  assert.ok(row)
  assert.equal(row.cachedTokens, 8_000)
  assert.ok(Math.abs(row.inputCost - 0.00216) < 1e-12)
  assert.ok(Math.abs(row.cost - 0.00216) < 1e-12)
})

test('cached_tokens 超过输入量时钳制，非数字不会写成 NaN', () => {
  recordUsage({
    purpose: 'test',
    source: 'test',
    model: 'doubao-seed-2-0-lite-260428',
    usage: {
      prompt_tokens: 1000,
      completion_tokens: Number.NaN,
      prompt_tokens_details: { cached_tokens: 5000 }
    },
    attributable: false
  })
  const [row] = readUsage()
  assert.equal(row?.cachedTokens, 1000)
  assert.equal(row?.outputTokens, 0)
  assert.equal(Number.isFinite(row?.cost), true)
})

test('坏掉的 JSONL 行不会把汇总加成 NaN', () => {
  writeFileSync(
    join(dir, 'usage.jsonl'),
    '{}\n123\n{"cost":"x"}\n{"ts":"2026-10-20T00:00:00.000Z","purpose":"reply","inputTokens":10,"outputTokens":2,"cost":0.001}\n',
    'utf8'
  )
  const summary = summarizeUsage(10)
  assert.equal(summary.total.calls, 1)
  assert.equal(summary.total.cost, 0.001)
  assert.equal(Number.isFinite(summary.total.inputTokens), true)
})

test('vision 只在 captureUsage 里归属，reply 才进全局 pending', async () => {
  recordUsage({
    purpose: 'vision',
    source: 'test',
    model: 'doubao-seed-2-0-lite-260428',
    usage: { prompt_tokens: 10, completion_tokens: 1 }
  })
  assert.equal(takePendingUsage(), undefined)

  const captured = await captureUsage(async () => {
    recordUsage({
      purpose: 'vision',
      source: 'test',
      model: 'doubao-seed-2-0-lite-260428',
      usage: { prompt_tokens: 20, completion_tokens: 2 }
    })
    await Promise.resolve()
    recordUsage({
      purpose: 'vision',
      source: 'test',
      model: 'doubao-seed-2-0-lite-260428',
      usage: { prompt_tokens: 30, completion_tokens: 3 }
    })
    return 'ok'
  })
  assert.equal(captured.value, 'ok')
  assert.equal(captured.usage?.calls, 2)
  assert.equal(captured.usage?.inputTokens, 50)
  assert.equal(takePendingUsage(), undefined)

  recordUsage({
    purpose: 'reply',
    source: 'test',
    model: 'doubao-seed-2-0-lite-260428',
    usage: { prompt_tokens: 5, completion_tokens: 1 }
  })
  recordUsage({
    purpose: 'learn',
    source: 'test',
    model: 'doubao-seed-2-0-lite-260428',
    usage: { prompt_tokens: 5, completion_tokens: 1 }
  })
  const pending = takePendingUsage()
  assert.deepEqual(
    pending?.items.map((item) => item.purpose),
    ['reply']
  )
})

test('discardPendingUsage 丢掉还没领走的 reply', () => {
  recordUsage({
    purpose: 'reply',
    source: 'test',
    model: 'doubao-seed-2-0-lite-260428',
    usage: { prompt_tokens: 5, completion_tokens: 1 }
  })
  discardPendingUsage()
  assert.equal(takePendingUsage(), undefined)
})
