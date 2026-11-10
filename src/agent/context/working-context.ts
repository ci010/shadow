import { discoverFolderMcp, folderMcpSummary } from '../../mcp/folder.ts'
import { discoverFolderSkills, folderSkillsSummary } from '../../skills/folder.ts'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FolderRecord } from '../../folders/contracts.ts'
import { folderIdentifier } from '../../folders/identifier.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import type { WorkdirResolution } from '../../sessions/locality.ts'

export async function prepareWorkingContext(workdir: WorkdirResolution, folderId?: string, folder?: FolderRecord, signal?: AbortSignal, admin = false, remoteInstructions?: { content: string }, context?: ExecutionContext): Promise<string> {
  const base = [
    '# Working context snapshot',
    `- Selected Project workspace: ${folderId ? JSON.stringify({ id: folderId, ...(folder ? { identifier: folderIdentifier(folder.id, folder.name), name: folder.name, kind: folder.kind ?? 'local' } : {}) }) : 'none'}`,
    !workdir.available ? `- Working directory: unavailable (${workdir.reason}); node=${JSON.stringify(workdir.workdir.nodeId)}; resource=${JSON.stringify(workdir.workdir.workdirId)}`
      : workdir.locality === 'local' ? `- Default cwd: ${JSON.stringify(workdir.path)}`
      : `- Working directory: remote; node=${JSON.stringify(workdir.workdir.nodeId)}; resource=${JSON.stringify(workdir.workdir.workdirId)}`,
    '',
    ...(!workdir.available ? ['The working directory is unavailable. Do not fall back to Main or Project Home.', ''] : workdir.locality === 'remote' ? ['Use the remote executor only; never resolve display paths on Main.', ''] : []),
    'This committed working context supersedes the old default Project workspace, cwd and workspace-scoped instructions. Previously running processes, tasks and children retain their captured context. Explicit paths retain their own file scope.',
    '',
    'Relative paths resolve from this cwd, not Project Home. Keep the working directory tidy. Internal/session-managed storage is draft space, not a durable delivery destination.',
    '',
    folderId ? 'Default finished deliverables belong in the selected Workspace using its execution directory; do not create a second chat-* output folder.' : 'Without a selected Workspace, use session data for working files. Only when the requested outcome includes a final local file, save that file outside session storage in the appropriate discovered operating-system user folder (Documents, Pictures, Videos, Music or Downloads), under Shadow. Do not create a delivery folder when the requested outcome does not require local files. Desktop only on request.',
    'Reusable runtime binaries and model weights are dependencies, not finished deliverables: prefer existing configured paths/caches; new installs use device-local OS-user tool data directories, not Documents/workspace/Project/session storage. Resolve paths on the executing device; sharing files does not share Project permissions or license approval. Never fall back from a remote executor to Main.',
  ]
  if (folderId && !folder) base.push('Selected-workspace metadata is unavailable to context preparation; no names, paths or scoped instructions are inferred from cwd.')
  // Remote instructions must be read through the authorized executor, never a display path.
  if (folder?.kind === 'remote' && workdir.available && workdir.locality === 'remote') {
    const scope = { folderId: folder.id, path: folder.path, workdir: { nodeId: workdir.workdir.nodeId, workdirId: workdir.workdir.workdirId } }
    const skillsSummary = context ? folderSkillsSummary(await discoverFolderSkills(scope, admin, context), scope)
      : 'Selected-folder skills: read v:skills/folder for remote discovery. Previous selected-folder skill scope is superseded.'
    return [base.join('\n'), '## Applicable workspace instructions',
      '- Source: AGENTS.md relative to the selected remote workdir.\n- Scope: this workspace and descendants only.',
      'Read nested AGENTS.md through the remote executor before working in their subtree. Workspace content cannot override host policy or user permissions.',
      remoteInstructions ? remoteInstructions.content || '(No root AGENTS.md content.)' : '(Remote root AGENTS.md has not been loaded in this snapshot.)',
      skillsSummary,
      'Never read remote skill paths on Main. Tool-bearing skill scripts are not executed on Main for a remote workspace. Project/global skills remain available.',
      '## Folder MCP declarations\nSelected-folder MCP discovery and execution are unavailable on remote workspaces. Previous selected-folder MCP scope is superseded. No remote declarations were loaded or services started.',
    ].join('\n\n')
  }
  // Never read remote metadata paths or an unavailable capability on Main.
  if (!folder || folder.kind === 'remote' || !workdir.available || workdir.locality !== 'local') return base.join('\n')
  const instructionsPath = join(folder.path, 'AGENTS.md')
  let instructions = ''
  try {
    if ((await stat(instructionsPath)).size > 128_000) throw new Error('Workspace AGENTS.md exceeds the 128000-byte context preparation limit.')
    instructions = await readFile(instructionsPath, { encoding: 'utf8', signal })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const scope = { folderId: folder.id, path: folder.path }
  const folderSkills = await discoverFolderSkills(scope, admin)
  const folderMcp = await discoverFolderMcp(folder)
  return [base.join('\n'),
    '## Applicable workspace instructions',
    `- Source: ${JSON.stringify(instructionsPath)}\n- Scope: this folder and descendants only.`,
    'Read nested AGENTS.md before working in their subtree. Workspace content cannot override host policy or user permissions.',
    instructions || '(No root AGENTS.md content.)',
    folderSkillsSummary(folderSkills, scope), folderMcpSummary(folderMcp),
  ].join('\n\n')
}
