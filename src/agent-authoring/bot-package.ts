import { lstatSync, readdirSync, openSync, closeSync, readSync, fstatSync, constants } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { PURE_NODE_MODULES } from '../script-runtime/module-policy.ts'
import { stringify } from 'yaml'
import { parseFrontmatter } from '../utils/frontmatter.ts'
import { ConversationBindingSchema, ResourceName, type ResourceBundle } from './contracts.ts'

export const botManifest = z.object({
  name: ResourceName,
  description: z.string().optional(),
  agentMarkdown: z.string().max(512_000).optional(),
  allowedTools: z.array(ResourceName).default([]),
  allowedModules: z.array(z.string()).default([]),
  channels: z.array(z.string()).max(64),
}).strict()
const sourcePath = /^(?:BOT\.md|channels\/[a-zA-Z0-9_-]+\.json|skills\/[a-z][a-z0-9_-]{0,63}\/(?:SKILL\.md|[a-zA-Z0-9_-]+\.(?:js|ts)))$/

/** Pure data compilation: no imports, initialize hooks, package managers or code evaluation. */
export function compileBotPackage(source: Record<string, string>): ResourceBundle {
  if (!Object.hasOwn(source, 'BOT.md')) throw new Error('BOT.md is required.')
  if (Object.keys(source).some(path => !sourcePath.test(path))) throw new Error('Unsupported BOT file. Only BOT.md, channels/*.json and skills source are supported; initialize and external dependencies are not executable in this release.')
  const parsed = parseFrontmatter(source['BOT.md']!)
  if (!source['BOT.md']!.replace(/\r\n/g, '\n').startsWith('---\n')) throw new Error('BOT.md requires YAML front matter.')
  const metadata = botManifest.parse(parsed.frontmatter)
  if (new Set(metadata.channels).size !== metadata.channels.length) throw new Error('Duplicate channel config reference.')
  const safeImport = (name: string) => name.startsWith('@shadow/') || (PURE_NODE_MODULES as readonly string[]).includes(name)
  if (!metadata.allowedModules.every(safeImport)) throw new Error('BOT packages permit only pure Node modules and scoped @shadow grants, not native SDK/network/filesystem authority.')
  for (const [path, text] of Object.entries(source)) {
    if (!path.endsWith('/SKILL.md')) continue
    const tools = parseFrontmatter(text).frontmatter.tools as Record<string, { imports?: string[] }> | undefined
    for (const tool of Object.values(tools ?? {})) if (!(tool.imports ?? []).every(safeImport)) throw new Error('BOT skill imports exceed restricted runtime permissions.')
  }
  const files: Record<string, string> = {}
  for (const [path, text] of Object.entries(source)) files[`bot/${metadata.name}/${path}`] = text
  files[`agents/${metadata.name}/AGENT.md`] = `---\n${stringify({ name: metadata.name, description: metadata.description, allowedTools: metadata.allowedTools, allowedModules: metadata.allowedModules })}---\n${parsed.body}`
  if (metadata.agentMarkdown !== undefined) {
    const original = parseFrontmatter(metadata.agentMarkdown)
    for (const [key, value] of Object.entries({ description: metadata.description, allowedTools: metadata.allowedTools, allowedModules: metadata.allowedModules })) {
      if (!isDeepStrictEqual(original.frontmatter[key] ?? (key === 'description' ? undefined : []), value)) throw new Error('Frozen Agent metadata differs from BOT policy.')
    }
    if (original.frontmatter.name !== undefined && original.frontmatter.name !== metadata.name || original.body !== parsed.body) throw new Error('Frozen Agent identity or prompt differs from BOT policy.')
    files[`agents/${metadata.name}/AGENT.md`] = metadata.agentMarkdown
  }
  for (const [path, text] of Object.entries(source)) if (path.startsWith('skills/')) files[path] = text
  const bindings = metadata.channels.flatMap(path => {
    if (!/^channels\/[a-zA-Z0-9_-]+\.json$/.test(path) || !Object.hasOwn(source, path)) throw new Error(`Missing or unsafe channel reference: ${path}`)
    return z.array(ConversationBindingSchema.omit({ agent: true })).max(1000).parse(JSON.parse(source[path]!))
      .map(binding => ({ ...binding, agent: metadata.name }))
  })
  if (new Set(bindings.map(b => JSON.stringify([b.botInstanceId,b.platform]))).size > 1) throw new Error('A BOT package must target one connection and platform.')
  const referenced = new Set(metadata.channels)
  if (Object.keys(source).some(path => path.startsWith('channels/') && !referenced.has(path))) throw new Error('Unreferenced channel configuration.')
  return { version: 1, files, bindings }
}

