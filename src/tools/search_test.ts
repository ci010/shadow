import { requireToolText } from './tool.ts'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import type { ExecutionContext } from './context.ts'
import { groupTools } from '../utils/tools-group.ts'
import { Tools, SessionTools } from './registry.ts'
import { SearchTool } from './search.ts'
import { detectRipgrep, GlobTool, GrepTool } from './ripgrep.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { createMemoryHandler, createSessionsHandler } from '../vfs/mounts.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { Tool } from './tool.ts'

test('virtual glob and grep scope subdirectories, exact files, patterns and pagination without host fallback', async () => {
  const vfs = new VirtualFs()
  vfs.mount('v:memory', 'Memory', () => 'not used', () => [
    { name: 'root.md', content: 'needle root' },
    { name: 'nested/a.md', content: 'first\nneedle child' },
    { name: 'nested/deeper/b.txt', content: 'needle deeper' },
  ])
  vfs.mount('v:config', 'Read-only config', () => '')
  const search = new SearchTool('.', undefined, vfs)
  const context = { tools: new SessionTools(new Tools('.'), '.'), signal: new AbortController().signal } as ExecutionContext
  assert.equal(await search.execute({ space: 'glob:v:memory', query: '**/*.md' }, context), 'v:memory/nested/a.md\nv:memory/root.md')
  assert.equal(await search.execute({ space: 'glob:v:memory/nested', query: '**/*.{md,txt}' }, context), 'v:memory/nested/a.md\nv:memory/nested/deeper/b.txt')
  assert.equal(await search.execute({ space: 'glob:', query: 'v:memory/nested/*.md' }, context), 'v:memory/nested/a.md')
  assert.equal(await search.execute({ space: 'grep:v:memory/nested/a.md', query: 'needle' }, context), 'v:memory/nested/a.md:  Line 2: needle child')
  assert.doesNotMatch(await search.execute({ space: 'grep:v:memory/nested', query: 'needle' }, context), /root.md|nested\/nested/)
  assert.equal(await search.execute({ space: 'grep:v:memory', query: 'NEEDLE' }, context), 'No matches found')
  assert.equal(await search.execute({ space: 'glob:v:memory', query: '**', limit: 1, offset: 2 }, context), 'v:memory/root.md')
  for (const space of ['glob:v:unknown', 'grep:v:config', 'glob:v:memory/../config']) {
    await assert.rejects(search.execute({ space, query: 'x' }, context), /virtual|Virtual/)
  }
  await assert.rejects(new SearchTool('.').execute({ space: 'glob:v:memory', query: '**' }, context), /not configured/)
  await assert.rejects(search.execute({ space: 'grep:v:memory', query: '[' }, context), /regular expression/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(search.execute({ space: 'glob:v:memory', query: '**' }, { ...context, signal: controller.signal }), { name: 'AbortError' })
})

test('virtual memory search reads the Project Home, not the session or registered folder', async () => {
  await withTempWorkspace(async home => {
    await mkdir(resolve(home, 'memory', 'nested'), { recursive: true })
    await mkdir(resolve(home, 'workdir'))
    await writeFile(resolve(home, 'memory', 'nested', 'lesson.md'), 'learned a useful lesson')
    await writeFile(resolve(home, 'workdir', 'lesson.md'), 'wrong workdir')
    const handlers = createMemoryHandler(home)
    const vfs = new VirtualFs()
    vfs.mount('v:memory', 'Memory', handlers.read, handlers.list)
    const context = { tools: new SessionTools(new Tools(home), home), cwd: resolve(home, 'workdir'), signal: new AbortController().signal } as ExecutionContext
    const search = new SearchTool(home, undefined, vfs)
    assert.match(await search.execute({ space: 'grep:v:memory', query: 'useful' }, context), /v:memory\/nested\/lesson.md/)
    assert.equal(await search.execute({ space: 'grep:v:memory', query: 'wrong' }, context), 'No matches found')
    assert.equal(await vfs.resolve('v:memory/nested/lesson.md', context), 'learned a useful lesson')
    assert.match(await vfs.resolve('v:memory/nested', context) ?? '', /nested\/lesson.md/)
  })
})

test('virtual session search includes earlier history while glob avoids loading transcripts', async () => {
  let historyReads = 0
  const handlers = createSessionsHandler({
    listSessions: () => [{ sessionId: 'web:one', segmentIndex: 0 }],
    getSessionState: () => ({ sessionId: 'web:one', segmentIndex: 0, config: {} }),
    getHistory: async (_id, query) => {
      historyReads++
      assert.equal(query?.maxMessages, Number.MAX_SAFE_INTEGER)
      return { messages: Array.from({ length: 60 }, (_, i) => ({ role: 'user' as const, content: i === 0 ? 'old needle' : 'recent' })), total: 60 }
    },
  })
  const vfs = new VirtualFs()
  vfs.mount('v:sessions', 'Sessions', handlers.read, handlers.list)
  const context = { tools: new SessionTools(new Tools('.'), '.'), signal: new AbortController().signal } as ExecutionContext
  const search = new SearchTool('.', undefined, vfs)
  assert.equal(await search.execute({ space: 'glob:v:sessions', query: '*' }, context), 'v:sessions/web:one')
  assert.equal(historyReads, 0)
  assert.match(await search.execute({ space: 'grep:v:sessions/web:one', query: 'old needle' }, context), /old needle/)
  assert.equal(historyReads, 1)
})

test('file searches still use real paths and can match literal virtual-path text', async t => {
  if (!await detectRipgrep()) return t.skip('ripgrep is not installed')
  await mkdir(resolve('.tmp'), { recursive: true })
  const home = await mkdtemp(resolve('.tmp', 'search-files-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(resolve(home, 'memory'))
  await writeFile(resolve(home, 'memory', 'lesson.md'), 'Read v:tools for metadata.\n')
  const search = new SearchTool(home)
  const tools = new SessionTools(new Tools(home), home)
  const context = { tools, cwd: home, signal: new AbortController().signal } as ExecutionContext
  assert.match(await search.execute({ space: 'glob:memory', query: '*.md' }, context), /lesson\.md/)
  assert.match(await search.execute({ space: 'grep:*.md', query: 'v:tools' }, context), /Read v:tools for metadata/)
})

test('search keeps the space contract and concise virtual-path boundary', () => {
  const search = new SearchTool('.')
  assert.deepEqual(search.parameters.required, ['space', 'query'])
  assert.equal('sources' in search.parameters.properties, false)
  assert.equal('instance' in search.parameters.properties, false)
  assert(search.description.length <= 180)
  assert.match(search.description, /without activating skills/)
})

test('virtual search preserves continuation and warnings while physical search keeps generic truncation', async t => {
  await withTempWorkspace(async home => {
    const vfs = new VirtualFs()
    vfs.mount('v:memory', 'Memory', () => '', () => [
      { name: 'a.md', content: 'x'.repeat(200), warning: 'incomplete metadata' },
      { name: 'b.md', content: 'x' },
    ])
    const search = new SearchTool(home, undefined, vfs)
    const base = new Tools(home, 40)
    base.register(search)
    const tools = new SessionTools(base, home)
    const context = { tools, cwd: home, signal: new AbortController().signal } as ExecutionContext
    for (const args of [
      { space: 'grep:v:memory', query: 'x' },
      { space: 'glob:v:memory', query: '**' },
      { space: 'glob:', query: 'v:memory/**' },
    ]) {
      const result = requireToolText(await tools.execute('search', { ...args, limit: 1 }, context))
      assert.match(result, /continue with offset: 1/)
      assert.match(result, /Warning: v:memory\/a.md: incomplete metadata/)
      assert.doesNotMatch(result, /\[truncated:/)
    }
    t.mock.method(search, 'execute', async () => 'x'.repeat(200))
    const result = requireToolText(await tools.execute('search', { space: 'grep:*.md', query: 'x' }, context))
    assert.match(result, /\[truncated:/)
  })
})

test('unified search keeps web dispatch, file/web query validation and source errors', async t => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const home = await mkdtemp(resolve('.tmp', 'search-dispatch-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const calls: Record<string, unknown>[] = []
  const web: Tool = {
    name: 'web', description: '', parameters: { type: 'object', properties: {} },
    execute: async args => { calls.push(args); return 'x'.repeat(13_000) },
  }
  const base = new Tools(home)
  base.register(new SearchTool(home, web))
  const tools = new SessionTools(base, home)
  const context = { tools, signal: new AbortController().signal } as ExecutionContext
  const result = await tools.execute('search', { space: 'web:example.com', query: 'docs' }, context)
  assert.deepEqual(calls, [{ query: 'docs site:example.com' }])
  assert.match(requireToolText(result), /\[truncated:/)
  for (const space of ['grep:*.ts', 'glob:src', 'web:']) {
    assert.match(requireToolText(await tools.execute('search', { space }, context)), /query must be a string/)
  }
  for (const space of ['tools:', 'skills:', 'sessions:', 'v:tools', 'unknown:']) {
    assert.match(requireToolText(await tools.execute('search', { space, query: '' }, context)), /unknown search space/)
  }
})

test('file, web and virtual searches are parallel reads', () => {
  const base = new Tools('.')
  base.register(new SearchTool('.'))
  const calls = ['grep:*.ts', 'glob:src', 'web:', 'grep:v:tools', 'glob:v:skills', 'web:example.com']
    .map((space, i) => ({ id: String(i), name: 'search', arguments: { space, query: '' } }))
  const groups = groupTools(calls, base)
  assert.deepEqual(groups.map(group => ({ readonly: group.readonly, ids: group.calls.map(call => call.id) })), [
    { readonly: true, ids: ['0', '1', '2', '3', '4', '5'] },
  ])
  assert.equal(base.isReadonly('search'), true)
})

test('web search reports missing providers and request failures without local setup instructions', async () => {
  const tools = new SessionTools(new Tools('.'), '.')
  const context = { tools, signal: new AbortController().signal } as ExecutionContext
  assert.equal(
    await new SearchTool('.').execute({ space: 'web:', query: 'docs' }, context),
    'Error: web search is not configured for this search tool.',
  )
  const web: Tool = {
    name: 'web', description: '', parameters: { type: 'object', properties: {} },
    execute: async () => { throw new Error('Synthetic network failure') },
  }
  assert.equal(
    await new SearchTool('.', web).execute({ space: 'web:', query: 'docs' }, context),
    'Web search failed: Synthetic network failure\n\n' +
      'Check network access to the search provider and its service status, API credentials, and usage limits.',
  )
})

test('web search preserves cancellation rather than suggesting provider repairs', async () => {
  const controller = new AbortController()
  const tools = new SessionTools(new Tools('.'), '.')
  const context = { tools, signal: controller.signal } as ExecutionContext
  const web: Tool = {
    name: 'web', description: '', parameters: { type: 'object', properties: {} },
    execute: async () => {
      controller.abort()
      throw controller.signal.reason
    },
  }
  await assert.rejects(
    new SearchTool('.', web).execute({ space: 'web:', query: 'docs' }, context),
    { name: 'AbortError' },
  )
})
