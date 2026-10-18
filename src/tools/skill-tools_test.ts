import { requireToolText } from './tool.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
import assert from 'node:assert/strict'
import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { SkillsManager, type SkillMeta } from '../skills/loader.ts'
import { parseSkillFile } from '../skills/parse.ts'
import type { SkillToolDeclarations } from '../skills/tool-declarations.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { createSkillsHandler } from '../vfs/mounts.ts'
import type { ExecutionContext } from './context.ts'
import { ImportTool } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import { ReadTool } from './read.ts'
import { SearchTool } from './search.ts'
import { Tools, SessionTools } from './registry.ts'
import { CallTools } from '../sessions/call-tools.ts'
import { EvalBridgeRuntime } from '../script-runtime/bridge.ts'
import { createProjectScope, getProjectScope } from '../projects/scope.ts'

function setup(home: string) {
  const skills = new SkillsManager(home)
  const loader = new ImportTool(new Map(), home, undefined, name => skills.getSkillDirectory(name))
  const vfs = new VirtualFs()
  const handlers = createSkillsHandler(skills, (skill, ctx) => loader.registerSkillTools(skill, ctx))
  vfs.mount('v:skills', 'Skills', handlers.read, handlers.list)
  const base = new Tools(home)
  base.register(new ReadTool(home, vfs))
  base.register(new InvokeTool(loader))
  base.register(new SearchTool(home, undefined, vfs))
  const session = new SessionTools(base, home)
  const context: ExecutionContext = {
    sessionId: 'fixture', physicalSessionId: 'fixture-0',
    channel: 'test', messageId: 'test', senderId: 'test', chatId: 'test',
    tools: session, signal: new AbortController().signal, cwd: home,
  }
  const read = (path: string, ctx = context) => ctx.tools.execute('read', { path }, ctx)
  const invoke = (name: string, args: Record<string, unknown> = { value: 'value' }, ctx = context) =>
    ctx.tools.execute('invoke_tool', { name, args }, ctx)
  return { skills, loader, vfs, base, session, context, read, invoke }
}

async function addSkill(home: string, skills: SkillsManager, name: string,
  tools: Record<string, Pick<SkillToolDeclarations[string], 'source'> & Partial<SkillToolDeclarations[string]>>,
  extra: Partial<SkillMeta> = {}) {
  const dir = projectStoragePath(home, 'skills', name)
  await mkdir(join(dir, 'tools'), { recursive: true })
  const declarations = Object.fromEntries(Object.entries(tools).map(([alias, declaration]) => [alias, {
    description: 'Synthetic string tool',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    imports: [], ...declaration,
  }]))
  const manifest = `---\n${JSON.stringify({ name, description: `Useful ${name} tools`, tools: declarations, ...extra })}\n---\nCall the declared tools with {value: string}. Unique body text: spreadsheets.`
  await writeFile(join(dir, 'SKILL.md'), manifest)
  skills.setSkill(name, { ...parseSkillFile(manifest, name), dirPath: dir })
  return dir
}

const moduleText = (prefix: string) => `
export async function run(args: {value: string}) {return ${JSON.stringify(prefix)} + args.value}
`

test('skill metadata is declarative; discovery never runs source and invocation uses a child', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const dir = await addSkill(home, f.skills, 'csv', {
      csv_summary: { source: 'tools/summary.ts', imports: ['node:fs'] },
      csv_format: { source: 'tools/format.ts' },
    })
    const marker = join(home, 'loaded')
    await writeFile(join(dir, 'tools', 'summary.ts'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded');\n${moduleText('summary:')}`)
    await writeFile(join(dir, 'tools', 'format.ts'), moduleText('format:'))
    assert.match(requireToolText(await f.invoke('csv_summary')), /could not be imported/)
    const result = await f.read('v:skills/csv')
    assert.match(requireToolText(result), /Registered for this session: csv_summary, csv_format/)
    await assert.rejects(access(marker), { code: 'ENOENT' })
    assert.equal(f.session.hasDynamic('csv_summary'), false)
    assert.match(f.loader.readCatalog('', f.session), /"skill":"csv"/)
    await f.loader.importForInvocation('csv_summary', f.session)
    await assert.rejects(access(marker), { code: 'ENOENT' })
    assert.equal(await f.invoke('csv_summary'), 'summary:value')
    assert.equal(await readFile(marker, 'utf8'), 'loaded')
    assert.equal(await f.invoke('csv_format'), 'format:value')
    assert.match(requireToolText(await f.invoke('csv_summary', { value: 7 })), /no tool was executed/)
    assert.deepEqual(f.session.names(), ['read', 'invoke_tool', 'search'])
    await assert.rejects(access(join(home, 'project-config.json')), { code: 'ENOENT' })
    f.session.resetDynamic()
  })
})

