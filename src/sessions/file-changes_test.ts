import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyPatch } from 'diff'
import { Bus } from '../bus/bus.ts'
import type { ChatMessage, LLMProvider, LLMResponse } from '../providers/provider.ts'
import type { LlmRuntimeConfig } from '../agent/llm-config.ts'
import { bindScriptTools } from '../script-runtime/bridge.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { recordedFileChange } from '../tools/file-change.ts'
import { WriteTool } from '../tools/filesystem.ts'
import { ToolOutcomeUnknownError } from '../tools/tool.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { BaseSession } from './base-session.ts'
import { fileChangeSchema, MAX_FILE_CHANGE_CHARS, parseFilePatch, formatFilePatch } from './file-change-contract.ts'
import { readSessionFileChange, readSessionFileChanges } from './file-changes.ts'
import { ViewEditTool } from '../tools/view-edit.ts'
import { physicalSessionId } from './session-identity.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionState, SessionStore } from './session-store.ts'

class TestSession extends BaseSession {
  run(context: ExecutionContext) {
    return this.runLlmLoop(context, { model: 'fixture', contextWindow: 128_000, temperature: 0 }, context.signal)
  }
}
class CompactingSession extends TestSession {
  protected override async appendMessages(llm: LlmRuntimeConfig, ...messages: ChatMessage[]): Promise<void> {
    if (this.state.segmentIndex === 0 && messages.some(message => message.role === 'assistant' && message.tool_calls?.length)) {
      const previous = this.physicalSessionId
      this.state.segmentIndex++
      await this.store.saveState(this.id, this.state)
      await this.store.createSessionLog(this.physicalSessionId, [{ sessionId: this.id, previous_physical_id: previous }])
    }
    await super.appendMessages(llm, ...messages)
  }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  for (const mode of ['session', 'task', 'call'] as const) {
    test(`${Store.name}: ${mode} persists memory writes and nested script writes without adding diffs to provider history`, async () => {
      await withTempWorkspace(async root => {
        const directory = join(root, 'sessions')
        const store: SessionStore = new Store(directory)
        await store.init()
        const state: SessionState = { sessionId: 'web:writer', segmentIndex: 0, physicalIdVersion: 2, mode }
        await store.saveState(state.sessionId, state)
        await store.createSessionLog(physicalSessionId(state), [{ sessionId: state.sessionId }])
        await mkdir(join(root, 'memory'))
        await writeFile(join(root, 'memory', 'notes.md'), 'context\n  old  \r\n')
        const tools = new Tools(root)
        tools.register(new WriteTool(root))
        tools.register(new ViewEditTool())
        tools.register({
          name: 'exec', description: '', parameters: { type: 'object', properties: {} },
          async execute(_args, context) {
            const binding = bindScriptTools(context)
            try { return String(await binding.call('write', { path: join(root, 'memory', 'notes.md'), flag: 'a', content: 'tail\n' }, context.signal)) }
            finally { await binding.cleanup() }
          },
        })
        const sessionTools = new SessionTools(tools, root)
        const responses: LLMResponse[] = [
          { content: '', toolCalls: [{ id: 'direct', name: 'write', arguments: { path: join(root, 'memory', 'notes.md'), match: '\told', content: 'new' } }] },
          { content: '', toolCalls: [{ id: 'script', name: 'exec', arguments: {} }] },
        ]
        let requestedDetail = false
        const provider: LLMProvider = { name: 'fixture', listModels: () => ['fixture'], async chat(messages) {
          assert.ok(messages.every(message => !('file_change' in message)))
          const next = responses.shift()
          if (next) return next
          if (!requestedDetail) {
            const receipts = messages.filter(message => message.role === 'tool').map(message => String(message.content))
            assert.ok(receipts.every(text => !text.includes('@@')))
            const id = /edit=(\S+)/.exec(receipts.at(-1)!)?.[1]
            assert.ok(id)
            requestedDetail = true
            return { content: '', toolCalls: [{ id: 'detail', name: 'view_edit', arguments: { edit_id: id } }] }
          }
          assert.match(String(messages.find(message => message.tool_call_id === 'detail')?.content), /^@@ /)
          return { content: 'Done', toolCalls: [] }
        } }
        const context: ExecutionContext = {
          sessionId: state.sessionId, physicalSessionId: physicalSessionId(state), cwd: join(root, 'effective-workdir'),
          channel: 'test', chatId: 'fixture', senderId: 'fixture', messageId: 'turn',
          signal: new AbortController().signal, tools: sessionTools,
        }
        let closed = false
        try {
          const Session = mode === 'session' ? CompactingSession : TestSession
          const session = new Session(root, state.sessionId, state, [], provider, sessionTools, new Bus(), store)
          await session.run(context)
          const page = await readSessionFileChanges(store, state, 0, 30, context.signal)
          assert.equal(page.total, 2)
          assert.equal(page.changes[0].mode, 'append')
          assert.notEqual(page.changes[0].toolCallId, 'script', 'Nested calls retain their own invocation identity')
          assert.ok(page.changes[0].patch.includes('+tail'))
          assert.ok(page.changes[1].patch.includes('-  old  '), 'Use actual fuzzy-matched file contents, not requested match text')
          assert.ok(page.changes[1].patch.includes('+new'))
          assert.equal(page.changes[1].toolCallId, 'direct')
          const ownChanges = []
          for await (const event of store.readSessionLog(session.physicalSessionId)) if (event.file_change) ownChanges.push(event)
          assert.equal(ownChanges.length, 2, 'Capture follows the invocation segment, even when appending the assistant compacted the session')
          assert.ok(session.history.filter(message => message.role === 'tool').every(message => typeof message.content === 'string'))
          const receipts = session.history.filter(message => message.role === 'tool' && message.tool_call_id !== 'detail').map(message => String(message.content))
          assert.ok(receipts.every(text => text.startsWith('OK ')))
          assert.ok(receipts.every(text => !text.includes('@@') && !text.includes('+tail') && !text.includes('-  old')))
          assert.ok(receipts.some(text => text.includes(`edit=${page.changes[1].id}`)))
          await writeFile(join(root, 'memory', 'notes.md'), 'Later unrelated edit')
          assert.deepEqual(await readSessionFileChanges(store, state, 0, 30, context.signal), page)
          store.close?.()
          closed = true
          const reopened: SessionStore = new Store(directory)
          try {
            assert.deepEqual(await readSessionFileChanges(reopened, state, 0, 30, context.signal), page)
            const detailContext = { ...context, readFileChange: (id: string) => readSessionFileChange(reopened, state, id, context.signal) }
            assert.equal(await new ViewEditTool().execute({ edit_id: page.changes[1].id }, detailContext), page.changes[1].patch)
          }
          finally { reopened.close?.() }
        } finally { if (!closed) store.close?.() }
      })
    })
  }

