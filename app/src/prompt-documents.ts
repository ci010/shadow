import type { InjectionKey } from 'vue'
import type { PromptSection } from './prompt-sections.ts'
export interface PromptDocument {
  key: string
  label: string
  source: string
  prompt: string
  sections?: PromptSection[]
}
export const PromptDocumentsKey: InjectionKey<{ open(projectId: string, document: PromptDocument): void }> = Symbol('PromptDocuments')
export function formatPromptQuote(source: string, text: string): string {
  return `> ${source.replace(/[\r\n]/g, ' ')}\n>\n${text.split(/\r?\n/).map(line => `> ${line}`).join('\n')}\n\n`
}
