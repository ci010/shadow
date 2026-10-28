import { classifierExampleFiles } from './input-classifier-examples.ts'
import { InputClassifier } from './input-classifier.ts'
import { ClassifierPolicySchema } from './input-classifier-contract.ts'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { observationExampleFiles } from './input-processor-examples.ts'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { InputProcessor, type ProcessorClock } from './input-processor.ts'

import { processorTypes as sdk } from './input-processor-compiler.ts'

export const processorAuthoringGuide = {
  documentation: 'docs/event-input-processing.md',
  resources: {
    classifierFiles:classifierExampleFiles,
    observationFiles:observationExampleFiles,
    documentation: `File-first input processors (owner local Web only)
Create processor.ts and fixtures.json in your session cwd using the complete content below; repository access is not needed.
Call channel_config with {action:"processor_check",path:"processor.ts"}, then {action:"processor_test",path:"processor.ts",fixturePath:"fixtures.json"}.
Check uses strict TS and requires exported run assignable to Processor. Use the supplied type-only SDK or literal action as const. Relative imports/re-exports with explicit .ts extensions are bundled from a frozen local dependency graph. Host/package imports, dynamic imports and triple-slash directives are forbidden.
Tests use the production restricted worker and InputProcessor with a virtual window clock. Steps input:{key,id,event} and advance:{ms} produce ordered input/publish/error traces, outputs:{at,ids}, and compare optional expected outputs. Window time is virtual; script Date.now and worker deadlines remain real. Invalid source/fixture/path produces diagnostics/tool errors; runtime failure never publishes fallback output.
List bindings with {action:"list"}; propose with {action:"processor_propose",path:"processor.ts",bindingId:"<UUID>",baseRevision:42,delayMs:1000,includeBots:false}. This copies an existing binding and only changes processor; it does not enable or create a binding. Show the returned reviewUrl to the owner for exact human approval. All dependency source bytes/hashes, graph hash, bundled program and its hash are frozen in the reviewed bindings.save proposal; subsequent file edits cannot change it. Proposal alone does not execute or activate code.
Actions: ignore drops; emit immediately publishes the original verified input; buffer retains original items in fixed per-sender/conversation windows, not trailing debounce. Emit does not flush an existing window. Managed adapters with a stable storage ID persist a bounded private inbox and 2000 dedupe IDs. Recovery rechecks host authority before delivery; at-least-once replay is possible after a crash. Failures retry at most three attempts; stop retains durable unacknowledged rows. Existing admission/revision checks remain active. Bot inputs require reviewed includeBots and retain cooldown/self suppression.
Paths are relative to cwd; absolute paths and realpath escapes are denied. UTF-8 TS modules: <=64000 bytes/file, <=32 files and <=128000 total source bytes; bundle <=64000 characters. Dependencies stay inside declared cwd; symlink modules are rejected. Fixtures <=256000 bytes/200 steps. Delay 10..60000 ms. State: run receives {event,state,now}. state is null or a partition-local JSON object; returning state replaces it, omission retains it. The host clock now is fixture-virtual. State is keyed by authority key AND program SHA-256, persists atomically with classification, expires after 10 minutes without replacement, and is limited to 16000 JSON bytes/partition and 100 active partitions; overflow fails closed, never silently evicts cooldowns. No host/network/tool/infer permissions. A separate owner-reviewed observation classifier policy is available: fetch classifier/processor.ts, classifier/policy.json and classifier/fixtures.json. processor_test uses only fake provider responses and reports modelCalls. observation_propose accepts classifier:<strict policy JSON> for exact review; enabled remains false by default. Return classify:true for a two-phase restricted run receiving classification:{label,confidence}. Unknown/low confidence/budget/deadline/revocation never wake. See docs/event-input-processing.md for full budgets and uncertain-billing semantics. observation_propose creates a separately reviewed, default-disabled same-guild channel observation scope on a dedicated restricted tool/domain-free service binding with no participants. Its audience is the binding target. Only this scope service context receives semantic evidence; emit without semantic does not wake it. See observationFiles for a complete standalone multi-file example. Use {action:"observation_propose",path,bindingId,baseRevision,delayMs,guildId,channelIds,enabled:false,includeBots:false}; proposal never approves or activates. Relative source modules are bundled; deployed code has no runtime imports. Legacy inline code remains compatible.
The local workflow is owner-only; it does not grant managed Discord conversations file access.`,
    types: sdk,
    example: `import type { Processor } from '@shadow/input-processor'
export const run: Processor = ({event}) => {
  const text = String(event.data.content ?? '')
  if (text === 'ok') return {action:'ignore'}
  if (text.includes('crypto')) return {action:'emit'}
  return {action:'buffer'}
}
`,
    fixtures: JSON.stringify({delayMs:1000,steps:[
      {kind:'input',key:'alice',id:'1',event:{type:'discord.MESSAGE_CREATE',data:{content:'ok'}}},
      {kind:'input',key:'alice',id:'2',event:{type:'discord.MESSAGE_CREATE',data:{content:'crypto'}}},
      {kind:'input',key:'alice',id:'3',event:{type:'discord.MESSAGE_CREATE',data:{content:'question'}}},
      {kind:'advance',ms:500},
      {kind:'input',key:'alice',id:'4',event:{type:'discord.MESSAGE_CREATE',data:{content:'more'}}},
      {kind:'advance',ms:500},
    ],expected:[{at:0,ids:['2']},{at:1000,ids:['3','4']}]}, null, 2),
  },
  types: 'src/events/input-processor-sdk.ts',
  typeDefinitions: sdk,
  importExample: "import type { Processor } from '@shadow/input-processor'; export const run: Processor = ({event}) => ({action:'ignore'});",
  fixtureFormat: '{delayMs:10..60000,steps:[{kind:"input",key,id,event}|{kind:"advance",ms}],expected?:[{at,ids,semantic?:{type,data}}]}',
  example: 'examples/input-processor/processor.ts',
  fixtures: 'examples/input-processor/fixtures.json',
  actions: ['processor_resource', 'processor_check', 'processor_test', 'processor_propose', 'observation_propose'],
  boundary: 'Owner local session cwd only. Relative paths, no symlink escapes. Multi-file local .ts graph; SDK import is type-only. Frozen dependencies; no runtime host imports, tools, network or arbitrary inference. Optional observation classifier is a separate exact owner-reviewed bounded zero-tool service capability. Bounded partition-local JSON state grants no observation authority by itself. observation_propose drafts an independent explicit scope for owner review, never activation.',
}
export async function readProcessorFile(root: string, filename: string, max = 64_000): Promise<string> {
  if (path.isAbsolute(filename)) throw new Error('Use a relative workspace path')
  const base = await realpath(root)
  const target = await realpath(path.resolve(base, filename))
  const relative = path.relative(base, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path outside workspace')
  if (!(await stat(target)).isFile() || (await stat(target)).size > max) throw new Error('File too large or not regular')
  const bytes = await readFile(target)
  if (bytes.length > max) throw new Error('File too large')
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}
export { compileProcessor as checkProcessor } from './input-processor-compiler.ts'
import { compileProcessor as checkProcessor } from './input-processor-compiler.ts'
const FixtureSchema = z.object({ classifier:z.object({policy:ClassifierPolicySchema,responses:z.array(z.string().max(4096)).max(200)}).strict().optional(), delayMs: z.number().int().min(10).max(60000),
  steps: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('input'), key: z.string(), id: z.string(), event: z.record(z.unknown()) }).strict(),
    z.object({ kind: z.literal('advance'), ms: z.number().int().min(0).max(60000) }).strict(),
  ])).max(200), expected: z.array(z.object({ at: z.number(), ids: z.array(z.string()), semantic:z.object({type:z.string(),data:z.record(z.unknown())}).strict().optional() }).strict()).optional(),
}).strict()
export async function testProcessor(root: string, filename: string, fixturePath: string, signal: AbortSignal) {
  const checked = await checkProcessor(root, filename)
  if (!checked.ok) return { ok: false, diagnostics: checked.diagnostics, trace: [] }
  const fixture = FixtureSchema.parse(JSON.parse(await readProcessorFile(root, fixturePath, 256_000)))
  const directory=mkdtempSync(path.join(realpathSync(tmpdir()),'shadow-classifier-fixture-'))
  let modelCalls=0
  const classifier=fixture.classifier ? new InputClassifier(()=>({name:'fixture',listModels:()=>[fixture.classifier!.policy.model],chat:async()=>{
    const content=fixture.classifier!.responses[modelCalls++] ?? '{"label":"unknown","confidence":0}'
    return {content,toolCalls:[]}
  }}),path.join(directory,'ledger.json'),()=>now) : undefined
  let now = 0
  const timers = new Map<{ unref(): void }, { at: number; callback: () => void }>()
  const clock: ProcessorClock = { now: () => now, setTimeout(callback, delay) { const token = { unref() {} }; timers.set(token, { at: now + delay, callback }); return token }, clearTimeout(token) { timers.delete(token) } }
  const trace: unknown[] = [], outputs: { at: number; ids: string[]; semantic?:{type:string;data:Record<string,unknown>} }[] = []
  let failed = false
  const processor = new InputProcessor<string>(() => { failed = true; trace.push({ at: now, error: 'Window delivery failed' }) }, 100, clock)
  try {
    for (const step of fixture.steps) {
      signal.throwIfAborted()
      if (step.kind === 'advance') {
        const end = now + step.ms
        for (;;) {
          const next = [...timers.entries()].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
          if (!next) break
          now = next[1].at; timers.delete(next[0]); next[1].callback(); await Promise.resolve()
        }
        now = end; trace.push({ at: now, kind: 'advance' })
      } else {
        trace.push({ at: now, kind: 'input', id: step.id })
        try {
          await processor.accept({ ...step, item: step.id, policy: { code: checked.code, delayMs: fixture.delayMs,...(fixture.classifier ? {classifier:fixture.classifier.policy} : {}) }, signal,
            classify: classifier ? signal=>classifier.classify({authority:step.key,eventId:step.id,policy:fixture.classifier!.policy,data:(step.event.data ?? {}) as Record<string,unknown>,signal,authorize:async()=>{}}) : undefined,
            publish: async (ids,_signal,semantic) => { const output = { at: now, ids,...(semantic ? {semantic} : {}) }; outputs.push(output); trace.push({ ...output, kind: 'publish' }) } })
        } catch (error) { failed = true; trace.push({ at: now, id: step.id, error: error instanceof Error ? error.message : String(error) }) }
      }
    }
  } finally { await processor.stop(); rmSync(directory,{recursive:true,force:true}) }
  const matches = !fixture.expected || JSON.stringify(outputs) === JSON.stringify(fixture.expected)
  return { modelCalls, ok: !failed && matches, sha256: checked.sha256, outputs, trace, diagnostics: matches ? [] : ['Outputs differ from fixture.expected'] }
}
