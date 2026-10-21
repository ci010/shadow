import type { SessionManager } from '../sessions/session-manager.ts'
import type { TopicService } from '../sessions/topics.ts'
import type { VirtualFsHandler, VirtualFsWriteHandler } from './virtual-fs.ts'

/** Current identity only: never accept a caller-supplied session/project target. */
export function createSelfSessionHandler(
  sessions: Pick<SessionManager, 'updateSelfMetadata' | 'getSelfWorkingPaths'>,
  topics: () => Pick<TopicService, 'assertActor'>,
): { read: VirtualFsHandler; write: VirtualFsWriteHandler } {
  const read: VirtualFsHandler = (subpath, context) => {
    if (subpath !== 'self.json') throw new Error('Use v:session/self.json; arbitrary session metadata paths are not supported.')
    context.signal.throwIfAborted()
    const state = topics().assertActor(context.projectId, context.sessionId)
    return JSON.stringify({
      ...sessions.getSelfWorkingPaths(context.sessionId),
      title: state.name ?? state.topic?.title ?? state.generatedTitle ?? state.chatName ?? '',
      description: state.description ?? '',
      completed: state.completed ?? false,
    }, null, 2)
  }
  const write: VirtualFsWriteHandler = async (subpath, request, context) => {
    let content = await read(subpath, context)
    const expected = request.match !== undefined ? content : undefined
    if (request.match !== undefined) {
      if (!request.match || !content.includes(request.match)) throw new Error('Exact match not found. Reread v:session/self.json before editing.')
      if (!request.replaceAll && content.indexOf(request.match) !== content.lastIndexOf(request.match)) throw new Error('Multiple matches found. Use a unique match or flag g.')
      content = request.replaceAll ? content.split(request.match).join(request.content) : content.replace(request.match, () => request.content)
    } else content = request.content
    let value: unknown
    try { value = JSON.parse(content) } catch { throw new Error('Invalid JSON. Write an object with title (string), description (string), and/or completed (boolean).') }
    context.signal.throwIfAborted()
    await sessions.updateSelfMetadata(context.sessionId, value, expected)
    return read(subpath, context)
  }
  return { read, write }
}
