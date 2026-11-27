import { normalizeStoredWorkdirIdentity } from '../execution/workdir-storage.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { SELF_EDIT_PATCH_ROUTE } from '../sessions/file-change-path.ts'

/** Read only the caller's recorded patch, never a path on the execution device. */
export async function readSessionEditPatch(route: string, context: ExecutionContext): Promise<string> {
  const encoded = route.startsWith(SELF_EDIT_PATCH_ROUTE) ? route.slice(SELF_EDIT_PATCH_ROUTE.length) : ''
  if (!encoded || /[/\\?#]/.test(encoded)) throw new Error('Invalid session edit patch path.')
  let editId: string
  try { editId = decodeURIComponent(encoded) }
  catch { throw new Error('Invalid session edit ID.') }
  if (!editId || editId.length > 256 || /[\x00-\x1f\x7f/\\]/.test(editId) || editId === '.' || editId === '..') {
    throw new Error('Invalid session edit ID.')
  }
  context.signal.throwIfAborted()
  if (!context.readFileChange) throw new Error('Historical edit lookup is unavailable in this execution context.')
  const change = await context.readFileChange(editId, context.signal)
  context.signal.throwIfAborted()
  if (!change) throw new Error('Edit not found in this session.')
  if (change.sessionId !== context.sessionId || change.id !== editId) throw new Error('Historical edit identity mismatch.')
  if (change.unavailable) throw new Error(`Recorded diff unavailable: ${change.unavailable}`)
  const stored = change.target && normalizeStoredWorkdirIdentity(change.target)
  if (change.target && !stored) throw new Error('Invalid historical directory identity.')
  const location = stored ? `Recorded on node ${JSON.stringify(stored.nodeId)}, workdir ${JSON.stringify(stored.workdirId)}, path ${JSON.stringify(change.path)}.\n` : ''
  return location + (change.patch || 'No content changes.')
}
