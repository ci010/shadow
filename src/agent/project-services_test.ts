import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import { createProjectScope, getProjectScope } from '../projects/scope.ts'
import { MemoryStore } from './memory.ts'
import { IdentityManager } from './identity.ts'
import { memoryProvider } from './context/memory-provider.ts'
import { SkillsManager } from '../skills/loader.ts'
import { AgentTypesManager } from './types/manager.ts'
import { Bus } from '../bus/bus.ts'
import { EventService } from '../events/service.ts'
import { BackgroundTaskManager } from './background-task.ts'
import type { SessionInput } from '../sessions/input.ts'
import { SessionTools, Tools } from '../tools/registry.ts'

async function put(home: string, path: string[], content: string): Promise<void> {
  await mkdir(join(home, ...path.slice(0, -1)), { recursive: true })
  await writeFile(join(home, ...path), content)
}

const skill = (marker: string) => `---\nname: shared\ndescription: ${marker}\n---\n${marker}`
const agent = (marker: string) => `---\nname: shared\ndescription: ${marker}\ndefaultMode: task\n---\n${marker}`

test('same-name projects retain independent memory retrieval, working sets, identity links, learned skills and watcher teardown', async (t) => {
  await withTempWorkspace(async (root) => {
    const homes = [join(root, 'a'), join(root, 'b')]
    const memories = homes.map((home) => new MemoryStore(home))
    const identities = homes.map((home) => new IdentityManager(home))
    const skills = homes.map((home) => new SkillsManager(home))
    const agents = homes.map((home) => new AgentTypesManager(home))
    const day = new Date().toISOString().slice(0, 10)
    try {
      await Promise.all(homes.map(async (home, i) => {
        const marker = i ? 'B_PRIVATE' : 'A_PRIVATE'
        await memories[i].recordModifiedFile('same-session', `${marker}.ts`, 'edit')
        await memories[i].addConvention('project', 'same-folder', marker)
        await identities[i].assignProfile('web', 'same-user', marker, 'same-chat')
        await put(home, ['memory', 'sessions', 'same-session.md'], marker)
        await put(home, ['memory', 'topics', `${marker}.md`], marker)
        await put(home, ['memory', 'events', `${day}.jsonl`], JSON.stringify({
          origin: 'same-other-session', what: marker, when: new Date().toISOString(),
        }) + '\n')
        await skills[i].saveLearnedSkill('shared', skill(marker))
        await put(home, ['agents', 'shared', 'AGENT.md'], agent(marker))
        await Promise.all([skills[i].load(), agents[i].load()])
        skills[i].startWatching()
        agents[i].startWatching()
      }))
      const prompts = await Promise.all(memories.map((memory, i) => memoryProvider(memory, () => 'same-folder').getPromptSection({
        projectId: i ? 'org-b' : 'org-a', sessionId: 'same-session', initiativeId: 'same-folder',
        behavior: {}, channel: 'web', chatId: 'same-chat',
        agent: { name: 'general', description: '', prompt: '', defaultMode: 'session', source: 'builtin' },
      })))
      for (let i = 0; i < homes.length; i++) {
        const own = i ? 'B_PRIVATE' : 'A_PRIVATE'
        const other = i ? 'A_PRIVATE' : 'B_PRIVATE'
        assert.match(prompts[i]!, new RegExp(own))
        assert.doesNotMatch(prompts[i]!, new RegExp(other))
        assert.match(await memories[i].readWorkingSet('same-session'), new RegExp(own))
        assert.match((await identities[i].lookupByAccount('web', 'same-user')).personContext, new RegExp(own))
        assert.equal(skills[i].getSkillBody('shared')?.trim(), own)
        assert.equal(agents[i].resolve('shared')?.prompt.trim(), own)
      }
      const challenge = await identities[0].createLinkChallenge('web', 'same-user', 'web', 'target')
      await assert.rejects(identities[1].confirmLink('web', 'target', challenge.code), /Invalid confirmation code/)
      await identities[0].confirmLink('web', 'target', challenge.code)
      assert.doesNotMatch((await identities[1].lookupByAccount('web', 'target')).personContext, /A_PRIVATE/)
      await assert.rejects(memories[0].addConvention('project', '..\\..\\..\\b', 'escape'), /single directory/)
      await assert.rejects(skills[0].saveLearnedSkill('..\\..\\b\\skills\\escape', 'escape'), /single directory/)
      await assert.rejects(skills[0].getOriginalSkillBody('..\\..\\b\\skills\\shared'), /single directory/)
      await assert.rejects(skills[0].getSkillResource('shared', '..\\..\\..\\b\\skills\\shared\\SKILL.md'), /inside its skill directory/)

      await Promise.all([skills[0].stopWatching(), agents[0].stopWatching()])
      await Promise.all(homes.map(async (home, i) => {
        const marker = i ? 'B_UPDATED' : 'A_STOPPED'
        await skills[i].saveLearnedSkill('shared', skill(marker))
        await put(home, ['agents', 'shared', 'AGENT.md'], agent(marker))
      }))
      await t.waitFor(() => {
        assert.equal(skills[1].getSkillBody('shared')?.trim(), 'B_UPDATED')
        assert.equal(agents[1].resolve('shared')?.prompt.trim(), 'B_UPDATED')
      }, { timeout: 5000 })
      assert.equal(skills[0].getSkillBody('shared')?.trim(), 'A_PRIVATE')
      assert.equal(agents[0].resolve('shared')?.prompt.trim(), 'A_PRIVATE')
      assert.match(await readFile(join(homes[0], 'memory', 'sessions', 'same-session.md'), 'utf8'), /A_PRIVATE/)
      const reloadedIdentity = new IdentityManager(homes[1])
      assert.match((await reloadedIdentity.lookupByAccount('web', 'same-user')).personContext, /B_PRIVATE/)
    } finally {
      await Promise.all([...skills.map((manager) => manager.stopWatching()), ...agents.map((manager) => manager.stopWatching())])
    }
  })
})

