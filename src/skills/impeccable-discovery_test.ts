import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getBuiltinSkills } from './builtins.ts'
import { SkillsManager } from './loader.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { createSkillsHandler } from '../vfs/mounts.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { SearchTool } from '../tools/search.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'

const references = ['craft-floor', 'layout', 'typeset', 'colorize', 'mode-operate', 'setup']

test('Impeccable is one source-bundled guidance skill with no executable payload', async () => {
  const builtin = (await getBuiltinSkills()).get('impeccable')!
  assert.ok(builtin)
  assert.equal(builtin.meta.name, 'impeccable')
  assert.deepEqual(Object.keys(builtin.meta.tools ?? {}), [])
  assert.equal(builtin.meta.toolsError, undefined)
  assert.match(builtin.meta.description, /guidance-only subset/)
  const files: string[] = []
  async function walk(dir: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${path}/`)
      else files.push(path)
    }
  }
  await walk(builtin.dirPath)
  assert.deepEqual(files.sort(), ['LICENSE', 'NOTICE.md', 'SKILL.md', 'UPSTREAM.md',
    ...references.map(name => `reference/${name}.md`)].sort())
  assert.match(await readFile(join(builtin.dirPath, 'LICENSE'), 'utf8'), /Apache License/)
  assert.match(await readFile(join(builtin.dirPath, 'NOTICE.md'), 'utf8'), /ehmo/)
  assert.match(await readFile(join(builtin.dirPath, 'UPSTREAM.md'), 'utf8'), /8409a564d1baee90b2dde4f7a8f06288838e3921/)
})

test('Impeccable discovery, exact reads and on-demand resources preserve guidance boundaries', async () => {
  await withTempWorkspace(async home => {
    const skills = new SkillsManager(home)
    try {
      await skills.load()
      let registrations = 0
      const handlers = createSkillsHandler(skills, async skill => {
        registrations++
        assert.deepEqual(Object.keys(skill.meta.tools ?? {}), [])
        return []
      })
      const vfs = new VirtualFs()
      vfs.mount('v:skills', 'Skills', handlers.read, handlers.list)
      const context = { tools: new SessionTools(new Tools(home), home),
        signal: new AbortController().signal } as ExecutionContext
      const read = async (path: string) => await handlers.read(path, context)
      assert.match(String(await read('')), /- impeccable/)
      const search = new SearchTool(home, undefined, vfs)
      for (const query of ['typography', 'contrast', 'responsive']) {
        assert.match(String(await search.execute({ handler: 'grep', path: 'v:skills/impeccable', query }, context)), /v:skills\/impeccable/)
      }
      assert.equal(registrations, 0, 'discovery and search do not activate skills')
      for (const name of references) {
        const body = String(await read(`impeccable/reference/${name}.md`))
        assert.match(body, /Shadow adaptation/)
        assert.doesNotMatch(body, /\.agents\/skills|```bash|\$impeccable|\]\((?:live|new-work|ios|android)\.md\)/)
      }
      assert.equal(registrations, 0, 'resource reads do not activate skills')
      const body = String(await read('impeccable'))
      assert.equal(registrations, 1)
      for (const rule of ['guidance-only subset', 'No tools are declared', 'No slash commands',
        'ask(kind=input)', 'ask(kind=decision)', 'wait for the answer', 'v:skills/micro-app',
        'exact-version owner approval', 'Report untested behavior', 'Do not run or install']) {
        assert.ok(body.includes(rule), rule)
      }
      assert.doesNotMatch(body, /Registered for this session/)
      assert.match(String(await read('impeccable/reference/missing.md')), /Resource not found/)
      await assert.rejects(async () => read('impeccable/../micro-app/SKILL.md'), /remain inside/)
      await assert.rejects(async () => skills.getSkillResource('impeccable', '/etc/passwd'), /remain inside/)
      assert.match(String(await read('impeccable/LICENSE')), /Version 2.0/)
    } finally { await skills.stopWatching() }
  })
})


test('project frontend instructions route to setup without forcing non-UI initialization', async () => {
  const instructions = await readFile(new URL('../../AGENTS.md', import.meta.url), 'utf8')
  for (const rule of ['DESIGN.md', 'v:skills/impeccable', 'reference/setup.md',
    'do not claim the skill was loaded', 'Non-UI tasks need no design',
    'do not require creating PRODUCT.md', 'Do not\ninstall hooks']) assert.ok(instructions.replace(/\s+/g, ' ').includes(rule.replace(/\s+/g, ' ')), rule)
  const setup = await readFile(new URL('./builtin/impeccable/reference/setup.md', import.meta.url), 'utf8')
  for (const rule of ['Only DESIGN.md exists', 'preserve it', 'ask(kind=input)',
    'ask(kind=decision)', 'wait', 'impeccable:product-schema 1',
    'Verify the saved PRODUCT.md exists', 'Init does not create',
    'Quiet\nWorkbench', 'do not block on a missing PRODUCT.md',
    'never silently overwrite', 'No `.impeccable/config.json`']) assert.ok(setup.replace(/\s+/g, ' ').includes(rule.replace(/\s+/g, ' ')), rule)
})
