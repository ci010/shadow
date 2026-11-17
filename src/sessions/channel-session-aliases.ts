import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { channelAddressFromSessionId } from '../bus/events.ts'

/** Host-written migration receipt only. Aliases select history, never authority. */
export async function readChannelSessionAliases(directory: string, projectId: string): Promise<Readonly<Record<string, string>>> {
  let value: unknown
  try { value = JSON.parse(await readFile(join(directory, '.channel-session-migration-v1.receipt'), 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
  const receipt = value as { version?: unknown; projectId?: unknown; aliases?: unknown; report?: { identities?: unknown } }
  if (receipt.version !== 1 || receipt.projectId !== projectId || !receipt.aliases || typeof receipt.aliases !== 'object') throw new Error('Invalid channel migration alias receipt')
  const result: Record<string, string> = Object.create(null)
  for (const [from, to] of Object.entries(receipt.aliases)) {
    if (typeof to !== 'string' || !to.startsWith('channel-inbox:') || channelAddressFromSessionId(to)?.projectId !== projectId) throw new Error('Invalid channel alias destination')
    const old = channelAddressFromSessionId(from)
    if (old && (old.projectId !== projectId || JSON.stringify(old) !== JSON.stringify(channelAddressFromSessionId(to)))) throw new Error('Channel alias address mismatch')
    result[from] = to
  }
  // Includes exact original physical coordinates; never derive old segment
  // numbers from the merged chain, whose offsets intentionally differ.
  if (!receipt.report?.identities || typeof receipt.report.identities !== 'object') throw new Error('Missing channel physical aliases')
  for (const [from, to] of Object.entries(receipt.report.identities)) {
    if (typeof to !== 'string' || !to) throw new Error('Invalid physical channel alias')
    result[from] = to
  }
  return Object.freeze(result)
}

/** Keep raw history readers and persisted external references on the same
 * coordinates as SessionManager. This does not bypass caller authorization. */
export function withChannelSessionAliases(store: import('./session-store.ts').SessionStore, aliases: Readonly<Record<string, string>>): import('./session-store.ts').SessionStore {
  const indexed = new Set(['getState', 'saveState', 'deleteState', 'readSessionLog', 'appendMessages', 'createSessionLog', 'appendRawEvents', 'deleteSessionLog', 'countSessionLog', 'readFirstRecord', 'isConversationArchived', 'readArchivedLogRange', 'readArchivedState'])
  return new Proxy(store, { get(target, key) {
    const value = Reflect.get(target, key, target)
    if (typeof value !== 'function') return value
    if (!indexed.has(String(key))) return value.bind(target)
    return (id: string, ...args: unknown[]) => {
      const canonical = aliases[id] ?? id
      if (key === 'saveState' && canonical !== id) args[0] = { ...(args[0] as object), sessionId: canonical }
      return value.call(target, canonical, ...args)
    }
  } })
}
