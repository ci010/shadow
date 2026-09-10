#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env
/**
 * Run trigger evaluation for a skill description.
 *
 * Faithful Deno/TypeScript port of the Python run_eval.py script.
 */

import { parseArgs } from 'jsr:@std/cli@^1.0.21/parse-args'
import { join } from 'jsr:@std/path@^1.1.2'
import { parseSkillMd } from './utils.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EvalItem {
  query: string
  should_trigger: boolean
}

interface EvalResult {
  query: string
  should_trigger: boolean
  trigger_rate: number
  triggers: number
  runs: number
  pass: boolean
}

interface EvalOutput {
  skill_name: string
  description: string
  results: EvalResult[]
  summary: {
    total: number
    passed: number
    failed: number
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk up from cwd looking for a `.claude/` directory. Returns the first
 * ancestor that contains one, or cwd itself if none is found.
 */
export function findProjectRoot(): string {
  let current = Deno.cwd()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const info = Deno.statSync(join(current, '.claude'))
      if (info.isDirectory) {
        return current
      }
    } catch {
      // directory doesn't exist here, keep climbing
    }
    const parent = join(current, '..')
    // Normalise so we can compare reliably
    const resolvedParent = resolve(parent)
    if (resolvedParent === current) {
      // Reached filesystem root
      break
    }
    current = resolvedParent
  }
  return Deno.cwd()
}

/** Minimal path.resolve polyfill using Deno.realPathSync where possible. */
function resolve(p: string): string {
  try {
    return Deno.realPathSync(p)
  } catch {
    return p
  }
}

// ---------------------------------------------------------------------------
// Semaphore for concurrency control
// ---------------------------------------------------------------------------

class Semaphore {
  private _queue: Array<() => void> = []
  private _current = 0

  constructor(private _max: number) {}

  async acquire(): Promise<void> {
    if (this._current < this._max) {
      this._current++
      return
    }
    await new Promise<void>((resolve) => {
      this._queue.push(resolve)
    })
  }

  release(): void {
    const next = this._queue.shift()
    if (next) {
      next()
    } else {
      this._current--
    }
  }
}

// ---------------------------------------------------------------------------
// Core evaluation logic
// ---------------------------------------------------------------------------

/**
 * Run a single query against the `claude` CLI and return whether the skill
 * (identified by its unique command-file name) was triggered.
 */
async function runSingleQuery(
  query: string,
  skillName: string,
  skillDescription: string,
  timeout: number,
  projectRoot: string,
  model?: string,
): Promise<boolean> {
  const uniqueId = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  const cleanName = `${skillName}-skill-${uniqueId}`
  const projectCommandsDir = join(projectRoot, '.claude', 'commands')
  const commandFile = join(projectCommandsDir, `${cleanName}.md`)

  try {
    // Ensure the commands directory exists
    await Deno.mkdir(projectCommandsDir, { recursive: true })

    // Build the temporary command file
    const indentedDesc = skillDescription.split('\n').join('\n  ')
    const commandContent =
      `---\n` +
      `description: |\n` +
      `  ${indentedDesc}\n` +
      `---\n\n` +
      `# ${skillName}\n\n` +
      `This skill handles: ${skillDescription}\n`
    await Deno.writeTextFile(commandFile, commandContent)

    // Build the CLI args
    const cmd: string[] = [
      'claude',
      '-p', query,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
    ]
    if (model) {
      cmd.push('--model', model)
    }

    // Build an env without the CLAUDECODE variable
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(Deno.env.toObject())) {
      if (k !== 'CLAUDECODE') {
        env[k] = v
      }
    }

    const process = new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdout: 'piped',
      stderr: 'null',
      cwd: projectRoot,
      env,
    }).spawn()

    let triggered = false
    const startTime = Date.now()
    let buffer = ''
    let pendingToolName: string | null = null
    let accumulatedJson = ''

    const reader = process.stdout.getReader()
    const decoder = new TextDecoder()

    try {
      while (Date.now() - startTime < timeout * 1000) {
        // Read with a per-iteration timeout so we don't block forever
        const readResult = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((resolve) =>
            setTimeout(() => resolve({ done: true, value: undefined }), Math.max(1000, timeout * 1000 - (Date.now() - startTime)))
          ),
        ])

        if (readResult.done && readResult.value === undefined && Date.now() - startTime < timeout * 1000) {
          // Timeout on read but overall timeout not yet elapsed - could be
          // the process is slow. We'll check if time is up on next iteration.
          continue
        }

        if (readResult.value) {
          buffer += decoder.decode(readResult.value, { stream: true })
        }

        // Process all complete lines in the buffer
        while (buffer.includes('\n')) {
          const idx = buffer.indexOf('\n')
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)

          if (!line) continue

          let event: Record<string, unknown>
          try {
            event = JSON.parse(line)
          } catch {
            continue
          }

          const parseResult = processEvent(event, cleanName, pendingToolName, accumulatedJson)
          if (parseResult.decided) {
            // We have a definitive answer
            triggered = parseResult.triggered
            // Cancel the reader and kill the process
            reader.cancel().catch(() => {})
            try { process.kill() } catch { /* already exited */ }
            await process.status.catch(() => {})
            return triggered
          }
          // Update mutable state carried across lines
          pendingToolName = parseResult.pendingToolName
          accumulatedJson = parseResult.accumulatedJson
        }

        if (readResult.done) {
          break
        }
      }
    } finally {
      reader.cancel().catch(() => {})
      try { process.kill() } catch { /* already exited */ }
      await process.status.catch(() => {})
    }

    // Drain any remaining partial line
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer.trim())
        const parseResult = processEvent(event, cleanName, pendingToolName, accumulatedJson)
        if (parseResult.decided) {
          return parseResult.triggered
        }
      } catch {
        // ignore
      }
    }

    return triggered
  } finally {
    // Always clean up the temporary command file
    try {
      await Deno.remove(commandFile)
    } catch {
      // file may not exist
    }
  }
}

