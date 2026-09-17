import type { SkillsManager } from './loader.ts'

/** Discovery never reads executable resources or activates skill tools. */
export function searchSkills(skills: SkillsManager, args: Record<string, unknown>, admin = false): string {
  if (args.query !== undefined && typeof args.query !== 'string') return 'Error: skill query must be a string'
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
  if (query.length > 500) return 'Error: skill query must contain at most 500 characters'
  const limit = args.limit ?? 5
  const offset = args.offset ?? 0
  if (args.limit === null || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    return 'Error: skill limit must be an integer from 1 through 20'
  }
  if (args.offset === null || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
    return 'Error: skill offset must be a nonnegative safe integer'
  }
  const terms = query.split(/\s+/).filter(Boolean)
  const matches = skills.availableSkills(admin)
    .filter(skill => !args.category || skill.meta.category === args.category)
    .map(skill => {
      const name = skill.meta.name.toLowerCase()
      const text = `${name} ${skill.meta.description} ${skill.meta.category ?? ''} ${skill.body}`.toLowerCase()
      const score = terms.every(term => text.includes(term))
        ? 1 + terms.reduce((sum, term) => sum + (name === term ? 10 : name.includes(term) ? 5 : 0), 0) : 0
      return { skill, score }
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.meta.name.localeCompare(b.skill.meta.name, 'en'))
  return JSON.stringify({
    skills: matches.slice(offset, offset + limit).map(({ skill }) => ({
      name: skill.meta.name, description: skill.meta.description.slice(0, 1000),
      ...(skill.meta.category ? { category: skill.meta.category } : {}),
      path: `v:skills/${skill.meta.name}`,
      toolNames: Object.keys(skill.meta.tools ?? {}),
      ...(skill.meta.toolsError ? { toolsError: skill.meta.toolsError } : {}),
    })),
    totalMatches: matches.length,
    hasMore: offset + limit < matches.length,
    nextOffset: offset + limit < matches.length ? offset + limit : null,
    activation: 'none',
  })
}
