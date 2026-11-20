import { posix } from 'node:path'
import { z } from 'zod'
import { isSharedWikiScope, type KnowledgeService } from '../knowledge/service.ts'
import { createSharedKnowledgeHandler } from '../vfs/knowledge.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { Tool, ToolResult } from '../tools/tool.ts'
import { cleanResourceSegment as clean, type ReadResources } from './read-scope.ts'
import { assertServiceGlob, matchesServiceGlob } from './service-glob.ts'

const pathArg = z.string().min(1).max(2048)
const readArgs = z.object({ path: pathArg, offset: z.number().int().min(1).max(1_000_000).optional(), limit: z.number().int().min(1).max(500).optional() }).strict()
const searchArgs = z.object({ path: pathArg, query: z.string().min(1).max(1000), handler: z.enum(['grep', 'glob']), limit: z.number().int().min(1).max(100).optional() }).strict()
const legacySearchArgs = z.object({ query: z.string().max(1000) }).strict()
export type ServiceRead = z.infer<typeof readArgs>
export type ServiceSearch = z.infer<typeof searchArgs>
const integer = { type: 'integer' } as const
const string = { type: 'string' } as const
export const serviceReadGuide = 'Read `.` to list authorized relative folder names. Use returned paths verbatim (spaces included). With an explicit Project grant use v:knowledge/catalog for metadata or v:memory/ for shared Wiki. Search uses {handler: "grep" | "glob", path, query, limit?}. Grep is literal; glob matches names. Platform folder backend limits still apply.'

export type FolderReadResult = ReturnType<typeof readResourceLines> | { path: string; offset: number; entries: Array<{ name: string; kind: 'file' | 'directory' }>; totalEntries: number }
type FileSearch = ReturnType<typeof searchResourceText>

export interface ServiceReadBackend {
  projectId: string
  views?: ReadResources
  knowledge?: Pick<KnowledgeService, 'sharedCatalog' | 'sharedWiki'>
  folders: () => Map<string, string>
  folderRead(id: string, input: ServiceRead, context: ExecutionContext): Promise<FolderReadResult>
  folderSearch(id: string, input: ServiceSearch, context: ExecutionContext): Promise<FileSearch>
  legacyRead?(input: ServiceRead, context: ExecutionContext): Promise<unknown> | unknown
  legacySearch?(input: z.infer<typeof legacySearchArgs>, context: ExecutionContext): Promise<unknown> | unknown
}

export function readResourceLines(path: string, content: string, input: ServiceRead) {
  const all = content.split('\n'), offset = input.offset ?? 1
  return { path, offset, lines: all.slice(offset - 1, offset - 1 + (input.limit ?? 200)), totalLines: all.length }
}

export function searchResourceText(documents: Iterable<{ path: string; content: string; name?: string }>, input: ServiceSearch) {
  const matches: Array<{ path: string; line?: number; text?: string }> = []
  const limit = input.limit ?? 50, needle = input.query.toLowerCase()
  for (const { path, name, content } of documents) {
    if (input.handler === 'glob') {
      if (matchesServiceGlob(name ?? path, input.query)) matches.push({ path })
    } else {
      for (const [index, line] of content.split('\n').entries()) {
        if (line.toLowerCase().includes(needle)) matches.push({ path, line: index + 1, text: line.slice(0, 2000) })
        if (matches.length > limit) break
      }
    }
    if (matches.length > limit) break
  }
  return { matches: matches.slice(0, limit), truncated: matches.length > limit }
}