test('event debounce and same-session background completions are runtime-bound and stopping one drains only its callbacks', async (t) => {
  await withTempWorkspace(async (root) => {
    const scopes = [createProjectScope('a'), createProjectScope('b')]
    const buses = [new Bus(), new Bus()]
    const received: SessionInput[][] = [[], []]
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const events = scopes.map((scope, i) => new EventService(join(root, String(i)), buses[i], async (sessionId, input) => {
      assert.equal(sessionId, 'same-session')
      assert.equal(getProjectScope(), scope)
      received[i].push(input)
      if (input.kind === 'message' && input.content === 'blocked') await gates[i].promise
      return { status: 'accepted', sessionId, inputId: input.id }
    }, scope))
    const tasks = scopes.map((scope, i) => new BackgroundTaskManager(buses[i], events[i], scope))
    const cancelled = [0, 0]
    try {
      await Promise.all(events.map((service) => service.start()))
      const context = {
        projectId: 'b', sessionId: 'same-session', physicalSessionId: 'same-physical',
        tools: new SessionTools(new Tools(root), root), signal: new AbortController().signal,
        channel: 'test', chatId: 'same-chat', senderId: 'user', messageId: 'same-message',
      }
      assert.throws(() => tasks[0].runToolTask(context.tools, 'fixture', {}, context), /binding mismatch/)
      for (const service of events) service.subscribe({
        sessionId: 'same-session', event: 'fixture', delivery: { urgency: 'debounce', debounceMs: 20 },
      })
      await Promise.all(events.map((service, i) => scopes[1 - i].run(() => service.emit({
        type: 'fixture', source: 'test', content: `private-${i}`,
      }))))
      await t.waitFor(() => assert(received.every((inputs) => inputs.length === 1)))
      assert.equal(received[0][0].kind === 'message' && received[0][0].content, 'private-0')
      assert.equal(received[1][0].kind === 'message' && received[1][0].content, 'private-1')
      const deferred = tasks.map((manager) => manager.createDeferredTask({
        kind: 'subagent', title: 'same-task', sessionId: 'same-session',
        tags: { sessionId: 'same-child' }, callback: { sessionId: 'same-session' },
      }))
      buses[0].emit('session.turn.finished', {
        sessionId: 'same-child', turnId: 'same-turn', inputId: 'same-input',
        source: { kind: 'session', sessionId: 'same-session' }, status: 'completed', content: 'blocked',
      })
      await t.waitFor(() => assert.equal(received[0].length, 2))
      assert.equal(tasks[1].listTasks()[0].status, 'running')
      let stopped = false
      const stopping = tasks[0].stop().then(() => { stopped = true })
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(stopped, false)
      gates[0].resolve()
      await stopping
      deferred[0].complete('must-not-deliver')
      assert.equal(received[0].length, 2)
      deferred[1].complete('B still running')
      await t.waitFor(() => assert.equal(received[1].length, 2))
      assert.equal(received[1][1].kind === 'message' && received[1][1].content, 'B still running')
      assert.throws(() => tasks[0].createDeferredTask({ kind: 'tool', title: 'late' }), /stopped/)

      const running = tasks[1].createDeferredTask({
        kind: 'process', title: 'cancel me', onCancel: () => { cancelled[1]++ },
        callback: { sessionId: 'same-session' },
      })
      await tasks[1].stop()
      await tasks[1].stop()
      running.complete('late result')
      assert.deepEqual(cancelled, [0, 1])
      assert.equal(received[1].length, 2)
      await events[1].emit({ type: 'fixture', source: 'test', content: 'pending' })
      await events[1].stop()
      await new Promise<void>((resolve) => setTimeout(resolve, 35))
      assert.equal(received[1].length, 2)
    } finally {
      gates.forEach((gate) => gate.resolve())
      await Promise.all(tasks.map((manager) => manager.stop()))
      await Promise.all(events.map((service) => service.stop()))
      scopes.forEach((scope) => scope.close())
      buses.forEach((bus) => bus.stopAll())
    }
  })
})
