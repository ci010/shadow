/** Fixed host-owned reader, not a script runtime or an Agent execution capability. */
import * as fs from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

export const SourceReadOperationSchema = z.object({
  path:z.string().max(2048).optional(),query:z.string().min(1).max(200).optional(),
  mode:z.enum(['names','content']).optional(),offset:z.number().int().min(1).max(1_000_000).optional(),
  limit:z.number().int().min(1).max(500).optional(),
}).strict()
export type SourceReadOperation = z.infer<typeof SourceReadOperationSchema>
const excluded = /^(?:node_modules|vendor|dist|build|coverage|target|workspace|uploads|temp_adapter_qq|temp_botpy)$|(?:secret|credential|private[-_]?key|token|password|oauth|keystore)|^(?:bot\.config|config\.local|settings\.(?:xml|json)|auth\.(?:json|ya?ml)|id_[a-z0-9]+$)/i
const text = /\.(?:[cm]?[jt]sx?|vue|svelte|html|css|scss|less|md|txt|rs|go|py|java|kt|c|h|cpp|hpp|cs|swift|sh|ya?ml|json|toml|xml|gradle)$/i
const maxFile=256_000,maxEntries=10_000,maxScan=8_000_000
function parts(path:string) {
  if(isAbsolute(path)||path.includes('\\')||path.includes('\0')) throw new Error('Invalid source path.')
  const segments=path?path.split('/'):[]
  if(segments.some(part=>!part||part==='..'||part.startsWith('.')||excluded.test(part)||/\.(?:pem|key|p12|pfx|keystore|env)$/i.test(part))) throw new Error('Source path is excluded.')
  return segments
}

/** Node lacks openat on macOS. This isolated process pins its cwd at each component:
 * open basename O_NOFOLLOW, chdir basename, then verify cwd is the opened directory.
 * A rename/symlink race can fail the operation but cannot redirect a subsequent read.
 * Main never changes cwd. No source file is evaluated, imported or executed.
 */
export function enterSourceDirectory(root:string,relative='') {
  if(!['darwin','linux'].includes(process.platform)||!fs.constants.O_NOFOLLOW||!fs.constants.O_DIRECTORY) throw new Error('Safe source reads are unsupported on this platform.')
  if(!isAbsolute(root)||root.includes('\0')||root.includes('\\')) throw new Error('Invalid registered source root.')
  const segments=[...root.split('/').filter(Boolean),...parts(relative)]
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

export function readSourceResource(root:string,raw:unknown) {
  const operation=SourceReadOperationSchema.parse(raw)
  const read=(relative:string) => {
    const segments=parts(relative),name=segments.pop()
    if(!name||!text.test(name)) throw new Error('Not an approved source text file.')
    enterSourceDirectory(root,segments.join('/'))
    const fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK)
    try {
      const stat=fs.fstatSync(fd)
      if(!stat.isFile()||stat.nlink!==1||stat.size>maxFile) throw new Error('Source file unavailable or too large.')
      const bytes=Buffer.alloc(maxFile+1),size=fs.readSync(fd,bytes,0,bytes.length,0)
      if(size>maxFile||bytes.subarray(0,size).includes(0)) throw new Error('Not a bounded source text file.')
      const content=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size))
      // Credential containers are denied by name; recognizable embedded secret material
      // is denied too. Source access is not a generic arbitrary-text-file grant.
      if(/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|(?:ghp_|github_pat_|sk_live_)[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16}|["']?(?:client_secret|access_token|refresh_token|password|passwd|api_key|token|secret|bot_token|botToken|discordToken|authorization)["']?\s*[:=]\s*["'][^"'\n]{8,}["']|<(?:password|passphrase|privateKey)>[^<]+</i.test(content)) throw new Error('Credential material is excluded from source resources.')
      return content
    } finally {fs.closeSync(fd)}
  }
  if(operation.query===undefined) {
    const path=operation.path??'',lines=read(path).split('\n'),offset=operation.offset??1,limit=operation.limit??200
    return {path,offset,lines:lines.slice(offset-1,offset-1+limit),totalLines:lines.length}
  }
  const matches:Array<{path:string;line?:number;text?:string}>=[]
  let visited=0,scanned=0,truncated=false
  const limit=Math.min(operation.limit??50,100),needle=operation.query.toLowerCase()
  const walk=(directory:string,depth:number) => {
    if(depth>32) {truncated=true;return}
    enterSourceDirectory(root,directory)
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
        if(operation.mode==='names') {
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
  walk(operation.path??'',0)
  return {matches,truncated,notice:'Bounded source-only literal search; excluded files and symlinks are not searched.'}
}