/**
 * Process a single parsed JSON event from the `claude` stream output.
 *
 * Returns an object describing the updated parsing state, and whether a
 * definitive decision has been reached.
 */
function processEvent(
  event: Record<string, unknown>,
  cleanName: string,
  pendingToolName: string | null,
  accumulatedJson: string,
): {
  decided: boolean
  triggered: boolean
  pendingToolName: string | null
  accumulatedJson: string
} {
  const unchanged = { decided: false, triggered: false, pendingToolName, accumulatedJson }

  if (event.type === 'stream_event') {
    const se = (event.event ?? {}) as Record<string, unknown>
    const seType = (se.type ?? '') as string

    if (seType === 'content_block_start') {
      const cb = (se.content_block ?? {}) as Record<string, unknown>
      if (cb.type === 'tool_use') {
        const toolName = (cb.name ?? '') as string
        if (toolName === 'Skill' || toolName === 'Read') {
          return { decided: false, triggered: false, pendingToolName: toolName, accumulatedJson: '' }
        }
        // Tool that is neither Skill nor Read -> not triggered
        return { decided: true, triggered: false, pendingToolName: null, accumulatedJson: '' }
      }
    } else if (seType === 'content_block_delta' && pendingToolName) {
      const delta = (se.delta ?? {}) as Record<string, unknown>
      if (delta.type === 'input_json_delta') {
        const newAccum = accumulatedJson + ((delta.partial_json ?? '') as string)
        if (newAccum.includes(cleanName)) {
          return { decided: true, triggered: true, pendingToolName, accumulatedJson: newAccum }
        }
        return { decided: false, triggered: false, pendingToolName, accumulatedJson: newAccum }
      }
    } else if (seType === 'content_block_stop' || seType === 'message_stop') {
      if (pendingToolName) {
        return { decided: true, triggered: accumulatedJson.includes(cleanName), pendingToolName: null, accumulatedJson: '' }
      }
      if (seType === 'message_stop') {
        return { decided: true, triggered: false, pendingToolName: null, accumulatedJson: '' }
      }
    }

    return unchanged
  }

  if (event.type === 'assistant') {
    const message = (event.message ?? {}) as Record<string, unknown>
    const contentItems = (message.content ?? []) as Array<Record<string, unknown>>
    for (const contentItem of contentItems) {
      if (contentItem.type !== 'tool_use') continue
      const toolName = contentItem.name as string
      const toolInput = (contentItem.input ?? {}) as Record<string, string>
      let triggered = false
      if (toolName === 'Skill' && (toolInput.skill ?? '').includes(cleanName)) {
        triggered = true
      } else if (toolName === 'Read' && (toolInput.file_path ?? '').includes(cleanName)) {
        triggered = true
      }
      return { decided: true, triggered, pendingToolName: null, accumulatedJson: '' }
    }
    return unchanged
  }

  if (event.type === 'result') {
    return { decided: true, triggered: false, pendingToolName: null, accumulatedJson: '' }
  }

  return unchanged
}

// ---------------------------------------------------------------------------
// Evaluation runner
// ---------------------------------------------------------------------------

/**
 * Run the full evaluation: for every query in the eval set (optionally
 * repeated `runsPerQuery` times), launch `runSingleQuery` with bounded
 * concurrency, aggregate the results, and return a summary object.
 */
