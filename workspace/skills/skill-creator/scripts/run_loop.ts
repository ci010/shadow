#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net
/**
 * Run the eval + improve loop until all pass or max iterations reached.
 *
 * Combines run_eval and improve_description in a loop, tracking history
 * and returning the best description. Supports train/test split.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-run --allow-env --allow-net \
 *     scripts/run_loop.ts --eval-set eval.json --skill-path skills/my-skill \
 *     [--description "override"] [--num-workers 4] [--timeout 30] \
 *     [--max-iterations 5] [--runs-per-query 1] [--trigger-threshold 0.5] \
 *     [--holdout 0.2] [--model gpt-4o] [--verbose] [--report] [--results-dir ./results]
 */

import { parseArgs } from 'jsr:@std/cli@^1.0.21/parse-args'
import { join } from 'jsr:@std/path@^1.1.2'

import { generateHtml } from './generate_report.ts'
import { improveDescription } from './improve_description.ts'
import { runEval, findProjectRoot } from './run_eval.ts'
import { parseSkillMd } from './utils.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvalQuery {
  query: string
  should_trigger: boolean
  [key: string]: unknown
}

export interface EvalResult {
  query: string
  passed: boolean
  should_trigger: boolean
  [key: string]: unknown
}

export interface EvalResults {
  results: EvalResult[]
  passed: number
  failed: number
  total: number
}

interface Summary {
  passed: number
  failed: number
  total: number
}

export interface HistoryEntry {
  iteration: number
  description: string
  train_passed: number
  train_failed: number
  train_total: number
  train_results: EvalResult[]
  test_passed?: number
  test_failed?: number
  test_total?: number
  test_results?: EvalResult[]
}

export interface LoopResult {
  exit_reason: string
  original_description: string
  best_description: string
  best_iteration: number
  history: HistoryEntry[]
}

// ---------------------------------------------------------------------------
// Seeded deterministic PRNG (mulberry32) + Fisher-Yates shuffle
// ---------------------------------------------------------------------------

/**
 * Mulberry32 - a simple 32-bit seeded PRNG.
 * Returns a function that produces pseudo-random floats in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let state = seed | 0
  return (): number => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * In-place Fisher-Yates shuffle using a seeded PRNG.
 * Returns the same array (mutated).
 */
function seededShuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

// ---------------------------------------------------------------------------
// Train / test split
// ---------------------------------------------------------------------------

/**
 * Split an eval set into train and test subsets, stratified by should_trigger.
 *
 * The split is deterministic for a given seed.
 */
