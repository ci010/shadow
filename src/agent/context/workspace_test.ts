import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { sessionWorkspacePath } from '../../utils/paths.ts'
import { resolve } from 'node:path'
import type { AgentTypeDefinition } from '../types/types.ts'
import { VirtualFs } from '../../vfs/virtual-fs.ts'
import { localFolderWorkdirRef, resolveSessionLocations } from '../../sessions/locality.ts'
import type { SessionPromptContext } from './builder.ts'
import { workspaceProvider } from './workspace.ts'
import { ContextBuilder } from './builder.ts'
import { guidelineProvider } from './guideline.ts'

const agent: AgentTypeDefinition = {
  name: 'test',
  description: '',
  prompt: '',
  defaultMode: 'task',
  soul: false,
  source: 'builtin',
}

function context(
  overrides: Partial<SessionPromptContext> = {},
): SessionPromptContext {
  return {
    behavior: {},
    channel: 'test',
    sessionId: 'discord:top',
    chatId: 'discord:top',
    agent,
    ...overrides,
  }
}

function assertAttachmentContext(prompt: string) {
  assert.match(prompt, /## Attachments\n\n- Session data: `SHADOW_SESSION_DATA_DIR` \(host-owned environment variable in local exec OS and Node processes\)\.\n- Uploaded files: `uploads\/` under the session data directory\.\n\nPrefer/)
  assert.match(prompt, /Prefer the exact attachment paths supplied in messages; they may refer to inherited uploads and are not remote workdir paths/)
  assert.match(prompt, /read\(\) does not expand environment variables/)
  assert.match(prompt, /Session working storage is for drafts and intermediate files; neither is the default destination for finished deliverables/)
  assert.doesNotMatch(prompt, /## Attachments and internal storage/)
}

test('system workspace context is stable across selection, locality and inherited workdirs', async () => {
  const home = resolve('.test-data', 'prompt-home')
  const folder = resolve('.test-data', 'prompt-folder')
  const provider = workspaceProvider(home, new VirtualFs(), () => ({
    node: 'online', capability: { kind: 'workdir', online: true, path: folder },
  }))
  const baseline = await provider.getPromptSection(context())
  for (const overrides of [
    { folderId: 'fixture', workdir: localFolderWorkdirRef('fixture') },
    { workspaceRoot: 'web:owner' },
    { workdir: { version: 1 as const, nodeId: 'remote', capabilityId: 'cap', displayPathSnapshot: 'DO-NOT-READ' } },
  ]) {
    const prompt = (await provider.getPromptSection(context(overrides)))!
    assert.equal(prompt, baseline)
    for (const path of [home, folder, sessionWorkspacePath(home, 'discord:top'), 'DO-NOT-READ']) assert(!prompt.includes(path))
    assert.doesNotMatch(prompt, /\*\*Working directory|\*\*Session workspace|\*\*Session uploads|Selected Project folder:/)
    assertAttachmentContext(prompt)
    assert.match(prompt, /honor an explicit user destination first; otherwise follow the current working-context snapshot destination policy/)
    assert.match(prompt, /Never remove user files or overwrite an existing destination without permission/)
    assert.match(prompt, /Verify the final file was saved at its durable destination before claiming delivery/)
    assert.match(prompt, /do not silently use session storage as final delivery/)
  }
})

test('knowledge requests direct every role to the Skill without inlining its manual or granting access', async () => {
  const fs = new VirtualFs()
  fs.mount('v:memory', 'Project memory', () => '')
  const provider = workspaceProvider(resolve('.test-data', 'wiki-alias'), fs)
  for (const name of ['general', 'sub']) {
    for (const allowedTools of [['read', 'search'], ['read', 'search', 'write']]) {
      const builder = new ContextBuilder(resolve('.test-data', 'wiki-alias'))
      builder.register(provider)
      const prompt = await builder.buildSystemPrompt(context({
        agent: { ...agent, name, allowedTools },
      }))
      assert.match(prompt, /Project memory, Wiki, knowledge or remembering facts, read `v:skills\/project-knowledge` before inspecting, editing or delegating knowledge work/)
      assert.match(prompt, /without granting permissions/)
      assert.equal(prompt.match(/v:skills\/project-knowledge/g)?.length, 1)
      assert.doesNotMatch(prompt, /canonical tool path|v:wiki|Session memory under|Files survive restarts|Write Wiki Markdown|Record mistakes|write-validation/)
    }
  }
})

test('ordinary workspace exposes discoverable Project resources', async () => {
  const fs = new VirtualFs()
  for (const prefix of ['v:project', 'v:sessions', 'v:memory', 'v:tools', 'v:bg', 'v:skills', 'v:config', 'v:events']) {
    fs.mount(prefix, prefix === 'v:memory' ? 'read, search, and write memory' : `${prefix} resources`, () => '')
  }
  const provider = workspaceProvider(resolve('.test-data', 'ordinary-prompt'), fs)
  const prompt = (await provider.getPromptSection(context({
    agent: { ...agent, name: 'general' },
  })))!
  assertAttachmentContext(prompt)
  assert.match(prompt, /Virtual resources:/)
  assert.doesNotMatch(prompt, /read\/search relevant Project memory|use `read`\/`search`/)
  for (const path of ['v:project', 'v:sessions', 'v:memory']) assert(prompt.includes(path))
  assert.match(prompt, /v:tools|v:config/)
  const ordinary = (await provider.getPromptSection(context()))!
  assert.match(ordinary, /v:tools|v:config/)
  assert.doesNotMatch(ordinary, /write\("notes.md"\)/)
})


test('current session metadata mount is discoverable in the injected workspace prompt', async () => {
  const fs = new VirtualFs()
  fs.mount('v:session', 'self.json: read/write current session title, description and completed as JSON; identity is runtime-bound; task metadata is parent-owned', () => '{}')
  const provider = workspaceProvider(resolve('.test-data', 'self-metadata-prompt'), fs)
  const prompt = (await provider.getPromptSection(context()))!
  assert.match(prompt, /Virtual resources:/)
  assert.match(prompt, /v:session\/.*self\.json: read\/write current session/)
  assert.match(prompt, /identity is runtime-bound; task metadata is parent-owned/)
  assert.doesNotMatch(prompt, /update_self/)
})

test('Git workflow is session-default without granting coordinator execution', async () => {
  const provider = workspaceProvider(resolve('.test-data', 'git-guidance'), new VirtualFs())
  for (const name of ['general', 'sub', 'explore']) {
    const prompt = (await provider.getPromptSection(context({ agent: { ...agent, name } })))!
    assert.match(prompt, /stricttools\/safegit/)
    assert.match(prompt, /Other Git commands use ordinary Git; safegit coverage alone does not require extra approval/)
    assert.match(prompt, /read `v:skills\/git-github`/)
    assert.match(prompt, /The skill covers commit\/push failure handling/)
  }
})
