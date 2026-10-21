import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isCommercialBuild, scrubCommercialLog } from './commercial.ts'

test('源码路径认环境变量，商业日志会抹掉模型名', () => {
  const previousCommercial = process.env.SIGHTFLOW_COMMERCIAL
  const previousRenderer = process.env.RENDERER_VITE_COMMERCIAL
  try {
    delete process.env.SIGHTFLOW_COMMERCIAL
    delete process.env.RENDERER_VITE_COMMERCIAL
    assert.equal(isCommercialBuild(), false)
    assert.equal(scrubCommercialLog('模型 doubao-seed-2-0-lite'), '模型 doubao-seed-2-0-lite')

    process.env.SIGHTFLOW_COMMERCIAL = '1'
    assert.equal(isCommercialBuild(), true)
    assert.equal(scrubCommercialLog('回复服务异常：doubao-seed-2-0-lite'), '回复服务异常：服务')
    assert.equal(scrubCommercialLog('额度用尽'), '额度用尽')
  } finally {
    if (previousCommercial === undefined) delete process.env.SIGHTFLOW_COMMERCIAL
    else process.env.SIGHTFLOW_COMMERCIAL = previousCommercial
    if (previousRenderer === undefined) delete process.env.RENDERER_VITE_COMMERCIAL
    else process.env.RENDERER_VITE_COMMERCIAL = previousRenderer
  }
})
