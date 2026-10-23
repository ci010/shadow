import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { withTempWorkspace } from '../src/testing/workspace.ts'
import { buildBackend } from './backend-build.ts'
import { backendEntries, compileBackend } from './backend-bundle.ts'

async function fixture(root: string): Promise<void> {
  if (process.platform === 'win32') {
    const repository = fileURLToPath(new URL('..', import.meta.url))
    const source = join(repository, 'integrations/agent-desktop')
    const target = join(root, 'integrations/agent-desktop')
    await mkdir(target, { recursive: true })
    for (const path of [`artifacts/win32-${process.arch}`, 'LICENSE', 'NOTICE']) {
      await cp(join(source, path), join(target, path), { recursive: true })
    }
  }
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  for (const entry of backendEntries.filter(name => name !== 'index')) {
    const file = join(root, 'src', entry + (entry === 'utils/image-codec-worker' ? '.js' : '.ts'))
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, 'export {}')
  }
  await writeFile(join(root, 'tsconfig.build.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', types: ['node'],
      allowImportingTsExtensions: true, noEmit: true,
    },
    include: ['src/**/*.ts'], exclude: ['src/**/*_test.ts', 'src/testing/**'],
  }))
}

test('backend build emits runnable JS, copies nested instruction assets and removes stale output', async () => {
  await withTempWorkspace(async root => {
    await fixture(root)
    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, 'dist', 'stale.js'), 'stale')
    await writeFile(join(root, 'src', 'index.ts'), [
      "export { value } from './value.ts'",
      "import { value } from './value.ts'",
      'export const staticValue = value',
      'export const logicalUrl: string = import.meta.url',
      'export const logicalDirectory: string = import.meta.dirname',
      'export const literal: string = "import.meta.url"',
      "export async function dynamicValue() { return (await import('./value.ts')).value }",
      "export class LazyValue { async read() { return (await import('./value.ts')).value } }",
    ].join('\n'))
    await writeFile(join(root, 'src', 'value.ts'), 'export const value: number = 42\n')
    await writeFile(join(root, 'src', 'example_test.ts'), 'const broken: number = "not compiled"\n')
    for (const [path, text] of [
      ['skills/builtin/example/SKILL.md', 'instruction'],
      ['agent/types/builtin/example/AGENT.md', 'agent'],
      ['__snapshots__/fixture.snap', 'snapshot'],
      ['testing/fixture.json', '{}'],
    ]) {
      const file = join(root, 'src', path)
      await mkdir(join(file, '..'), { recursive: true })
      await writeFile(file, text)
    }
    await buildBackend(root)
    // Native Node (no tsx loader) must resolve static imports, re-exports and lazy imports.
    const indexUrl = pathToFileURL(join(root, 'dist', 'src', 'index.js')).href
    const emitted = await readFile(join(root, 'dist/src/index.js'), 'utf8')
    assert.doesNotMatch(emitted, /\.ts['"]/)
    await assert.rejects(readFile(join(root, 'src/index.js')), { code: 'ENOENT' })
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const built = await import(${JSON.stringify(indexUrl)});
      assert.equal(built.value, 42);
      assert.equal(built.logicalUrl, ${JSON.stringify(indexUrl)});
      assert.equal(built.logicalDirectory, ${JSON.stringify(join(root, 'dist/src'))});
      assert.equal(built.literal, 'import.meta.url');
      assert.equal(built.staticValue, 42);
      assert.equal(await built.dynamicValue(), 42);
      assert.equal(await new built.LazyValue().read(), 42);
    `], { cwd: root, stdio: 'pipe' })
    assert.equal(await readFile(join(root, 'dist/src/skills/builtin/example/SKILL.md'), 'utf8'), 'instruction')
    assert.equal(await readFile(join(root, 'dist/src/agent/types/builtin/example/AGENT.md'), 'utf8'), 'agent')
    for (const path of ['stale.js', 'src/example_test.js', 'src/__snapshots__/fixture.snap', 'src/testing/fixture.json']) {
      await assert.rejects(readFile(join(root, 'dist', path)), { code: 'ENOENT' })
    }
  })
})

test('backend build rejects compilation failures instead of copying success-shaped assets', async () => {
  await withTempWorkspace(async root => {
    await fixture(root)
    await writeFile(join(root, 'src/index.ts'), 'const value: number = "invalid"\n')
    await writeFile(join(root, 'src/SKILL.md'), 'not yet built')
    await assert.rejects(buildBackend(root))
    await assert.rejects(readFile(join(root, 'dist/src/index.js')), { code: 'ENOENT' })
    await assert.rejects(readFile(join(root, 'dist/src/SKILL.md')), { code: 'ENOENT' })
  })
})

test('built session routes and usage aggregates run with native Node', async () => {
  await withTempWorkspace(async root => {
    const repository = fileURLToPath(new URL('..', import.meta.url))
    const output = join(root, 'dist', 'src')
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await compileBackend(repository, join(root, 'dist'), ['sessions/session-manager', 'sessions/routes'])
    const managerUrl = pathToFileURL(join(output, 'sessions', 'session-manager.js')).href
    const routesUrl = pathToFileURL(join(output, 'sessions', 'routes.js')).href
    const change = {
      version: 1, id: 'edit-fixture', sessionId: 'web:patch-fixture', toolCallId: 'saved-write',
      path: 'notes.md', mode: 'edit',
      patch: '@@ -1,1 +1,1 @@\n-Old content\n+Written content\n',
    }
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { Hono } from 'hono';
      import { SessionManager } from ${JSON.stringify(managerUrl)};
      import { sessionsApiPlugin } from ${JSON.stringify(routesUrl)};
      const change = ${JSON.stringify(change)};
      const { sessionId } = change;
      const manager = {
        readSessionState: async id => id === sessionId ? { sessionId, segmentIndex: 0 } : null,
        store: { async *readSessionLog(id) {
          assert.equal(id, 'web_patch-fixture-0');
          yield { role: 'assistant', tool_calls: [{ id: 'old-write',
            function: { name: 'write', arguments: JSON.stringify({ path: 'notes.md', content: 'Written content' }) } }] };
          yield { role: 'tool', tool_call_id: 'old-write', content: 'Success: write notes.md' };
          yield { file_change: change };
        } },
        getFileChanges: SessionManager.prototype.getFileChanges,
      };
      const app = new Hono();
      sessionsApiPlugin(manager)(app);
      const response = await app.request('/api/sessions/web%3Apatch-fixture/file-changes?toolCallId=saved-write');
      assert.equal(response.status, 200, await response.clone().text());
      const page = await response.json();
      assert.equal(page.total, 1);
      assert.deepEqual(page.changes, [change]);
      const legacy = await app.request('/api/sessions/web%3Apatch-fixture/file-changes?toolCallId=old-write');
      assert.equal(legacy.status, 200);
      assert.deepEqual(await legacy.json(), { changes: [], total: 0, offset: 0 });
      // Regression: dynamic TS imports in classes must work after Vite bundling.
      // Exercise the actual v:stats aggregate under native Node, using only synthetic logs.
      const state = { sessionId: 'web:stats-fixture', projectId: 'fixture', segmentIndex: 0 };
      const usageManager = Object.create(SessionManager.prototype);
      Object.assign(usageManager, {
        sessionStates: { [state.sessionId]: state },
        listHistoryStates: async () => [state],
        readSessionState: async id => id === state.sessionId ? state : undefined,
        deps: { projectId: 'fixture', store: { async *readSessionLog(id) {
          assert.equal(id, 'web_stats-fixture-0');
          yield { type: 'model_usage', sessionId: state.sessionId, id: 'usage-fixture',
            timestamp: '2026-10-10T12:00:00Z',
            usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } };
        } } },
      });
      const usage = await usageManager.getProfileUsage([state.sessionId],
        Date.parse('2026-10-10T00:00:00Z'), Date.parse('2026-10-11T00:00:00Z'));
      assert.equal(usage.providerCalls, 1);
      assert.equal(usage.totalTokens, 6);
      assert.equal(usage.trackedSessions, 1);
      console.log('BUILT_FILE_DIFF_AND_STATS_OK');
    `], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
    assert.match(result, /BUILT_FILE_DIFF_AND_STATS_OK/)
  })
})
