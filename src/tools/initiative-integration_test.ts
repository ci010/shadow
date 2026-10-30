import { DatabaseSync } from 'node:sqlite'
import { projectStoragePath } from '../utils/data-paths.ts'
import { requireToolText } from './tool.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { InitiativeStore } from '../initiatives/store.ts'
import { INITIATIVE_SCHEMA_PROMPT } from '../initiatives/schema.ts'
import { InitiativeTool } from './initiative.ts'
import { ImportTool } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import { Tools, SessionTools } from './registry.ts'
import type { ExecutionContext } from './context.ts'

for (const remote of [false, true]) {
  test(`Initiative SQL uses lazy invocation and Project Home (${remote ? 'remote' : 'local'} workdir)`, async () => {
    await withTempWorkspace(async root => {
      const home = join(root, 'one')
      new InitiativeStore(home).close()
      const archive = new DatabaseSync(projectStoragePath(home, 'initiatives.sqlite'))
      archive.exec('PRAGMA user_version=5')
      archive.close()
      const store = new InitiativeStore(home, { isSessionKnown: id => id === 'web:actor' })
      const other = new InitiativeStore(join(root, 'two'))
      const base = new Tools(home)
      const importer = new ImportTool(new Map([
        ['initiative', new InitiativeTool(store, 'one', INITIATIVE_SCHEMA_PROMPT)],
      ]), home)
      base.register(importer)
      base.register(new InvokeTool(importer))
      const tools = new SessionTools(base, home)
      const context: ExecutionContext = {
        projectId: 'one', sessionId: 'web:actor', physicalSessionId: 'web_actor-0',
        channel: 'web', chatId: 'actor', senderId: 'user', messageId: 'message',
        tools, signal: new AbortController().signal,
        ...(remote ? { remoteWorkdir: {
          nodeId: 'child', workdirId: 'folder',
          executor: {
            execute() { throw new Error('Must not execute against remote files') },
            async getStatus() { throw new Error('Must not inspect remote execution') },
            async cancel() { throw new Error('Must not cancel remote execution') },
          },
        } } : {}),
      }
      try {
        const invoke = (query: string, ctx = context) =>
          tools.execute('invoke_tool', { name: 'initiative', args: { query } }, ctx)
        const text = 'x'.repeat(14_000)
        const created = JSON.parse(requireToolText(await invoke(
          `INSERT INTO initiatives (id,title,goal,context) VALUES ('work','Work','Finish','${text}');`,
        )))
        assert.equal(created.changes, 1)
        assert.match(requireToolText(await invoke(
          "INSERT INTO initiatives (id,title,goal) VALUES ('foreign','Foreign','Must reject')",
          { ...context, sessionId: 'web:foreign' },
        )), /Owner\/assignee target session is not known in this Project/)
        assert.deepEqual(store.query("SELECT id FROM initiatives WHERE id='foreign'", 'web:actor').results[0].rows, [])
        const queried = JSON.parse(requireToolText(await invoke("SELECT context FROM initiatives WHERE id='work'")))
        assert.equal(queried.results[0].rows[0].context, text)
        assert.equal(other.query('SELECT id FROM initiatives', 'web:actor').results[0].rows.length, 0)
        assert.match(requireToolText(await invoke('SELECT id FROM initiatives', { ...context, projectId: 'two' })), /owning Project/)
        if (remote) {
          assert.match(requireToolText(await tools.execute('import_tool', { source: 'module.ts' }, context)), /only the built-in/)
          assert.match(requireToolText(await tools.execute('invoke_tool', { name: 'other', args: {} }, context)), /only the built-in/)
          await importer.updateMcpServers([{ name: 'initiative', transport: 'stdio', command: 'must-not-run' }])
          assert.equal(importer.canInvokeFromRemote('initiative'), false)
          assert.match(requireToolText(await invoke('SELECT id FROM initiatives')), /only the built-in/)
          await importer.updateMcpServers([])
          assert.equal(importer.canInvokeFromRemote('initiative'), true)
        }
      } finally {
        tools.resetDynamic()
        store.close()
        other.close()
      }
    })
  })
}