export function serviceReadTools(backend: ServiceReadBackend): Tool<ToolResult>[] {
  const denied = () => new Error('Resource path is outside the authorized service scope.')
  const scope = (context: ExecutionContext) => {
    context.signal.throwIfAborted()
    if (context.projectId !== backend.projectId) throw denied()
  }
  const knowledge = () => {
    if (!backend.views?.knowledge || !backend.knowledge) throw denied()
    return createSharedKnowledgeHandler(backend.knowledge, backend.projectId, scope, !!backend.views.wiki)
  }
  const wiki = (path: string) => {
    if (!backend.views?.wiki || !backend.knowledge || !isSharedWikiScope(path.slice('v:memory/'.length))) throw denied()
    const prefix = path === 'v:memory' ? 'v:memory/' : path
    const docs = backend.knowledge.sharedWiki().map(item => ({ path: `v:${item.entry.path}`, content: item.content }))
    return docs.filter(item => item.path === prefix || item.path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))
  }
  const routeFolder = (path: string) => {
    const [root, ...parts] = (path.endsWith('/') ? path.slice(0, -1) : path).split('/')
    if (!clean(root) || parts.some(part => !clean(part))) throw denied()
    const id = backend.folders().get(root)
    if (!id) throw denied()
    return { id, root, path: parts.join('/') || '.' }
  }
  const projectPath = (path: string, root: string) => path === root || path.startsWith(`${root}/`)
  const legacyMemory = /^v:memory\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/
  return [{
    name: 'read', readonly: true, description: serviceReadGuide,
    parameters: { type: 'object', properties: { path: string, offset: integer, limit: integer }, required: ['path'], additionalProperties: false },
    execute: async (raw, context) => {
      scope(context)
      const input = readArgs.parse(raw), { path } = input
      let result: unknown
      if (path === '.') result = { path, entries: [...backend.folders().keys()] }
      else if (projectPath(path, 'v:knowledge')) {
        const navigation = String(await knowledge().read(path.slice('v:knowledge/'.length), context))
        result = readResourceLines(path, navigation, input)
      } else if (backend.legacyRead && (path === 'v:sessions/current' || legacyMemory.test(path) || !backend.views?.wiki && (path === 'v:memory' || path === 'v:memory/'))) result = await backend.legacyRead(input, context)
      else if (projectPath(path, 'v:memory')) {
        const docs = wiki(path), exact = docs.find(item => item.path === path)
        if (!docs.length && path !== 'v:memory' && path !== 'v:memory/') throw denied()
        const start = input.offset ?? 1, limit = input.limit ?? 200
        result = exact ? readResourceLines(path, exact.content, input) : { path, entries: docs.slice(start - 1, start - 1 + limit).map(item => item.path), total: docs.length }
      } else {
        const route = routeFolder(path)
        result = { ...await backend.folderRead(route.id, { ...input, path: route.path }, context), path }
        if (backend.folders().get(route.root) !== route.id) throw denied()
      }
      scope(context)
      return JSON.stringify(result)
    },
  }, {
    name: 'search', readonly: true, description: serviceReadGuide + (backend.legacySearch ? ' For existing Discord scoped records only, omit handler and path; an empty query lists permitted records.' : ''),
    parameters: { type: 'object', properties: { path: string, query: string, handler: { type: 'string', enum: ['grep', 'glob'] }, limit: integer }, required: backend.legacySearch ? ['query'] : ['handler', 'path', 'query'], additionalProperties: false },
    execute: async (raw, context) => {
      scope(context)
      if (backend.legacySearch && !Object.hasOwn(raw, 'path') && !Object.hasOwn(raw, 'handler')) {
        const result = await backend.legacySearch(legacySearchArgs.parse(raw), context)
        scope(context)
        return JSON.stringify(result)
      }
      const input = searchArgs.parse(raw), { path } = input
      if (input.handler === 'glob') assertServiceGlob(input.query)
      let result: unknown
      if (path === '.') {
        if (input.handler !== 'glob') throw new Error('Use read or glob to discover granted folder names.')
        result = searchResourceText([...backend.folders().keys()].map(path => ({ path, content: '' })), input)
      } else if (projectPath(path, 'v:knowledge')) {
        const entries = await knowledge().list(context, { subpath: path.slice('v:knowledge/'.length), content: input.handler !== 'glob' })
        result = searchResourceText((entries ?? []).map(item => ({ path: `v:knowledge/${item.name}`, name: item.name, content: item.content })), input)
      } else if (projectPath(path, 'v:memory')) {
        const prefix = path.endsWith('/') ? path : `${path}/`
        result = searchResourceText(wiki(path).map(item => ({ ...item, name: item.path.startsWith(prefix) ? item.path.slice(prefix.length) : posix.basename(item.path) })), input)
      } else {
        const route = routeFolder(path)
        const output = await backend.folderSearch(route.id, { ...input, path: route.path }, context)
        if (backend.folders().get(route.root) !== route.id) throw denied()
        result = { ...output, matches: output.matches.flatMap(match => {
          if (match.path === '.') return [{ ...match, path: route.root }]
          if (!match.path.split('/').every(clean)) return []
          return [{ ...match, path: `${route.root}/${match.path}` }]
        }) }
      }
      scope(context)
      return JSON.stringify(result)
    },
  }]
}
