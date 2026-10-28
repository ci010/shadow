import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Bus } from '../bus/bus.ts'
import type { ChatMessage, LLMProvider } from '../providers/provider.ts'
import { Tools } from '../tools/registry.ts'
import { FolderRegistry } from '../folders/registry.ts'
import { CapabilityBroker } from '../agent-authoring/capabilities.ts'
import { ProposalInboxes } from './proposal-inbox.ts'
import { TopicService } from './topics.ts'
import { SessionManager, type SessionManagerDeps } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: first proposal creates durable inbox with real host setup; restart reuse and deleted replacement`, async () => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const home = await mkdtemp(resolve('.tmp', 'proposal-context-'))
    const bus = new Bus(), store = new Store(join(home, 'sessions'))
    const folders = new FolderRegistry(home)
    let calls = 0
    const captured: ChatMessage[][] = []
    const provider: LLMProvider = { name: 'fixture', listModels: () => ['fixture'], chat: async messages => {
      calls++; captured.push(structuredClone(messages)); return { content: 'Proposal noted; no work dispatched.', toolCalls: [], finishReason: 'stop' }
    } }
    const makeSessions = () => new SessionManager({ projectId: 'fixture-project', workspace: home, store, bus,
      tools: new Tools(home), provider, context: { buildSystemPrompt: async () => 'Synthetic context' },
      handoffManager: { shouldHandoff: () => false },
      agentTypes: { resolve: () => ({ name: 'general', description: '', prompt: '', defaultMode: 'session', source: 'builtin' }) },
      getLlmRuntimeConfig: () => ({ model: 'fixture', contextWindow: 100000, temperature: 0 }),
    } as unknown as SessionManagerDeps)
    let sessions = makeSessions()
    try {
      await store.init(); await folders.init(); await sessions.start()
      const topics = new TopicService({ projectId: 'fixture-project', sessions, folders,
        listStates: async () => sessions.listSessions(), resolveAgent: () => ({ defaultMode: 'session' }), changed: () => {} })
      const inboxes = new ProposalInboxes({ projectId: 'fixture-project', directory: join(home, 'inboxes'), topics, sessions })
      const input = { repository: 'voxelum/x-minecraft-launcher' }
      assert.equal((await inboxes.status('issue-triage')).phase, 'unbound')
      assert.equal(calls, 0)
      await sessions.buildSession('fixture-bot', undefined, { mode: 'session' })
      await sessions.buildSession('fixture-bot-2', undefined, { mode: 'session' })
      let publicValid = false, finished = 0
      const completed = Promise.withResolvers<void>()
      bus.on('session.turn.finished', fact => { if (fact.sessionId.startsWith('web:chat-')) { assert.equal(fact.status, 'completed'); if (++finished === 2) completed.resolve() } })
      const broker = new CapabilityBroker({ projectId: 'fixture-project', directory: join(home, 'receipts'),
        resolveSecret: async () => { throw Error('Must verify anonymously') },
        request: async () => new Response(JSON.stringify({ number: publicValid ? 7 : -1, html_url: 'https://github.com/voxelum/x-minecraft-launcher/issues/7', title: 'PRIVATE_SENTINEL' })),
        canDeliver: id => sessions.getSessionState(id)?.mode === 'session',
        admitProposalInbox: (name, repository, target, deliver) => inboxes.admit(name, repository, target, deliver),
        resolveProposalInbox: (name, repository, pinned) => inboxes.resolve(name, repository, pinned),
        deliver: (id, payload) => sessions.deliver(id, payload),
      })
      const grant = { id: 'xmcl-coordinator', kind: 'proposal-inbox' as const, inbox: 'issue-triage',
        disclosurePolicy: { kind: 'public-github-issue-proposal' as const, repository: input.repository } }
      const proposal = { issueNumber: 7, suggestedPriority: 'triage', category: 'investigation' }
      const ctx = { sessionId: 'fixture-bot', inputId: randomUUID(), toolCallId: 'fixture-call', bindingKey: 'fixture-binding', revision: 'fixture', signal: new AbortController().signal, assertCurrent() {} }
      await assert.rejects(broker.execute(grant, proposal, ctx), /Public issue verification failed/)
      assert.equal((await inboxes.status('issue-triage')).phase, 'unbound')
      publicValid = true
      const [receipt, other] = await Promise.all([
        broker.execute(grant, proposal, ctx),
        broker.execute(grant, proposal, { ...ctx, sessionId: 'fixture-bot-2', bindingKey: 'other-binding' }),
      ])
      assert.equal((receipt as { sessionId: string }).sessionId, (other as { sessionId: string }).sessionId)
      assert.equal((receipt as {status:string}).status, 'admitted')
      const id = (receipt as { sessionId: string }).sessionId
      assert.equal(await inboxes.resolve('issue-triage', input.repository), id)
      const restarted = new ProposalInboxes({ projectId: 'fixture-project', directory: join(home, 'inboxes'), topics, sessions })
      assert.equal(await restarted.resolve('issue-triage', input.repository), id)
      await completed.promise
      assert.equal(calls, 2)
      const prompt = JSON.stringify(captured[0])
      assert.match(prompt, /Host-recorded explicit owner setup instructions/)
      assert.match(prompt, /deduplicate by repository \+ issue number/)
      assert.match(prompt, /Prioritize before considering work/)
      assert.match(prompt, /reliable sources/)
      assert.match(prompt, /after actual permission and criteria are satisfied/)
      assert.match(prompt, /Untrusted external request/)
      assert.doesNotMatch(prompt, /PRIVATE_SENTINEL/)
      await sessions.stop()
      sessions = makeSessions(); await sessions.start()
      const restoredTopics = new TopicService({ projectId: 'fixture-project', sessions, folders,
        listStates: async () => sessions.listSessions(), resolveAgent: () => ({ defaultMode: 'session' }), changed: () => {} })
      const restored = new ProposalInboxes({ projectId: 'fixture-project', directory: join(home, 'inboxes'), topics: restoredTopics, sessions })
      assert.equal(await restored.resolve('issue-triage', input.repository), id)
      assert.equal(calls, 2)
      await sessions.deleteSession(id)
      const replacement = await restored.resolve('issue-triage', input.repository)
      assert.notEqual(replacement, id)
      assert.equal(calls, 2) // replacement setup alone never infers

    } finally { await sessions.stop(); bus.stopAll(); await store.close?.(); await rm(home, { recursive: true, force: true }) }
  })
}
