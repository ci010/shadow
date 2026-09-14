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
          'This folder is home. Treat it that way.',
          '',
          'Files you create with relative paths land in your **workspace root** —',
          'that keeps home tidy. Files people upload to you stay in private session data:',
          `**Session uploads**: \`${join(locations.sessionDataDir, 'uploads')}\` (not the project folder).`,
          'Use the absolute attachment paths supplied in messages. A few shared resources still resolve from home by their',
          'plain names, never your workspace root:',
          '',
          '- `.tmp/` — scratch space for tools and ephemeral data',
          '',
          'For example `write("notes.md")` writes into your workspace root, while',
          '`write("v:memory/today.md")` saves to your shared memory store.',
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
          'Project file and process operations must use the remote executor.',
        )
      }

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
        'Use stored memories as relevant context, not as a substitute for current evidence.',
        'Your memory lives under `v:memory/` — read and search there.',
        '',
        '### Recap If Needed',
        '- Use `read` or `search` on `v:memory/` to recap relevant memories.',
        '',
      )

      if (isToolAllowed(ctx.agent, 'write')) {
        lines.push(
          '### Write It Down',
          '- **Memory is limited** — if you want to remember something, write it under `v:memory/`',
          '- "Mental notes" don\'t survive session restarts. Files do.',
          '- When someone says "remember this" → update the relevant file under `v:memory/`',
          '- When you learn a lesson → update the relevant memory file, or update relevant skills or create one',
          "- When you make a mistake → document it so future-you doesn't repeat it",
          '- Memory files form a **knowledge graph** — use markdown links (not bare code spans) when referencing files. The system validates your writes and reports issues in the tool result. Fix any reported issues.',
          '',
        )
      }
      return lines.join('\n')
    },
  }
}
