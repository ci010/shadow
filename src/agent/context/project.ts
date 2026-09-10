import type { SystemPromptProvider } from './builder.ts'
import { readFileIfExists, workspacePath } from '../../utils/paths.ts'

export function projectProvider(workspace: string): SystemPromptProvider {
  return {
    name: 'project',
    async getPromptSection(ctx) {
      const projectName = ctx.projectName
      if (!projectName) return null

      const file = workspacePath(workspace, 'projects', projectName, 'project.md')
      const content = await readFileIfExists(file)
      if (!content?.trim()) return null

      return [
        '# Project Context',
        '',
        `You are working on project **${projectName}**.`,
        `The project file is at \`projects/${projectName}/project.md\` — update it with your progress.`,
        '',
        content.trim(),
      ].join('\n')
    },
  }
}