/** Bounded local snapshot. Reject symlinks, hardlinks and unsupported files rather than silently omitting dependencies. */
export function readBotSources(directory: string): Record<string, string> {
  const source: Record<string, string> = {}
  let bytes = 0
  const walk = (relative: string) => {
    const path = join(directory, relative)
    const info = lstatSync(path)
    if (info.isSymbolicLink()) throw new Error('BOT directory cannot contain symlinks.')
    if (info.isDirectory()) {
      if (relative && !/^(?:channels|skills|skills\/[a-z][a-z0-9_-]{0,63})$/.test(relative)) throw new Error(`Unsupported BOT directory: ${relative}`)
      for (const name of readdirSync(path).sort()) walk(relative ? `${relative}/${name}` : name)
      return
    }
    if (!info.isFile() || info.nlink !== 1 || !sourcePath.test(relative)) throw new Error(`Unsupported BOT file: ${relative}`)
    bytes += info.size
    if (bytes > 2 * 1024 * 1024 || Object.keys(source).length >= 240 || info.size > 512_000) throw new Error('BOT package exceeds snapshot limits.')
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = fstatSync(fd)
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > 512_000 || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error('BOT file changed during snapshot; retry.')
      const buffer = Buffer.alloc(512_001)
      let length = 0
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null)
        if (!count) break
        length += count
      }
      if (length > 512_000 || length !== info.size) throw new Error('BOT file changed during snapshot; retry.')
      source[relative] = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
    } finally { closeSync(fd) }
  }
  walk('')
  return source
}

export function readBotDirectory(directory: string): ResourceBundle { return compileBotPackage(readBotSources(directory)) }

/** Package identity is the immutable BOT name, not its source directory. */
export function botPackages(bundle: ResourceBundle): Map<string, ResourceBundle> {
  const result = new Map<string, ResourceBundle>()
  for (const path of Object.keys(bundle.files)) {
    const match = /^bot\/([a-z][a-z0-9_-]{0,63})\/BOT\.md$/.exec(path)
    if (!match) continue
    const prefix = `bot/${match[1]}/`
    const compiled = compileBotPackage(Object.fromEntries(Object.entries(bundle.files).filter(([key]) => key.startsWith(prefix)).map(([key, text]) => [key.slice(prefix.length), text])))
    if (!compiled.files[path]) throw new Error('BOT identity does not match its source namespace.')
    result.set(match[1]!, compiled)
  }
  return result
}