  test(`${Store.name}: pagination and detail lookup span own segments, exclude parents and do not reconstruct legacy writes`, async () => {
    await withTempWorkspace(async root => {
      const store: SessionStore = new Store(join(root, 'sessions'))
      const state: SessionState = { sessionId: 'web:child', segmentIndex: 1, physicalIdVersion: 2, parent: { id: 'web:parent' } }
      const signal = new AbortController().signal
      try {
        await store.init()
        for (let segment = 0; segment < 2; segment++) {
          await store.createSessionLog(physicalSessionId(state, segment), [{ sessionId: state.sessionId }])
          await store.appendRawEvents(physicalSessionId(state, segment), [{
            file_change: recordedFileChange({ sessionId: state.sessionId, toolCallId: `call-${segment}`, path: 'memory/notes.md', mode: 'write', before: 'old', after: `new-${segment}` }),
          }])
        }
        const parentChange = recordedFileChange({ sessionId: 'web:parent', toolCallId: 'parent', path: 'private-parent.md', mode: 'write', before: '', after: 'parent' })
        await store.createSessionLog(physicalSessionId({ ...state, sessionId: 'web:parent', segmentIndex: 0 }), [{ file_change: parentChange }])
        await store.appendRawEvents(physicalSessionId(state), [
          { role: 'assistant', tool_calls: [{ id: 'legacy', function: { name: 'invoke_tool', arguments: JSON.stringify({ name: 'write', args: { path: 'old-memory.md', match: 'requested-old', content: 'requested-new' } }) } }] },
          { role: 'tool', tool_call_id: 'legacy', content: 'Success: edit old-memory.md' },
          { role: 'assistant', tool_calls: [{ id: 'failed', function: { name: 'write', arguments: JSON.stringify({ path: 'failed.md', content: 'bad' }) } }] },
          { role: 'tool', tool_call_id: 'failed', content: 'Error: no write happened' },
        ])
        const page = await readSessionFileChanges(store, state, 0, 1, signal)
        assert.equal(page.total, 2)
        assert.equal(page.changes[0].toolCallId, 'call-1')
        const remaining = await readSessionFileChanges(store, state, 1, 30, signal)
        assert.deepEqual(remaining.changes.map(change => change.toolCallId), ['call-0'])
        const filtered = await readSessionFileChanges(store, state, 0, 30, signal, 'call-0')
        assert.equal(filtered.total, 1)
        assert.deepEqual(filtered.changes.map(change => change.toolCallId), ['call-0'])
        const legacyFiltered = await readSessionFileChanges(store, state, 0, 30, signal, 'legacy')
        assert.equal(legacyFiltered.total, 0)
        assert.equal((await readSessionFileChange(store, state, remaining.changes[0].id, signal))?.toolCallId, 'call-0')
        assert.equal(await readSessionFileChange(store, state, parentChange.id, signal), undefined)
        assert.deepEqual(await readSessionFileChanges(store, state, 0, 30, signal, 'parent'), { changes: [], total: 0, offset: 0 })
        assert.deepEqual(await readSessionFileChanges(store, state, 1, 30, signal, 'call-0'), { changes: [], total: 1, offset: 1 })
        assert.equal((await readSessionFileChanges(store, state, 0, 30, signal, 'failed')).total, 0)
        assert.equal((await readSessionFileChanges(store, state, 10, 30, signal)).changes.length, 0)
        await assert.rejects(readSessionFileChanges(store, state, 0, 30, AbortSignal.abort()), /abort/i)
      } finally { store.close?.() }
    })
  })
}

