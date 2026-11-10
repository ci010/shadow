import { selfSessionMetadata } from '../sessions/session-metadata.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { TopicService } from '../sessions/topics.ts'
import type { VirtualFsHandler, VirtualFsWriteHandler, VirtualFsListHandler, VirtualDirectoryHandler } from './virtual-fs.ts'

/** One namespace for history and current metadata; only self.json is writable. */
export function withSelfSession(
  history: { read: VirtualFsHandler; list: VirtualFsListHandler; directory: VirtualDirectoryHandler },
  self: { read: VirtualFsHandler; write: VirtualFsWriteHandler },
) {
  const read: VirtualFsHandler = (path, context, options) => path === 'self.json'
    ? self.read(path, context, options) : history.read(path, context, options)
  const list: VirtualFsListHandler = async (context, options) => {
    const path = options?.subpath
    if (path === 'self.json') return [{ name: 'self.json', content: options?.content === false ? '' : await self.read('self.json', context) }]
    const entries = await history.list(context, options)
    if (!path) entries.unshift({ name: 'self.json', content: options?.content === false ? '' : await self.read('self.json', context) })
    return entries
  }
  return { read, list, directory: history.directory, write: self.write }
}

/** Current identity only: never accept a caller-supplied session/project target. */
export function createSelfSessionHandler(
  sessions: Pick<SessionManager, 'updateSelfMetadata'>,
  topics: () => Pick<TopicService, 'assertActor'>,
): { read: VirtualFsHandler; write: VirtualFsWriteHandler } {
  const read: VirtualFsHandler = (subpath, context) => {
    if (subpath !== 'self.json') throw new Error('Use v:sessions/self.json; arbitrary session metadata paths are not supported.')
    context.signal.throwIfAborted()
    const state = topics().assertActor(context.projectId, context.sessionId)
    return JSON.stringify(selfSessionMetadata(state), null, 2)
  }
  const write: VirtualFsWriteHandler = async (subpath, request, context) => {
    let content = await read(subpath, context)
    const expected = request.match !== undefined ? content : undefined
    if (request.match !== undefined) {
      if (!request.match || !content.includes(request.match)) throw new Error('Exact match not found. Reread v:sessions/self.json before editing.')
      if (!request.replaceAll && content.indexOf(request.match) !== content.lastIndexOf(request.match)) throw new Error('Multiple matches found. Use a unique match or flag g.')
      content = request.replaceAll ? content.split(request.match).join(request.content) : content.replace(request.match, () => request.content)
    } else content = request.content
    let value: unknown
    try { value = JSON.parse(content) } catch { throw new Error('Invalid JSON. Write an object with topic (string), focus (string), and/or completed (boolean).') }
    context.signal.throwIfAborted()
    await sessions.updateSelfMetadata(context.sessionId, value, expected)
    return read(subpath, context)
  }
  return { read, write }
}
