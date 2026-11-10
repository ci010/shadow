import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LEARNING_LIMITS, LearningRuntime, learningTask } from './pipelines.ts'
import { LearningTools } from './tools.ts'
import { fakeSessions } from './test-fixtures.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { Tools, SessionTools } from '../../tools/registry.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import { projectStoragePath } from '../../utils/data-paths.ts'

// The role may be overridden or an old tool may still be registered. The host
// allowlist, not the prompt or available tool definitions, must stop bypasses.
test('reflector host allowlist denies generic writes regardless of path and role advertisement', async () => withTempWorkspace(async workspace => {
  const base = new Tools(workspace)
  let writes = 0
  base.register({ name: 'write', description: 'legacy writer', parameters: { type: 'object', properties: {} },
    execute: async () => { writes++; return 'unexpected write' } })
  const tools = new SessionTools(base, workspace, ['write'])
  tools.setTrustedLimits(LEARNING_LIMITS.reflector)
  const context = { tools, sessionId: 'fixture', signal: new AbortController().signal } as ExecutionContext
  for (const path of ['v:memory/topics/skill-reading-interface.md', 'memory/topics/skill-reading-interface.md',
    join(workspace, 'memory/topics/skill-reading-interface.md'), 'v:memory/concepts/example.md',
    'v:memory/identities/example.md', 'v:memory/tools/example.md', 'v:memory/other/example.md']) {
    const attempt = new SessionTools(base, workspace, ['write'])
    attempt.setTrustedLimits(LEARNING_LIMITS.reflector)
    for (const edit of [{}, { match: 'old' }, { flag: 'a' }]) {
      assert.match(String(await attempt.execute('write', { path, content: 'new', ...edit }, { ...context, tools: attempt })), /trusted one-shot allowlist/)
    }
  }
  assert.match(tools.executionDenial('invoke_tool', { name: 'write', args: {} })!, /trusted one-shot allowlist/)
  assert.equal(writes, 0)
  const role = await readFile(new URL('../types/builtin/reflector/AGENT.md', import.meta.url), 'utf8')
  assert.match(role, /allowedTools: \[read, search, view_edit, log, learning_memory, learning_result\]/)
  assert.doesNotMatch(role, /use write to merge|Direct write to existing wiki/)
}))

test('routed correction survives interruption with attribution and exact provenance; no premature acknowledgement', async () => withTempWorkspace(async workspace => {
  const f = fakeSessions(workspace, [{ sessionId: 'web:source', segmentIndex: 0, total: 6 }])
  const runtime = new LearningRuntime(f.sessions, 'a')
  const learning = new LearningTools(runtime)
  const batch = runtime.ledger.create('reflector', [{ sessionId: 'web:source', physicalId: 'source-0', segmentIndex: 0, offset: 0, end: 6 }], [])
  runtime.ledger.bind(batch.id, 'cron:route')
  f.records.set('cron:route', { sessionId: 'cron:route', segmentIndex: 0, projectId: 'a' })
  const base = new Tools(workspace)
  base.register(learning.memory); base.register(learning.result)
  const tools = new SessionTools(base, workspace, ['learning_memory', 'learning_result'])
  tools.setTrustedLimits(LEARNING_LIMITS.reflector)
  const context = { sessionId: 'cron:route', projectId: 'a', tools, signal: new AbortController().signal } as ExecutionContext
  const draft = { action: 'save_wiki', path: 'topics/targeting-correction.md', revision: '',
    content: '# Targeting correction\n\nSynthetic parent report: explicit Mac and Windows Folder targeting failed while default local access worked. The general access-failure hypothesis is withdrawn; distinguish explicit targeting from default access in the next reproduction. Cause, fix and deployment remain unknown. Revalidate after target-resolution changes; do not infer remote readiness from local success.',
    summary: 'Parent reports explicit Folder targeting failure despite working default access; cause remains unknown.',
    wikiEvidence: [{ sessionId: 'web:source', physicalId: 'source-0', offset: 2, end: 4 }] }
  const missing = JSON.parse(String(await tools.execute('learning_memory', { action: 'read_wiki', path: draft.path }, context)))
  assert.equal(missing.revision, '')
  for (const evidence of [ { ...draft.wikiEvidence[0], physicalId: 'stale-segment' }, { ...draft.wikiEvidence[0], end: 7 } ]) {
    assert.match(String(await tools.execute('learning_memory', { ...draft, wikiEvidence: [evidence] }, context)), /inside an assigned source/)
  }
  assert.equal(runtime.ledger.batch(batch.id).artifacts.length, 0)
  const append = learning.appendLog.bind(learning)
  learning.appendLog = () => { throw new Error('provenance append interrupted') }
  assert.match(String(await tools.execute('learning_memory', draft, context)), /provenance append interrupted/)
  learning.appendLog = append
  const pending = new LearningTools(new LearningRuntime(f.sessions, 'a'))
  // Exact replay is supported even with the original empty revision.
  const receipt = JSON.parse(String(await pending.memory.execute(draft, context)))
  assert.equal(receipt.verified, true)
  await pending.memory.execute(draft, context)
  const restarted = new LearningRuntime(f.sessions, 'a')
  const retained = restarted.ledger.batch(batch.id)
  assert.equal(retained.artifacts.length, 1)
  assert.equal(retained.events.length, 1)
  assert.equal(retained.proposal, undefined)
  assert.equal(restarted.ledger.cursor(batch.sources[0]), 0)
  assert.match(learningTask(retained), /Recovery: these effects already persisted/)
  assert.match(learningTask(retained), /generic write is unavailable/)
  const content = await readFile(projectStoragePath(workspace, 'memory', draft.path), 'utf8')
  assert.match(content, /general access-failure hypothesis is withdrawn/)
  assert.match(content, /next reproduction.*Cause, fix and deployment remain unknown/)
  assert.equal(content.split('source-0 messages [2, 4)').length - 1, 1)
  await assert.rejects(pending.result.execute({ status: 'no_change', summary: 'Duplicate page' }, context), /persisted effects/)
  await pending.result.execute({ status: 'partial', summary: 'Correction retained; [0,2) and [4,6) remain unread. No verified cause or fix.' }, context)
  assert.equal(new LearningRuntime(f.sessions, 'a').ledger.batch(batch.id).proposal?.status, 'partial')
  assert.equal(new LearningRuntime(f.sessions, 'a').ledger.cursor(batch.sources[0]), 0)
}))
