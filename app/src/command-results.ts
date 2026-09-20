import { isCommandReceipt, type CommandReceipt } from '../../src/slash-commands/receipt.ts'

export interface CommandMessage {
  role: 'command'
  content: string
  timestamp: string
  commandReceipt: CommandReceipt
}

/** Merge after tool pairing, so a command cannot split a tool call from its result. */
export function mergeCommandResults<T extends { timestamp?: string; commandReceipt?: CommandReceipt }>(
  messages: T[], raw: unknown,
): Array<T | CommandMessage> {
  if (raw === undefined) return [...messages]
  if (!Array.isArray(raw) || !raw.every(isCommandReceipt)) throw new Error('Invalid command history. Refresh to retry.')
  const receipts = new Map<string, CommandReceipt>()
  for (const message of messages) if (message.commandReceipt) receipts.set(message.commandReceipt.id, message.commandReceipt)
  for (const receipt of raw) receipts.set(receipt.id, receipt)
  const pending = [...receipts.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
  const result: Array<T | CommandMessage> = []
  let index = 0
  const append = (receipt: CommandReceipt) => result.push({
    role: 'command', content: receipt.output, timestamp: receipt.timestamp, commandReceipt: receipt,
  })
  for (const message of messages) {
    if (message.commandReceipt) continue
    const time = message.timestamp ? Date.parse(message.timestamp) : NaN
    while (index < pending.length && Date.parse(pending[index].timestamp) <= time) append(pending[index++])
    result.push(message)
  }
  while (index < pending.length) append(pending[index++])
  return result
}
