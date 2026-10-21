import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { verifyReleaseManifest } from './release-manifest.ts'
import { ARIA2_VERSION, aria2Executable } from './aria2-package.ts'
import { desktopTarget } from './desktop-target.ts'
import {
  assertMacIconEncoding, assertOutsideRepository, backendCommand, backendResourceReport, bounded, createVerificationDirectory, descendants, fetchBounded,
  killProcessTree, nodeModeProbe, packagedEvalCommand, prepareRendererSmoke, prepareVerificationData, relocatedPackageRoot, remainingBudget, rendererEnvironment, rendererSignatureCommands, reservePort, runCommand, sanitizeLog, snapshotProcesses,
  serviceEnvironment, startProcess, terminateProcess, verifyRendererArtifacts, waitForOutput, waitReady, waitSuccessful,
  type ManagedProcess, type ProcessIdentity,
} from './packaged-verification.ts'

const target = desktopTarget()
const repository = await realpath(resolve('.'))
const packaged = resolve(process.argv[2] ?? join('desktop', 'release', target.unpackedDirectory))
const token = randomBytes(32).toString('hex')
let scratch: string | undefined
let backendProcess: ManagedProcess | undefined
let rootIdentity: ProcessIdentity | undefined
const ownedDescendants = new Map<number, ProcessIdentity>()
let rendererProcess: ManagedProcess | undefined
let rendererIdentity: ProcessIdentity | undefined
const rendererDescendants = new Map<number, ProcessIdentity>()
let stage = 'source release manifest'
const failures: string[] = []

async function inspectBackendTree(sample: string): Promise<void> {
  const snapshot = await snapshotProcesses()
  if (!rootIdentity) rootIdentity = snapshot.find((value) => value.pid === backendProcess?.child.pid)
  assert.ok(rootIdentity, 'Backend was not present in process census')
  const currentRoot = snapshot.find((value) => value.pid === rootIdentity!.pid && value.created === rootIdentity!.created)
  assert.ok(currentRoot, 'Backend exited before process census')
  const children = descendants(snapshot, rootIdentity)
  for (const child of children) ownedDescendants.set(child.pid, child)
  assert.ok(!rootIdentity.gui && !children.some((child) => child.gui), 'Headless backend launched a Chromium renderer/GPU/utility process')
  console.log(`Backend resources (${sample}): ${JSON.stringify(backendResourceReport(currentRoot))}`)
}

