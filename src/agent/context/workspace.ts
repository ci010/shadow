import type { SystemPromptProvider } from './builder.ts'
import { join } from 'node:path'
import type { VirtualFs } from '../../vfs/virtual-fs.ts'
import { isToolAllowed } from '../../utils/tool-allow.ts'
import {
  resolveSessionLocations,
  type WorkdirCapabilityLookup,
} from '../../sessions/locality.ts'
import { readFileIfExists, workspacePath } from '../../utils/paths.ts'

export function workspaceProvider(
  workspace: string,
  virtualFs: VirtualFs,
  workdirCapabilityLookup?: WorkdirCapabilityLookup,
): SystemPromptProvider {
  return {
    name: 'workspace-intro',
    async getPromptSection(ctx) {
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
        '# Workspace',
        '',
        `**Home**: \`${locations.home}\``,
      ]

      if (
        locations.workdir.available && locations.workdir.locality === 'local'
      ) {
        lines.push(
          `**Workspace root (this session)**: \`${locations.workdir.path}\``,
          '',
          'Keep this folder tidy. Relative file paths resolve from your workspace root.',
          `**Session uploads**: \`${join(locations.sessionDataDir, 'uploads')}\` (not the registered folder).`,
          'The shared `.tmp/` name resolves from Home, not the workspace root, for scratch/ephemeral data.',
          '`write("notes.md")` writes into the workspace root; `write("v:memory/today.md")` into shared memory.',
        )
      } else if (!locations.workdir.available) {
        const ref = locations.workdir.workdir
        lines.push(
          '**Workspace root (this session)**: unavailable',
          `**Node**: \`${ref.nodeId}\``,
          `**Capability**: \`${ref.capabilityId}\``,
          `**Unavailable reason**: \`${locations.workdir.reason}\``,
          '',
          'The workspace capability is unavailable. Local file operations cannot use it.',
        )
      } else {
        const ref = locations.workdir.workdir
        lines.push(
          '**Workspace root (this session)**: remote capability',
          `**Node**: \`${ref.nodeId}\``,
          `**Capability**: \`${ref.capabilityId}\``,
          '',
          'Folder file and process operations must use the remote executor.',
        )
      }

      lines.push(
        '',
        'Files, attachments and images received on any channel are automatically saved in private session uploads, not the registered folder.',
        'Use the absolute attachment paths supplied in messages; they are not remote workdir paths.',
      )

      const prefixes = virtualFs.prefixes()
      if (prefixes.length > 0) {
        lines.push(
          '',
          'Virtual folders (use `read`/`search` to access):',
          '',
          ...prefixes.map((p) => `- \`${p.prefix}/\` — ${p.description}`),
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
        'Read/search `v:memory/` for relevant context, not as a substitute for current evidence.',
        '',
      )

      if (isToolAllowed(ctx.agent, 'write')) {
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
