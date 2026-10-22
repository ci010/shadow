import type { SystemPromptProvider } from './builder.ts'
import type { VirtualFs } from '../../vfs/virtual-fs.ts'
import {
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
        '## Git and GitHub',
        '',
        coordinator
          ? 'When routing Git/GitHub work, default workers to bundled stricttools/safegit for commits and pushes and prefer gh for GitHub research. If safegit is unavailable or fails, stop, inspect possible side effects, and report before retrying. Never automatically fall back to raw Git. Only explicit human authorization for the specified repository and operation permits the corresponding raw Git operation, subject to higher-priority restrictions; it does not expand force/reset/clean, hook bypass or publication permissions. Route that human decision through the parent when required; workers cannot authorize their own bypass. Coordination grants no execution or publication permissions.'
          : 'Before Git mutations or GitHub research, read `v:skills/git-github`. By default, use the bundled stricttools/safegit CLI for commits and pushes via exec. Local exec provides a child-only PATH alias `safegit` and absolute SHADOW_SAFEGIT_PATH; there is no structured safegit tool. Main aliases are not forwarded to remote devices. If safegit is unavailable or fails, stop the mutation, inspect possible side effects, and report before retrying. Never automatically fall back to raw Git. Only explicit human authorization for the specified repository and operation permits the corresponding raw Git operation, subject to higher-priority restrictions. Honor an explicit scoped human instruction to use ordinary Git; ask if scope is unclear. This does not expand force/reset/clean, hook bypass or publication permissions. Workers must route human decisions through the parent when required; they cannot authorize their own bypass. Prefer `gh` for searching and reading GitHub; the skill covers optional setup. This is an agent workflow rule, not an OS sandbox or permission to publish.',
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
