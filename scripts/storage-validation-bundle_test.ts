import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { compileBackend, backendEntries } from './backend-bundle.ts'
import { BackendStartupDiagnostics } from '../desktop/src/sidecar/backend-startup-diagnostics.ts'
import { StartupDiagnosticsLog } from '../desktop/src/sidecar/startup-diagnostics.ts'

test('real Vite chunks retain focus and legacy Work TypeError frames through desktop disk sink', { timeout: 120_000 }, async () => {
  const root = resolve('.')
  const scratch = process.env.SHADOW_SESSION_DATA_DIR ?? join(root, '.tmp')
  await mkdir(scratch, { recursive: true })
  const temporary = await mkdtemp(join(scratch, 'storage-bundle-'))
  const dist = join(temporary, 'dist')
  // Multiple real production modules force shared chunks, using the actual build pipeline.
  await compileBackend(root, dist, [...backendEntries, 'projects/session-ownership', 'projects/catalog', 'utils/data-paths'])
  const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(join(dist, 'src', name + '.js')).href)
  const runner = join(temporary, 'fixture.mjs')
  await writeFile(runner, `
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reserveRemoteSessionWorkdirs } from ${moduleUrl('projects/session-ownership')};
import { ProjectCatalog } from ${moduleUrl('projects/catalog')};
import { projectStoragePath } from ${moduleUrl('utils/data-paths')};
const home = join(process.argv[2], 'private-home');
const catalog = new ProjectCatalog(join(process.argv[2], 'catalog'));
await catalog.init();
const directory = projectStoragePath(home, '.sessions');
await mkdir(directory, { recursive: true });
const target = join(directory, 'private-session.json');
for (const fields of [{ focus: { secret: 'private-value' } }, { initiativeName: 'private-value' }]) {
  const raw = JSON.stringify({ ownershipVersion: 2, projectId: 'private-project', sessionId: 'private-session', segmentIndex: 0, ...fields });
  await writeFile(target, raw);
  await assert.rejects(reserveRemoteSessionWorkdirs(home, catalog, 'private-project'), TypeError);
  assert.equal(await readFile(target, 'utf8'), raw);
  assert.deepEqual(catalog.remoteClaims(), []);
}
`)
  // No tsx loader or source maps: execute the emitted JavaScript in plain Node.
  const child = spawnSync(process.execPath, [runner, temporary], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  assert.equal(child.status, 0, child.stderr)
  const terminal: string[] = []
  const path = join(temporary, 'desktop', 'startup.jsonl')
  const log = new StartupDiagnosticsLog(path, undefined, line => terminal.push(line))
  const parser = new BackendStartupDiagnostics(() => {}, storageValidation => log.write({
    timestamp: new Date().toISOString(), role: 'main', event: 'backend-storage-validation-failed', elapsedMs: 0, storageValidation,
  }))
  for (let i = 0; i < child.stderr.length; i += 17) parser.push('stderr', child.stderr.slice(i, i + 17))
  const text = await readFile(path, 'utf8')
  const records = text.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(records.length, 2)
  for (const [index, record] of records.entries()) {
    const diagnostic = record.storageValidation
    assert.equal(diagnostic.stage, 'jsonl')
    assert.equal(diagnostic.source, 'jsonl')
    assert.equal(diagnostic.error, 'TypeError')
    assert.ok(diagnostic.frames.length >= 1 && diagnostic.frames.length <= 4)
    for (const frame of diagnostic.frames) {
      assert.match(frame, /^dist\/_chunks\/[A-Za-z0-9_][A-Za-z0-9_-]{0,79}-[A-Za-z0-9_-]{8}\.js:[1-9]\d{0,5}:[1-9]\d{0,5}$/)
      const [file, line, column] = frame.split(':')
      const source = await readFile(join(temporary, file), 'utf8')
      const sourceLine = source.split('\n')[Number(line) - 1]!
      assert.ok(sourceLine && Number(column) <= sourceLine.length + 1)
    }
    const [file, line] = diagnostic.frames[0].split(':')
    const throwingLine = (await readFile(join(temporary, file), 'utf8')).split('\n')[Number(line) - 1]!
    assert.match(throwingLine, index === 0 ? /throw new TypeError.*[Ff]ocus/ : /throw new InitiativeMetadataError.*legacy Work/)
    assert.ok(terminal.some(line => line.includes(JSON.stringify(diagnostic))))
    console.info('Verified bundled diagnostic:', JSON.stringify(diagnostic))
  }
  assert.doesNotMatch(text + terminal.join('\n'), /private|secret|message|projectId/)
  assert.ok(!text.includes(temporary))
  console.info('Retained isolated bundle and sink evidence:', temporary)
})


