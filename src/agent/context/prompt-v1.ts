import type { SystemPromptSection } from './builder.ts'

export const PROMPT_SEPARATOR = '\n\n---\n\n'

/** Legacy provider order and exact provider separators. */
export function assemblePromptV1(sections: SystemPromptSection[]) {
  return sections.map(section => (section.separatorBefore ?? '') + section.content).join('')
}
