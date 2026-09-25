import type { SystemPromptProvider } from './builder.ts'
import { join } from 'node:path'
import type { VirtualFs } from '../../vfs/virtual-fs.ts'
import { isToolAllowed } from '../../utils/tool-allow.ts'
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
            '`write("notes.md")` writes into the working directory; `write("v:memory/today.md")` into Project memory.',
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
      )

      const prefixes = virtualFs.prefixes().filter(p => !coordinator ||
        ['v:project', 'v:sessions', 'v:memory'].includes(p.prefix.replace(/\/$/, '')))
      if (prefixes.length > 0) {
        lines.push(
          '',
          'Virtual resources:',
          '',
          ...prefixes.map((p) => `- \`${p.prefix}/\` — ${coordinator && p.prefix.replace(/\/$/, '') === 'v:memory'
            ? 'read relevant Project memory' : p.description}`),
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
        '## Memory',
        '',
        'Use `v:memory/` for relevant historical context, not as a substitute for current evidence.',
        '',
      )

      if (!coordinator && isToolAllowed(ctx.agent, 'write')) {
        lines.push(
          '- Files survive restarts; mental notes do not. Write what you need to remember under `v:memory/`, including explicit "remember this" requests.',
          '- Record mistakes to avoid repeating them; save lessons in memory or update/create relevant skills.',
          '- Memory is a knowledge graph: reference files with markdown links, not bare code spans. Fix write-validation issues reported in tool results.',
          '',
        )
      }
      return lines.join('\n')
    },
  }
}
