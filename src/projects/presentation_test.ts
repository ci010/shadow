import assert from 'node:assert/strict'
import test from 'node:test'
import { InitiativeStore } from '../initiatives/store.ts'
import { workRecordSchema } from '../initiatives/work-contract.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { voiceEvidence, voiceGroups } from '../testing/voice-presentation.ts'
import { Bus } from '../bus/bus.ts'
import { createProjectScope } from './scope.ts'
import { WorkOrganizer } from './work-organizer.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { readFile } from 'node:fs/promises'
import { WorkObserver } from './work-observer.ts'
import { projectFocusSnapshotSchema } from './focus-contract.ts'

const work = workRecordSchema.parse({ key: 'topic:web:chat-voice', subject: { kind: 'topic', sessionId: 'web:chat-voice' }, sequence: 1, revision: 1,
  definition: { objective: 'Current: local ASR only', acceptance: [], boundaries: [], evidence: [] }, origin: 'agent_interpretation',
  changedBy: 'work-observer', changedAt: '2026-10-11T00:00:00Z', change: 'understanding', reason: 'fixture', paused: false,
  observation: { sessionId: 'web:chat-voice', observedAt: '2026-10-11T00:00:00Z', sources: [{ id: 'record:0', physicalId: 'voice.1' }] } })

test('semantic organization recovers discarded human discussion, splits outcomes and persists presentation separately', async () => withTempWorkspace(async home => {
  let store = new InitiativeStore(home)
  const scope = createProjectScope('fixture')
  store.saveWork(work, 0, 'fixture', 'created')
  let calls = 0, mode = 'valid', activity = 'before', missing = false
  const observer = new WorkObserver(store, { scope, bus: new Bus(), state: () => ({ lastActivityAt: activity }) as never, changed() {},
    summarize:async()=>{throw new Error('Automatic summarizer must not organize')},
    organize:async(runMode,signal)=>{
      calls++
      const organizer=new WorkOrganizer(store,{projectId:'fixture',activity:()=>activity,changed(){},evidence:async()=>({sources:missing?voiceEvidence.slice(0,3):voiceEvidence,partial:false})})
      const ctx={sessionId:'fixture:organizer',physicalSessionId:'physical',projectId:'fixture',signal,tools:new SessionTools(new Tools(home),home)} as ExecutionContext
      const input=JSON.parse(organizer.begin(ctx.sessionId,runMode,signal))
      try{
        assert.match(input.manifest[0].objective,/local ASR only/)
        let offset:number|null=0,seen:typeof voiceEvidence=[]
        while(offset!==null){const page=JSON.parse(await organizer.read({key:work.key,offset},ctx));seen.push(...page.sources);offset=page.next}
        assert.match(seen[2]!.text,/先放弃/)
        if(mode==='stale')activity='after'
        if(mode==='deleted')missing=true
        const groups=structuredClone(voiceGroups).map(g=>({...g,id:'voice-topic'}))
        if(mode==='invented')groups[0]!.cards[0]!.sources[0]!.id='invented'
        await organizer.patch({patchId:'voice-patch',expectedRevision:store.projectFocus()?.revision??0,groups,hierarchy:[{id:'voice',title:'提升语音能力',purpose:'相关语音目标的展示归纳',groupIds:['voice-topic']}]},ctx)
        await organizer.finish({},ctx)
      }finally{organizer.end()}
    } }, false)
  try {
    assert.equal(calls, 0)
    await observer.organize(new AbortController().signal)
    assert.equal(calls, 1)
    const snapshot = store.projectFocus()!
    assert.deepEqual(snapshot.result.groups.map(({id:_id,...group})=>group), voiceGroups)
    assert.equal(store.workRecords().length, 1, 'presentation never writes execution decomposition')
    assert.equal(snapshot.result.groups[0]!.cards!.length, 2)
    assert.equal(snapshot.result.groups[0]!.cards![0]!.state, 'abandoned')
    assert.match(snapshot.result.groups[0]!.cards![1]!.markdown, /为什么.*做了什么.*如何/s)
    for (const invalid of ['invented', 'stale', 'deleted']) {
      mode = invalid
      await assert.rejects(observer.organize(new AbortController().signal))
      assert.deepEqual(store.projectFocus(), snapshot)
    }
    await observer.stop(); store.close()
    store = new InitiativeStore(home)
    assert.deepEqual(store.projectFocus(), snapshot, 'SQLite safe reopen retains evidence snapshot')
    assert.deepEqual(projectFocusSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot))), snapshot, 'JSON roundtrip retains optional presentation')
  } finally { await observer.stop(); store.close(); scope.close() }
}))

