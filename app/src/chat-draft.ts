import type { ProjectRecord, ProjectsClient } from './projects-client.ts'

export interface ChatContextItem {
  kind: 'file' | 'folder'
  path: string
}

/** A draft has no session identity until its first send. Failed sends reuse it. */
export function createChatDraft(
  client: Pick<ProjectsClient, 'createSession'>,
  project?: ProjectRecord,
  createId: () => string = () => `chat-${crypto.randomUUID()}`,
) {
  let sessionId = ''
  let pending: Promise<string> | undefined
  return {
    project,
    prepare(signal?: AbortSignal): Promise<string> {
      if (sessionId) return Promise.resolve(sessionId)
      pending ??= (async () => {
        sessionId = project
          ? (await client.createSession(project.id, signal)).sessionId
          : `web:${createId()}`
        return sessionId
      })().finally(() => { pending = undefined })
      return pending
    },
  }
}

export function addChatContext(existing: readonly ChatContextItem[], kind: ChatContextItem['kind'], paths: readonly string[]): ChatContextItem[] {
  const result = [...existing]
  for (const path of paths) {
    if (!result.some(item => item.kind === kind && item.path === path)) result.push({ kind, path })
  }
  return result
}

export function chatContextName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path
}

export function composeChatMessage(text: string, context: readonly ChatContextItem[]): string {
  if (!context.length) return text
  const references = context.map(item => `${item.kind === 'file' ? 'File' : 'Folder'}: ${JSON.stringify(item.path)}`).join('\n')
  return [text, `Local context references (not uploaded; use filesystem tools where available):\n${references}`].filter(Boolean).join('\n\n')
}
