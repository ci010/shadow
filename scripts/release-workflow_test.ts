import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parse } from 'yaml'

const yaml = async (path: string) => parse(await readFile(new URL(path, import.meta.url), 'utf8'))

test('one release entry selects desktop/mobile/all, shares preparation and retains native gates', async () => {
  const workflow = await yaml('../.github/workflows/release-check.yml')
  const mobile = await yaml('../.github/workflows/mobile-release.yml')
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.target.options, ['desktop', 'mobile', 'all'])
  assert.equal(workflow.on.workflow_dispatch.inputs.target.default, 'all')
  assert.equal(workflow.on.push, undefined, 'Do not start a second automatic release when a PR push already validates')
  assert.deepEqual(Object.keys(mobile.on), ['workflow_call'], 'Mobile jobs have no competing entrypoint')
  assert.equal(workflow.concurrency['cancel-in-progress'], true)
  const prepare = workflow.jobs.prepare
  assert.equal(prepare.steps.filter((step: { run?: string }) => step.run?.includes('pnpm release:prepare')).length, 1)
  for (const id of ['windows-release', 'portable-release', 'mobile-release']) {
    assert.equal(workflow.jobs[id].needs, 'prepare')
  }
  assert.equal(workflow.jobs['windows-release'].if, "inputs.target != 'mobile'")
  assert.equal(workflow.jobs['portable-release'].if, "inputs.target != 'mobile'")
  assert.equal(workflow.jobs['mobile-release'].if, "inputs.target != 'desktop'")
  for (const id of ['windows-release', 'portable-release']) {
    const steps = workflow.jobs[id].steps
    assert(steps.some((step: { run?: string }) => step.run?.includes('pnpm test:release')))
    assert(steps.some((step: { run?: string }) => step.run?.includes('pnpm desktop:package')))
    assert(steps.some((step: { uses?: string }) => step.uses === './.github/actions/restore-prepared'))
    assert(!steps.some((step: { run?: string }) => step.run?.includes('pnpm typecheck')))
    const source = steps.find((step: { with?: { repository?: string } }) => step.with?.repository === 'aria2/aria2')
    assert.equal(source.with.ref, '02f2d0d8472b3c38c29b4dba8c75ebd5fdd2899a')
    const nativeBuild = steps.find((step: { run?: string }) => step.run?.includes('scripts/build-aria2-native.sh'))
    const packageIndex = steps.findIndex((step: { run?: string }) => step.run?.includes('pnpm desktop:package'))
    assert(steps.indexOf(nativeBuild) >= 0 && steps.indexOf(nativeBuild) < packageIndex)
  }
  for (const id of ['android-validation', 'ios-validation', 'android-signed', 'ios-signed']) {
    const job = mobile.jobs[id]
    assert(job.steps.some((step: { uses?: string }) => step.uses === './.github/actions/restore-prepared'))
    assert(job.steps.some((step: { run?: string }) => step.run === 'pnpm mobile:sync'))
    assert(!job.steps.some((step: { run?: string }) => /pnpm (typecheck|mobile:build)/.test(step.run ?? '')))
    if (id.endsWith('-validation')) {
      assert(job.steps.some((step: { run?: string }) => step.run?.includes('pnpm test:mobile')))
    } else {
      assert.equal(job.environment, 'mobile-release')
      assert.match(job.if, /workflow_dispatch/)
      assert.equal(job.needs, id.replace('-signed', '-validation'))
    }
  }
})

test('caches separate native downloads by OS/arch and do not retain signing material or skip verification', async () => {
  const setup = await yaml('../.github/actions/setup-build/action.yml')
  const restore = await yaml('../.github/actions/restore-prepared/action.yml')
  const native = setup.runs.steps.find((step: { uses?: string }) => step.uses === 'actions/cache@v4')
  assert.match(native.with.key, /runner\.os/)
  assert.match(native.with.key, /runner\.arch/)
  assert.match(native.with.key, /pnpm-lock\.yaml/)
  assert.doesNotMatch(native.with.path, /node_modules|signing|DerivedData|dist/)
  const builder = setup.runs.steps.find((step: { with?: { path?: string } }) => step.with?.path?.endsWith('/electron-builder-cache'))
  assert.equal(builder.if, "inputs.packaging == 'true'")
  assert.notEqual(builder.with.key, native.with.key, 'Mobile must not save an incomplete desktop packaging cache')
  assert(restore.runs.steps.some((step: { run?: string }) => step.run?.includes('pnpm release:verify-prepared')))
  const extraction = restore.runs.steps.find((step: { run?: string }) => step.run?.includes('tar -xf'))
  assert.match(extraction.run, /tar -xf - < "\$RUNNER_TEMP\/prepared\/prepared-build\.tar"/,
    'Read the archive through stdin so tar never interprets a Windows drive letter as a remote host')
  const mobile = await yaml('../.github/workflows/mobile-release.yml')
  const signingGradle = mobile.jobs['android-signed'].steps.find((step: { uses?: string }) => step.uses === 'gradle/actions/setup-gradle@v4')
  assert.equal(signingGradle.with['cache-read-only'], true)
  const signingSwift = mobile.jobs['ios-signed'].steps.find((step: { uses?: string }) => step.uses === 'actions/cache/restore@v4')
  assert.equal(signingSwift.with.path, 'mobile/ios/SourcePackages')
})

test('Windows native gate accepts postinstall preparation but retains pinned source validation', async () => {
  const workflow = await yaml('../.github/workflows/release-check.yml')
  const step = workflow.jobs['windows-release'].steps.find((step: { name?: string }) => step.name === 'Build pinned Windows desktop native resources')
  assert.match(step.run, /if \(-not \(Test-Path integrations\/agent-desktop\/\.upstream\)\) \{\s+node integrations\/agent-desktop\/scripts\/fetch\.mjs\s+if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}\s+\}/)
  assert.match(step.run, /node integrations\/agent-desktop\/scripts\/build\.mjs x86_64-pc-windows-msvc\s+if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/)
  const build = await readFile(new URL('../integrations/agent-desktop/scripts/build.mjs', import.meta.url), 'utf8')
  assert.match(build, /\['scripts\/fetch\.mjs', '--sync'\]/)
  assert.match(build, /'--locked'/)
  const fetch = await readFile(new URL('../integrations/agent-desktop/scripts/fetch.mjs', import.meta.url), 'utf8')
  assert.match(fetch, /if \(git\(\['rev-parse', 'HEAD'\], upstream\) !== revision\) throw new Error\('Upstream revision mismatch'\)/)
})
