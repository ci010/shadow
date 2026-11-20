import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { ReflectionDiary } from './reflection-diary.ts'
import { REFLECTION_DIARY_AUTOMATION, REFLECTION_DIARY_DEFAULT_KEY, REFLECTION_DIARY_ID } from './defaults.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { IdentityManager } from '../agent/identity.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import { physicalSessionId } from '../sessions/session-identity.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { Watermarks } from '../watermarks/store.ts'
import { TestCronService } from './testing.ts'
import { projectStoragePath } from '../utils/data-paths.ts'

const signal = new AbortController().signal
const session = { sessionId: 'web:old', segmentIndex: 0, projectId: 'test' }
const physical = physicalSessionId(session)
const at = '2026-01-02T03:04:05.000Z'
const mark = (id: string, text: string, owner = session.sessionId) => ({ sessionId: owner, id, text, at })
const job = { ...REFLECTION_DIARY_AUTOMATION, id: REFLECTION_DIARY_ID, createdAt: at }

test('reflection retries the same bounded input, then processes new direct inputs in an old session', async () => {
  const root = await mkdtemp(join(process.cwd(), '.test-reflection-'))
  try {
    const store = new JsonlSessionStore(root)
    await store.init()
    await store.saveState(session.sessionId, session)
    await store.createSessionLog(physical, [
      { role: 'user', content: 'FORWARDED' },
      { role: 'assistant', content: 'INTERNAL' },
      { role: 'user', direct_input: mark('copied', 'COPIED', 'web:parent') },
      { role: 'user', direct_input: mark('one', 'A'.repeat(600) + 'TRUNCATED REST') },
    ])
    const previews: string[] = []
    const context = { sessionId: 'cron:fixture', projectId: 'test', signal } as ExecutionContext
    const diary: ReflectionDiary = new ReflectionDiary(root, 'test', store, { dispatch: async (_job, _signal, task, accepted, limits) => {
      assert.deepEqual(limits?.allowedTools, ['reflection_diary'])
      previews.push(task!)
      accepted?.(context.sessionId)
      await assert.rejects(() => diary.execute({ action: 'submit', notes: [{ refs: [2], evidence: 'Out of scope' }] }, context), /outside/)
      if (previews.length <= 2) {
        assert(!task?.includes('TRUNCATED REST'))
        assert.deepEqual(JSON.parse(await diary.execute({ action: 'continue', ref: 1, offset: 600 }, context)),
          { ref: 1, text: 'TRUNCATED REST', nextOffset: null })
      }
      await diary.execute({ action: 'submit', notes: [{ refs: [1], evidence: 'Stated priority', inference: 'Possible future preference' }] }, context)
      if (previews.length === 1) throw new Error('inference failed after staging')
      return context.sessionId
    } })
    const marks = () => new Watermarks(root, 'test', 'reflection-diary-v1').inspect()
    const file = projectStoragePath(root, 'memory', 'reflection-diary.json')
    await assert.rejects(() => diary.run(job, signal), /inference failed/)
    assert.deepEqual(marks().cursors, {})
    const first = marks().batches[0]!.id
    await assert.rejects(() => readFile(file), { code: 'ENOENT' })
    // New input arriving during retry must not widen the failed batch.
    await store.appendRawEvents(physical, [
      { role: 'user', direct_input: mark('one', 'DUPLICATE') },
      { channel_input_admitted: { direct_input: mark('two', 'FRESH USER INPUT') } },
    ])
    await diary.run(job, signal)
    assert.equal(previews[0], previews[1])
    assert(!/FORWARDED|INTERNAL|COPIED/.test(previews[1]!))
    assert.equal(marks().cursors[physical], '4')
    assert.equal(marks().batches[0]!.id, first)
    await assert.rejects(() => diary.execute({ action: 'continue', ref: 1, offset: 600 }, context), /active reflection/)
    await diary.run(job, signal)
    assert.match(previews[2]!, /FRESH USER INPUT/)
    assert.doesNotMatch(previews[2]!, /DUPLICATE/)
    assert.equal(marks().cursors[physical], '6')
    await diary.run(job, signal)
    assert.equal(previews.length, 3)
    const entries = JSON.parse(await readFile(file, 'utf8')).entries
    assert.equal(entries.length, 2)
    assert.equal(entries[0].batchId, first)
    assert.deepEqual(entries.map((entry: { refs: { inputId: string }[] }) => entry.refs[0]!.inputId), ['one', 'two'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('reflection default is a daily Workflow and committed entries repair interrupted acknowledgement', async () => {
  const root = await mkdtemp(join(process.cwd(), '.test-reflection-'))
  const cron = new TestCronService(root)
  try {
    await cron.start()
    await cron.ensureDefaultJob(REFLECTION_DIARY_DEFAULT_KEY, REFLECTION_DIARY_AUTOMATION)
    const definition = cron.workflow.inspect().definitions.find(flow => flow.id === `schedule:${REFLECTION_DIARY_ID}`)
    assert.equal(definition?.name, REFLECTION_DIARY_AUTOMATION.name)
    const configured = cron.listJobs().find(item => item.id === REFLECTION_DIARY_ID)
    assert.equal(configured?.schedule, '0 4 * * *')
    assert.equal(configured?.enabled, false)
    const marks = new Watermarks(root, 'test', 'reflection-diary-v1')
    const batch = marks.prepare(physical, null, '1')
    marks.claim(batch.id, 'interrupted')
    const file = projectStoragePath(root, 'memory', 'reflection-diary.json')
    await mkdir(projectStoragePath(root, 'memory'), { recursive: true })
    const committed = JSON.stringify({ version: 1, entries: [{ batchId: batch.id, at, physicalId: physical, refs: [], notes: [] }] })
    await writeFile(file, committed)
    const store = new JsonlSessionStore(root)
    await store.init()
    const diary: ReflectionDiary = new ReflectionDiary(root, 'test', store, { dispatch: async () => assert.fail('must not dispatch committed batch') })
    await diary.run(job, signal)
    assert.equal(await readFile(file, 'utf8'), committed)
    const recovered = new Watermarks(root, 'test', 'reflection-diary-v1').inspect()
    assert.equal(recovered.batches[0]!.state, 'done')
    assert.equal(recovered.cursors[physical], '1')
  } finally { await cron.stop(); await rm(root, { recursive: true, force: true }) }
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: profile commit resumes the saved plan and preserves manual content`, async () => {
    const root = await mkdtemp(join(process.cwd(), '.test-reflection-'))
    const store = new Store(root)
    try {
      await store.init()
      await store.saveState(session.sessionId, session)
      const identity = new IdentityManager(root, 'test')
      const source = { channel: 'web', senderId: 'owner' }
      const assigned = await identity.assignProfile('web', 'owner', 'Owner')
      const path = join(root, assigned.profilePath)
      const manual = '# Owner\n\n## Preferences\n\nManual entry – keep this.\n'
      await writeFile(path, manual)
      const input = (id: string, text: string, date = at, profileSource = source) => ({
        role: 'user', direct_input: { ...mark(id, text), at: date, profileSource },
      })
      await store.createSessionLog(physical, [
        input('single-request', 'Please be concise.'),
        input('other-account', 'I prefer detailed replies.', at, { channel: 'web', senderId: 'other' }),
        { role: 'user', direct_input: mark('legacy', 'I prefer detailed replies.') },
      ])
      const ctx = { sessionId: 'cron:fixture', projectId: 'test', signal } as ExecutionContext
      let dispatches = 0
      let phase: 'normal' | 'fail' | 'lost-receipt' = 'normal'
      const diary: ReflectionDiary = new ReflectionDiary(root, 'test', store, { dispatch: async (_job, _signal, task, accepted) => {
        dispatches++
        assert(!task?.includes('senderId'))
        accepted?.(ctx.sessionId)
        await assert.rejects(() => diary.execute({ action: 'submit', notes: [], profilePath: 'elsewhere.md' }, ctx))
        await diary.execute({ action: 'submit', notes: [{ refs: [1], evidence: 'Model-supplied claim', inference: 'Speculative label' }] }, ctx)
        return ctx.sessionId
      } }, {
        reflectionProfile: identity.reflectionProfile.bind(identity),
        appendReflectionProfile: async (...args) => {
          if (phase === 'fail') throw new Error('injected profile failure')
          await identity.appendReflectionProfile(...args)
          if (phase === 'lost-receipt') throw new Error('lost profile receipt')
        },
      })
      const cursor = () => new Watermarks(root, 'test', 'reflection-diary-v1').inspect().cursors[physical]
      const entries = async () => JSON.parse(await readFile(projectStoragePath(root, 'memory', 'reflection-diary.json'), 'utf8')).entries
      await diary.run(job, signal)
      assert.equal(cursor(), '3')
      assert.equal(await readFile(path, 'utf8'), manual, 'single request and unscoped evidence do not update a profile')

      await store.appendRawEvents(physical, [input('recurrence', 'Please keep it brief.', '2026-01-03T03:04:05.000Z')])
      phase = 'fail'
      await assert.rejects(() => diary.run(job, signal), /injected profile failure/)
      assert.equal(cursor(), '3')
      assert.equal((await entries()).length, 2, 'diary and profile plan are already saved')
      phase = 'normal'
      const alternate = await identity.assignProfile('web', 'owner', 'Alternate')
      const alternatePath = join(root, alternate.profilePath)
      const alternateBefore = await readFile(alternatePath, 'utf8')
      await assert.rejects(() => diary.run(job, signal), /identity changed/)
      assert.equal(cursor(), '3')
      assert.equal(await readFile(alternatePath, 'utf8'), alternateBefore, 'a pending write cannot follow a relink')
      await identity.assignProfile('web', 'owner', 'Owner')
      const edited = manual + '\nManual edit made between attempts.\n'
      await writeFile(path, edited)
      phase = 'lost-receipt'
      await assert.rejects(() => diary.run(job, signal), /lost profile receipt/)
      assert.equal(cursor(), '3')
      const updated = await readFile(path, 'utf8')
      assert(updated.startsWith(edited))
      assert.match(updated, /Tentative pattern.*recurrence.*single-request/)
      assert.doesNotMatch(updated, /Speculative label|Model-supplied claim/)
      phase = 'normal'
      await diary.run(job, signal)
      assert.equal(cursor(), '4')
      assert.equal(dispatches, 2, 'neither retry dispatches the model')
      assert.equal(await readFile(path, 'utf8'), updated, 'durable receipt prevents duplicate profile append')
      assert.equal((await entries()).length, 2)

      await store.appendRawEvents(physical, [input('explicit', 'I prefer detailed answers.', '2026-01-04T03:04:05.000Z')])
      await diary.run(job, signal)
      const explicit = await readFile(path, 'utf8')
      assert(explicit.startsWith(updated))
      assert.match(explicit, /Explicit preference: prefers detailed replies.*explicit/)
      await store.appendRawEvents(physical, [input('repeat', 'I prefer detailed replies.', '2026-01-05T03:04:05.000Z')])
      await diary.run(job, signal)
      assert.equal(cursor(), '6')
      assert.equal(await readFile(path, 'utf8'), explicit, 'same preference is not written again')
    } finally { if (store instanceof SqliteSessionStore) store.close(); await rm(root, { recursive: true, force: true }) }
  })
}