test('default production entries preserve actual index throw positions through the desktop sink', { timeout: 120_000 }, async () => {
  const { Script, createContext } = await import('node:vm')
  const ts = await import('typescript')
  const scratch = process.env.SHADOW_SESSION_DATA_DIR ?? resolve('.tmp')
  await mkdir(scratch, { recursive: true })
  const temporary = await mkdtemp(join(scratch, 'storage-default-bundle-'))
  const dist = join(temporary, 'dist')
  // Do not add diagnostic entries: those move validators out of the real index entry.
  await compileBackend(resolve('.'), dist)
  const filename = join(dist, 'src', 'index.js')
  const code = await readFile(filename, 'utf8')
  const ast = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const context = createContext({})
  const extract = (name: string): void => {
    const declarations = ast.statements.filter(node =>
      (ts.isFunctionDeclaration(node) && node.name?.text === name)
      || (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name)))
    assert.equal(declarations.length, 1, `exact emitted declaration: ${name}`)
    const declaration = declarations[0]!
    const start = declaration.getStart(ast)
    const position = ast.getLineAndCharacterOfPosition(start)
    // Run only unchanged, side-effect-free validators, never the backend entrypoint.
    // VM offsets preserve the actual emitted source line AND column, not invented frames.
    new Script(code.slice(start, declaration.end), { filename, lineOffset: position.line, columnOffset: position.character }).runInContext(context)
  }
  for (const name of ['parseSessionFocus', 'InitiativeMetadataError', 'parseInitiativeId', 'SOURCES', 'storageValidationFrames']) extract(name)
  assert.match(code, /function parseStoredState\(raw\)/)
  assert.match(code, /session_storage_validation_failed/)
  const terminal: string[] = []
  const sink = join(temporary, 'startup.jsonl')
  const log = new StartupDiagnosticsLog(sink, undefined, line => terminal.push(line))
  const emitted: unknown[] = []
  const parser = new BackendStartupDiagnostics(() => assert.fail('not timing'), storageValidation => {
    emitted.push(storageValidation)
    log.write({ timestamp: new Date().toISOString(), role: 'main', event: 'backend-storage-validation-failed', elapsedMs: 0, storageValidation })
  })
  for (const [expression, expectedThrow] of [
    ['parseSessionFocus({ secret: "private-value" })', /throw new TypeError.*Focus/],
    ['parseInitiativeId({ initiativeName: "private-value" })', /throw new InitiativeMetadataError.*legacy Work/],
  ] as const) {
    let caught: unknown
    try { new Script(expression).runInContext(context) } catch (error) { caught = error }
    assert.ok(caught)
    context.failure = caught
    assert.equal(new Script('failure instanceof TypeError').runInContext(context), true)
    const frames: string[] = JSON.parse(JSON.stringify(new Script('storageValidationFrames(failure)').runInContext(context)))
    assert.equal(frames.length, 1)
    assert.match(frames[0]!, /^dist\/src\/index\.js:[1-9]\d{4,5}:[1-9]\d{0,5}$/)
    const [, line, column] = frames[0]!.split(':')
    const throwingLine = code.split('\n')[Number(line) - 1]!
    assert.match(throwingLine, expectedThrow)
    assert.ok(Number(column) <= throwingLine.length)
    const diagnostic = { stage: 'jsonl', source: 'jsonl', error: 'TypeError', frames }
    const wire = `[projects] session_storage_validation_failed stage=jsonl source=jsonl error=TypeError frames=${frames.join(',')}\r\n`
    for (let i = 0; i < wire.length; i += 7) parser.push('stderr', wire.slice(i, i + 7))
    assert.deepEqual(emitted.at(-1), diagnostic)
    console.info('Verified default-entry emitted throw (synthetic input):', frames[0], throwingLine.trim())
  }
  const persisted = await readFile(sink, 'utf8')
  assert.deepEqual(persisted.trim().split('\n').map(line => JSON.parse(line).storageValidation), emitted)
  assert.equal(terminal.length, 2)
  for (const diagnostic of emitted) assert.ok(terminal.some(line => line.includes(JSON.stringify(diagnostic))))
  assert.doesNotMatch(persisted + terminal.join('\n'), /private|secret|message|projectId/)
  assert.ok(!persisted.includes(temporary))
  console.info('Retained default-layout evidence (no production data or backend startup):', temporary)
})