test('skill search, category listing and bundled resource reads do not register tools or promote recency', async t => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const used = t.mock.method(f.skills, 'markSkillUsed')
    const dir = await addSkill(home, f.skills, 'csv', { csv_summary: { source: 'tools/summary.ts' } }, { category: 'data' })
    await writeFile(join(dir, 'tools', 'summary.ts'), moduleText('summary:'))
    const searched = requireToolText(await f.session.execute('search', { handler: 'grep', path: 'v:skills', query: 'spreadsheets' }, f.context))
    assert.match(searched, /v:skills\/csv:.*spreadsheets/)
    await f.read('v:skills')
    await f.read('v:skills/data')
    await f.read('v:skills/csv/tools/summary.ts')
    await f.read('v:skills/csv/SKILL.md')
    assert.match(requireToolText(await f.invoke('csv_summary')), /could not be imported/)
    assert.doesNotMatch(f.loader.readCatalog('', f.session), /csv_summary/)
    assert.equal(used.mock.callCount(), 0)
    await f.read('v:skills/csv')
    assert.deepEqual(used.mock.calls.map(call => call.arguments), [['csv', 'fixture']])
    assert.equal(await f.invoke('csv_summary'), 'summary:value')
    f.session.resetDynamic()
  })
})

test('registrations are session-local, reset on sleep, and never restored merely from the skill declaration', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const dir = await addSkill(home, f.skills, 'csv', { csv_summary: { source: 'tools/summary.ts' } })
    await writeFile(join(dir, 'tools', 'summary.ts'), moduleText('summary:'))
    await f.read('v:skills/csv')
    assert.equal(await f.invoke('csv_summary'), 'summary:value')
    const borrowed = f.session.snapshot()
    const other = new SessionTools(f.base, home)
    assert.match(requireToolText(await f.invoke('csv_summary', {}, { ...f.context, tools: other })), /could not be imported/)
    f.session.resetDynamic()
    assert.equal(borrowed.hasDynamic('csv_summary'), false)
    assert.match(requireToolText(await f.invoke('csv_summary')), /could not be imported/)
    assert.doesNotMatch(f.loader.readCatalog('', f.session), /csv_summary/)
    await f.read('v:skills/csv')
    assert.equal(await f.invoke('csv_summary'), 'summary:value')
    const restarted = setup(home)
    restarted.skills.setSkill('csv', f.skills.getSkill('csv')!)
    assert.match(requireToolText(await restarted.invoke('csv_summary')), /could not be imported/)
    f.session.resetDynamic()
  })
})

test('re-reading replaces changed declarations and sources, invalidates borrowed aliases, and removes dropped tools', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const dir = await addSkill(home, f.skills, 'csv', { csv_summary: { source: 'tools/summary.ts' } })
    await writeFile(join(dir, 'tools', 'summary.ts'), moduleText('original:'))
    await f.read('v:skills/csv')
    assert.equal(await f.invoke('csv_summary'), 'original:value')
    const borrowed = f.session.snapshot()
    await f.read('v:skills/csv')
    assert.equal(borrowed.hasDynamic('csv_summary'), true)
    await writeFile(join(dir, 'tools', 'summary.ts'), moduleText('changed-longer:'))
    await f.read('v:skills/csv')
    assert.equal(borrowed.hasDynamic('csv_summary'), false)
    assert.equal(await f.invoke('csv_summary'), 'changed-longer:value')
    await addSkill(home, f.skills, 'csv', {})
    await f.read('v:skills/csv')
    assert.match(requireToolText(await f.invoke('csv_summary')), /could not be imported/)
  })
})

