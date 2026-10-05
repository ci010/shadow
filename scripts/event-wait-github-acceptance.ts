import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { DEFAULT_COPILOT_MODEL } from '../src/config/defaults.ts'
import { CopilotProvider } from '../src/providers/copilot.ts'
import { runEventWait } from './event-wait-acceptance.ts'
import { GitHubWait } from './event-wait-github.ts'

async function main() {
  if (process.env.SHADOW_EVENT_WAIT_LIVE !== '1') throw new Error('Set SHADOW_EVENT_WAIT_LIVE=1 to authorize real model and Actions execution')
  const { values } = parseArgs({ options: {
    out: { type: 'string' }, 'ci-run': { type: 'string' }, sha: { type: 'string' }, request: { type: 'string' },
    model: { type: 'string', default: DEFAULT_COPILOT_MODEL },
    repository: { type: 'string', default: 'ci010/shadow' }, branch: { type: 'string', default: 'session' },
    'timeout-seconds': { type: 'string', default: '900' },
  } })
  const output = resolve(z.string().min(1).parse(values.out))
  const capability = new GitHubWait({
    repository: values.repository, branch: values.branch, sha: z.string().parse(values.sha),
    requestId: z.string().parse(values.request), ciRunId: z.coerce.number().int().positive().parse(values['ci-run']),
  })
  const provider = new CopilotProvider()
  if (!(await provider.listModels()).includes(values.model)) throw new Error(`Model unavailable: ${values.model}`)
  await mkdir(join(output, '..'), { recursive: true })
  const result = await runEventWait({
    output, scenario: 'cold', model: values.model, storage: 'sqlite', holdMs: 0,
    timeoutMs: z.coerce.number().int().min(120).max(1800).parse(values['timeout-seconds']) * 1000,
    maxCalls: 40, urlTimeoutMs: 60_000, external: capability.asScenario(),
  }, provider)
  await writeFile(join(output, 'github-evidence.json'), JSON.stringify(capability.evidence, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ ...result, summary: join(output, 'summary.json'), github: capability.evidence }))
  if (!result.passed) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
