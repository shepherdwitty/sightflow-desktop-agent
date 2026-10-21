import { AIClient } from '../ai-client'
import { captureLayoutArea } from '../rpa/screenshot-utils'
import { AppType } from '../rpa/types'
import { getLayoutCache } from '../rpa/vision-utils'
import type { ObservedScreen } from './decide-turn'
import { BUBBLE_PROMPT, IDENTITY_PROMPT, parseBubbles, parseIdentity } from './vision-parse'

export async function readScreen(ai: AIClient, appType: AppType): Promise<ObservedScreen> {
  const boxSelect = !getLayoutCache(appType)?.headerArea
  const chatShot = await captureLayoutArea(appType, 'chatMainArea')
  const parsed = chatShot ? parseBubbles(await ai.detectVision(BUBBLE_PROMPT, chatShot)) : { bubbles: [], mentionedMe: null }

  if (boxSelect) {
    return {
      boxSelect: true,
      appType,
      identity: null,
      bubbles: parsed.bubbles,
      mentionedMe: parsed.mentionedMe
    }
  }

  const headerShot = await captureLayoutArea(appType, 'headerArea')
  const identity = headerShot ? parseIdentity(await ai.detectVision(IDENTITY_PROMPT, headerShot)) : null
  return {
    boxSelect: false,
    appType,
    identity,
    bubbles: parsed.bubbles,
    mentionedMe: parsed.mentionedMe
  }
}
