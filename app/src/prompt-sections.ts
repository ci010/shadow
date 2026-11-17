/** Provenance is accepted only when every supplied segment matches the exact text. */
export interface PromptSection { name: string; content: string; characters: number; separatorBefore?: string }
export function promptSections(prompt: string, value: unknown): PromptSection[] {
  if (!Array.isArray(value) || !value.length) return []
  const sections: PromptSection[] = []
  let offset = 0
  for (const item of value) {
    if (!item || typeof item.name !== 'string' || typeof item.content !== 'string' || !item.content
      || item.characters !== item.content.length) return []
    if (item.separatorBefore !== undefined) {
      if (typeof item.separatorBefore !== 'string' || !/^[\s-]*$/.test(item.separatorBefore)
        || !prompt.startsWith(item.separatorBefore, offset)) return []
      offset += item.separatorBefore.length
    } else if (sections.length) {
      if (prompt.startsWith('\n\n---\n\n', offset)) offset += 7
      else if (prompt.startsWith('\n\n', offset)) offset += 2
      else return []
    }
    if (!prompt.startsWith(item.content, offset)) return []
    offset += item.content.length
    sections.push({ name: item.name, content: item.content, characters: item.characters,
      ...(item.separatorBefore !== undefined ? { separatorBefore: item.separatorBefore } : {}) })
  }
  return offset === prompt.length ? sections : []
}
