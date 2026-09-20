import type { Tool } from './tool.ts'

const stopWords = new Set(['a', 'an', 'the', 'and', 'or', 'to', 'of', 'in', 'for', 'with', 'by', 'tool', 'tools'])

export function toolSearchScore(query: string, tool: Pick<Tool, 'name' | 'description'>, source = ''): number {
  const normalize = (text: string) => text.normalize('NFKC').toLowerCase()
  const text = normalize(query)
  if (!text.trim()) return 1
  const name = normalize(tool.name)
  const description = normalize(tool.description)
  const origin = normalize(source)
  const words = [...new Set(text.match(/[\p{L}\p{N}_]+/gu) ?? [])].filter(word => !stopWords.has(word))
  const score = words.reduce((total, word) =>
    total + (name.includes(word) ? 6 : 0) + (description.includes(word) ? 3 : 0) + (origin.includes(word) ? 1 : 0), 0)
  return score + (name === text ? 100 : name.includes(text) ? 12 : description.includes(text) ? 6 : 0)
}