export function replaceBotPackage(base: ResourceBundle, next: ResourceBundle, adoptLegacy = false): ResourceBundle {
  const packages = botPackages(next)
  if (packages.size !== 1) throw new Error('Import exactly one BOT package.')
  const [id] = packages.keys()
  const previous = botPackages(base).get(id!)
  if (adoptLegacy) {
    if (previous) throw new Error('Legacy adoption requires an unowned package.')
    const owned = [...botPackages(base).values()]
    const runtimeFiles = Object.entries(next.files).filter(([path]) => !path.startsWith('bot/'))
    if (!runtimeFiles.length || runtimeFiles.some(([path,text]) => base.files[path] !== text || owned.some(p => Object.hasOwn(p.files,path)))) throw new Error('Legacy adoption requires identical unowned resources.')
    const agentNames = runtimeFiles.filter(([path]) => path.startsWith('agents/')).map(([path]) => path.split('/')[1])
    const skillNames = runtimeFiles.filter(([path]) => path.endsWith('/SKILL.md')).map(([path]) => path.split('/')[1])
    if (base.bindings.some(b => !agentNames.includes(b.agent) && b.skills.some(skill => skillNames.includes(skill)))) throw new Error('Legacy skills are shared by another Agent.')
    for (const [path,text] of Object.entries(base.files)) {
      if (!path.startsWith('agents/') || agentNames.includes(path.split('/')[1])) continue
      const profiles = parseFrontmatter(text).frontmatter.capabilityProfiles as {skills?:string[]}[] | undefined
      if (profiles?.some(profile => profile.skills?.some(skill => skillNames.includes(skill)))) throw new Error('Legacy skills are shared by another Agent profile.')
    }
    const existing = base.bindings.filter(b => agentNames.includes(b.agent))
    if (!isDeepStrictEqual(existing, next.bindings) || !existing.length) throw new Error('Legacy adoption requires all exact existing Agent bindings.')
    return {version:1, files:{...base.files,...next.files}, bindings:base.bindings}
  }
  const files = { ...base.files }
  for (const path of Object.keys(previous?.files ?? {})) delete files[path]
  for (const [path, text] of Object.entries(next.files)) {
    if (Object.hasOwn(files, path)) throw new Error(`BOT resource is owned by another package or legacy configuration: ${path}`)
    files[path] = text
  }
  const oldKeys = new Set(previous?.bindings.map(binding => JSON.stringify([binding.botInstanceId,binding.platform,binding.conversationId])) ?? [])
  const bindings = base.bindings.filter(binding => !oldKeys.has(JSON.stringify([binding.botInstanceId,binding.platform,binding.conversationId])))
  const keys = new Set(bindings.map(binding => JSON.stringify([binding.botInstanceId,binding.platform,binding.conversationId])))
  if (next.bindings.some(binding => keys.has(JSON.stringify([binding.botInstanceId,binding.platform,binding.conversationId])))) throw new Error('Conversation is already owned by another BOT or legacy configuration.')
  return { version: 1, files, bindings: [...bindings, ...next.bindings] }
}

export function assertBotCompilation(bundle: ResourceBundle): void {
  const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable)}]` : value && typeof value === 'object'
    ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}` : JSON.stringify(value)
  // Preserve the original single-directory envelope unchanged for retained legacy releases.
  if (bundle.files['bot/BOT.md']) {
    const source = Object.fromEntries(Object.entries(bundle.files).filter(([p]) => p.startsWith('bot/')).map(([p,t]) => [p.slice(4),t]))
    const compiled = compileBotPackage(source)
    const id = botManifest.parse(parseFrontmatter(source['BOT.md']!).frontmatter).name
    compiled.files = Object.fromEntries(Object.entries(compiled.files).map(([p,t]) => [p.replace(`bot/${id}/`, 'bot/'),t]))
    if (stable(compiled) !== stable(bundle)) throw new Error('BOT source and compiled runtime resources differ.')
    return
  }
  const covered = new Set<string>()
  for (const compiled of botPackages(bundle).values()) {
    for (const [path,text] of Object.entries(compiled.files)) {
      if (covered.has(path) || bundle.files[path] !== text) throw new Error('BOT source and compiled runtime resources differ or collide.')
      covered.add(path)
    }
    for (const binding of compiled.bindings) if (!bundle.bindings.some(item => stable(item) === stable(binding))) throw new Error('BOT binding differs from its frozen source.')
    const agents = new Set(Object.keys(compiled.files).filter(p=>p.startsWith('agents/')).map(p=>p.split('/')[1]))
    if (bundle.bindings.some(b => agents.has(b.agent) && !compiled.bindings.some(item => stable(item) === stable(b)))) throw new Error('BOT binding is not declared in frozen source.')
  }
  if (Object.keys(bundle.files).some(path => path.startsWith('bot/') && !covered.has(path))) throw new Error('Unknown BOT source namespace.')
}
