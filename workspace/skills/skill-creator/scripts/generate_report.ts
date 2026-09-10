#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Generate an HTML report from run_loop output.
 *
 * Usage:
 *   deno run --allow-read --allow-write scripts/generate_report.ts <input.json> [-o output.html] [--auto-refresh] [--skill-name <name>]
 *
 * Examples:
 *   deno run --allow-read --allow-write scripts/generate_report.ts results.json
 *   deno run --allow-read --allow-write scripts/generate_report.ts results.json -o report.html --skill-name my-skill
 *   deno run --allow-read --allow-write scripts/generate_report.ts results.json --auto-refresh
 */

import { parseArgs } from 'jsr:@std/cli@^1.0.21/parse-args'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunResult {
  correct: boolean
  trigger_rate?: number
}

interface QueryResult {
  query: string
  should_trigger?: boolean
  results?: RunResult[]
}

interface HistoryEntry {
  description?: string
  train_results?: QueryResult[]
  results?: QueryResult[]
  test_results?: QueryResult[]
}

interface ReportData {
  history?: HistoryEntry[]
  holdout?: number
}

interface AggregateResult {
  correct: number
  total: number
  rate: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape special HTML characters in a string.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

/**
 * Aggregate correct/total across all retries for a single query result.
 */
function aggregateRuns(result: QueryResult): AggregateResult {
  const runs = result.results || []
  const correct = runs.filter((r) => r.correct).length
  const total = runs.length
  const rate = total > 0 ? correct / total : 0
  return { correct, total, rate }
}

/**
 * Return CSS class name for a score percentage.
 *   >= 80 % -> "score-good"
 *   >= 50 % -> "score-ok"
 *   <  50 % -> "score-bad"
 */
function scoreClass(score: number): string {
  if (score >= 80) return 'score-good'
  if (score >= 50) return 'score-ok'
  return 'score-bad'
}

// ---------------------------------------------------------------------------
// Main report generator (exported for programmatic use)
// ---------------------------------------------------------------------------

export function generateHtml(
  data: ReportData,
  autoRefresh: boolean = false,
  skillName: string = '',
): string {
  const history = data.history || []
  const holdout = data.holdout || 0
  const titlePrefix = skillName ? escapeHtml(skillName + ' \u2014 ') : ''

  // Extract canonical query lists from the first history entry.
  const trainQueries: { query: string; shouldTrigger: boolean }[] = []
  const testQueries: { query: string; shouldTrigger: boolean }[] = []

  if (history.length > 0) {
    const first = history[0]
    for (const r of first.train_results ?? first.results ?? []) {
      trainQueries.push({
        query: r.query,
        shouldTrigger: r.should_trigger ?? true,
      })
    }
    if (first.test_results) {
      for (const r of first.test_results) {
        testQueries.push({
          query: r.query,
          shouldTrigger: r.should_trigger ?? true,
        })
      }
    }
  }

  const refreshTag = autoRefresh
    ? '    <meta http-equiv="refresh" content="5">\n'
    : ''

  // ----- thead ----------------------------------------------------------

  let theadHtml = '<tr><th>Iter</th><th>Train</th>'
  if (testQueries.length > 0) {
    theadHtml += '<th>Test</th>'
  }
  theadHtml += '<th>Description</th>'

  for (const q of trainQueries) {
    const colClass = q.shouldTrigger ? 'positive-col' : 'negative-col'
    const label = q.shouldTrigger ? '+' : '\u2212'
    theadHtml +=
      `<th class="query-col ${colClass}">${escapeHtml(q.query)}<br><span class="train-label">${label} train</span></th>`
  }

  for (const q of testQueries) {
    const colClass = q.shouldTrigger ? 'positive-col' : 'negative-col'
    const label = q.shouldTrigger ? '+' : '\u2212'
    theadHtml +=
      `<th class="query-col test-col ${colClass}">${escapeHtml(q.query)}<br><span class="test-label">${label} test</span></th>`
  }
  theadHtml += '</tr>'

  // ----- per-iteration data + best detection ----------------------------

  interface RowData {
    iter: number
    trainScore: number
    testScore: number
    description: string
    trainResults: QueryResult[]
    testResults: QueryResult[]
  }

  const rows: RowData[] = []
  let bestIdx = -1
  let bestCombined = -1

  for (let i = 0; i < history.length; i++) {
    const entry = history[i]
    const trainResults = entry.train_results ?? entry.results ?? []
    const testResults = entry.test_results ?? []
    const description = entry.description ?? ''

    // Train score: percentage of train queries that passed (rate >= 0.5).
    let trainPasses = 0
    for (const r of trainResults) {
      if (aggregateRuns(r).rate >= 0.5) trainPasses++
    }
    const trainScore =
      trainResults.length > 0 ? (trainPasses / trainResults.length) * 100 : 0

    // Test score: percentage of test queries that passed.
    let testPasses = 0
    for (const r of testResults) {
      if (aggregateRuns(r).rate >= 0.5) testPasses++
    }
    const testScore =
      testResults.length > 0 ? (testPasses / testResults.length) * 100 : 0

    const combined =
      testResults.length > 0 ? (trainScore + testScore) / 2 : trainScore
    if (combined > bestCombined) {
      bestCombined = combined
      bestIdx = i
    }

    rows.push({
      iter: i + 1,
      trainScore,
      testScore,
      description,
      trainResults,
      testResults,
    })
  }

  // ----- tbody ----------------------------------------------------------

  let tbodyHtml = ''
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const rowClass = i === bestIdx ? ' class="best-row"' : ''

    tbodyHtml += `<tr${rowClass}>`
    tbodyHtml += `<td>${row.iter}</td>`
    tbodyHtml +=
      `<td><span class="score ${scoreClass(row.trainScore)}">${row.trainScore.toFixed(0)}%</span></td>`

    if (testQueries.length > 0) {
      tbodyHtml +=
        `<td><span class="score ${scoreClass(row.testScore)}">${row.testScore.toFixed(0)}%</span></td>`
    }

    tbodyHtml += `<td class="description">${escapeHtml(row.description)}</td>`

    // Train result cells
    for (const r of row.trainResults) {
      const agg = aggregateRuns(r)
      const passed = agg.rate >= 0.5
      const icon = passed ? '\u2713' : '\u2717'
      const cls = passed ? 'pass' : 'fail'
      tbodyHtml +=
        `<td class="result"><span class="${cls}">${icon}</span><span class="rate">${agg.correct}/${agg.total}</span></td>`
    }

    // Test result cells
    for (const r of row.testResults) {
      const agg = aggregateRuns(r)
      const passed = agg.rate >= 0.5
      const icon = passed ? '\u2713' : '\u2717'
      const cls = passed ? 'pass' : 'fail'
      tbodyHtml +=
        `<td class="result test-result"><span class="${cls}">${icon}</span><span class="rate">${agg.correct}/${agg.total}</span></td>`
    }

    tbodyHtml += '</tr>\n'
  }

