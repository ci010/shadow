import { readFileSync } from 'node:fs'
import type { SessionPromptContext } from './builder.ts'
import { resolvePrompt } from './prompt-version.ts'

export type BehaviorFragments = Readonly<Record<string, string>>
export type BehaviorFacts = { channel: string; mode: string; tools: ReadonlySet<string> }
type Condition = Partial<Record<'tools' | 'channels' | 'modes', string[]>>
type Block = { text: string; condition?: Condition } | { include: string }
const fragmentId = /^[a-z][a-z0-9-]{0,63}$/
const token = /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$/
const modes = new Set(['session', 'task', 'call'])
export const legacyBehaviorBoundary = '<!-- behavior-v2 -->'
const bundledFragments = readFileSync(new URL('./behavior-fragments.md', import.meta.url), 'utf8')

export function usesBehaviorMarkdown(ctx: SessionPromptContext): boolean {
  if (ctx.promptDraft) return ctx.promptDraft.fragments !== undefined
  if (ctx.subDraft) return false
  return (ctx.promptVersion ?? resolvePrompt(ctx.agent).version) === 'v2' ||
    (ctx.agent.source === 'workspace' && !ctx.agent.runtimeOrigin)
}

function lines(markdown: string) { return markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [] }

function parseCondition(source: string): Condition {
  const condition: Condition = {}
  for (const predicate of source.split(';')) {
    const match = /^(tools|channels|modes)\s*=\s*(.+)$/.exec(predicate.trim())
    if (!match) throw new Error(`Invalid behavior condition: ${predicate}`)
    const key = match[1] as keyof Condition
    const values = match[2]!.split(',').map(value => value.trim())
    if (condition[key] || values.some(value => !token.test(value) || (key === 'modes' && !modes.has(value)))) {
      throw new Error(`Invalid behavior condition: ${predicate}`)
    }
    condition[key] = values
  }
  return condition
}

function parse(markdown: string, allowIncludes: boolean): Block[] {
  const blocks: Block[] = []
  let body = '', condition: Condition | undefined
  let fence: string | undefined
  const flush = () => {
    if (body) blocks.push(condition ? { text: body, condition } : { text: body })
    body = ''
  }
  for (const line of lines(markdown)) {
    const trimmed = line.trim()
    const fenceLine = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(line.trimEnd())
    if (fence) {
      body += line
      if (fenceLine && fenceLine[1]![0] === fence[0] && fenceLine[1]!.length >= fence.length && !fenceLine[2]!.trim()) fence = undefined
      continue
    }
    if (fenceLine) { fence = fenceLine[1]; body += line; continue }
    if (trimmed === legacyBehaviorBoundary) continue
    const when = /^<!-- when:\s*(.*?)\s*-->$/.exec(trimmed)
    if (when) {
      if (condition) throw new Error('Nested behavior conditions are not supported')
      flush()
      condition = parseCondition(when[1]!)
      continue
    }
    if (trimmed === '<!-- /when -->') {
      if (!condition) throw new Error('Behavior condition closing marker has no opener')
      flush()
      condition = undefined
      continue
    }
    const include = /^<!-- include:\s*(.*?)\s*-->$/.exec(trimmed)
    if (include) {
      if (!allowIncludes || condition || !fragmentId.test(include[1]!)) throw new Error(`Invalid behavior include: ${include[1]}`)
      flush()
      blocks.push({ include: include[1]! })
      continue
    }
    if (/^<!--\s*(?:\/?when|else|include|\/?fragment)(?=\s|:|-->|$)/.test(trimmed)) {
      throw new Error(`Invalid behavior directive: ${trimmed}`)
    }
    body += line
  }
  if (condition) throw new Error('Unclosed behavior condition')
  flush()
  return blocks
}

function parseCatalog(source: string): BehaviorFragments {
  const catalog: Record<string, string> = Object.create(null)
  let name: string | undefined, body = ''
  for (const line of lines(source)) {
    const trimmed = line.trim()
    const start = /^<!-- fragment: ([a-z][a-z0-9-]{0,63}) -->$/.exec(trimmed)
    if (start) {
      if (name || Object.hasOwn(catalog, start[1]!)) throw new Error(`Duplicate or nested behavior fragment: ${start[1]}`)
      name = start[1]!
    } else if (trimmed === '<!-- /fragment -->') {
      if (!name || !body.trim()) throw new Error('Unexpected or empty behavior fragment')
      parse(body, false)
      catalog[name] = body
      name = undefined
      body = ''
    } else if (name) body += line
    else if (trimmed && !trimmed.startsWith('#')) throw new Error(`Unexpected fragment catalog content: ${trimmed}`)
  }
  if (name) throw new Error(`Unclosed behavior fragment: ${name}`)
  return Object.freeze(catalog)
}

let catalog: BehaviorFragments | undefined

/** Resolve only named, registered content. Pinned revisions cannot fall back to today's catalog. */
export function snapshotBehaviorFragments(markdown: string, source?: BehaviorFragments): BehaviorFragments {
  const ids = [...new Set(parse(markdown, true).flatMap(block => 'include' in block ? [block.include] : []))].sort()
  if (!ids.length) return {}
  const entries = source ?? (catalog ??= parseCatalog(bundledFragments))
  return Object.fromEntries(ids.map(id => {
    if (!Object.hasOwn(entries, id) || typeof entries[id] !== 'string') throw new Error(`Unknown behavior fragment: ${id}`)
    parse(entries[id]!, false)
    return [id, entries[id]!]
  }))
}

function matches(condition: Condition | undefined, facts: BehaviorFacts): boolean {
  return !condition || ((!condition.tools || condition.tools.every(tool => facts.tools.has(tool))) &&
    (!condition.channels || condition.channels.includes(facts.channel)) &&
    (!condition.modes || condition.modes.includes(facts.mode)))
}

export function renderBehaviorMarkdown(markdown: string, facts: BehaviorFacts, pinned?: BehaviorFragments): string {
  const fragments = snapshotBehaviorFragments(markdown, pinned)
  const render = (blocks: Block[]): string => blocks.map(block => 'include' in block
    ? render(parse(fragments[block.include]!, false))
    : matches(block.condition, facts) ? block.text : '').join('')
  return render(parse(markdown, true))
}