test('presentation rejects wrong physical provenance, delegate-only cards and inferred abandonment', () => {
  const snapshot = { origin: 'model_interpretation', inferredAt: '2026-10-11T00:00:00Z', inputCount: 1, omittedCount: 0,
    sources: [{ key: work.key, sequence: 1 }], evidence: voiceEvidence, result: { groups: voiceGroups } }
  assert(projectFocusSnapshotSchema.safeParse(snapshot).success)
  for (const mutate of [
    (value: typeof voiceGroups) => { value[0]!.cards[0]!.stateSources[0]!.physicalId = 'wrong' },
    (value: typeof voiceGroups) => { value[0]!.cards[0]!.stateSources = [value[0]!.cards[0]!.sources[1]!] },
    (value: typeof voiceGroups) => { value[0]!.cards[0]!.sources = [value[0]!.cards[0]!.sources[1]!]; value[0]!.cards[0]!.stateSources = value[0]!.cards[0]!.sources },
  ]) {
    const groups = structuredClone(voiceGroups); mutate(groups)
    assert(!projectFocusSnapshotSchema.safeParse({ ...snapshot, result: { groups } }).success)
  }
})


test('material autonomous model decision is a distinct goal-anchored card; routine delegate detail stays supporting evidence', async () => withTempWorkspace(async home => {
  const store = new InitiativeStore(home), scope = createProjectScope('fixture')
  store.saveWork(work, 0, 'fixture', 'created')
  const evidence = [...voiceEvidence,
    { sessionId: 'web:chat-voice', physicalId: 'voice.1', id: 'record:1', kind: 'assistant' as const,
      text: '模型选择流式识别架构以降低延迟，代价是缓冲复杂度；把录音与解码能力分开实现。' },
    { sessionId: 'web:chat-voice', physicalId: 'voice.1', id: 'record:2', kind: 'report' as const,
      text: '子任务完成一次检查、重试和修复；测试通过。' },
  ]
  const reference = (index: number) => { const { sessionId, physicalId, id } = evidence[index]!; return { sessionId, physicalId, id } }
  const groups = structuredClone(voiceGroups)
  groups[0]!.cards.push({ id: 'streaming-choice', title: '流式识别架构取舍', state: 'reported_complete',
    markdown: '**模型选择**：降低延迟，接受缓冲复杂度。\n\n**如何**：分开录音和解码能力；检查、重试和修复仅为支撑细节，不代表用户批准。',
    sources: [reference(2), reference(4), reference(5)], stateSources: [reference(4)] })
  const observer = new WorkObserver(store, { scope, bus: new Bus(), state: () => undefined, changed() {},
    summarize:async()=>{throw new Error('Automatic summarizer must not organize')},
    organize:async(runMode,signal)=>{
      const instructions=await readFile(new URL('../agent/types/builtin/work-organizer/AGENT.md',import.meta.url),'utf8')
      assert.match(instructions,/material model choices/)
      assert.match(instructions,/explicitly labelled model/)
      assert.match(instructions,/not worker identifiers, retries or routine checks/)
      const organizer=new WorkOrganizer(store,{projectId:'fixture',activity:()=>'',changed(){},evidence:async()=>({sources:evidence,partial:false})})
      const ctx={sessionId:'fixture:organizer',physicalSessionId:'physical',projectId:'fixture',signal,tools:new SessionTools(new Tools(home),home)} as ExecutionContext
      organizer.begin(ctx.sessionId,runMode,signal)
      try{
        let offset:number|null=0,seen:typeof evidence=[]
        while(offset!==null){const page=JSON.parse(await organizer.read({key:work.key,offset},ctx));seen.push(...page.sources);offset=page.next}
        assert.equal(seen.find(s=>s.id===evidence[4]!.id&&s.physicalId===evidence[4]!.physicalId)!.kind,'assistant');assert.equal(seen.find(s=>s.id===evidence[5]!.id&&s.physicalId===evidence[5]!.physicalId)!.kind,'report')
        await organizer.patch({patchId:'model-choice',expectedRevision:0,groups:groups.map(g=>({...g,id:'voice-topic'})),hierarchy:[{id:'voice',title:'提升语音能力',purpose:'相关语音目标的展示归纳',groupIds:['voice-topic']}]},ctx)
        await organizer.finish({},ctx)
      }finally{organizer.end()}
    } }, false)
  try {
    await observer.organize(new AbortController().signal)
    const snapshot = store.projectFocus()!
    assert.deepEqual(snapshot.result.groups[0]!.cards!.map(card => card.id), ['ime-option', 'local-asr', 'streaming-choice'])
    assert.match(snapshot.result.groups[0]!.cards![2]!.markdown, /模型选择/)
    assert.equal(snapshot.evidence!.find(source => source.id === 'record:2' && source.physicalId === 'voice.1')!.kind, 'report')
    const delegateOnly = structuredClone(groups)
    delegateOnly[0]!.cards[2]!.sources = [reference(4), reference(5)]
    assert(!projectFocusSnapshotSchema.safeParse({ ...snapshot, result: { groups: delegateOnly } }).success)
  } finally { await observer.stop(); store.close(); scope.close() }
}))