  // ----- summary --------------------------------------------------------

  let summaryHtml = `<p>Iterations: <strong>${history.length}</strong></p>`

  if (bestIdx >= 0) {
    const best = rows[bestIdx]
    let bestLine = `Best: Iteration ${best.iter} \u2014 Train ${best.trainScore.toFixed(0)}%`
    if (testQueries.length > 0) {
      bestLine += ` / Test ${best.testScore.toFixed(0)}%`
    }
    summaryHtml += `<p class="best">${bestLine}</p>`
  }

  if (holdout > 0) {
    summaryHtml += `<p>Holdout queries: ${holdout}</p>`
  }

  // ----- legend ---------------------------------------------------------

  let legendHtml = `<div class="legend">
      <div class="legend-item"><span class="legend-swatch swatch-positive"></span> Should trigger (+)</div>
      <div class="legend-item"><span class="legend-swatch swatch-negative"></span> Should NOT trigger (\u2212)</div>`
  if (testQueries.length > 0) {
    legendHtml += `
      <div class="legend-item"><span class="legend-swatch swatch-train"></span> Train query</div>
      <div class="legend-item"><span class="legend-swatch swatch-test"></span> Test query</div>`
  }
  legendHtml += '\n    </div>'

  // ----- explainer ------------------------------------------------------

  const explainerHtml = `<div class="explainer">
      Each row is one iteration of the optimizer. The description is refined to maximize the score across all training queries.
      \u2713 means the skill correctly triggered (or correctly did not trigger for negative cases) on the majority of retries.
      \u2717 means it failed. The fraction beneath shows correct retries / total retries.
    </div>`

