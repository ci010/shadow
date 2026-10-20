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
        /search\(\{ handler: "grep", path: "v:tools", query: "browser_setup" \}\)/,
        /name: "browser_setup", args: \{ action: "launch", browser: "edge" \}/,
        /`browser` accepts `edge`, `brave`, `chrome`, or `default`/,
        /`executablePath` instead of `browser`.*explicit choice never falls back/,
        /exclusively leases one persistent Project browser slot/,
        /Setup does not change Project configuration/,
        /action: "attach", endpoint: "http:\/\/127\.0\.0\.1:9222"/,
        /loopback HTTP\(S\)\/WS\(S\)/,
        /ws:\/\/127\.0\.0\.1:9222\/devtools\/browser\/\.\.\./,
        /preenabled CDP target, including compatible Electron/,
        /source: "v:tools\/chrome-devtools", mode, owned, ready/,
        /connects and lists live contracts without business tool RPCs/,
        /args: \{ action: "list" \}/,
        /args: \{ action: "close", instance: "<id>" \}/,
        /handler: "grep", path: "v:tools\/chrome-devtools\/<id>", query: "snapshot"/,
        /name: "chrome-devtools__take_snapshot", instance: "<id>", args: \{\}/,
        /no per-instance prefix variants or alternate full source/,
        /One session instance allows omitted `instance`; two or more require an explicit ID/,
        /no mutable current browser/,
        /invalid or other-session IDs fail without fallback/,
        /Sleep\/reset closes owned instances; attached targets are only disconnected, never killed/,
        /Blocking leaf calls\/snapshots instead borrow the owner's instance IDs.*may interact\/list but cannot launch, attach, or close/,
        /If the owner has no browser, automatic discovery\/invocation fails asking the owner to initialize first/,
        /never silently creates a persistent resource in a leaf/,
        /Startup import\/preload arguments are pinned per instance/,
        /`preload_tools: \{ "chrome-devtools": \[\] \}` still works/,
        /IDs are scoped to the session lifecycle/,
        /Each instance has an isolated tool registry/,
        /raw endpoint\/profile\/executable flags/,
        /Invocation can lazily launch a default browser in an owning session/,
        /Global VFS search includes already-loaded browser contracts under their instance paths without reconnecting/,
        /Uninitialized browser sources remain deferred even when explicitly selected/,
        /Installed MCP search remains offline/,
        /Browser\/host tests are synthetic, not actual browser end-to-end verification/,
      ]) assert.match(normalized, contract)
      assert.doesNotMatch(body, /All tools share one managed browser|Each subagent gets a separate browser|Do not attach a manually launched browser/)
      assert.doesNotMatch(body, /chrome-devtools-full|~30 MCP tools|## Tool sets|npx chrome-devtools-mcp/)
    } finally {
      await skills.stopWatching()
    }
  })
})