test('registration is atomic across declarations and cannot overwrite base, catalog or another skill tools', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const dir = await addSkill(home, f.skills, 'csv', { owned: { source: 'tools/one.ts' } })
    await writeFile(join(dir, 'tools', 'one.ts'), moduleText('owned:'))
    await f.read('v:skills/csv')
    const other = await addSkill(home, f.skills, 'other', { unique: { source: 'tools/one.ts' }, owned: { source: 'tools/one.ts' } })
    await writeFile(join(other, 'tools', 'one.ts'), moduleText('other:'))
    assert.match(requireToolText(await f.read('v:skills/other')), /conflicts/)
    assert.match(requireToolText(await f.invoke('unique')), /could not be imported/)
    assert.equal(await f.invoke('owned'), 'owned:value')
    await assert.rejects(f.loader.updateMcpServers([{ name: 'owned', transport: 'stdio', command: 'synthetic' }]), /conflicts/)
    assert.equal(await f.invoke('owned'), 'owned:value')
    await addSkill(home, f.skills, 'other', { read: { source: 'tools/one.ts' } })
    assert.match(requireToolText(await f.read('v:skills/other')), /conflicts/)
    await f.loader.updateMcpServers([{ name: 'catalog', transport: 'stdio', command: 'synthetic' }])
    await addSkill(home, f.skills, 'other', { catalog: { source: 'tools/one.ts' } })
    assert.match(requireToolText(await f.read('v:skills/other')), /conflicts/)
    f.session.resetDynamic()
  })
})

