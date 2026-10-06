import type { OutboundMessage } from '../bus/events.ts'
import type { MemoryAccess } from '../memory/contracts.ts'
import type { SessionInput } from './input.ts'

export interface RuntimeBoundary {
  readonly memoryAccess: MemoryAccess
  readonly signal: AbortSignal
  assertCurrent(): void
  begin(input: SessionInput, signal: AbortSignal): Promise<void>
  beforeInference(signal: AbortSignal): Promise<void>
  beforeOutput(signal: AbortSignal): Promise<void>
  stamp(message: OutboundMessage): OutboundMessage
  finish(): void
  rememberSummary(content: string): void
  close(): void
}
