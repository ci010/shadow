import { fork, type ForkOptions } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { FolderRegistry } from '../folders/registry.ts'
import { SourceReadOperationSchema, type SourceReadOperation } from './source-reader.ts'

const resultSchema=z.union([
  z.object({path:z.string(),offset:z.number(),lines:z.array(z.string()),totalLines:z.number()}).strict(),
  z.object({matches:z.array(z.object({path:z.string(),line:z.number().optional(),text:z.string().optional()}).strict()).max(100),truncated:z.boolean(),notice:z.string()}).strict(),
])

/** Registered Project resource broker. The helper is fixed host code, never a Bot exec grant.
 * No caller executable/script/env/cwd is accepted. Root comes only from the local registry.
 */
export class SourceResources {
  constructor(private readonly folders:FolderRegistry) {}
  validate(ids:readonly string[]) {
    if(ids.length&&!['darwin','linux'].includes(process.platform)) throw new Error('Safe source reads are unsupported on this platform.')
    for(const id of ids) {
      const folder=this.folders.get(id)
      if(!folder||folder.kind==='remote'||realpathSync(folder.path)!==resolve(folder.path)||!lstatSync(folder.path).isDirectory()) throw new Error('Registered local source folder unavailable.')
    }
  }
  async run(ids:readonly string[],id:string,raw:SourceReadOperation,signal:AbortSignal) {
    const release=this.folders.acquireAccess()
    try {
      signal.throwIfAborted()
      if(!ids.includes(id)) throw new Error('Source folder is outside the approved scope.')
      this.validate([id])
      const root=this.folders.get(id)!.path,operation=SourceReadOperationSchema.parse(raw)
      const result=await new Promise<z.infer<typeof resultSchema>>((resolveResult,reject)=>{
        const extension=import.meta.url.endsWith('.ts')?'ts':'js'
        const forkOptions:ForkOptions & {windowsHide:boolean}={
          execArgv:['--max-old-space-size=64'],env:process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{},
          cwd:'/',stdio:['ignore','ignore','ignore','ipc'],serialization:'json',windowsHide:true,
        }
        const child=fork(new URL(`./source-reader-process.${extension}`,import.meta.url),[],forkOptions)
        let result:z.infer<typeof resultSchema>|undefined,error:Error|undefined
        const stop=(reason:Error)=>{error??=reason;child.kill('SIGKILL')}
        const abort=()=>stop(new Error('Source read aborted.'))
        const timer=setTimeout(()=>stop(new Error('Source read timed out.')),5000)
        signal.addEventListener('abort',abort,{once:true})
        child.once('error',()=>stop(new Error('Source reader unavailable.')))
        child.once('message',raw=>{
          try {
            if(Buffer.byteLength(JSON.stringify(raw))>1_000_000) throw new Error('Source output limit exceeded.')
            const packet=z.object({ok:z.literal(true),result:resultSchema}).strict().parse(raw)
            result=packet.result
          } catch {stop(new Error('Source resource unavailable, excluded or unsafe.'))}
        })
        child.once('close',code=>{
          clearTimeout(timer);signal.removeEventListener('abort',abort)
          if(error||code!==0||!result) reject(error??new Error('Source reader failed.'))
          else resolveResult(result)
        })
        if(signal.aborted) abort()
        else child.send({root,operation},error=>{if(error) stop(new Error('Source reader unavailable.'))})
      })
      signal.throwIfAborted()
      if(this.folders.get(id)?.path!==root||!ids.includes(id)) throw new Error('Source registration or scope changed.')
      this.validate([id])
      return {folderId:id,...result}
    } finally {release()}
  }
}
