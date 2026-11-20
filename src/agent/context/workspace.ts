import { resolvePrompt } from './prompt-version.ts'
import type { SessionPromptContext, SystemPromptProvider } from './builder.ts'
import type { VirtualFs } from '../../vfs/virtual-fs.ts'
import {
  type WorkdirLookup,
} from '../../sessions/locality.ts'
import { readFileIfExists, workspacePath } from '../../utils/paths.ts'
import type { ProjectFolderDiscovery } from '../../folders/discovery.ts'
import { projectProvider } from './project.ts'

export function usesWebWorkspacePreview(ctx: SessionPromptContext): boolean {
  return (ctx.promptVersion ?? resolvePrompt(ctx.agent).version) === 'v2' && ctx.channel === 'web' &&
    (ctx.mode ?? ctx.agent.defaultMode) === 'session'
}

export function virtualResourceCatalog(virtualFs: Pick<VirtualFs, 'prefixes'>, knowledgeNavigation = false): string[] {
  const prefixes = virtualFs.prefixes()
  const describe = ({ prefix, description }: (typeof prefixes)[number]) => {
    if (!knowledgeNavigation) return description
    if (prefix === 'v:knowledge') return 'browse Project knowledge, references, backlinks and historical logs (read-only)'
    if (prefix === 'v:memory') return 'read original Project records and edit shared Wiki Markdown'
    return description
  }
  return prefixes.length ? ['Virtual resources:', '', ...prefixes.map(p => `- \`${p.prefix}/\` — ${describe(p)}`)] : []
}

export function workspaceProvider(
  workspace: string,
  virtualFs: VirtualFs,
  workdirLookup?: WorkdirLookup,
  project?: ProjectFolderDiscovery,
): SystemPromptProvider {
  return {
    name: 'workspace-intro',
    async getPromptSection(ctx) {
      const concise = usesWebWorkspacePreview(ctx)
      const lines = [
        '# Working context',
        '',
        ...(project ? [await projectProvider(project, concise).getPromptSection(ctx) ?? '', ''] : []),
      ]

      lines.push(
        '## Attachments',
        '',
        '- Session data: `SHADOW_SESSION_DATA_DIR` (host-owned environment variable in local exec OS and Node processes).',
        '- Uploaded files: `uploads/` under the session data directory.',
        '',
        ...(concise ? [
          'Use the exact attachment paths supplied in messages, including inherited uploads. Do not treat them as remote workdir paths. `read` does not expand environment variables. The shared `.tmp/` resolves from internal Project Home, not cwd. Project Home is not a default deliverable destination.',
          '',
          '## File destinations and delivery',
          '',
          '- Use the explicit user destination, or follow the current working-context snapshot’s delivery policy. If the destination is a system user folder, resolve its actual location on the execution device, including localized or redirected folders. Do not guess paths or substitute a folder on Main.',
          '- Keep drafts and intermediate files in session storage. Save only requested final files to the delivery destination; do not create extra files or folders just to document completion. Do not remove or overwrite user files without permission; use a distinct name for new output. If the destination cannot be resolved or accessed with permitted tools, explain and ask for an accessible one. Do not silently deliver to session storage.',
          '- Verify the final file at its durable destination before claiming delivery. Report its actual location and an accessible reference when supported. Do not invent links, imply a local file was uploaded, or present drafts as delivered or surviving chat deletion.',
          '',
          '## Installations and cleanup',
          '',
          'Keep persistent installations and dependencies in their normal platform locations within authorized scope. Do not relocate existing user resources or silently elevate privileges. Session cleanup must not remove files outside session storage.',
        ] : [
          'Prefer the exact attachment paths supplied in messages; they may refer to inherited uploads and are not remote workdir paths. read() does not expand environment variables. Project Home is internal application data. Session working storage is for drafts and intermediate files; neither is the default destination for finished deliverables. The shared `.tmp/` name resolves from Project Home, not cwd.',
          '',
          '## File destinations and delivery',
          '',
          'For file-producing requests, honor an explicit user destination first; otherwise follow the current working-context snapshot destination policy.',
          'Discover the actual system user-folder paths on the execution device using supported platform facilities; account for localization and redirected or cloud-backed folders. Do not guess paths from a username, assume English directory names, or use Main user-folder paths for a remote device. If the destination cannot be resolved or permitted tools cannot access it, explain the limitation and ask for an accessible destination; do not silently use session storage as final delivery.',
          'Deliver the requested outcome, not incidental working files. Create local deliverables only when the requested outcome requires them; do not generate extra files or delivery folders merely to document completion.',
          'Keep intermediate files in session data and promote only requested final files to delivery destinations. Keep persistent installations and dependencies in their normal platform locations with authorized scope; do not relocate existing user resources or silently elevate privileges.',
          'Keep drafts and intermediate files separate from final outputs. Never remove user files or overwrite an existing destination without permission; choose a distinct filename for new output. Existing file-access permissions and tool restrictions still apply.',
          'Verify the final file was saved at its durable destination before claiming delivery. Report its actual location and an accessible reference when supported; do not invent links, imply a local file was uploaded, or present draft-only storage as delivered or surviving chat deletion. Never remove files outside session storage during session cleanup.',
        ]),
      )

      if (!concise) {
        const catalog = virtualResourceCatalog(virtualFs)
        if (catalog.length) lines.push('', ...catalog)
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
