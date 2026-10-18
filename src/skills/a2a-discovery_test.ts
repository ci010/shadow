import assert from 'node:assert/strict'
import test from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { SearchTool } from '../tools/search.ts'
import { createSkillsHandler } from '../vfs/mounts.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { SkillsManager } from './loader.ts'

test('A2A guidance is discoverable and readable without configuring remote agents', async () => {
  await withTempWorkspace(async home => {
    const skills = new SkillsManager(home)
    try {
      await skills.load()
      for (const admin of [false, true]) {
        const entry = skills.getMetadataSummary(admin).match(/<skill name="a2a">([^<]+)<\/skill>/)?.[1]
        assert.ok(entry, 'A2A must be discoverable in the default compact summary')
        for (const keyword of ['A2A', 'remote agents', 'Claude Code', 'Codex', 'GitHub Copilot']) {
          assert.ok(entry.includes(keyword), `Summary must expose ${keyword}`)
        }
      }
      const skill = skills.getSkill('a2a')
      assert.ok(skill)
      assert.deepEqual(Object.keys(skill.meta.tools ?? {}), [], 'Guidance must not declare executable tools')
      const handlers = createSkillsHandler(skills)
      const vfs = new VirtualFs()
      vfs.mount('v:skills', 'Skills', handlers.read, handlers.list)
      const search = new SearchTool(home, undefined, vfs)
      const tools = new SessionTools(new Tools(home), home)
      const context = { tools, signal: new AbortController().signal } as ExecutionContext
      for (const query of ['A2A', 'Claude', 'Codex', 'Copilot', 'request_id']) {
        const result = await search.execute({ handler: 'grep', path: 'v:skills', query }, context)
        assert.match(result, /v:skills\/a2a/, `A2A must be searchable by ${query}`)
      }
      assert.equal(await handlers.read('a2a', context), skill.body)
      assert.equal(tools.hasDynamic('a2a_send'), false, 'Reading the skill must not grant A2A tools')
      assert.match(skills.getSkillBody('tool-operations')!, /v:skills\/a2a/)
    } finally {
      await skills.stopWatching()
    }
  })
})

test('A2A guidance unifies input replies without granting decision authority', async () => {
  await withTempWorkspace(async home => {
    const skills = new SkillsManager(home)
    try {
      await skills.load()
      const body = skills.getSkillBody('a2a')
      assert.ok(body)
      const normalized = body.replace(/\s+/g, ' ')
      for (const contract of [
        /read\(\{ path: "v:agents" \}\)/,
        /agent_type: "a2a:copilot"/,
        /message\(\{ sessionId:/,
        /v:sessions\/<returned-sessionId>\/executions/,
        /cancel\(\{ executionId:/,
        /Reading this skill does not register tools/,
        /`a2a-text` role still has no tools/,
        /`submitted` is not completion/,
        /new handle\/execution reference returned by the reply/,
        /reply\(\{ request_id:/,
        /does not make the caller a local human decision authority/,
        /`auth-required` needs operator action/,
        /do not automatically resend/,
        /not an exactly-once durable queue/,
        /does not rewrite a completed inbound A2A task/,
        /cancellation does not roll back effects/,
      ]) assert.match(normalized, contract)
      assert.doesNotMatch(body, /name: "a2a_(send|get|calls|cancel|agents)"/)
    } finally {
      await skills.stopWatching()
    }
  })
})
