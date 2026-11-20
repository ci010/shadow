import { allowedWorkspaceReadSegment, cleanResourceSegment } from '../bots/read-scope.ts'
import { assertServiceGlob, matchesServiceGlob } from '../bots/service-glob.ts'
/** Fixed host-owned reader, not a script runtime or an Agent execution capability. */
import * as fs from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

export const SourceReadOperationSchema = z.object({
  path:z.string().max(2048).optional(),query:z.string().min(1).max(1000).optional(),
  mode:z.enum(['names','content','glob']).optional(),offset:z.number().int().min(1).max(1_000_000).optional(),
  limit:z.number().int().min(1).max(500).optional(),
}).strict()
export const SourceReadProfile = z.enum(['source', 'workspace'])
export type SourceReadProfile = z.infer<typeof SourceReadProfile>
export type SourceReadOperation = z.infer<typeof SourceReadOperationSchema>
const excluded = /^(?:node_modules|vendor|dist|build|coverage|target|workspace|uploads|temp_adapter_qq|temp_botpy)$|(?:secret|credential|private[-_]?key|token|password|oauth|keystore)|^(?:bot\.config|config\.local|settings\.(?:xml|json)|auth\.(?:json|ya?ml)|id_[a-z0-9]+$)/i
const text = /\.(?:[cm]?[jt]sx?|vue|svelte|html|css|scss|less|md|txt|rs|go|py|java|kt|c|h|cpp|hpp|cs|swift|sh|ya?ml|json|toml|xml|gradle)$/i
const maxFile=256_000,maxEntries=10_000,maxScan=8_000_000
function parts(path:string, profile: SourceReadProfile = 'source') {
  if(isAbsolute(path)||path.includes('\\')||path.includes('\0')) throw new Error('Invalid source path.')
  const segments=path?path.split('/'):[]
  if(segments.some(part => profile === 'workspace' ? !allowedWorkspaceReadSegment(part) : !cleanResourceSegment(part) || part.startsWith('.') || excluded.test(part) || /\.(?:pem|key|p12|pfx|keystore|env)$/i.test(part))) throw new Error('Source path is excluded.')
  return segments
}

/** Node lacks openat on macOS. This isolated process pins its cwd at each component:
 * open basename O_NOFOLLOW, chdir basename, then verify cwd is the opened directory.
 * A rename/symlink race can fail the operation but cannot redirect a subsequent read.
 * Main never changes cwd. No source file is evaluated, imported or executed.
 */
export function enterSourceDirectory(root:string,relative='', profile: SourceReadProfile = 'source') {
  if(!['darwin','linux'].includes(process.platform)||!fs.constants.O_NOFOLLOW||!fs.constants.O_DIRECTORY) throw new Error('Safe source reads are unsupported on this platform.')
  if(!isAbsolute(root)||root.includes('\0')||root.includes('\\')) throw new Error('Invalid registered source root.')
  const segments=[...root.split('/').filter(Boolean),...parts(relative, profile)]
  if(segments.some(part=>part==='.'||part==='..')) throw new Error('Invalid source root.')
  process.chdir('/')
  for(const name of segments) {
    const fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_DIRECTORY)
    try {
      const expected=fs.fstatSync(fd)
      process.chdir(name)
      const actual=fs.statSync('.')
      if(!expected.isDirectory()||expected.dev!==actual.dev||expected.ino!==actual.ino) throw new Error('Source directory changed during traversal.')
    } finally {fs.closeSync(fd)}
  }
}