test('recorded diffs validate their hunks, Unicode, no-newline markers, no-op and explicit bounded failures', () => {
  const base = { sessionId: 'web:fixture', toolCallId: 'write', path: 'memory/notes.md', mode: 'write' as const }
  for (const [before, after] of [['old', '\u4f60\u597d'], ['', 'new'], ['old', ''], ['', 'new\n'], ['old\n', ''], ['', ''], ['same', 'same'], ['one\r\nold\r\n', 'one\nnew\n']]) {
    const change = recordedFileChange({ ...base, before, after })
    assert.ok(fileChangeSchema.safeParse(change).success)
    assert.equal(formatFilePatch(parseFilePatch(change.patch)), change.patch)
    if (change.patch) assert.equal(applyPatch(before.replaceAll('\r\n', '\n'), change.patch), after.replaceAll('\r\n', '\n'))
    assert.ok(!('hunks' in change))
  }
  const unknown = recordedFileChange({ ...base, after: 'new', unavailable: 'Previous content was not readable.' })
  assert.equal(unknown.patch, '')
  assert.equal(unknown.writtenContent, 'new')
  assert.match(unknown.unavailable!, /not readable/)
  const huge = recordedFileChange({ ...base, before: 'a'.repeat(2 * 1024 * 1024), after: 'b' })
  assert.match(huge.unavailable!, /size limit/)
  const outputLimit = recordedFileChange({ ...base, before: 'old'.repeat(MAX_FILE_CHANGE_CHARS), after: 'new'.repeat(MAX_FILE_CHANGE_CHARS) })
  assert.ok(outputLimit.unavailable)
  assert.ok(fileChangeSchema.safeParse(outputLimit).success)
  const invalid = { ...unknown, patch: '@@ -1,10 +1,1 @@\n+new\n' }
  assert.equal(fileChangeSchema.safeParse(invalid).success, false)
  for (const patch of ['junk\n', '@@ -1,1 +1,1 @@\n-old\n', '--- a\n+++ b\n@@ -1,1 +1,1 @@\n-a\n+b\n']) {
    assert.equal(fileChangeSchema.safeParse({ ...unknown, patch }).success, false)
  }
  const multi = recordedFileChange({ ...base, before: 'old\n' + 'same\n'.repeat(20) + 'end\n', after: 'new\n' + 'same\n'.repeat(20) + 'tail\n' })
  assert.equal(parseFilePatch(multi.patch).length, 2)
  assert.ok(JSON.stringify({ patch: multi.patch }).length < JSON.stringify({ hunks: parseFilePatch(multi.patch) }).length)
})

test('writes rejected before I/O create no records; cancellation after successful I/O still retains the observed write', async () => {
  await withTempWorkspace(async root => {
    const tools = new Tools(root)
    const controller = new AbortController()
    const records: unknown[] = []
    const context: ExecutionContext = {
      sessionId: 'web:fixture', physicalSessionId: 'fixture-0', toolCallId: 'write', cwd: root,
      channel: 'test', chatId: 'fixture', senderId: 'fixture', messageId: 'turn',
      signal: controller.signal, tools: new SessionTools(tools, root),
      async recordFileChange(change) { records.push(change); controller.abort() },
    }
    const tool = new WriteTool(root)
    assert.match(await tool.execute({ path: 'missing', match: 'old', content: 'new' }, context), /^Error:/)
    assert.equal(records.length, 0)
    await assert.rejects(tool.execute({ path: 'notes.md', content: 'new' }, context), /abort/i)
    assert.equal(records.length, 1)
    assert.equal(await readFile(join(root, 'notes.md'), 'utf8'), 'new')
  })
})

test('capture preserves actual UTF-8 encoding and persistence failure stops retries after successful file I/O', async () => {
  await withTempWorkspace(async root => {
    const changes: unknown[] = []
    const tools = new Tools(root)
    const tool = new WriteTool(root)
    tools.register(tool)
    const context: ExecutionContext = {
      sessionId: 'web:fixture', physicalSessionId: 'fixture-0', toolCallId: 'write', cwd: root,
      channel: 'test', chatId: 'fixture', senderId: 'fixture', messageId: 'turn',
      signal: new AbortController().signal, tools: new SessionTools(tools, root),
      async recordFileChange(change) { changes.push(change) },
    }
    await tool.execute({ path: 'unicode.md', content: '\uD800' }, context)
    const change = fileChangeSchema.parse(changes[0])
    assert.ok(change.patch.includes('+\uFFFD'))
    assert.equal(await readFile(join(root, 'unicode.md'), 'utf8'), '\uFFFD')
    context.recordFileChange = async () => { throw new Error('Synthetic persistence failure') }
    await assert.rejects(tools.execute('write', { path: 'saved.md', content: 'already saved' }, context),
      error => error instanceof ToolOutcomeUnknownError && /file was written/.test(error.message))
    assert.equal(await readFile(join(root, 'saved.md'), 'utf8'), 'already saved')
  })
})
