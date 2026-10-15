import type { SystemPromptProvider } from './builder.ts'
import { join } from 'node:path'
import type { VirtualFs } from '../../vfs/virtual-fs.ts'
import {
  managedSessionWorkdirRef,
  resolveSessionLocations,
  type WorkdirCapabilityLookup,
} from '../../sessions/locality.ts'
import { readFileIfExists, workspacePath } from '../../utils/paths.ts'
import type { ProjectFolderDiscovery } from '../../folders/discovery.ts'
import { projectProvider } from './project.ts'

export function workspaceProvider(
  workspace: string,
  virtualFs: VirtualFs,
  workdirCapabilityLookup?: WorkdirCapabilityLookup,
  project?: ProjectFolderDiscovery,
): SystemPromptProvider {
  return {
    name: 'workspace-intro',
    async getPromptSection(ctx) {
      const coordinator = ctx.agent.name === 'orchestrator'
      const locations = resolveSessionLocations(
        workspace,
        {
          sessionId: ctx.sessionId,
          workspaceRoot: ctx.workspaceRoot,
          workdir: ctx.workdir,
        },
        undefined,
        workdirCapabilityLookup,
      )
      const lines = [
        '# Current environment',
        '',
        ...(project ? [await projectProvider(project).getPromptSection(ctx) ?? '', ''] : []),
      ]

      if (
        locations.workdir.available && locations.workdir.locality === 'local'
      ) {
        lines.push(
          `**Working directory**: \`${locations.workdir.path}\``,
          `**Directory source**: ${locations.workdir.workdir.capabilityId === managedSessionWorkdirRef(ctx.workspaceRoot ?? ctx.sessionId).capabilityId
            ? ctx.workspaceRoot && ctx.workspaceRoot !== ctx.sessionId ? 'inherited session-managed directory' : 'session-managed directory'
            : 'local workdir capability'}.`,
          '',
          coordinator ? 'Relative file paths resolve from the working directory.'
            : 'Keep this directory tidy. Relative file paths resolve from the working directory.',
          `**Session uploads**: \`${join(locations.sessionDataDir, 'uploads')}\` (not the registered folder).`,
          ...(!coordinator ? [
            'The shared `.tmp/` name resolves from the Project data directory, not the working directory, for scratch/ephemeral data.',
            '`write("notes.md")` writes into the working directory.',
          ] : []),
        )
      } else if (!locations.workdir.available) {
        const ref = locations.workdir.workdir
        lines.push(
          '**Working directory**: unavailable',
          `**Node**: \`${ref.nodeId}\``,
          `**Capability**: \`${ref.capabilityId}\``,
          `**Unavailable reason**: \`${locations.workdir.reason}\``,
          '',
          'The workdir capability is unavailable. Do not fall back to the Project data directory or a display path.',
        )
      } else {
        const ref = locations.workdir.workdir
        lines.push(
          '**Working directory**: remote capability',
          `**Node**: \`${ref.nodeId}\``,
          `**Capability**: \`${ref.capabilityId}\``,
          '',
          'File and process operations must use the remote executor. Display paths are not Main filesystem paths.',
        )
      }

      lines.push(
        '',
        `**Project data directory (Home; not the working directory)**: \`${locations.home}\``,
        'Files, attachments and images received on any channel are automatically saved in private session uploads, not the registered folder.',
        'Use the absolute attachment paths supplied in messages; they are not remote workdir paths.',
        '',
        '## File destinations and delivery',
        '',
        'A registered Folder is the durable home for user work, not a private per-session copy. Session-managed directories are draft spaces for uploads, experiments and intermediate files, not the sole destination for finished deliverables. Project Home is internal application data, not an output folder.',
        'For file-producing requests, honor the user\'s explicit destination first. Otherwise, when a Folder is selected, put finished deliverables in that Folder using its workdir capability. Do not create a second chat-* output folder there. Existing project conventions take precedence over the generic category defaults below.',
        'Without a selected Folder, save finished deliverables outside session-managed storage in the appropriate operating-system user folder: reports and documents in Documents, images in Pictures, videos in Videos, audio in Music, and downloaded files in Downloads. Use a Shadow subfolder to keep generated files organized. Use Desktop only when the user requests it; do not clutter it by default.',
        'Discover the actual system user-folder paths on the execution device using supported platform facilities; account for localization and redirected or cloud-backed folders. Do not guess paths from a username, assume English directory names, or use Main user-folder paths for a remote device. If the destination cannot be resolved or permitted tools cannot access it, explain the limitation and ask for an accessible destination; do not silently use session storage as final delivery.',
        'Keep drafts and intermediate files separate from final outputs. Never remove user files or overwrite an existing destination without authorization; choose a distinct filename for a new deliverable. Follow existing file-access permissions and tool restrictions; this guidance grants no additional access.',
        'Before claiming delivery, verify that the final file was successfully saved at its durable destination. Give the user the actual location and an accessible file reference when supported by the channel; do not invent links or claim that a local path was uploaded. Do not describe a draft-only file as delivered or claim it will survive chat deletion. A file saved outside session storage must not be removed as part of session cleanup.',
        ...(coordinator ? [
          'When delegating file-producing work, carry these destination rules into the task and require the actual saved location in the result. Coordination does not grant file-operation capabilities.',
        ] : []),
      )

      const prefixes = virtualFs.prefixes().filter(p => !coordinator ||
        ['v:project', 'v:sessions', 'v:memory'].includes(p.prefix.replace(/\/$/, '')))
      if (prefixes.length > 0) {
        lines.push(
          '',
          'Virtual resources:',
          '',
          ...prefixes.map((p) => `- \`${p.prefix}/\` — ${coordinator && p.prefix.replace(/\/$/, '') === 'v:memory'
            ? 'read Project Wiki and memory' : p.description}`),
        )
      }

      if (ctx.agent.soul !== false) {
        const soul = await readFileIfExists(workspacePath(workspace, 'SOUL.md'))
        if (soul?.trim()) {
          lines.push('', soul.trim())
        }
      }

      lines.push(
        '',
        '## Project knowledge',
        '',
        'For requests about Project memory, Wiki, knowledge or remembering facts, read `v:skills/project-knowledge` before inspecting, editing or delegating knowledge work; it explains aliases, storage and the operation rules without granting permissions.',
        '',
      )
      return lines.join('\n')
    },
  }
}
