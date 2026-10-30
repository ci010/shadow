import { normalizeStoredWorkdirIdentity } from '../execution/workdir-storage.ts'
import { z } from 'zod'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

const input = z.object({ edit_id: z.string().min(1).max(256) }).strict()

export class ViewEditTool implements Tool {
  readonly name = 'view_edit'
  readonly readonly = true
  // This reads Main's session log, not the remote workdir's filesystem.
  readonly supportsRemoteWorkdir = true
  readonly description = 'View the recorded patch for a write receipt edit ID in this session. Returns plain unified hunks, not the current file. No changes and unavailable diffs are reported explicitly.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: { edit_id: { type: 'string', description: 'The edit ID returned by write.' } },
    required: ['edit_id'],
    additionalProperties: false,
  }

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    const { edit_id } = input.parse(args)
    context.signal.throwIfAborted()
    if (!context.readFileChange) throw new Error('Historical edit lookup is unavailable in this execution context.')
    const change = await context.readFileChange(edit_id, context.signal)
    context.signal.throwIfAborted()
    if (!change) throw new Error('Edit not found in this session.')
    if (change.sessionId !== context.sessionId || change.id !== edit_id) throw new Error('Historical edit identity mismatch.')
    if (change.unavailable) throw new Error(`Recorded diff unavailable: ${change.unavailable}`)
    const stored = change.target && normalizeStoredWorkdirIdentity(change.target)
    if (change.target && !stored) throw new Error('Invalid historical directory identity.')
    const location = stored ? `Recorded on node ${JSON.stringify(stored.nodeId)}, workdir ${JSON.stringify(stored.workdirId)}, path ${JSON.stringify(change.path)}.\n` : ''
    return location + (change.patch || 'No content changes.')
  }
}