test('entrypoints cannot escape the skill by traversal or directory symlink, and missing owners fail at invocation', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const dir = await addSkill(home, f.skills, 'csv', { escape: { source: '../../outside.ts' } })
    await writeFile(join(home, 'outside.ts'), moduleText('outside:'))
    assert.match(requireToolText(await f.read('v:skills/csv')), /inside their owning skill/)
    const outside = join(home, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'tool.ts'), moduleText('outside:'))
    await symlink(outside, join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await addSkill(home, f.skills, 'csv', { escape: { source: 'linked/tool.ts' } })
    assert.match(requireToolText(await f.read('v:skills/csv')), /symlink|junction/i)
    await rm(join(dir, 'linked'))
    await addSkill(home, f.skills, 'csv', { csv_summary: { source: 'tools/summary.ts' } })
    await writeFile(join(dir, 'tools', 'summary.ts'), moduleText('summary:'))
    await f.read('v:skills/csv')
    f.skills.removeSkill('csv')
    assert.match(requireToolText(await f.invoke('csv_summary')), /Skill.*not found/)
    await addSkill(home, f.skills, 'csv', { csv_summary: { source: 'tools/summary.ts' } })
    assert.equal(await f.invoke('csv_summary'), 'summary:value')
    await rm(join(dir, 'SKILL.md'))
    assert.match(requireToolText(await f.invoke('csv_summary')), /ENOENT/)
    f.session.resetDynamic()
  })

  test('changed Skill bundles require a fresh exact read before both lazy and active execution', async () => {
    await withTempWorkspace(async home => {
      const f = setup(home)
      const dir = await addSkill(home, f.skills, 'csv', { csv_summary: { source: 'tools/summary.ts' } })
      const source = join(dir, 'tools', 'summary.ts')
      await writeFile(source, moduleText('before:'))
      await f.read('v:skills/csv')
      await writeFile(source, moduleText('after!:'))
      assert.match(requireToolText(await f.invoke('csv_summary')), /changed.*read the skill again/i)
      await f.read('v:skills/csv')
      assert.equal(await f.invoke('csv_summary'), 'after!:value')
      await writeFile(join(dir, 'data.txt'), 'resource one')
      assert.match(requireToolText(await f.invoke('csv_summary')), /changed.*read the skill again/i)
      await f.read('v:skills/csv')
      assert.equal(await f.invoke('csv_summary'), 'after!:value')
      await writeFile(join(dir, 'data.txt'), 'resource two')
      assert.match(requireToolText(await f.invoke('csv_summary')), /changed.*read the skill again/i)
      await f.read('v:skills/csv')
      assert.equal(await f.invoke('csv_summary'), 'after!:value')
      const manifestPath = join(dir, 'SKILL.md')
      const old = await readFile(manifestPath, 'utf8')
      await writeFile(manifestPath, old.replace('Unique body text: spreadsheets.', 'New instructions only.'))
      assert.match(requireToolText(await f.invoke('csv_summary')), /changed.*read the skill again/i)
      assert.match(requireToolText(await f.read('v:skills/csv')), /New instructions only/)
      assert.equal(await f.invoke('csv_summary'), 'after!:value')
      f.session.resetDynamic()
    })
  })

  test('refreshing one session does not refresh other sessions or hide manifest edits from raw cache', async () => {
    await withTempWorkspace(async home => {
      const f = setup(home)
      const dir = await addSkill(home, f.skills, 'csv', { csv_summary: { source: 'tools/summary.ts' } })
      const source = join(dir, 'tools', 'summary.ts')
      await writeFile(source, moduleText('old:'))
      const other = new SessionTools(f.base, home)
      const otherContext = { ...f.context, sessionId: 'other', tools: other }
      await f.read('v:skills/csv')
      await f.read('v:skills/csv', otherContext)
      assert.equal(await f.invoke('csv_summary', { value: 'other' }, otherContext), 'old:other')
      await writeFile(source, moduleText('new:'))
      await f.read('v:skills/csv')
      assert.equal(await f.invoke('csv_summary'), 'new:value')
      assert.match(requireToolText(await f.invoke('csv_summary', { value: 'other' }, otherContext)), /changed.*read the skill again/i)
      await f.read('v:skills/csv', otherContext)
      assert.equal(await f.invoke('csv_summary', { value: 'other' }, otherContext), 'new:other')
      await writeFile(join(dir, 'SKILL.md'), '---\nname: csv\n---\nTool removed externally.')
      assert.match(requireToolText(await f.invoke('csv_summary')), /changed.*read the skill again/i)
      assert.match(requireToolText(await f.read('v:skills/csv')), /Tool removed externally/)
      assert.match(requireToolText(await f.invoke('csv_summary')), /could not be imported/)
      f.session.resetDynamic()
      other.resetDynamic()
    })
  })
})

test('admin, agent-role and remote restrictions cannot be bypassed by skill registration or invocation', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const dir = await addSkill(home, f.skills, 'private', { secret_tool: { source: 'tools/tool.ts' } }, { admin: true, category: 'hidden' })
    await writeFile(join(dir, 'tools', 'tool.ts'), moduleText('private:'))
    assert.doesNotMatch(requireToolText(await f.read('v:skills')), /private/)
    assert.match(requireToolText(await f.read('v:skills/private')), /Unknown/)
    assert.match(requireToolText(await f.read('v:skills/hidden')), /Unknown/)
    const normal = requireToolText(await f.session.execute('search', { handler: 'glob', path: 'v:skills', query: '**' }, f.context))
    assert.equal(normal, 'No files found')
    const admin = { ...f.context, admin: true }
    await f.read('v:skills/private', admin)
    assert.equal(await f.invoke('secret_tool', { value: 'value' }, admin), 'private:value')
    assert.match(requireToolText(await f.invoke('secret_tool')), /admin/)
    const restricted = new SessionTools(f.base, home, ['read', 'search'])
    assert.match(requireToolText(await f.read('v:skills/private', { ...admin, tools: restricted })), /not available/)
    const remote = { ...admin, remoteWorkdir: {
      nodeId: 'remote', capabilityId: 'opaque', get executor(): never { throw new Error('Must not access remote executor') },
    } }
    assert.match(requireToolText(await f.read('v:skills/private', remote)), /local workdir/)
    assert.match(requireToolText(await f.invoke('secret_tool', {}, remote)), /remote workdirs/)
    f.session.resetDynamic()
  })
})