try {
  // Never execute an unverified package, including the Node-mode runtime probe.
  await verifyReleaseManifest(packaged, repository)
  if (target.platform === 'darwin') {
    stage = 'macOS small-icon encoding'
    assertMacIconEncoding(await readFile(join(packaged, target.resourcesRelativePath, 'icon.icns')))
  }
  stage = 'complete package relocation'
  // Deliberately outside the source tree: neither executable nor dependencies may fall back to the checkout.
  scratch = await createVerificationDirectory()
  assertOutsideRepository(await realpath(scratch), repository)
  const relocated = relocatedPackageRoot(scratch, target)
  // macOS frameworks contain relative symlinks; preserve the complete .app layout.
  await cp(packaged, relocated, { recursive: true, dereference: target.platform === 'win32', verbatimSymlinks: target.platform !== 'win32' })
  stage = 'relocated release manifest'
  await verifyReleaseManifest(relocated, repository)
  stage = 'relocated bundled aria2 executable'
  const aria2Path = join(relocated, target.resourcesRelativePath, 'aria2', aria2Executable(target))
  const aria2Version = await runCommand(aria2Path, ['--version'],
    { cwd: scratch, env: process.env }, 10_000, stage)
  assert.match(aria2Version, new RegExp(`^aria2 version ${ARIA2_VERSION.replaceAll('.', '\\.')}\\r?\\n`))
  stage = 'renderer artifact references'
  await verifyRendererArtifacts(relocated)
  console.log(`Artifact checks (${target.platform}/${target.arch}): release manifest verified ASAR main/preload and backend/renderer hashes; ${target.platform === 'win32' ? 'Windows service resources verified' : 'Windows service resources absent'}; referenced renderer assets present (not UI execution).`)

  const dataDir = join(scratch, 'data')
  const bootstrap = join(scratch, 'bootstrap.json')
  await prepareVerificationData(dataDir)
  await mkdir(join(scratch, 'profile', 'roaming'), { recursive: true })
  await mkdir(join(scratch, 'profile', 'local'), { recursive: true })
  await writeFile(bootstrap, JSON.stringify({
    version: 1, mode: 'main', dataDir, localNodeId: 'packaging-smoke',
  }))
  const port = await reservePort()
  const credentialFile = join(scratch, 'service-credential')
  await writeFile(credentialFile, `${token}\n`, { mode: 0o600 })
  const env = serviceEnvironment(scratch, credentialFile, port)
  const command = backendCommand(relocated, bootstrap)
  const options = { cwd: scratch, env }

  stage = 'Electron Node-mode baseline probe'
  const probe = await runCommand(command.executable, ['-e', nodeModeProbe], options, 10_000, stage, [token])
  const reportLine = probe.split(/\r?\n/).find((line) => line.startsWith('SHADOW_NODE_PROBE='))
  assert.ok(reportLine, 'Node runtime probe returned no report')
  const report = JSON.parse(reportLine.slice('SHADOW_NODE_PROBE='.length))
  assert.equal(typeof report.electron, 'string')
  assert.equal(report.processType, null)
  assert.equal(report.guiApis, false)
  assert.ok(Number.isFinite(report.memoryUsage?.rss) && report.memoryUsage.rss > 0)
  console.log(`Node runtime baseline (NOT backend RSS or a memory budget): ${JSON.stringify(report)}`)

  stage = 'relocated headless backend startup (--service process mode, file credential, Electron Node mode; no OS service registration)'
  backendProcess = startProcess(command.executable, command.args, options, [token])
  const origin = `http://127.0.0.1:${port}`
  const headers = { Authorization: `Bearer ${token}` }
  await waitReady(origin, headers, backendProcess)
  await inspectBackendTree('ready')
  stage = 'authentication and telemetry'
  assert.equal((await fetchBounded(`${origin}/local/v1/readiness`)).status, 401)
  const logs = await fetchBounded(`${origin}/v1/query/logs`, { headers })
  assert.equal(logs.status, 200)
  assert.ok(JSON.stringify(JSON.parse(logs.body)).includes('All services started'))

  stage = 'packaged native TypeScript eval'
  const script = join(scratch, 'eval-fixture.ts')
  await writeFile(join(scratch, 'value.ts'), 'export enum Value { Answer = 42 }\n')
  await writeFile(script, `
    import { Value } from './value.ts'
    class Result { constructor(public value: number) {} }
    export default () => new Result(Value.Answer).value
  `)
  const evalCommand = packagedEvalCommand(relocated, script, target)
  const evaluated = await runCommand(evalCommand.executable, evalCommand.args, options, 15_000, stage, [token])
  const evalReport = evaluated.split(/\r?\n/).find(line => line.startsWith('SHADOW_PACKAGED_EVAL_RESULT='))
  assert.ok(evalReport, 'Packaged script runtime returned no evaluation report')
  assert.deepEqual(JSON.parse(evalReport.slice('SHADOW_PACKAGED_EVAL_RESULT='.length)), { result: 42 })

  stage = 'graceful backend shutdown'
  await inspectBackendTree('before shutdown')
  assert.equal((await fetchBounded(`${origin}/local/v1/shutdown`, { method: 'POST', headers })).status, 202)
  await waitSuccessful(backendProcess, 15_000, stage)
  stage = 'post-shutdown process census'
  const after = await snapshotProcesses()
  for (const child of descendants(after, rootIdentity!)) ownedDescendants.set(child.pid, child)
  const survivors = after.filter((value) => {
    const owned = value.pid === rootIdentity!.pid ? rootIdentity : ownedDescendants.get(value.pid)
    return owned?.created === value.created
  })
  assert.equal(survivors.length, 0, `Backend left owned processes running: ${survivors.map((value) => value.pid).join(', ')}`)
  console.log('Relocated packaged backend: headless startup with file credential (no interactive local executor), auth, telemetry, native TypeScript eval, graceful exit and observed descendant cleanup OK.')

  stage = 'synthetic hidden packaged renderer/preload entry'
  const fixture = await readFile(join(repository, 'scripts', 'fixtures', 'packaged-renderer-smoke.cjs'), 'utf8')
  const renderer = await prepareRendererSmoke(relocated, scratch, fixture)
  for (const signing of rendererSignatureCommands(relocated, scratch, target)) {
    stage = 'ad-hoc signing of disposable synthetic renderer bundle (not release signing acceptance)'
    await runCommand(signing.executable, signing.args, { cwd: scratch, env: rendererEnvironment(scratch) }, 30_000, stage)
  }
  stage = 'synthetic hidden packaged renderer/preload execution'
  rendererProcess = startProcess(renderer.executable, renderer.args, { cwd: scratch, env: rendererEnvironment(scratch) })
  await waitForOutput(rendererProcess, 'SHADOW_RENDERER_WAITING', 12_000)
  const rendererStart = await snapshotProcesses()
  rendererIdentity = rendererStart.find((value) => value.pid === rendererProcess!.child.pid)
  assert.ok(rendererIdentity, 'Renderer fixture was not present in process census')
  for (const child of descendants(rendererStart, rendererIdentity)) rendererDescendants.set(child.pid, child)
  await writeFile(`${renderer.control}.start`, '')
  await waitForOutput(rendererProcess, 'SHADOW_RENDERER_RESULT=', 15_000)
  const rendererReport = rendererProcess.logs().split(/\r?\n/).find((line) => line.startsWith('SHADOW_RENDERER_RESULT='))
  assert.ok(rendererReport, 'Renderer fixture returned no report')
  const rendered = JSON.parse(rendererReport.slice('SHADOW_RENDERER_RESULT='.length))
  assert.equal(rendered.rendererMounted, true)
  assert.equal(rendered.preloadIpc, true)
  assert.equal(rendered.isolatedWorld, true)
  assert.equal(rendered.visible, false)
  const rendererBeforeExit = await snapshotProcesses()
  for (const child of descendants(rendererBeforeExit, rendererIdentity)) rendererDescendants.set(child.pid, child)
  await writeFile(`${renderer.control}.stop`, '')
  await waitSuccessful(rendererProcess, 10_000, stage)
  const rendererAfterExit = await snapshotProcesses()
  for (const child of descendants(rendererAfterExit, rendererIdentity)) rendererDescendants.set(child.pid, child)
  assert.ok(!rendererAfterExit.some((value) =>
    [rendererIdentity!, ...rendererDescendants.values()].some((owned) => value.pid === owned.pid && value.created === owned.created)),
  'Hidden renderer fixture left owned processes running')
  console.log(`Packaged renderer/preload smoke: ${JSON.stringify(rendered)}`)
  console.log('Coverage boundary: process census is sampled, not OS process containment. Hidden renderer/preload used synthetic bootstrap/window IPC and a test-only entry in a disposable package copy, NOT unmodified production main or signature/notarization acceptance. Complete UI flows still require native acceptance. No service registered or elevated.')
  console.log(target.platform === 'win32'
    ? 'Windows SCM install/start/stop/recovery/uninstall still require Windows VM acceptance.'
    : 'Unix verification covers headless processes only, NOT launchd/systemd installation, lifecycle or recovery.')
} catch (error) {
  failures.push(`Packaged verification FAILED at ${stage}: ${sanitizeLog(error, [token])}\n${backendProcess?.logs() ?? ''}\n${rendererProcess?.logs() ?? ''}`)
} finally {
  for (const ownedProcess of [
    { process: rendererProcess, identity: rendererIdentity, descendants: rendererDescendants },
    { process: backendProcess, identity: rootIdentity, descendants: ownedDescendants },
  ]) {
    try {
      const managed = ownedProcess.process
      if (managed?.child.pid === undefined) continue
      const deadline = Date.now() + 45_000
      const snapshot = await snapshotProcesses(remainingBudget(deadline, 10_000))
      const identity = ownedProcess.identity ?? snapshot.find((value) => value.pid === managed.child.pid)
      if (identity) {
        for (const child of descendants(snapshot, identity)) ownedProcess.descendants.set(child.pid, child)
        await killProcessTree(identity, deadline)
      }
      for (const child of ownedProcess.descendants.values()) await killProcessTree(child, deadline)
      await terminateProcess(managed.child, remainingBudget(deadline, 5_000))
      const remaining = await snapshotProcesses(remainingBudget(deadline, 10_000))
      const tracked = [...ownedProcess.descendants.values(), ...(identity ? [identity] : [])]
      assert.ok(!remaining.some((value) => tracked.some((owned) => owned.pid === value.pid && owned.created === value.created)),
        'Owned processes survived cleanup')
    } catch (error) {
      failures.push(`Process cleanup FAILED: ${sanitizeLog(error, [token])}`)
      // Census can fail independently; always attempt direct termination of our own child.
      if (ownedProcess.process) {
        try { await terminateProcess(ownedProcess.process.child) } catch (error) {
          failures.push(`Owned process termination FAILED: ${sanitizeLog(error, [token])}`)
        }
      }
    }
  }
  if (scratch) {
    try {
      await bounded(rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }), 20_000, 'Relocation cleanup')
    } catch (error) {
      failures.push(`Relocation cleanup FAILED (${scratch}): ${sanitizeLog(error, [token])}`)
    }
  }
}
if (failures.length) {
  console.error(sanitizeLog(failures.join('\n'), [token], 24_000))
  process.exitCode = 1
}