  // ----- assemble full page ---------------------------------------------

  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
${refreshTag}    <title>${titlePrefix}Skill Description Optimization</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600&family=Lora:wght@400;500&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Lora', Georgia, serif; max-width: 100%; margin: 0 auto; padding: 20px; background: #faf9f5; color: #141413; }
        h1 { font-family: 'Poppins', sans-serif; color: #141413; }
        .explainer { background: white; padding: 15px; border-radius: 6px; margin-bottom: 20px; border: 1px solid #e8e6dc; color: #b0aea5; font-size: 0.875rem; line-height: 1.6; }
        .summary { background: white; padding: 15px; border-radius: 6px; margin-bottom: 20px; border: 1px solid #e8e6dc; }
        .summary p { margin: 5px 0; }
        .best { color: #788c5d; font-weight: bold; }
        .table-container { overflow-x: auto; width: 100%; }
        table { border-collapse: collapse; background: white; border: 1px solid #e8e6dc; border-radius: 6px; font-size: 12px; min-width: 100%; }
        th, td { padding: 8px; text-align: left; border: 1px solid #e8e6dc; white-space: normal; word-wrap: break-word; }
        th { font-family: 'Poppins', sans-serif; background: #141413; color: #faf9f5; font-weight: 500; }
        th.test-col { background: #6a9bcc; }
        th.query-col { min-width: 200px; }
        td.description { font-family: monospace; font-size: 11px; word-wrap: break-word; max-width: 400px; }
        td.result { text-align: center; font-size: 16px; min-width: 40px; }
        td.test-result { background: #f0f6fc; }
        .pass { color: #788c5d; }
        .fail { color: #c44; }
        .rate { font-size: 9px; color: #b0aea5; display: block; }
        tr:hover { background: #faf9f5; }
        .score { display: inline-block; padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 11px; }
        .score-good { background: #eef2e8; color: #788c5d; }
        .score-ok { background: #fef3c7; color: #d97706; }
        .score-bad { background: #fceaea; color: #c44; }
        .train-label { color: #b0aea5; font-size: 10px; }
        .test-label { color: #6a9bcc; font-size: 10px; font-weight: bold; }
        .best-row { background: #f5f8f2; }
        th.positive-col { border-bottom: 3px solid #788c5d; }
        th.negative-col { border-bottom: 3px solid #c44; }
        th.test-col.positive-col { border-bottom: 3px solid #788c5d; }
        th.test-col.negative-col { border-bottom: 3px solid #c44; }
        .legend { font-family: 'Poppins', sans-serif; display: flex; gap: 20px; margin-bottom: 10px; font-size: 13px; align-items: center; }
        .legend-item { display: flex; align-items: center; gap: 6px; }
        .legend-swatch { width: 16px; height: 16px; border-radius: 3px; display: inline-block; }
        .swatch-positive { background: #141413; border-bottom: 3px solid #788c5d; }
        .swatch-negative { background: #141413; border-bottom: 3px solid #c44; }
        .swatch-test { background: #6a9bcc; }
        .swatch-train { background: #141413; }
    </style>
</head>
<body>
    <h1>${titlePrefix}Skill Description Optimization</h1>
    ${explainerHtml}
    <div class="summary">
      ${summaryHtml}
    </div>
    ${legendHtml}
    <div class="table-container">
    <table>
      <thead>${theadHtml}</thead>
      <tbody>
${tbodyHtml}      </tbody>
    </table>
    </div>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(Deno.args, {
    string: ['output', 'skill-name'],
    boolean: ['auto-refresh', 'help'],
    alias: { o: 'output', h: 'help' },
    default: {
      'auto-refresh': false,
      'skill-name': '',
      help: false,
    },
  })

  const positionals = args._.map((v) => String(v))

  if (args.help || positionals.length === 0) {
    console.log(
      `Usage: generate_report.ts <input.json> [-o output.html] [--auto-refresh] [--skill-name <name>]

Generate an HTML report from run_loop output.

Arguments:
  input              Input JSON file (required)

Options:
  -o, --output       Output HTML file (default: <input>.html)
  --auto-refresh     Add auto-refresh meta tag (5s interval)
  --skill-name       Skill name to show in the page title
  -h, --help         Show this help message`,
    )
    Deno.exit(args.help ? 0 : 1)
  }

  const inputPath = positionals[0]
  const outputPath =
    args.output || inputPath.replace(/\.json$/, '') + '.html'

  const raw = Deno.readTextFileSync(inputPath)
  const data: ReportData = JSON.parse(raw)

  const htmlContent = generateHtml(
    data,
    Boolean(args['auto-refresh']),
    (args['skill-name'] as string) || '',
  )
  Deno.writeTextFileSync(outputPath, htmlContent)
  console.log(`Report written to ${outputPath}`)
}

if (import.meta.main) {
  main()
}