export async function runEval(opts: {
  evalSet: EvalItem[]
  skillName: string
  description: string
  numWorkers: number
  timeout: number
  projectRoot: string
  runsPerQuery?: number
  triggerThreshold?: number
  model?: string
}): Promise<EvalOutput> {
  const {
    evalSet,
    skillName,
    description,
    numWorkers,
    timeout,
    projectRoot,
    runsPerQuery = 1,
    triggerThreshold = 0.5,
    model,
  } = opts

  // Build the list of jobs
  interface Job {
    item: EvalItem
    runIdx: number
  }
  const jobs: Job[] = []
  for (const item of evalSet) {
    for (let runIdx = 0; runIdx < runsPerQuery; runIdx++) {
      jobs.push({ item, runIdx })
    }
  }

  // Run with bounded concurrency
  const sem = new Semaphore(numWorkers)
  const jobResults: Array<{ query: string; item: EvalItem; triggered: boolean }> = []

  const promises = jobs.map(async (job) => {
    await sem.acquire()
    try {
      const triggered = await runSingleQuery(
        job.item.query,
        skillName,
        description,
        timeout,
        projectRoot,
        model,
      )
      return { query: job.item.query, item: job.item, triggered }
    } catch (e) {
      console.error(`Warning: query failed: ${e}`)
      return { query: job.item.query, item: job.item, triggered: false }
    } finally {
      sem.release()
    }
  })

  const settled = await Promise.all(promises)
  jobResults.push(...settled)

  // Aggregate per-query
  const queryTriggers = new Map<string, boolean[]>()
  const queryItems = new Map<string, EvalItem>()
  for (const jr of jobResults) {
    queryItems.set(jr.query, jr.item)
    const arr = queryTriggers.get(jr.query) ?? []
    arr.push(jr.triggered)
    queryTriggers.set(jr.query, arr)
  }

  const results: EvalResult[] = []
  for (const [query, triggers] of queryTriggers) {
    const item = queryItems.get(query)!
    const triggerCount = triggers.filter((t) => t).length
    const triggerRate = triggerCount / triggers.length
    const shouldTrigger = item.should_trigger

    const didPass = shouldTrigger
      ? triggerRate >= triggerThreshold
      : triggerRate < triggerThreshold

    results.push({
      query,
      should_trigger: shouldTrigger,
      trigger_rate: triggerRate,
      triggers: triggerCount,
      runs: triggers.length,
      pass: didPass,
    })
  }

  const passed = results.filter((r) => r.pass).length
  const total = results.length

  return {
    skill_name: skillName,
    description,
    results,
    summary: {
      total,
      passed,
      failed: total - passed,
    },
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(Deno.args, {
    string: ['eval-set', 'skill-path', 'description', 'model'],
    default: {
      'num-workers': 10,
      'timeout': 30,
      'runs-per-query': 3,
      'trigger-threshold': 0.5,
      'verbose': false,
    },
    boolean: ['verbose'],
    alias: {},
  })

  const evalSetPath = args['eval-set']
  const skillPath = args['skill-path']

  if (!evalSetPath || !skillPath) {
    console.error('Usage: run_eval.ts --eval-set <path> --skill-path <path> [options]')
    console.error('Required:')
    console.error('  --eval-set      Path to JSON eval set file')
    console.error('  --skill-path    Path to the skill directory')
    console.error('Options:')
    console.error('  --description          Override skill description')
    console.error('  --num-workers <n>      Concurrency limit (default: 10)')
    console.error('  --timeout <s>          Per-query timeout in seconds (default: 30)')
    console.error('  --runs-per-query <n>   Runs per query (default: 3)')
    console.error('  --trigger-threshold <f> Trigger threshold (default: 0.5)')
    console.error('  --model <name>         Model override')
    console.error('  --verbose              Verbose output')
    Deno.exit(1)
  }

  const numWorkers = Number(args['num-workers']) || 10
  const timeout = Number(args['timeout']) || 30
  const runsPerQuery = Number(args['runs-per-query']) || 3
  const triggerThreshold = Number(args['trigger-threshold']) || 0.5
  const model = args['model'] || undefined

  const evalSetText = await Deno.readTextFile(evalSetPath)
  const evalSet: EvalItem[] = JSON.parse(evalSetText)

  const { name, description: originalDescription } = parseSkillMd(skillPath)
  const description = args['description'] || originalDescription

  const projectRoot = findProjectRoot()

  const output = await runEval({
    evalSet,
    skillName: name,
    description,
    numWorkers,
    timeout,
    projectRoot,
    runsPerQuery,
    triggerThreshold,
    model,
  })

  console.log(JSON.stringify(output, null, 2))
}

if (import.meta.main) {
  main()
}
