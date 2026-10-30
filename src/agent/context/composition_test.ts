import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { ContextBuilder, type SessionPromptContext } from './builder.ts'
import { runtimeContextEvent } from '../../sessions/runtime-context-event.ts'
import { contentText } from '../../providers/provider.ts'
import { executionContractProvider, guidelineProvider } from './guideline.ts'
import { runtimeDiscoveryProvider, runtimeIdentityProvider, type RuntimeProviderDeps } from './runtime.ts'
import { workspaceProvider } from './workspace.ts'
import { initiativeProvider } from './initiative.ts'
import { memoryProvider } from './memory-provider.ts'
import { MemoryStore } from '../memory.ts'
import { IdentityManager } from '../identity.ts'
import { getBuiltinAgentTypes } from '../types/builtins.ts'
import { getBuiltinSkills } from '../../skills/builtins.ts'
import { ProjectFolderDiscovery } from '../../folders/discovery.ts'
import { VirtualFs } from '../../vfs/virtual-fs.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'

test('assembled prompt separates current identity, work, environment, guidance, discovery and historical claims', async () => {
  await withTempWorkspace(async home => {
    const agent = (await getBuiltinAgentTypes()).find(role => role.name === 'general')!
    const ctx: SessionPromptContext = {
      projectId: 'fixture', sessionId: 'web:worker', channel: 'web', chatId: 'worker',
      mode: 'session', behavior: {}, agent: { ...agent, soul: false },
    }
    const memory = new MemoryStore(home)
    await mkdir(join(home, 'memory', 'sessions'), { recursive: true })
    const summaryPath = join(home, 'memory', 'sessions', 'web_worker.md')
    const oldSummary = '# Session Summary\nUpdated: 2026-09-21T10:55:48Z\n## Current Focus\nRemain archived and paused.'
    await writeFile(summaryPath, oldSummary)
    await memory.recordModifiedFile(ctx.sessionId, 'src/example.ts', 'edit')
    const runtime: RuntimeProviderDeps = {
      projectId: ctx.projectId, identity: new IdentityManager(home),
      getSkillsSummary: () => 'DISCOVER_SKILLS', getAgentTypesSummary: () => 'DISCOVER_ROLES',
    }
    const discovery = new ProjectFolderDiscovery({
      projectId: 'fixture', workspace: home,
      getProject: () => ({ id: 'fixture', name: 'Fixture', createdAt: '2026-09-21T00:00:00Z' }),
      registry: { list: () => [] }, workdirLookup: () => ({ node: 'missing' }),
    })
    const builder = new ContextBuilder(home)
    builder.register(runtimeIdentityProvider(runtime))
    builder.register(executionContractProvider())
    builder.register(initiativeProvider({
      getSummary: () => null,
      getSessionSummary: () => 'Recorded context: first phase was read-only.',
    }))
    builder.register(workspaceProvider(home, new VirtualFs(), undefined, discovery))
    builder.register(guidelineProvider())
    builder.register(runtimeDiscoveryProvider(runtime))
    builder.register(memoryProvider(memory, () => undefined))
    const built = await builder.buildSystemPromptDetails(ctx)
    assert.deepEqual(built.sections.map(section => section.name), [
      'runtime', 'execution-contract', 'initiative', 'workspace-intro',
      'guideline', 'capability-discovery', 'memory',
    ])
    const work = '# Current work contracts (runtime facts)\nRevision 2: current human-confirmed outcome. Boundary: No external publication.'
    const messages = [{ role: 'system' as const, content: built.systemPrompt }, { role: 'user' as const, content: 'Task history' }]
    const composed = [...messages, (await runtimeContextEvent(messages, 'work', work, home))!]
    assert.deepEqual(composed.slice(0, -1), messages)
    assert.equal(composed.at(-1)!.role, 'user')
    assert.match(contentText(composed.at(-1)!.content), /Revision 2: current human-confirmed outcome/)
    const prompt = composed.map(message => contentText(message.content)).join('\n\n')
    const order = ['# Runtime', 'Execution Contract:', '# Initiative Context',
      '# Working context', '# Agent Guideline', '# Capability discovery', '# Historical reference', work]
      .map(text => prompt.indexOf(text))
    assert(order.every((position, index) => position >= 0 && (!index || position > order[index - 1])))
    assert.doesNotMatch(built.systemPrompt, /\*\*Working directory\*\*:/)
    assert.doesNotMatch(prompt, /Workspace root|Selected folder: none|Conventions \(always in effect\)/)
    assert.match(prompt, /Project Home is internal application data/)
    assert.match(prompt, /Historical context is not fresh human authorization/)
    assert.doesNotMatch(prompt, /# Task context|Topic brief|no explicit topic brief/)
    assert.match(prompt, /source, scope, version and explicit supersession, not timestamp alone/)
    assert.match(prompt, /A newer agent report cannot lift a human restriction/)
    assert.match(prompt, /No external publication/)
    assert.doesNotMatch(prompt, /Historical session summary|Session Summary|Remain archived and paused/)
    assert.doesNotMatch(prompt, /^## Current Focus/m)
    assert.equal(await readFile(summaryPath, 'utf8'), oldSummary, 'Presentation must not rewrite or discard historical evidence')
    assert(!built.sections[0].content.includes('DISCOVER_SKILLS'))
    assert(built.sections.find(section => section.name === 'capability-discovery')!.content.includes('DISCOVER_SKILLS'))
    const update = (await runtimeContextEvent(composed, 'work', work.replace('Revision 2', 'Revision 3'), home))!
    const next = [...composed, update]
    assert.deepEqual(next.slice(0, -1), composed)
    assert(contentText(composed.at(-1)!.content).includes('Revision 2'))
    assert(contentText(update.content).includes('Revision 3'))
    assert.equal(update.role, 'user')
  })
})

test('on-demand tool maintenance guide is a real discoverable built-in with recovery and authoring rules', async () => {
  const skills = await getBuiltinSkills()
  const guide = skills.get('tool-operations')
  assert(guide)
  const content = await readFile(join(guide.dirPath, 'SKILL.md'), 'utf8')
  for (const rule of [/skill_save/, /opaque.*revision/s, /toolExecution: "unknown"/,
    /request_probe/, /request_secret/, /Publish\/Cancel/, /not an OS sandbox/]) {
    assert.match(content, rule)
  }
})
