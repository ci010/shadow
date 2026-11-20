/** Fixed one-shot resource helper entrypoint. Not an Agent script or terminal. */
import { z } from 'zod'
import { SourceReadOperationSchema, SourceReadProfile, readSourceResource } from './source-reader.ts'

if(process.send) process.once('message',raw=>{
  try {
    const input=z.object({root:z.string().max(8192),operation:SourceReadOperationSchema,profile:SourceReadProfile.optional()}).strict().parse(raw)
    const result=readSourceResource(input.root,input.operation,input.profile)
    process.send!({ok:true,result},()=>process.disconnect())
  } catch {
    // Do not disclose outside paths, OS diagnostics or credential-bearing content.
    process.send!({ok:false},()=>process.disconnect())
  }
})
