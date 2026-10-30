import type { SystemPromptProvider } from './builder.ts'
import type { VirtualFs } from '../../vfs/virtual-fs.ts'
import {
  type WorkdirLookup,
} from '../../sessions/locality.ts'
import { readFileIfExists, workspacePath } from '../../utils/paths.ts'
import type { ProjectFolderDiscovery } from '../../folders/discovery.ts'
import { projectProvider } from './project.ts'

export function workspaceProvider(
  workspace: string,
  virtualFs: VirtualFs,
  workdirLookup?: WorkdirLookup,
  project?: ProjectFolderDiscovery,
): SystemPromptProvider {
  return {
    name: 'workspace-intro',
    async getPromptSection(ctx) {
      const lines = [
        '# Working context',
        '',
        ...(project ? [await projectProvider(project).getPromptSection(ctx) ?? '', ''] : []),
      ]

      lines.push(
        '## Attachments',
        '',
        '- Session data: `SHADOW_SESSION_DATA_DIR` (host-owned environment variable in local exec OS and Node processes).',
        '- Uploaded files: `uploads/` under the session data directory.',
        '',
        'Prefer the exact attachment paths supplied in messages; they may refer to inherited uploads and are not remote workdir paths. read() does not expand environment variables. Project Home is internal application data. Session working storage is for drafts and intermediate files; neither is the default destination for finished deliverables. The shared `.tmp/` name resolves from Project Home, not cwd.',
        '',
        '## File destinations and delivery',
        '',
        'For file-producing requests, honor an explicit user destination first; otherwise follow the current working-context snapshot destination policy.',
        'Discover the actual system user-folder paths on the execution device using supported platform facilities; account for localization and redirected or cloud-backed folders. Do not guess paths from a username, assume English directory names, or use Main user-folder paths for a remote device. If the destination cannot be resolved or permitted tools cannot access it, explain the limitation and ask for an accessible destination; do not silently use session storage as final delivery.',
        'Keep drafts and intermediate files separate from final outputs. Never remove user files or overwrite an existing destination without permission; choose a distinct filename for new output. Existing file-access permissions and tool restrictions still apply.',
        'Verify the final file was saved at its durable destination before claiming delivery. Report its actual location and an accessible reference when supported; do not invent links, imply a local file was uploaded, or present draft-only storage as delivered or surviving chat deletion. Never remove files outside session storage during session cleanup.',

      )

      const prefixes = virtualFs.prefixes()
      if (prefixes.length > 0) {
        lines.push(
          '',
          'Virtual resources:',
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
        '## Git and GitHub',
        '',
        'Before commits, pushes or GitHub research, read `v:skills/git-github`. Use bundled stricttools/safegit via exec for concurrent-safe commits and pushes. Other Git commands use ordinary Git; safegit coverage alone does not require extra approval. Existing destructive-operation and publication permissions still apply. The skill covers commit/push failure handling and gh usage.',
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