test('malformed frontmatter tools are discoverable as errors without disabling healthy skills', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const dir = projectStoragePath(home, 'skills', 'invalid')
    await mkdir(dir, { recursive: true })
    const text = '---\nname: invalid\ntools:\n  wrong: {source: /absolute.ts}\n---\nInvalid tool'
    await writeFile(join(dir, 'SKILL.md'), text)
    f.skills.setSkill('invalid', { ...parseSkillFile(text, 'invalid'), dirPath: dir })
    await addSkill(home, f.skills, 'healthy', {})
    const result = requireToolText(await f.session.execute('search', { handler: 'glob', path: 'v:skills', query: '**/SKILL.md' }, f.context))
    assert.match(result, /v:skills\/healthy\/SKILL.md/)
    assert.match(result, /Warning: v:skills\/invalid:.*relative/)
    assert.match(requireToolText(await f.read('v:skills/invalid')), /Invalid tools/)
    assert.match(requireToolText(await f.read('v:skills/healthy')), /declared tools/)
  })
})

test('virtual skill search supports deterministic pagination, metadata grep and strict bounds without loading modules', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    for (const name of ['csv', 'beta', 'alpha']) await addSkill(home, f.skills, name, {}, { category: name === 'csv' ? 'data' : 'misc' })
    const search = async (args: Record<string, unknown>) => requireToolText(await f.session.execute('search', { handler: 'glob', path: 'v:skills', query: '**/SKILL.md', ...args }, f.context))
    assert.equal(await search({ limit: 2 }), 'v:skills/alpha/SKILL.md\nv:skills/beta/SKILL.md\n(Showing 2 of 3 results; continue with offset: 2.)')
    assert.equal(await search({ offset: 2 }), 'v:skills/csv/SKILL.md')
    assert.match(await search({ handler: 'grep', path: 'v:skills/csv/SKILL.md', query: '"category":"data"' }), /v:skills\/csv\/SKILL.md/)
    assert.equal(await search({ query: 'no-match' }), 'No files found')
    assert.equal(await search({ offset: 100 }), 'No results at this offset.')
    for (const args of [{ query: null }, { limit: null }, { limit: 101 }, { offset: -1 }, { offset: 0.5 }]) {
      assert.match(await search(args), /^Error/)
    }
    assert.equal(f.session.activeDynamicTools().length, 0)
  })
})

test('skill tools can lazily compose sibling tools after a single skill read', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const dir = await addSkill(home, f.skills, 'csv', {
      first: { source: 'tools/one.ts', imports: ['@shadow/second'], parameters: { type: 'object', properties: {} } },
      second: { source: 'tools/two.ts' },
    })
    await writeFile(join(dir, 'tools', 'one.ts'), `
import second from '@shadow/second'
export async function run(){return await second({value:'nested'})}
`)
    await writeFile(join(dir, 'tools', 'two.ts'), moduleText('second:'))
    await f.read('v:skills/csv')
    assert.equal(await f.invoke('first', {}), 'second:nested')
    f.session.resetDynamic()
  })
})

