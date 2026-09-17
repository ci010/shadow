import { FOLDER_DISCOVERY_NOTICE, type ProjectFolderDiscovery } from '../../folders/discovery.ts'
import type { FolderRecord } from '../../folders/contracts.ts'
import type { SystemPromptProvider } from './builder.ts'

export const PROJECT_FOLDER_SUMMARY_LIMIT = 8

function display(value: string, limit: number): string {
  let encoded = ''
  for (const character of value) {
    const part = JSON.stringify(character).slice(1, -1).replace(
      /[<>&`\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
      character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    )
    if (encoded.length + part.length > limit) return `"${encoded}…"`
    encoded += part
  }
  return `"${encoded}"`
}

function folderLine(folder: FolderRecord): string {
  return `id=${display(folder.id, 128)} name=${display(folder.name, 120)} kind=${folder.kind ?? 'local'} displayPath=${display(folder.path, 220)}`
}

export function projectProvider(discovery: ProjectFolderDiscovery): SystemPromptProvider {
  return {
    name: 'project',
    getPromptSection(ctx) {
      const { project, folders } = discovery.snapshot(ctx.projectId)
      const selected = ctx.folderId ? folders.find(folder => folder.id === ctx.folderId) : undefined
      const visible = folders.slice(0, PROJECT_FOLDER_SUMMARY_LIMIT)
      return [
        '# Project and registered folders',
        '',
        `Current project: id=${display(project.id, 128)} name=${display(project.name, 160)}`,
        ctx.folderId
          ? selected
            ? `Selected folder: ${folderLine(selected)}`
            : `Selected folder: id=${display(ctx.folderId, 128)} (not registered in this project; unavailable)`
          : 'Selected folder: none. The session uses its existing workspace; no registered folder is selected.',
        '',
        FOLDER_DISCOVERY_NOTICE,
        'The Workspace section describes the effective workdir. This bounded list is a snapshot; read("v:project/folders") for the full current project folder metadata and availability.',
        'Use search with space="glob:v:project" and query="folders/*" to discover individual metadata entries, then read their virtual paths.',
        '',
        `Registered folders (${folders.length}; showing ${visible.length}):`,
        ...visible.map(folder => `- ${folderLine(folder)}`),
        ...(folders.length ? [] : ['- none']),
        ...(folders.length > visible.length
          ? [`${folders.length - visible.length} more folders omitted; read("v:project/folders") for the complete list.`]
          : []),
      ].join('\n')
    },
  }
}