test('hierarchy uniquely owns evidence topics, preserves cards and validates bounded acyclic references', () => {
  const groups = [...structuredClone(voiceGroups), { category: '视觉主题', purpose: '阅读清晰', motivation: '视觉归纳', topicKeys: ['appearance'] }]
  const hierarchy = [
    { id: 'voice', title: '提升语音能力', purpose: '语音相关', groupIndexes: [] as number[] },
    { id: 'voice-options', title: '输入方案', purpose: '保留取舍', parentId: 'voice', groupIndexes: [0] },
    { id: 'appearance', title: '提升Shadow视觉外观', purpose: '视觉相关', groupIndexes: [1] },
  ]
  const snapshot = { origin: 'model_interpretation', inferredAt: '2026-10-11T00:00:00Z', inputCount: 2, omittedCount: 0,
    sources: [{ key: work.key, sequence: 1 }, { key: 'appearance', sequence: 1 }], evidence: voiceEvidence, result: { groups, hierarchy } }
  const parsed = projectFocusSnapshotSchema.parse(snapshot)
  assert.deepEqual(parsed.result.groups[0]!.cards, voiceGroups[0]!.cards, 'hierarchy cannot alter evidence or abandoned state')
  const invalid = [
    [...hierarchy, { ...hierarchy[0]! }],
    hierarchy.map(node => node.id === 'voice' ? { ...node, parentId: 'voice-options' } : node),
    hierarchy.map(node => node.id === 'voice-options' ? { ...node, parentId: 'missing' } : node),
    hierarchy.map(node => node.id === 'appearance' ? { ...node, groupIndexes: [0, 1] } : node),
    hierarchy.map(node => node.id === 'appearance' ? { ...node, groupIndexes: [2] } : node),
    hierarchy.filter(node => node.id !== 'appearance'),
    [...hierarchy, { id: 'empty', title: 'empty', purpose: 'empty', groupIndexes: [] }],
    Array.from({ length: 61 }, (_, index) => ({ id: `n${index}`, title: 'bounded', purpose: 'bounded', ...(index ? { parentId: `n${index - 1}` } : {}), groupIndexes: index === 60 ? [0, 1] : [] })),
    Array.from({ length: 5 }, (_, index) => ({ id: `n${index}`, title: 'deep', purpose: 'deep', ...(index ? { parentId: `n${index - 1}` } : {}), groupIndexes: index === 4 ? [0, 1] : [] })),
  ]
  for (const value of invalid) assert(!projectFocusSnapshotSchema.safeParse({ ...snapshot, result: { groups, hierarchy: value } }).success)
  const altered = structuredClone(parsed.result.groups)
  altered[0]!.cards![0]!.stateSources[0]!.physicalId = 'invented'
  assert(!projectFocusSnapshotSchema.safeParse({ ...snapshot, result: { groups: altered, hierarchy } }).success)
  assert(projectFocusSnapshotSchema.safeParse({ ...snapshot, result: { groups } }).success, 'legacy snapshots need no invented inference')
})


test('related visual topics share a purpose root with useful subgroups while unrelated voice stays separate', () => {
  const visual = ['chat-readability', 'reveal-style', 'dashboard-density'].map(key => ({ category: key, purpose: '具体视觉改进', motivation: '展示解释', topicKeys: [key], cards: [] }))
  const groups = [...visual, ...structuredClone(voiceGroups)]
  const hierarchy = [
    { id: 'appearance', title: '提升Shadow视觉外观', purpose: '共同视觉体验', groupIndexes: [] },
    { id: 'readability', title: '提升信息可读性', purpose: '减少信息密度负担', parentId: 'appearance', groupIndexes: [0, 2] },
    { id: 'style', title: '统一视觉风格', purpose: '保持外观一致', parentId: 'appearance', groupIndexes: [1] },
    { id: 'voice', title: '提升语音能力', purpose: '不同目的保持独立', groupIndexes: [3] },
  ]
  const snapshot = { origin: 'model_interpretation', inferredAt: '2026-10-11T00:00:00Z', inputCount: 4, omittedCount: 0,
    sources: [...visual.map(group => ({ key: group.topicKeys[0]!, sequence: 1 })), { key: work.key, sequence: 1 }], evidence: voiceEvidence, result: { groups, hierarchy } }
  const parsed = projectFocusSnapshotSchema.parse(snapshot)
  assert.equal(parsed.result.hierarchy!.filter(node => !node.parentId).length, 2)
  assert.deepEqual(parsed.result.groups[3]!.cards, voiceGroups[0]!.cards)
  const missing = { ...snapshot, inputCount: 5, sources: [...snapshot.sources, { key: 'uncertain-but-retained', sequence: 1 }] }
  assert(!projectFocusSnapshotSchema.safeParse(missing).success, 'cannot silently hide a supplied uncertain topic')
})