export function readSourceResource(root:string,raw:unknown, profile: SourceReadProfile = 'source') {
  const operation=SourceReadOperationSchema.parse(raw)
  const fileLimit = profile === 'workspace' ? 256 * 1024 : maxFile
  const enter = (relative: string) => enterSourceDirectory(root, relative, profile)
  const read=(relative:string) => {
    const segments=parts(relative, profile),name=segments.pop()
    if(!name || profile === 'source' && !text.test(name)) throw new Error('Not an approved source text file.')
    enter(segments.join('/'))
    const fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK)
    try {
      const stat=fs.fstatSync(fd)
      if(!stat.isFile()||stat.nlink!==1||stat.size>fileLimit) throw new Error('Source file unavailable or too large.')
      const bytes = Buffer.alloc(fileLimit + 1)
      let size = 0
      while (size < bytes.length) {
        const count = fs.readSync(fd, bytes, size, bytes.length - size, null)
        if (!count) break
        size += count
      }
      if(size>fileLimit || profile === 'source' && bytes.subarray(0,size).includes(0)) throw new Error('Not a bounded source text file.')
      const content=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size))
      // Credential containers are denied by name; recognizable embedded secret material
      // is denied too. Source access is not a generic arbitrary-text-file grant.
      if(profile === 'source' && /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|(?:ghp_|github_pat_|sk_live_)[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16}|["']?(?:client_secret|access_token|refresh_token|password|passwd|api_key|token|secret|bot_token|botToken|discordToken|authorization)["']?\s*[:=]\s*["'][^"'\n]{8,}["']|<(?:password|passphrase|privateKey)>[^<]+</i.test(content)) throw new Error('Credential material is excluded from source resources.')
      return content
    } finally {fs.closeSync(fd)}
  }
  const target = operation.path === '.' ? '' : operation.path ?? ''
  const list = (directory: string) => {
    enter(directory)
    const dir = fs.opendirSync('.', { bufferSize: 32 })
    const entries: Array<{ name: string; kind: 'file' | 'directory' }> = []
    let visited = 0, bytes = 0
    try {
      let entry: fs.Dirent | null
      while ((entry = dir.readSync()) !== null) {
        if (++visited > maxEntries || bytes >= maxScan) throw new Error('Folder listing exceeds limits.')
        const name = entry.name, relative = directory ? `${directory}/${name}` : name
        try {
          parts(relative, profile)
          if (entry.isDirectory()) { enter(relative); entries.push({ name, kind: 'directory' }) }
          else if (entry.isFile()) { bytes += Buffer.byteLength(read(relative)); entries.push({ name, kind: 'file' }) }
        } catch { /* Do not advertise excluded, linked or unreadable entries. */ }
      }
    } finally { dir.closeSync() }
    return entries.sort((a, b) => a.name < b.name ? -1 : a.name === b.name ? 0 : 1)
  }
  if (operation.query === undefined) {
    const path = operation.path ?? '', offset = operation.offset ?? 1, limit = operation.limit ?? 200
    let directory = true
    try { enter(target) } catch { directory = false }
    if (directory) {
      const entries = list(target)
      return { path, offset, entries: entries.slice(offset - 1, offset - 1 + limit), totalEntries: entries.length }
    }
    const lines = read(target).split('\n')
    return {path,offset,lines:lines.slice(offset-1,offset-1+limit),totalLines:lines.length}
  }
  if (profile === 'workspace' && operation.mode !== 'glob') {
    const content = read(target), matches: Array<{ path: string; line: number; text: string }> = []
    const limit = Math.min(operation.limit ?? 50, 100), needle = operation.query.toLowerCase()
    for (const [index, line] of content.split('\n').entries()) {
      if (line.toLowerCase().includes(needle)) matches.push({ path: target, line: index + 1, text: line.slice(0, 2000) })
      if (matches.length > limit) break
    }
    return { matches: matches.slice(0, limit), truncated: matches.length > limit, notice: 'Bounded single-file search.' }
  }
  if (profile === 'workspace') {
    assertServiceGlob(operation.query)
    const matches = list(target).filter(entry => matchesServiceGlob(entry.name, operation.query!))
    const limit = Math.min(operation.limit ?? 50, 100)
    return { matches: matches.slice(0, limit).map(entry => ({ path: target ? `${target}/${entry.name}` : entry.name })), truncated: matches.length > limit, notice: 'Bounded immediate directory names.' }
  }
  if (operation.query.length > 200) throw new Error('Source search query exceeds limit.')
  if (operation.mode === 'glob') assertServiceGlob(operation.query)
  const base = target
  const matches:Array<{path:string;line?:number;text?:string}>=[]
  let visited=0,scanned=0,truncated=false
  const limit=Math.min(operation.limit??50,100),needle=operation.query.toLowerCase()
  const walk=(directory:string,depth:number) => {
    if(depth>32) {truncated=true;return}
    enter(directory)
    const dir=fs.opendirSync('.',{bufferSize:32})
    try {
      let entry:fs.Dirent|null
      while((entry=dir.readSync())!==null) {
        if(++visited>maxEntries||scanned>=maxScan||matches.length>=limit) {truncated=true;return}
        const relative=directory?`${directory}/${entry.name}`:entry.name
        try {parts(relative)} catch {continue}
        if(entry.isSymbolicLink()) continue
        if(entry.isDirectory()) {try {walk(relative,depth+1)} catch { /* Changed/unsafe directories are not searched. */ };continue}
        if(!entry.isFile()||!text.test(relative)) continue
        let content:string
        try {content=read(relative)} catch {continue}
        scanned+=Buffer.byteLength(content)
        if (operation.mode === 'glob') {
          if (matchesServiceGlob(base ? relative.slice(base.length + 1) : relative, operation.query!)) matches.push({ path: relative })
        } else if(operation.mode==='names') {
          if(relative.toLowerCase().includes(needle)) matches.push({path:relative})
        } else {
          for(const [index,line] of content.split('\n').entries()) {
            if(line.toLowerCase().includes(needle)) matches.push({path:relative,line:index+1,text:line.slice(0,2000)})
            if(matches.length>=limit) {truncated=true;break}
          }
        }
      }
    } finally {dir.closeSync()}
  }
  walk(base,0)
  return {matches,truncated,notice:'Bounded source-only literal search; excluded files and symlinks are not searched.'}
}
