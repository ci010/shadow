import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

export const TEST_ENVIRONMENT = 'shadow-event-wait-acceptance'
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function required(env, key) {
  const value = env[key]
  if (typeof value !== 'string' || !value) throw new Error(`Missing ${key}`)
  return value
}

export function stepIdentity(env) {
  const requestId = required(env, 'EVENT_WAIT_REQUEST_ID')
  const repository = required(env, 'GITHUB_REPOSITORY')
  const sha = required(env, 'GITHUB_SHA')
  const runId = Number(required(env, 'GITHUB_RUN_ID'))
  if (!uuidPattern.test(requestId) || !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !/^[a-f0-9]{40}$/.test(sha) || !Number.isSafeInteger(runId) || runId < 1) {
    throw new Error('Invalid acceptance identity')
  }
  return { requestId, repository, sha, runId }
}

export async function createBuildReceipt(root, identity) {
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Build output contains a symbolic link')
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push({
        path: relative(root, path).split(sep).join('/'),
        sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
      })
    }
  }
  await visit(join(root, 'dist'))
  if (!files.length) throw new Error('Backend build has no output files')
  return { version: 1, ...identity, files: files.sort((a, b) => a.path.localeCompare(b.path)) }
}

export async function verifyBuildReceipt(root, expected) {
  const receipt = JSON.parse(await readFile(join(root, 'build-receipt.json'), 'utf8'))
  if (receipt.version !== 1 || receipt.repository !== expected.repository ||
    receipt.sha !== expected.sha || receipt.requestId !== expected.requestId ||
    receipt.runId !== expected.runId || !Array.isArray(receipt.files) || !receipt.files.length) {
    throw new Error('CI build receipt identity mismatch')
  }
  const directory = await realpath(root)
  const seen = new Set()
  for (const file of receipt.files) {
    if (!file || typeof file.path !== 'string' || !/^dist\/[^\\]+$/.test(file.path) ||
      file.path.split('/').some(part => part === '..' || part === '.') ||
      !/^[a-f0-9]{64}$/.test(file.sha256) || seen.has(file.path)) throw new Error('Invalid build receipt path/hash')
    seen.add(file.path)
    const path = resolve(directory, ...file.path.split('/'))
    const real = await realpath(path)
    const rel = relative(directory, real)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) ||
      (await lstat(path)).isSymbolicLink()) throw new Error('Build receipt escapes its artifact')
    if (createHash('sha256').update(await readFile(real)).digest('hex') !== file.sha256) {
      throw new Error(`Build output checksum mismatch: ${file.path}`)
    }
  }
  return { files: receipt.files.length, ...expected }
}

export async function runUrlStep(options) {
  const { identity, ciRunId, timeoutMs, request, log = console.log, now = Date.now, monotonic = () => performance.now() } = options
  if (!Number.isSafeInteger(ciRunId) || ciRunId < 1 || !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1000 || timeoutMs > 120_000) throw new Error('Invalid CI run or URL deadline')
  const base = `repos/${identity.repository}`
  const ci = await request(`${base}/actions/runs/${ciRunId}`)
  if (ci.status !== 'completed' || ci.conclusion !== 'success' || ci.head_sha !== identity.sha ||
    ci.display_title !== `Shadow event wait ci ${identity.requestId}`) throw new Error('CI dependency is not the exact successful run')
  const deployment = await request(`${base}/deployments`, 'POST', {
    ref: identity.sha, auto_merge: false, required_contexts: [],
    environment: TEST_ENVIRONMENT, transient_environment: true, production_environment: false,
    description: `Event wait acceptance ${identity.requestId}`,
    payload: { requestId: identity.requestId, ciRunId, cdRunId: identity.runId },
  })
  if (!Number.isSafeInteger(deployment.id) || deployment.id < 1) throw new Error('Invalid deployment response')
  const printedAtMs = now()
  const started = monotonic()
  const signal = {
    version: 1, requestId: identity.requestId, ciRunId, cdRunId: identity.runId,
    deploymentId: deployment.id,
    url: `https://api.github.com/${base}/deployments/${deployment.id}/statuses`,
    printedAt: new Date(printedAtMs).toISOString(),
    deadlineAt: new Date(printedAtMs + timeoutMs).toISOString(),
  }
  log(`PROCESS_URL=${signal.url}`)
  log(`URL_DEADLINE=${signal.deadlineAt}`)
  const check = await request(`${base}/check-runs`, 'POST', {
    name: `shadow-event-wait-url-${identity.requestId}`, head_sha: identity.sha,
    status: 'in_progress', external_id: identity.requestId,
    details_url: `https://github.com/${identity.repository}/actions/runs/${identity.runId}`,
    output: { title: 'Third-step URL is waiting for processing', summary: 'Printed URL; runner deadline is active.', text: JSON.stringify(signal) },
  })
  if (!Number.isSafeInteger(check.id) || check.id < 1) throw new Error('Invalid Check Run response')
  let result
  while (monotonic() - started < timeoutMs) {
    const statuses = await request(`${base}/deployments/${deployment.id}/statuses?per_page=100`)
    const elapsedMs = monotonic() - started
    if (!Array.isArray(statuses)) throw new Error('Invalid deployment status response')
    const success = statuses.find(status => status.state === 'success' &&
      status.description === `event-wait:${identity.requestId}:url-processed`)
    if (success && elapsedMs < timeoutMs) {
      result = { ...signal, passed: true, observedAckAt: new Date(now()).toISOString(), elapsedMs, ackStatusId: success.id }
      break
    }
    await delay(Math.min(options.pollMs ?? 1000, Math.max(1, timeoutMs - elapsedMs)))
  }
  result ??= { ...signal, passed: false, error: 'url_deadline_exceeded', elapsedMs: monotonic() - started }
  await request(`${base}/check-runs/${check.id}`, 'PATCH', {
    status: 'completed', conclusion: result.passed ? 'success' : 'failure',
    completed_at: new Date(now()).toISOString(),
    output: { title: result.passed ? 'URL processed within deadline' : 'URL deadline missed',
      summary: result.passed ? 'Real CI artifact was processed and deployment receipt acknowledged.' : 'Third step failed; late processing cannot change this result.',
      text: JSON.stringify(result) },
  })
  log(JSON.stringify(result))
  return result
}

async function main() {
  const identity = stepIdentity(process.env)
  const [command, directory] = process.argv.slice(2)
  if (command === 'receipt') {
    const receipt = await createBuildReceipt(process.cwd(), identity)
    await writeFile('build-receipt.json', JSON.stringify(receipt, null, 2) + '\n')
    console.log(`Created verified backend receipt with ${receipt.files.length} files`)
    return
  }
  const ciRunId = Number(required(process.env, 'EVENT_WAIT_CI_RUN_ID'))
  if (command === 'verify') {
    if (!directory) throw new Error('Missing artifact directory')
    const verified = await verifyBuildReceipt(resolve(directory), { ...identity, runId: ciRunId })
    console.log(JSON.stringify(verified))
    return
  }
  if (command !== 'wait') throw new Error('Expected receipt, verify or wait')
  const token = required(process.env, 'GITHUB_TOKEN')
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`https://api.github.com/${path}`, {
      method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
        'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`GitHub API failed: ${method} ${path} HTTP ${response.status}`)
    return response.json()
  }
  const result = await runUrlStep({
    identity, ciRunId, timeoutMs: Number(required(process.env, 'EVENT_WAIT_URL_TIMEOUT_SECONDS')) * 1000, request,
  })
  if (!result.passed) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
