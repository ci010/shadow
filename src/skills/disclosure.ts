import { estimateTokens } from '../utils/estimate-tokens.ts'
import type { Skill } from './loader.ts'

/** Includes guidance, markup, and the estimator's single-message overhead; not exact model tokens. */
export const SKILL_DISCLOSURE_TOKEN_LIMIT = 1200
export const SKILL_DISCLOSURE_CORE_LIMIT = 4
export const SKILL_DISCLOSURE_ENTRY_LIMIT = 12
/** Limits apply separately to public and admin-only usage. */
export const SKILL_DISCLOSURE_SESSION_LIMIT = 128
export const SKILL_DISCLOSURE_HISTORY_LIMIT = 32
export const SKILL_DISCLOSURE_PROJECT_HISTORY_LIMIT = 64
const ENTRY_TOKEN_LIMIT = 120

const GUIDANCE = [
  '## Skills',
  '',
  'Skills describe reusable workflows. Below is a bounded selection, not the full catalog; omitted skills remain available.',
  '- read("v:skills/<name>") loads instructions and registers that skill\'s frontmatter tools for this session only.',
  '- read("v:skills/<category>") lists skills in a category.',
  '- read("v:skills/<name>/<path>") reads bundled resources.',
  'Category/resource reads do not register tools. Reading a skill does not run its code; invocation may run initialization. Sleep clears registrations: read the skill again. TypeScript entrypoints stay inside their owning skill directory.',
].join('\n')

function tokens(text: string): number {
  return estimateTokens([{ role: 'system', content: text }])
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"'\u0000-\u001f\u007f]/g, char => {
    switch (char) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      case "'": return '&apos;'
      default: return ' '
    }
  })
}

function render(lines: string[]): string {
  return `${GUIDANCE}\n<available_skills>\n${lines.join('\n')}\n</available_skills>`
}

function entry(skill: Skill): string | undefined {
  // Never shorten a name into a different, unreadable skill path.
  if (skill.meta.name.length > ENTRY_TOKEN_LIMIT * 4) return undefined
  const name = escapeXml(skill.meta.name)
  const suffix = `${skill.isLearned ? ' [learned]' : ''}</skill>`
  const prefix = `  <skill name="${name}">`
  if (tokens(prefix + suffix) > ENTRY_TOKEN_LIMIT) return undefined
  const description = skill.meta.description.slice(0, 680)
  const firstSentence = description.match(/^.+?[.!?。！？](?=\s|$)/)?.[0] ?? description
  const characters = Array.from(firstSentence).slice(0, 340)
  const full = prefix + escapeXml(characters.join('')) + suffix
  if (tokens(full) <= ENTRY_TOKEN_LIMIT) return full
  let low = 0
  let high = characters.length
  let line = prefix + suffix
  while (low <= high) {
    const length = Math.floor((low + high) / 2)
    const candidate = prefix + escapeXml(characters.slice(0, length).join('') + '…') + suffix
    if (tokens(candidate) <= ENTRY_TOKEN_LIMIT) {
      line = candidate
      low = length + 1
    } else {
      high = length - 1
    }
  }
  return line
}

type History = Map<string, number>

function touch(history: History, name: string, order: number, limit: number): void {
  history.delete(name)
  history.set(name, order)
  if (history.size > limit) history.delete(history.keys().next().value!)
}

class Usage {
  readonly project: History = new Map()
  readonly sessions = new Map<string, History>()

  mark(name: string, order: number, sessionId?: string): void {
    touch(this.project, name, order, SKILL_DISCLOSURE_PROJECT_HISTORY_LIMIT)
    if (sessionId === undefined) return
    const history = this.sessions.get(sessionId) ?? new Map<string, number>()
    touch(history, name, order, SKILL_DISCLOSURE_HISTORY_LIMIT)
    this.sessions.delete(sessionId)
    this.sessions.set(sessionId, history)
    if (this.sessions.size > SKILL_DISCLOSURE_SESSION_LIMIT) {
      this.sessions.delete(this.sessions.keys().next().value!)
    }
  }
}

/** In-memory, manager/project-local usage. Rendering and discovery never mutate it. */
export class SkillDisclosure {
  private readonly publicUsage = new Usage()
  private readonly adminUsage = new Usage()
  private order = 0

  markSkillUsed(skill: Skill, sessionId?: string): void {
    const usage = skill.meta.admin ? this.adminUsage : this.publicUsage
    usage.mark(skill.meta.name, ++this.order, sessionId)
  }

  summary(visibleSkills: Skill[], sessionId?: string): string {
    const visible = new Map(visibleSkills.map(skill => [skill.meta.name, skill]))
    const sorted = [...visibleSkills].sort((a, b) =>
      a.meta.name < b.meta.name ? -1 : a.meta.name > b.meta.name ? 1 : 0)
    const recent = (session: boolean): Skill[] => {
      const histories = [this.publicUsage, this.adminUsage].map(usage =>
        session ? usage.sessions.get(sessionId!) : usage.project)
      return histories.flatMap(history => [...(history ?? [])])
        .filter(([name]) => visible.has(name))
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => visible.get(name)!)
    }
    const candidates = [
      ...sorted.filter(skill => skill.meta.core).slice(0, SKILL_DISCLOSURE_CORE_LIMIT),
      ...(sessionId === undefined ? [] : recent(true)),
      ...recent(false),
      ...sorted.filter(skill => !skill.meta.core),
    ]
    const selected = new Set<string>()
    const lines: string[] = []
    for (const skill of candidates) {
      if (selected.has(skill.meta.name)) continue
      selected.add(skill.meta.name)
      const line = entry(skill)
      if (!line || tokens(render([...lines, line])) > SKILL_DISCLOSURE_TOKEN_LIMIT) continue
      lines.push(line)
      if (lines.length === SKILL_DISCLOSURE_ENTRY_LIMIT) break
    }
    return render(lines)
  }
}
