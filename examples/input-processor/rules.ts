import type { ProcessorDecision } from '@shadow/input-processor'

/** Text-only demonstration, not an image/campaign detector. */
export function classifyText(text: string): ProcessorDecision {
  if (text === 'ok') return { action: 'ignore' }
  if (text.includes('crypto')) return { action: 'emit' }
  return { action: 'buffer' }
}