test('sleep aborts a running child and its broker calls without reactivating a skill tool', { timeout: 10_000 }, async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const dir = await addSkill(home, f.skills, 'csv', {
      waiting: { source: 'tools/wait.ts', imports: ['@shadow/gate'], parameters: { type: 'object', properties: {} } },
    })
    const entered = Promise.withResolvers<void>()
    let brokerSignal: AbortSignal | undefined
    f.base.register({
      name: 'gate', description: 'Synthetic blocking tool', parameters: { type: 'object', properties: {} },
      async execute(_args, context) {
        brokerSignal = context.signal
        entered.resolve()
        return new Promise<string>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
        })
      },
    })
    await writeFile(join(dir, 'tools', 'wait.ts'), `
import gate from '@shadow/gate'
export async function run(){await gate({}); return 'obsolete'}
`)
    await f.read('v:skills/csv')
    const pending = f.invoke('waiting', {})
    await entered.promise
    f.session.resetDynamic()
    assert.match(requireToolText(await pending), /abort|cancel/i)
    assert.equal(brokerSignal?.aborted, true)
    assert.equal(f.session.hasDynamic('waiting'), false)
    assert.match(requireToolText(await f.invoke('waiting', {})), /could not be imported/)
    assert.match(await readFile(join(dir, 'SKILL.md'), 'utf8'), /waiting/)
  })
})

test('controlled skill callbacks stay in their owning project and use fresh invocation identities', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const scope = createProjectScope('skill-project')
    const runtime = new EvalBridgeRuntime({ projectId: scope.projectId, scope })
    const context = { ...f.context, projectId: scope.projectId, evalBridge: runtime, toolCallId: 'outer-call' }
    f.base.register({
      name: 'who', description: 'Synthetic scope identity', parameters: { type: 'object', properties: {} },
      async execute(_args, nested) {
        assert.equal(getProjectScope(), scope)
        assert.equal(nested.projectId, scope.projectId)
        assert.notEqual(nested.toolCallId, 'outer-call')
        assert.equal(nested.toolCallName, 'who')
        return JSON.stringify({ projectId: nested.projectId, callId: nested.toolCallId })
      },
    })
    const dir = await addSkill(home, f.skills, 'scope', {
      scoped: { source: 'tools/scoped.ts', imports: ['@shadow/who'] },
    })
    await writeFile(join(dir, 'tools', 'scoped.ts'), `import who from '@shadow/who'; export async function run(args) { return await who(args) }`)
    try {
      await f.read('v:skills/scope', context)
      const result = JSON.parse(requireToolText(await f.invoke('scoped', { value: 'fixture' }, context)))
      assert.equal(result.projectId, scope.projectId)
      assert.equal(typeof result.callId, 'string')
      assert.match(requireToolText(await f.invoke('scoped', { value: 'fixture' }, { ...context, projectId: 'foreign' })), /binding mismatch/)
      await runtime.shutdown()
      assert.match(requireToolText(await f.invoke('scoped', { value: 'fixture' }, context)), /closed/)
    } finally {
      await runtime.shutdown()
      scope.close()
      f.session.resetDynamic()
    }
  })
})

test('agent module ceilings restrict registration, borrowed tools and invocation', async () => {
  await withTempWorkspace(async home => {
    const f = setup(home)
    const dir = await addSkill(home, f.skills, 'paths', {
      basename: { source: 'tools/path.js', imports: ['node:path'] },
    })
    await writeFile(join(dir, 'tools', 'path.js'), `import path from 'node:path'; export function run(args) { return path.basename(args.value) }`)
    const denied = new SessionTools(f.base, home, undefined, undefined, [])
    assert.match(requireToolText(await f.read('v:skills/paths', { ...f.context, tools: denied })), /allow.*module|module.*allow/i)
    const allowed = new SessionTools(f.base, home, undefined, undefined, ['node:path'])
    const context = { ...f.context, tools: allowed }
    await f.read('v:skills/paths', context)
    assert.equal(await f.invoke('basename', { value: 'one/two' }, context), 'two')
    assert.deepEqual(allowed.snapshot().allowedModules, ['node:path'])
    const narrowed = new CallTools(allowed, home, undefined, undefined, [])
    assert.deepEqual(narrowed.allowedModules, [])
    assert.match(requireToolText(await f.invoke('basename', { value: 'one/two' }, { ...context, tools: narrowed })), /allow.*module|module.*allow/i)
    assert.match(await f.loader.importSource({ source: join(dir, 'tools', 'path.js') }, allowed), /Declare scripts in SKILL.md/)
    allowed.resetDynamic()
  })
})
