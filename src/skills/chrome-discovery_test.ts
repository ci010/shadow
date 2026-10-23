import assert from 'node:assert/strict'
import test from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import { SkillsManager } from './loader.ts'
import { SearchTool } from '../tools/search.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { createSkillsHandler } from '../vfs/mounts.ts'

test('browser capabilities are visible in the compact summary before tool discovery', async () => {
  await withTempWorkspace(async home => {
    const skills = new SkillsManager(home)
    try {
      await skills.load()
      for (const admin of [false, true]) {
        const entry = skills.getMetadataSummary(admin).match(/<skill name="chrome-devtools">([^<]+)<\/skill>/)?.[1]
        assert.ok(entry, 'Browser capabilities must be inline in the default summary')
        for (const capability of ['navigate', 'forms', 'screenshots', 'network', 'console', 'slow pages', 'memory', 'audits', 'emulate', 'browser_setup', 'Edge', 'Brave', 'Electron']) {
          assert.ok(entry.includes(capability), `Summary must expose ${capability}`)
        }
        assert.ok(entry.length < 350, 'The capability entry must remain a compact routing hint')
      }
      const handlers = createSkillsHandler(skills, async () => { assert.fail('search must not register skill tools') })
      const vfs = new VirtualFs()
      vfs.mount('v:skills', 'Skills', handlers.read, handlers.list)
      const search = new SearchTool(home, undefined, vfs)
      const context = { tools: new SessionTools(new Tools(home), home), signal: new AbortController().signal } as ExecutionContext
      for (const query of ['[Ss]low page', '[Ff]ailed API request', '[Bb]roken button', 'memory', '[Mm]obile layout', 'accessibility audit', 'Edge', 'Brave', 'Electron', 'browser_setup']) {
        const result = await search.execute({ handler: 'grep', path: 'v:skills/chrome-devtools', query }, context)
        assert.match(result, /v:skills\/chrome-devtools/, `Browser skill must be discoverable for ${query}`)
      }
      const body = skills.getSkillBody('chrome-devtools')
      assert.ok(body)
      assert.match(body, /tool search uses case-sensitive regular expressions/)
      assert.match(body, /Check warnings/)
      assert.match(body, /handler: "glob", path: "v:tools\/chrome-devtools", query: "\*\*", limit: 20/)
      assert.match(body, /continuation footer's offset/)
      assert.match(body, /not merely to hide tool schemas/)
      assert.match(body, /does not inherit the parent's open page or login/)
      const normalized = body.replace(/\s+/g, ' ')
      for (const contract of [
        /action: "discover"/,
        /action: "managed"/,
        /one loopback-CDP Chrome per Project runtime/,
        /Source files are never modified/,
        /Encrypted cookies\/passwords/,
        /action: "autoConnect", channel: "stable"/,
        /Chrome 144\+/,
        /Chrome 136\+/,
        /action: "attach", endpoint: "http:\/\/127\.0\.0\.1:9222"/,
        /browser-wide/,
        /not isolated to the selected human profile/,
        /Every page-scoped tool requires pageId/,
        /`select_page` is not exposed or callable/,
        /args: \{ pageId: 1 \}/,
        /action: "list"/,
        /action: "close", instance: "<id>"/,
        /Leaf calls borrow their owner's binding/,
        /session-only/,
        /never kill the user browser/,
        /Empty preloads require an existing binding/,
        /Installed MCP search is offline/,
        /Browser tests are synthetic/,
      ]) assert.match(normalized, contract)
      assert.doesNotMatch(body, /All tools share one managed browser|Each subagent gets a separate browser|Do not attach a manually launched browser/)
      assert.doesNotMatch(body, /chrome-devtools-full|~30 MCP tools|## Tool sets|npx chrome-devtools-mcp/)
    } finally {
      await skills.stopWatching()
    }
  })
})
