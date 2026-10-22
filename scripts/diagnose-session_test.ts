import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { withTempWorkspace } from '../src/testing/workspace.ts'
import { JsonlSessionStore } from '../src/sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../src/sessions/session-store-sqlite.ts'

const execute = promisify(execFile)
for (const storage of ['jsonl', 'sqlite'] as const) {
  test(`offline diagnosis CLI exports ${storage} evidence without overwriting files`, async () => {
    await withTempWorkspace(async root => {
      const store = storage === 'jsonl' ? new JsonlSessionStore(root) : new SqliteSessionStore(root)
      try {
        await store.saveState('web:case', { sessionId: 'web:case', segmentIndex: 0, projectId: 'one' })
        await store.createSessionLog('web_case-0', [
          { role: 'user', content: 'MCP installation case' },
          { role: 'tool', tool_call_id: 'call', content: '{"clientSecret":"do-not-export"}' },
        ])
      } finally {
        if (store instanceof SqliteSessionStore) store.close()
      }
      const out = join(root, 'diagnosis.json')
      const args = [
        '--import', 'tsx', resolve('scripts', 'diagnose-session.ts'), '--sessions-dir', root,
        '--storage', storage, '--session', 'web:case', '--project', 'one', '--out', out,
      ]
      await execute(process.execPath, args)
      const json = await readFile(out, 'utf8')
      const result = JSON.parse(json)
      assert.equal(result.session.sessionId, 'web:case')
      assert.equal(result.history.records.length, 2)
      assert.equal(result.trace.available, false)
      assert.ok(!json.includes('do-not-export'))
      await assert.rejects(execute(process.execPath, args), /EEXIST/)
      assert.equal(await readFile(out, 'utf8'), json)
    })
  })
}
