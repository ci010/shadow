import { z } from 'zod'
import { SafeCallCodeSchema } from '../script-runtime/protocol.ts'
import { CapabilityError } from './capabilities.ts'

const httpResult = z.object({ status: z.number().int().min(200).max(599), body: z.unknown() }).strict()
const inboxResult = z.object({
  status: z.literal('admitted'), sessionId: z.string().min(1), inputId: z.string().uuid(),
}).strict()
const failure = z.object({
  throws: z.object({ code: SafeCallCodeSchema, status: z.number().int().min(100).max(599).optional() }).strict(),
}).strict()
const sequence = z.object({ sequence: z.array(z.unknown()).min(1).max(32) }).strict()

function has(value: unknown, key: string): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, key)
}

export function validateMockResult(kind: 'http' | 'inbox', result: unknown): void {
  const values = has(result, 'sequence') ? sequence.parse(result).sequence : [result]
  for (const value of values) {
    if (has(value, 'throws')) failure.parse(value)
    else if (kind === 'http') {
      if (!Object.hasOwn(httpResult.parse(value), 'body')) throw new Error('HTTP mock requires a body.')
    } else inboxResult.parse(value)
  }
}

/** Receipts match broker behavior: non-2xx HTTP results throw, not return a body. */
export function createMockResponder(results: Record<string, unknown>): (name: string) => unknown {
  const mocks = structuredClone(results)
  const cursors = new Map<string, number>()
  return name => {
    if (!Object.hasOwn(mocks, name)) throw new CapabilityError('mock_missing', `No synthetic result supplied for ${name}.`)
    let value = mocks[name]
    if (has(value, 'sequence')) {
      const values = sequence.parse(value).sequence
      const index = cursors.get(name) ?? 0
      if (index >= values.length) throw new CapabilityError('mock_missing', `Synthetic sequence exhausted for ${name}.`)
      cursors.set(name, index + 1)
      value = values[index]
    }
    if (has(value, 'throws')) {
      const error = failure.parse(value).throws
      throw new CapabilityError(error.code, 'Synthetic capability failure.', error.status)
    }
    if (has(value, 'status') && typeof value.status === 'number' && value.status >= 300) {
      throw new CapabilityError('http_status', 'Synthetic HTTP failure.', value.status)
    }
    return structuredClone(value)
  }
}
