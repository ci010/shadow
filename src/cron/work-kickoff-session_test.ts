import assert from 'node:assert/strict'
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { buildUserChatMessage } from '../agent/message-builder.ts'
import { Bus } from '../bus/bus.ts'
import { InitiativeStore } from '../initiatives/store.ts'
import type { WorkRecord } from '../initiatives/work-contract.ts'
import type { ChatMessage } from '../providers/provider.ts'
import { localFolderWorkdirRef, type WorkdirRefV2 } from '../sessions/locality.ts'
import { SessionManager, type SessionManagerDeps } from '../sessions/session-manager.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import { WorkAlignment } from '../sessions/work-alignment.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { Tools } from '../tools/registry.ts'
import { WORK_DISPATCH_AUTOMATION } from './defaults.ts'
import { WorkDispatcher } from './work-dispatch.ts'
import { WORK_DISPATCH_ID, workDispatchConfigSchema } from './work-dispatch-contract.ts'

const config = workDispatchConfigSchema.parse({ kind: 'work-dispatch', folderId: 'source' })
const job = { ...WORK_DISPATCH_AUTOMATION, program: config, id: WORK_DISPATCH_ID, createdAt: new Date().toISOString() }
const human = { kind: 'user' as const }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000
  while (!check()) { assert.ok(Date.now() < deadline, 'fixture timed out'); await delay(10) }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  async function fixture(home: string, run: (f: Awaited<ReturnType<typeof start>>, restart: () => Promise<Awaited<ReturnType<typeof start>>>, requests: ChatMessage[][]) => Promise<void>) {
    const directory = join(home, 'sessions'), requests: ChatMessage[][] = []
    let instructions = 'Original exact instructions, captured at acceptance'
    let capacity = config.maxConcurrent
    let firstInference: Promise<void> | undefined
    let isolationAvailable = true
    async function start() {
      const history = new Store(directory)
      await history.init()
      const bus = new Bus()
      const tools = new Tools(home)
      const manager = new SessionManager({ workspace: home, projectId: 'fixture', store: history, bus, tools,
        provider: { name: 'fixture', chat: async (messages: ChatMessage[]) => {
          requests.push(messages)
          if (requests.length === 1) await firstInference
          return { content: 'Synthetic result', toolCalls: [] }
        } },
        ownsFolder: (id: string) => id === 'isolated',
        ownsWorkdir: (ref: WorkdirRefV2) => ref.workdirId === localFolderWorkdirRef('isolated').workdirId,
        workdirLookup: () => ({ node: 'online', workdir: { online: true, path: home } }),
        backgroundTasks: { listTasks: () => [] },
        agentTypes: { resolve: (name: string) => ({ name, description: '', prompt: '', source: 'builtin', defaultMode: 'session' }) },
        context: { buildSystemPromptDetails: async () => ({ systemPrompt: 'Fixture system', sections: [] }) },
        handoffManager: { shouldHandoff: () => false, getContextPolicy: () => undefined },
        getLlmRuntimeConfig: () => ({ model: 'fixture', contextWindow: 128000, temperature: 0 }),
      } as unknown as SessionManagerDeps)
      const inbox = new InitiativeStore(home, { isSessionKnown: id => !!manager.getSessionState(id) })
      const alignment = new WorkAlignment(inbox, { projectId: 'fixture', state: id => manager.getSessionState(id), changed: async () => {},
        wakeWorkNotifications: () => manager.recoverWorkNotifications() })
      manager.alignment = alignment
      const dispatcher = new WorkDispatcher({ projectId: 'fixture', store: inbox, sessions: manager,
        validateTarget: async () => {}, prepare: async () => ({ folderId: 'isolated', path: home, branch: 'shadow/exact' }),
        verify: async () => {
          await delay(1) // the owning-device verification is asynchronous
          if (!isolationAvailable) throw new Error('Owning worktree disappeared/replaced')
        }, changed: async () => {}, workerInstructions: async () => instructions,
        capacityPolicy: () => ({ maxConcurrent: capacity, maxConcurrentPerDevice: capacity }) })
      bus.on('session.turn.finished', fact => dispatcher.finished(fact))
      await manager.start()
      const wake = manager.wakeAutomaticWorkKickoffs.bind(manager)
      const claimWithoutWake = async () => {
        const work = await alignment.execute(human, 'create', undefined, undefined,
          { title: 'Synthetic kickoff', definition: 'Observe only' }) as WorkRecord
        manager.wakeAutomaticWorkKickoffs = () => {}
        try {
          const claimed = await dispatcher.dispatchWork(job, work.key, work.sequence, {}, new AbortController().signal)
          const entry = inbox.workKickoff(claimed.automaticExecution!.inputId)!
          assert.equal(entry.state, 'pending')
          assert.equal(claimed.automaticExecution!.stage, 'claimed')
          assert.equal(manager.getSessionState(entry.target)?.executionStatus, 'pending')
          return { claimed, entry }
        } finally { manager.wakeAutomaticWorkKickoffs = wake }
      }
      return { history, bus, manager, inbox, alignment, dispatcher, claimWithoutWake, wake,
        holdFirstInference: (gate: Promise<void>) => { firstInference = gate },
        limit: (limit: number) => { capacity = limit },
        isolation: (available: boolean) => { isolationAvailable = available },
        close: async () => { await manager.stop(); history.close?.(); inbox.close() } }
    }
    let active = await start()
    try {
      await run(active, async () => {
        await active.close()
        instructions = 'New instructions must not reconstruct an accepted kickoff'
        active = await start()
        await active.manager.recoverAutomaticWorkKickoffs()
        await active.dispatcher.recover()
        return active
      }, requests)
    } finally { await active.close() }
  }

  test(`${Store.name}: a queued comment cannot overtake the accepted automatic kickoff`, async () => withTempWorkspace(home => fixture(home, async (f, _restart, requests) => {
    const { entry } = await f.claimWithoutWake()
    const worker = 'web:commenter'
    await f.manager.buildSession(worker, undefined, { mode: 'session' })
    const work = await f.alignment.execute({ kind: 'session', sessionId: entry.target }, 'create', undefined, undefined,
      { title: 'Separate managed Work', definition: 'Observe only', assignee: worker }) as WorkRecord
    const receipt = await f.alignment.createWorkNote(worker, { workKey: work.key, body: 'Note to automatic manager', notifyManager: true })
    assert.equal(receipt.notification, 'queued')
    assert.equal(f.inbox.workKickoff(entry.input.id)?.state, 'pending')
    assert.deepEqual(f.inbox.pendingWorkNotifications(entry.target).map(notice => notice.id), [`note:${receipt.note.id}`])
    assert.equal(requests.length, 0)
    f.wake()
    await until(() => requests.length >= 2 && !f.inbox.pendingWorkNotifications(entry.target).length)
    assert.match(JSON.stringify(requests[0]), /Original exact instructions/)
    assert(!JSON.stringify(requests[0]).includes(receipt.note.id))
    assert(JSON.stringify(requests[1]).includes(`/comments/id/${receipt.note.id}`))
    const physical = SessionManager.currentPhysicalId(f.manager.getSessionState(entry.target)!)
    const history = await Array.fromAsync(f.history.readSessionLog(physical, { strict: true }))
    const kickoff = history.findIndex(row => row.work_kickoff)
    const comment = history.findIndex(row => row.name === '__work_notification__')
    assert(kickoff >= 0 && kickoff < comment)
  })))

  for (const phase of ['committed', 'stamped', 'appended', 'settled', 'tools'] as const) {
    test(`${Store.name}: restart at ${phase} preserves exact inbox and reconciles across physical segments`, async () => withTempWorkspace(home => fixture(home, async (f, restart, requests) => {
      const { entry } = await f.claimWithoutWake()
      const state = f.manager.getSessionState(entry.target)!
      const first = SessionManager.currentPhysicalId(state)
      let current = first
      if (phase !== 'committed') {
        f.inbox.stampWorkKickoff(entry.input.id, first)
        if (phase !== 'stamped') {
          const message = await buildUserChatMessage(entry.input, home, home)
          await f.history.appendMessages(first, [{ ...message, timestamp: entry.input.timestamp,
            work_kickoff: { id: entry.input.id, key: entry.key, target: entry.target, revision: entry.revision } }])
          if (phase === 'settled' || phase === 'tools') f.inbox.recordWorkKickoff(entry.input.id, first)
          if (phase === 'tools') {
            await f.history.appendMessages(first, [{ role: 'assistant', content: null, timestamp: entry.input.timestamp,
              tool_calls: [{ id: 'tool-uncertain', type: 'function', function: { name: 'uncertain', arguments: '{}' } }] }])
          }
        }
        if (phase !== 'settled' && phase !== 'tools') {
          const nextState = { ...state, segmentIndex: state.segmentIndex + 1 }
          current = SessionManager.currentPhysicalId(nextState)
          await f.history.createSessionLog(current, [{ sessionId: state.sessionId, previous_physical_id: first, timestamp: entry.input.timestamp }])
          await f.history.saveState(entry.target, nextState)
        }
      }
      const recovered = await restart()
      assert.deepEqual(recovered.inbox.workKickoff(entry.input.id)?.input, entry.input)
      const shouldRun = phase === 'committed' || phase === 'stamped'
      assert.equal(recovered.inbox.workKickoff(entry.input.id)?.state, shouldRun ? 'pending' : 'recorded')
      if (!shouldRun) assert.equal(recovered.alignment.get(entry.key).status, 'blocked')
      if (phase === 'settled') assert.equal(recovered.manager.getSessionRecovery(entry.target)?.pendingToolCalls, 0)
      if (phase === 'tools') {
        const recovery = recovered.manager.getSessionRecovery(entry.target)!
        assert.equal(recovery.pendingToolCalls, 1)
        await assert.rejects(recovered.manager.resumeSession(entry.target, recovery.id), /Confirm that unfinished tools may run again/)
      }
      recovered.wake(); recovered.wake(); recovered.wake()
      if (shouldRun) await until(() => requests.length === 1 && !recovered.manager.isSessionBusy(entry.target))
      else await delay(40)
      assert.equal(requests.length, shouldRun ? 1 : 0)
      if (shouldRun) {
        assert.match(JSON.stringify(requests[0]), /Original exact instructions/)
        assert.doesNotMatch(JSON.stringify(requests[0]), /New instructions must not reconstruct/)
      }
      let markers = 0
      for (const id of new Set([first, current])) for await (const row of recovered.history.readSessionLog(id, { strict: true })) {
        if (row.work_kickoff) { markers++; assert.equal((row.work_kickoff as { id: string }).id, entry.input.id) }
      }
      assert.equal(markers, 1)
    })))
  }

  test(`${Store.name}: failed append does not infer or leave an unsaved copy; retry uses the exact input once`, async () => withTempWorkspace(home => fixture(home, async (f, _restart, requests) => {
    const { entry } = await f.claimWithoutWake()
    await assert.rejects(f.manager.deliver(entry.target, entry.input), /Project inbox drain/)
    const append = f.history.appendMessages.bind(f.history)
    let failed = false
    f.history.appendMessages = async (id, messages) => {
      if (messages.some(message => message.work_kickoff)) { failed = true; throw new Error('injected append failure') }
      await append(id, messages)
    }
    f.wake()
    await until(() => failed && !f.manager.isSessionBusy(entry.target))
    assert.equal(requests.length, 0)
    assert.equal(f.inbox.workKickoff(entry.input.id)?.state, 'pending')
    f.history.appendMessages = append
    // The bounded transient retry wakes itself without a new dispatch.
    await until(() => requests.length === 1 && !f.manager.isSessionBusy(entry.target))
    assert.equal(requests[0].filter(message => JSON.stringify(message.content).includes(entry.input.content.split('\n')[0])).length, 1)
    assert.equal(f.inbox.workKickoff(entry.input.id)?.state, 'recorded')
  })))

  test(`${Store.name}: an uncertain append with a complete row reconciles in place, never retries inference`, async () => withTempWorkspace(home => fixture(home, async (f, _restart, requests) => {
    const { entry } = await f.claimWithoutWake()
    const append = f.history.appendMessages.bind(f.history)
    let wrote = false
    f.history.appendMessages = async (id, messages) => {
      await append(id, messages)
      if (messages.some(message => message.work_kickoff)) { wrote = true; throw new Error('injected failure after append') }
    }
    f.wake()
    await until(() => wrote && !f.manager.isSessionBusy(entry.target))
    assert.equal(requests.length, 0)
    assert.equal(f.inbox.workKickoff(entry.input.id)?.state, 'pending')
    f.history.appendMessages = append
    f.wake()
    await until(() => f.alignment.get(entry.key).status === 'blocked')
    assert.equal(f.inbox.workKickoff(entry.input.id)?.state, 'recorded')
    assert.ok(f.manager.getSessionRecovery(entry.target))
    assert.equal(requests.length, 0)
    let markers = 0
    for await (const row of f.history.readSessionLog(SessionManager.currentPhysicalId(f.manager.getSessionState(entry.target)!))) {
      if (row.work_kickoff) markers++
    }
    assert.equal(markers, 1)
  })))

  for (const phase of ['append-in-flight', 'before-inference'] as const) {
    test(`${Store.name}: release at ${phase} can leave one historical row but cannot start stale inference`, async () => withTempWorkspace(home => fixture(home, async (f, _restart, requests) => {
      const { entry } = await f.claimWithoutWake()
      const release = () => {
        const record = f.alignment.get(entry.key)
        f.inbox.saveWork({ ...record, sequence: record.sequence + 1, assignee: null,
          automaticExecution: undefined, assignmentRevision: record.assignmentRevision + 1 }, record.sequence, 'user', 'assignment')
      }
      if (phase === 'append-in-flight') {
        const append = f.history.appendMessages.bind(f.history)
        f.history.appendMessages = async (id, messages) => {
          await append(id, messages)
          if (messages.some(message => message.work_kickoff)) release()
        }
      } else f.bus.on('session.turn.started', fact => { if (fact.inputId === entry.input.id) release() })
      f.wake()
      await until(() => f.inbox.workKickoff(entry.input.id)?.state === 'invalid' && !f.manager.isSessionBusy(entry.target))
      assert.equal(requests.length, 0)
      let markers = 0
      for await (const row of f.history.readSessionLog(SessionManager.currentPhysicalId(f.manager.getSessionState(entry.target)!))) {
        if (row.work_kickoff) markers++
      }
      assert.equal(markers, 1)
    })))
  }

  test(`${Store.name}: an in-flight turn holds current capacity; its idle wake drains the next exact input`, async () => withTempWorkspace(home => fixture(home, async (f, _restart, requests) => {
    const first = await f.claimWithoutWake(), second = await f.claimWithoutWake()
    const release = Promise.withResolvers<void>()
    f.holdFirstInference(release.promise)
    f.limit(1)
    try {
      f.wake()
      await until(() => requests.length === 1)
      assert.equal(f.inbox.workKickoff(first.entry.input.id)?.state, 'recorded')
      assert.equal(f.inbox.workKickoff(second.entry.input.id)?.state, 'pending')
      assert.equal(f.alignment.get(first.entry.key).automaticExecution?.stage, 'running')
    } finally { release.resolve() }
    await until(() => requests.length === 2 && !f.manager.isSessionBusy(second.entry.target))
    assert.equal(f.inbox.workKickoff(second.entry.input.id)?.state, 'recorded')
  })))

  for (const phase of ['before-append', 'before-inference'] as const) {
    test(`${Store.name}: owning-device isolation lost ${phase} stops the kickoff`, async () => withTempWorkspace(home => fixture(home, async (f, _restart, requests) => {
      const { entry } = await f.claimWithoutWake()
      let lost = false
      const lose = () => { lost = true; f.isolation(false) }
      if (phase === 'before-append') f.bus.on('session.input.accepted', fact => { if (fact.input.id === entry.input.id) lose() })
      else f.bus.on('session.turn.started', fact => { if (fact.inputId === entry.input.id) lose() })
      f.wake()
      await until(() => lost && !f.manager.isSessionBusy(entry.target))
      assert.equal(requests.length, 0)
      let markers = 0
      for await (const row of f.history.readSessionLog(SessionManager.currentPhysicalId(f.manager.getSessionState(entry.target)!))) {
        if (row.work_kickoff) markers++
      }
      assert.equal(markers, phase === 'before-append' ? 0 : 1)
      if (phase === 'before-inference') {
        assert.match(f.alignment.get(entry.key).blockedReason!, /Owning worktree disappeared\/replaced/)
        assert.equal(f.inbox.workKickoff(entry.input.id)?.state, 'recorded')
      } else assert.equal(f.inbox.workKickoff(entry.input.id)?.state, 'pending')
    })))
  }

  test(`${Store.name}: ambiguous duplicate kickoff history is quarantined across restart`, async () => withTempWorkspace(home => fixture(home, async (f, restart, requests) => {
    const { entry } = await f.claimWithoutWake()
    const id = SessionManager.currentPhysicalId(f.manager.getSessionState(entry.target)!)
    f.inbox.stampWorkKickoff(entry.input.id, id)
    const row = { ...await buildUserChatMessage(entry.input, home, home), timestamp: entry.input.timestamp,
      work_kickoff: { id: entry.input.id, key: entry.key, target: entry.target, revision: entry.revision } }
    await f.history.appendMessages(id, [row, row])
    const recovered = await restart()
    let scans = 0
    const read = recovered.history.readSessionLog.bind(recovered.history)
    recovered.history.readSessionLog = (physical, options) => { if (options?.strict) scans++; return read(physical, options) }
    recovered.wake(); recovered.wake()
    await recovered.manager.recoverAutomaticWorkKickoffs()
    await delay(80)
    assert.equal(scans, 0)
    const receipt = recovered.inbox.workKickoff(entry.input.id)!
    assert.equal(receipt.state, 'inspect')
    assert.deepEqual(receipt.input, entry.input)
    const work = recovered.alignment.get(entry.key)
    assert.equal(work.status, 'blocked')
    assert.match(work.blockedReason!, /Ambiguous automatic kickoff history/)
    await assert.rejects(recovered.dispatcher.resume(work.key, work.sequence, new AbortController().signal, true), /cannot be replayed or resumed/)
    assert.equal(requests.length, 0)
  })))

  test(`${Store.name}: missing canonical executor is quarantined without recreating a session`, async () => withTempWorkspace(home => fixture(home, async (f, restart, requests) => {
    const { entry } = await f.claimWithoutWake()
    await f.history.deleteState(entry.target)
    const recovered = await restart()
    recovered.wake()
    await delay(80)
    assert.equal(recovered.manager.getSessionState(entry.target), null)
    assert.equal(recovered.inbox.workKickoff(entry.input.id)?.state, 'inspect')
    assert.match(recovered.alignment.get(entry.key).blockedReason!, /Canonical Project executor is missing/)
    await assert.rejects(recovered.manager.deliver(entry.target, { ...entry.input, id: 'ordinary-followup' }), /delivery cannot recreate it/)
    assert.equal(recovered.manager.getSessionState(entry.target), null)
    assert.equal(requests.length, 0)
  })))

  if (Store === JsonlSessionStore) {
    test('JSONL torn history is quarantined, not polled or replayed after restart', async () => withTempWorkspace(home => fixture(home, async (f, restart, requests) => {
      const { entry } = await f.claimWithoutWake()
      const physicalId = SessionManager.currentPhysicalId(f.manager.getSessionState(entry.target)!)
      f.inbox.stampWorkKickoff(entry.input.id, physicalId)
      const directory = join(home, 'sessions')
      const file = (await readdir(directory, { recursive: true })).find(name => name.endsWith('.jsonl'))!
      const path = join(directory, file)
      const complete = await readFile(path)
      await appendFile(path, '{"role":"user","work_kickoff":')
      const torn = await readFile(path)
      assert.equal(file, `${physicalId}.jsonl`)
      f.wake()
      await until(() => f.inbox.workKickoff(entry.input.id)?.state === 'inspect')
      const recovered = await restart()
      let drainScans = 0
      const pending = recovered.inbox.pendingWorkKickoffs.bind(recovered.inbox)
      recovered.inbox.pendingWorkKickoffs = () => { drainScans++; return pending() }
      recovered.wake()
      await delay(5200) // cross the former perpetual five-second retry interval
      assert.equal(drainScans, 1)
      assert.deepEqual(await readFile(path), torn)
      assert.equal(requests.length, 0)
      assert.deepEqual(recovered.inbox.workKickoff(entry.input.id)?.input, entry.input)
      assert.match(recovered.alignment.get(entry.key).blockedReason!, /torn session log/)
      await writeFile(path, complete) // fixture repairs the bytes; quarantine remains explicit
      await recovered.manager.recoverAutomaticWorkKickoffs()
      const work = recovered.alignment.get(entry.key)
      await assert.rejects(recovered.dispatcher.resume(work.key, work.sequence, new AbortController().signal, true), /cannot be replayed or resumed/)
      const next = { ...entry.input, id: 'ordinary-followup' }
      await assert.rejects(recovered.manager.deliver(entry.target, next), /cannot be replayed or resumed/)
      assert.equal((await readFile(path)).compare(complete), 0)
    })))
  }
}