export function splitEvalSet(
  evalSet: EvalQuery[],
  holdout: number,
  seed = 42,
): { trainSet: EvalQuery[]; testSet: EvalQuery[] } {
  const rng = mulberry32(seed)

  const trigger = evalSet.filter((e) => e.should_trigger)
  const noTrigger = evalSet.filter((e) => !e.should_trigger)

  seededShuffle(trigger, rng)
  seededShuffle(noTrigger, rng)

  const nTriggerTest = Math.max(1, Math.floor(trigger.length * holdout))
  const nNoTriggerTest = Math.max(1, Math.floor(noTrigger.length * holdout))

  const testSet = [
    ...trigger.slice(0, nTriggerTest),
    ...noTrigger.slice(0, nNoTriggerTest),
  ]
  const trainSet = [
    ...trigger.slice(nTriggerTest),
    ...noTrigger.slice(nNoTriggerTest),
  ]

  return { trainSet, testSet }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function calculateSummary(results: EvalResult[]): Summary {
  const passed = results.filter((r) => r.passed).length
  return { passed, failed: results.length - passed, total: results.length }
}

/**
 * Open a file path in the default browser, cross-platform.
 */
async function openInBrowser(filePath: string): Promise<void> {
  const isWindows = Deno.build.os === 'windows'
  let cmd: Deno.Command

  if (isWindows) {
    cmd = new Deno.Command('cmd', { args: ['/c', 'start', filePath] })
  } else if (Deno.build.os === 'darwin') {
    cmd = new Deno.Command('open', { args: [filePath] })
  } else {
    cmd = new Deno.Command('xdg-open', { args: [filePath] })
  }

  const child = cmd.spawn()
  await child.status
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export interface RunLoopOptions {
  evalSet: EvalQuery[]
  skillPath: string
  descriptionOverride?: string | null
  numWorkers: number
  timeout: number
  maxIterations: number
  runsPerQuery: number
  triggerThreshold: number
  holdout: number
  model: string
  verbose: boolean
  liveReportPath?: string | null
  logDir?: string | null
}

/**
 * Run the eval + improve loop until all train queries pass or max iterations
 * are reached. Returns the best description found across all iterations.
 */
export async function runLoop(options: RunLoopOptions): Promise<LoopResult> {
  const {
    evalSet,
    skillPath,
    descriptionOverride,
    numWorkers,
    timeout,
    maxIterations,
    runsPerQuery,
    triggerThreshold,
    holdout,
    model,
    verbose,
    liveReportPath = null,
    logDir = null,
  } = options

  const projectRoot = findProjectRoot()
  const { name, description: originalDescription, content } = parseSkillMd(skillPath)
  let currentDescription = descriptionOverride || originalDescription

  let trainSet: EvalQuery[]
  let testSet: EvalQuery[]

  if (holdout > 0) {
    const split = splitEvalSet(evalSet, holdout)
    trainSet = split.trainSet
    testSet = split.testSet
  } else {
    trainSet = evalSet
    testSet = []
  }

  if (verbose) {
    console.log(`\nSkill: ${name}`)
    console.log(`Skill path: ${skillPath}`)
    console.log(`Project root: ${projectRoot}`)
    console.log(`Model: ${model}`)
    console.log(`Max iterations: ${maxIterations}`)
    console.log(`Runs per query: ${runsPerQuery}`)
    console.log(`Trigger threshold: ${triggerThreshold}`)
    console.log(`Holdout: ${holdout}`)
    console.log(`Num workers: ${numWorkers}`)
    console.log(`Timeout: ${timeout}s`)
    console.log(`Train set size: ${trainSet.length}`)
    console.log(`Test set size: ${testSet.length}`)
    if (liveReportPath) {
      console.log(`Live report: ${liveReportPath}`)
    }
    if (logDir) {
      console.log(`Log directory: ${logDir}`)
    }
    console.log(`Original description: ${originalDescription.slice(0, 120)}${originalDescription.length > 120 ? '...' : ''}`)
    if (descriptionOverride) {
      console.log(`Description override: ${descriptionOverride.slice(0, 120)}${descriptionOverride.length > 120 ? '...' : ''}`)
    }
  }

  const history: HistoryEntry[] = []
  let exitReason = 'unknown'

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    // --- Header ---
    if (verbose) {
      console.log(`\n${'='.repeat(60)}`)
      console.log(`Iteration ${iteration}/${maxIterations}`)
      console.log(`${'='.repeat(60)}`)
      console.log(`Current description: ${currentDescription.slice(0, 100)}${currentDescription.length > 100 ? '...' : ''}`)
    }

    // --- Evaluate train + test together ---
    const allQueries: EvalQuery[] = [...trainSet, ...testSet]
    const startTime = performance.now()

    const allResults: EvalResults = await runEval({
      evalSet: allQueries,
      skillName: name,
      description: currentDescription,
      numWorkers,
      timeout,
      projectRoot,
      runsPerQuery,
      triggerThreshold,
      model,
    })

    const elapsedSec = ((performance.now() - startTime) / 1000).toFixed(1)

    if (verbose) {
      console.log(`Evaluation completed in ${elapsedSec}s`)
    }

    // --- Split results back by query ---
    const trainQuerySet = new Set(trainSet.map((q) => q.query))
    const trainResultList = allResults.results.filter((r) => trainQuerySet.has(r.query))
    const testResultList = allResults.results.filter((r) => !trainQuerySet.has(r.query))

    // --- Calculate summaries ---
    const trainSummary = calculateSummary(trainResultList)
    const testSummary: Summary | null = testResultList.length > 0
      ? calculateSummary(testResultList)
      : null

    // --- Build history entry ---
    const entry: HistoryEntry = {
      iteration,
      description: currentDescription,
      train_passed: trainSummary.passed,
      train_failed: trainSummary.failed,
      train_total: trainSummary.total,
      train_results: trainResultList,
    }

    if (testSummary) {
      entry.test_passed = testSummary.passed
      entry.test_failed = testSummary.failed
      entry.test_total = testSummary.total
      entry.test_results = testResultList
    }

    history.push(entry)

    // --- Verbose result logging ---
    if (verbose) {
      console.log(`\nTrain: ${trainSummary.passed}/${trainSummary.total} passed, ${trainSummary.failed} failed`)
      if (testSummary) {
        console.log(`Test:  ${testSummary.passed}/${testSummary.total} passed, ${testSummary.failed} failed`)
      }
      for (const r of trainResultList) {
        const status = r.passed ? 'PASS' : 'FAIL'
        console.log(`  [${status}] (train) ${r.query}`)
      }
      for (const r of testResultList) {
        const status = r.passed ? 'PASS' : 'FAIL'
        console.log(`  [${status}] (test)  ${r.query}`)
      }
    }

    // --- Write live report ---
    if (liveReportPath) {
      try {
        const html = generateHtml(history, name)
        await Deno.writeTextFile(liveReportPath, html)
        if (verbose) {
          console.log(`Live report updated: ${liveReportPath}`)
        }
      } catch (err) {
        console.error(`Warning: failed to write live report: ${(err as Error).message}`)
      }
    }

    // --- Write per-iteration log ---
    if (logDir) {
      try {
        const logPath = join(logDir, `iteration_${iteration}.json`)
        await Deno.writeTextFile(logPath, JSON.stringify(entry, null, 2))
        if (verbose) {
          console.log(`Iteration log written: ${logPath}`)
        }
      } catch (err) {
        console.error(`Warning: failed to write iteration log: ${(err as Error).message}`)
      }
    }

    // --- Check stopping conditions ---
    if (trainSummary.failed === 0) {
      exitReason = `all_passed (iteration ${iteration})`
      if (verbose) {
        console.log(`\nAll train queries passed! Stopping.`)
      }
      break
    }

    if (iteration === maxIterations) {
      exitReason = `max_iterations (${maxIterations})`
      if (verbose) {
        console.log(`\nMax iterations reached. Stopping.`)
      }
      break
    }

    // --- Improve description ---
    if (verbose) {
      console.log(`\nImproving description...`)
    }

    // Build blinded history (strip test_* keys so the improver cannot overfit to the test set)
    const blindedHistory = history.map((h) => {
      const blinded: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(h)) {
        if (!k.startsWith('test_')) {
          blinded[k] = v
        }
      }
      return blinded
    })

    const newDescription = await improveDescription({
      skillName: name,
      currentDescription: currentDescription,
      history: blindedHistory,
      skillContent: content,
      model,
    })

    currentDescription = newDescription

    if (verbose) {
      console.log(`New description: ${newDescription.slice(0, 100)}${newDescription.length > 100 ? '...' : ''}`)
    }
  }

  // --- Find best entry by test score (fall back to train score if no test set) ---
  let bestEntry = history[0]
  let bestScore = -1
  for (const h of history) {
    const score = h.test_passed ?? h.train_passed
    if (score > bestScore) {
      bestScore = score
      bestEntry = h
    }
  }

  const result: LoopResult = {
    exit_reason: exitReason,
    original_description: originalDescription,
    best_description: bestEntry.description,
    best_iteration: bestEntry.iteration,
    history,
  }

  if (verbose) {
    console.log(`\n${'='.repeat(60)}`)
    console.log(`Loop complete: ${exitReason}`)
    console.log(`Best description (iteration ${bestEntry.iteration}): ${bestEntry.description.slice(0, 100)}${bestEntry.description.length > 100 ? '...' : ''}`)
    console.log(`${'='.repeat(60)}`)
  }

  return result
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    string: [
      'eval-set',
      'skill-path',
      'description',
      'num-workers',
      'timeout',
      'max-iterations',
      'runs-per-query',
      'trigger-threshold',
      'holdout',
      'model',
      'results-dir',
    ],
    boolean: ['verbose', 'report', 'help'],
    alias: { h: 'help' },
    default: {
      'num-workers': '4',
      'timeout': '30',
      'max-iterations': '5',
      'runs-per-query': '1',
      'trigger-threshold': '0.5',
      'holdout': '0.2',
      'model': 'gpt-4o',
      'verbose': false,
      'report': false,
      'help': false,
    },
  })

  if (args.help) {
    console.log(`Usage: deno run --allow-read --allow-write --allow-run --allow-env --allow-net \\
  scripts/run_loop.ts --eval-set <path> --skill-path <path> [options]

Options:
  --eval-set <path>          Path to eval set JSON file (required)
  --skill-path <path>        Path to skill directory (required)
  --description <text>       Override the skill description
  --num-workers <n>          Number of parallel workers (default: 4)
  --timeout <seconds>        Timeout per evaluation in seconds (default: 30)
  --max-iterations <n>       Maximum loop iterations (default: 5)
  --runs-per-query <n>       Number of eval runs per query (default: 1)
  --trigger-threshold <f>    Trigger threshold 0-1 (default: 0.5)
  --holdout <f>              Fraction of eval set to hold out for testing (default: 0.2)
  --model <name>             Model to use (default: gpt-4o)
  --verbose                  Enable verbose logging
  --report                   Generate and open an HTML report in the browser
  --results-dir <path>       Directory to write per-iteration results
  -h, --help                 Show this help message`)
    Deno.exit(0)
  }

  const evalSetPath = args['eval-set']
  const skillPath = args['skill-path']

  if (!evalSetPath) {
    console.error('Error: --eval-set is required')
    Deno.exit(1)
  }
  if (!skillPath) {
    console.error('Error: --skill-path is required')
    Deno.exit(1)
  }

  // Parse eval set JSON
  let evalSet: EvalQuery[]
  try {
    const raw = await Deno.readTextFile(evalSetPath)
    evalSet = JSON.parse(raw) as EvalQuery[]
  } catch (err) {
    console.error(`Error: failed to read eval set from '${evalSetPath}': ${(err as Error).message}`)
    Deno.exit(1)
  }

  const numWorkers = parseInt(args['num-workers'] as string, 10)
  const timeout = parseInt(args['timeout'] as string, 10)
  const maxIterations = parseInt(args['max-iterations'] as string, 10)
  const runsPerQuery = parseInt(args['runs-per-query'] as string, 10)
  const triggerThreshold = parseFloat(args['trigger-threshold'] as string)
  const holdout = parseFloat(args['holdout'] as string)
  const model = args['model'] as string
  const verbose = Boolean(args.verbose)
  const report = Boolean(args.report)
  const resultsDir = args['results-dir'] as string | undefined
  const descriptionOverride = args['description'] as string | undefined

  // Validate numeric args
  for (const [name, value] of Object.entries({ numWorkers, timeout, maxIterations, runsPerQuery })) {
    if (isNaN(value) || value < 1) {
      console.error(`Error: --${name.replace(/([A-Z])/g, '-$1').toLowerCase()} must be a positive integer`)
      Deno.exit(1)
    }
  }
  for (const [name, value] of Object.entries({ triggerThreshold, holdout })) {
    if (isNaN(value) || value < 0 || value > 1) {
      console.error(`Error: --${name.replace(/([A-Z])/g, '-$1').toLowerCase()} must be a number between 0 and 1`)
      Deno.exit(1)
    }
  }

  // Prepare log directory
  const logDir = resultsDir ?? null
  if (logDir) {
    try {
      await Deno.mkdir(logDir, { recursive: true })
    } catch (err) {
      console.error(`Error: failed to create results directory '${logDir}': ${(err as Error).message}`)
      Deno.exit(1)
    }
  }

  // Prepare live report path
  let liveReportPath: string | null = null
  if (report) {
    const tmpDir = await Deno.makeTempDir()
    liveReportPath = join(tmpDir, 'skill_eval_report.html')
    if (verbose) {
      console.log(`Live report will be written to: ${liveReportPath}`)
    }
  }

  // Run the loop
  const result = await runLoop({
    evalSet,
    skillPath,
    descriptionOverride: descriptionOverride ?? null,
    numWorkers,
    timeout,
    maxIterations,
    runsPerQuery,
    triggerThreshold,
    holdout,
    model,
    verbose,
    liveReportPath,
    logDir,
  })

  // Open live report in browser
  if (report && liveReportPath) {
    try {
      await openInBrowser(liveReportPath)
      if (verbose) {
        console.log(`Opened report in browser: ${liveReportPath}`)
      }
    } catch (err) {
      console.error(`Warning: failed to open report in browser: ${(err as Error).message}`)
      console.log(`Report available at: ${liveReportPath}`)
    }
  }

  // Write final result to log directory
  if (logDir) {
    const resultPath = join(logDir, 'loop_result.json')
    try {
      await Deno.writeTextFile(resultPath, JSON.stringify(result, null, 2))
      if (verbose) {
        console.log(`Final result written to: ${resultPath}`)
      }
    } catch (err) {
      console.error(`Warning: failed to write final result: ${(err as Error).message}`)
    }
  }

  // Print final result to stdout
  console.log(JSON.stringify(result, null, 2))
}

if (import.meta.main) {
  main()
}
