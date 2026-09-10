#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env
/**
 * Improve a skill description based on eval results.
 *
 * Faithful Deno/TypeScript port of the Python improve_description.py script.
 */

import { parseArgs } from 'jsr:@std/cli@^1.0.21/parse-args'
import { join } from 'jsr:@std/path@^1.1.2'
import { parseSkillMd } from './utils.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface HistoryEntry {
  description: string
  score: string
  iteration: number
}

interface Transcript {
  iteration: number | null
  prompt: string
  response: string
  parsed_description: string
  char_count: number
  over_limit: boolean
  rewrite_prompt?: string
  rewrite_response?: string
  rewrite_description?: string
  rewrite_char_count?: number
  final_description?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Call `claude -p` as a subprocess, sending the prompt via stdin.
 * Removes the CLAUDECODE env var from the subprocess environment.
 */
async function callClaude(prompt: string, model: string | undefined, timeout = 300): Promise<string> {
  const cmd = ['claude', '-p', '--output-format', 'text']
  if (model) {
    cmd.push('--model', model)
  }

  // Build env without CLAUDECODE
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(Deno.env.toObject())) {
    if (k !== 'CLAUDECODE') {
      env[k] = v
    }
  }

  const process = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
    env,
  })

  const child = process.spawn()

  // Write prompt to stdin and close it
  const encoder = new TextEncoder()
  const writer = child.stdin.getWriter()
  await writer.write(encoder.encode(prompt))
  await writer.close()

  // Wait for the process to complete with timeout
  const result = await Promise.race([
    child.output(),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => {
        try {
          child.kill()
        } catch {
          // already exited
        }
        reject(new Error(`claude -p timed out after ${timeout}s`))
      }, timeout * 1000)
    ),
  ])

  const decoder = new TextDecoder()
  if (result.code !== 0) {
    const stderr = decoder.decode(result.stderr)
    throw new Error(`claude -p exited ${result.code}\nstderr: ${stderr}`)
  }

  return decoder.decode(result.stdout)
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Improve a skill description based on eval results.
 *
 * Calls `claude -p` with a prompt asking it to optimise the description so
 * that it triggers correctly on the eval queries.  If the returned
 * description exceeds 1024 characters it will automatically request a
 * shortened version.
 *
 * @returns The improved description string.
 */
export async function improveDescription(opts: {
  skillName: string
  skillContent: string
  currentDescription: string
  evalResults: EvalOutput
  history: HistoryEntry[]
  model: string | undefined
  testResults?: EvalOutput
  logDir?: string
  iteration?: number
}): Promise<string> {
  const {
    skillName,
    skillContent,
    currentDescription,
    evalResults,
    history,
    model,
    testResults,
    logDir,
    iteration,
  } = opts

  const failedTriggers = evalResults.results.filter(
    (r) => r.should_trigger && !r.pass,
  )
  const falseTriggers = evalResults.results.filter(
    (r) => !r.should_trigger && !r.pass,
  )

  const trainScore = `${evalResults.summary.passed}/${evalResults.summary.total}`
  let scoresSummary: string
  if (testResults) {
    const testScore = `${testResults.summary.passed}/${testResults.summary.total}`
    scoresSummary = `Train: ${trainScore}, Test: ${testScore}`
  } else {
    scoresSummary = `Train: ${trainScore}`
  }

  // Format failed triggers
  let formattedFailed: string
  if (failedTriggers.length === 0) {
    formattedFailed = '(none — all positive cases are passing)'
  } else {
    formattedFailed = failedTriggers
      .map(
        (r, i) =>
          `${i + 1}. Query: "${r.query}"\n` +
          `   should_trigger: ${r.should_trigger}, trigger_rate: ${r.trigger_rate}, pass: ${r.pass}`,
      )
      .join('\n')
  }

  // Format false triggers
  let formattedFalse: string
  if (falseTriggers.length === 0) {
    formattedFalse = '(none — all negative cases are passing)'
  } else {
    formattedFalse = falseTriggers
      .map(
        (r, i) =>
          `${i + 1}. Query: "${r.query}"\n` +
          `   should_trigger: ${r.should_trigger}, trigger_rate: ${r.trigger_rate}, pass: ${r.pass}`,
      )
      .join('\n')
  }

  // Format history
  let formattedHistory: string
  if (history.length === 0) {
    formattedHistory = '(no previous attempts)'
  } else {
    formattedHistory = history
      .map(
        (h) =>
          `Iteration ${h.iteration}: score=${h.score}\n` +
          `  Description: "${h.description}"`,
      )
      .join('\n\n')
  }

  const prompt = `You are optimizing a skill description for a Claude Code skill called "${skillName}".

## Background

A skill description is the primary mechanism the agent uses to decide whether to load a skill for a given user request. The description appears in the skill's YAML frontmatter and is matched against user messages to determine relevance.

A good description:
1. Triggers on all user messages that the skill should handle (high recall)
2. Does NOT trigger on user messages the skill should not handle (high precision)
3. Is under 1024 characters (HARD LIMIT — descriptions over this are rejected)
4. Does not contain angle brackets (< or >)

The agent sees the description alongside descriptions of all other installed skills, and uses it to decide which skill (if any) to load. The description must be specific enough to trigger on relevant queries, yet precise enough to avoid false triggers on unrelated queries.

## Current Description

"${currentDescription}"

## Current Performance

Scores: ${scoresSummary}

## Failed Triggers (should have triggered but didn't)

These user messages SHOULD have caused the skill to trigger, but the current description failed to match them. You must ensure the new description covers these cases:

${formattedFailed}

## False Triggers (should NOT have triggered but did)

These user messages should NOT have caused the skill to trigger, but the current description incorrectly matched them. You must ensure the new description does NOT match these:

${formattedFalse}

## History of Previous Attempts

Review these to avoid reverting to a previously tried description that didn't work. Each entry shows the description that was tried and its score. Do NOT reuse a description that scored the same or worse than the current one:

${formattedHistory}

## Skill Content (for context)

The full SKILL.md content is provided below so you understand what the skill actually does. Use this to inform your description, but remember that the description is about WHEN to trigger the skill, not a summary of its instructions:

---
${skillContent}
---

## Instructions

Write an improved description that:

1. **Covers all failed trigger cases**: The description must include keywords, phrases, or semantic patterns that would cause the agent to recognise these queries as relevant to this skill. Look at the specific wording and intent of each failed trigger query and ensure the description addresses it.

2. **Excludes false trigger cases**: The description must NOT match these queries. Consider what makes these queries different from legitimate ones and use that distinction in your wording.

3. **Stays under 1024 characters**: This is a HARD LIMIT. Descriptions over 1024 characters are automatically rejected. Aim for 400-900 characters to leave room for clarity without hitting the limit.

4. **Does not contain angle brackets**: No < or > characters anywhere in the description.

5. **Maintains passing cases**: Do not lose coverage of queries that currently pass. The description should be a strict improvement, not a lateral move.

6. **Avoids previously failed descriptions**: Check the history above. Do not revert to or closely resemble any description that scored the same or worse.

7. **Uses natural, descriptive language**: The description should read naturally. Include specific trigger words, domain terms, file types, action verbs, and scenario descriptions that align with the skill's purpose.

8. **Frontloads the most important information**: Put the most distinctive, high-signal terms at the beginning. The agent may weigh earlier content more heavily.

Think step by step:
- First, analyse the failed triggers to identify what keywords or concepts are missing from the current description.
- Then, analyse the false triggers to identify what makes them different from legitimate queries.
- Finally, craft a description that adds coverage for the missing cases while excluding the false ones.

Respond with your improved description wrapped in <new_description> tags. Do NOT include quotes around the description inside the tags:

<new_description>
your improved description here
</new_description>`

  const text = await callClaude(prompt, model)

  // Parse the response
  const match = text.match(/<new_description>([\s\S]*?)<\/new_description>/)
  let description: string
  if (match) {
    description = match[1].trim().replace(/^"|"$/g, '')
  } else {
    description = text.trim().replace(/^"|"$/g, '')
  }

  const transcript: Transcript = {
    iteration: iteration ?? null,
    prompt,
    response: text,
    parsed_description: description,
    char_count: description.length,
    over_limit: description.length > 1024,
  }

  // If over 1024 characters, ask for a shortened version
  if (description.length > 1024) {
    const shortenPrompt =
      `${prompt}\n\n` +
      `---\n\n` +
      `A previous attempt produced this description, which at ${description.length} characters is over the 1024-character hard limit:\n\n` +
      `"${description}"\n\n` +
      `Rewrite it to be under 1024 characters while keeping the most important trigger words and intent coverage. Respond with only the new description in <new_description> tags.`

    const shortenText = await callClaude(shortenPrompt, model)
    const shortenMatch = shortenText.match(/<new_description>([\s\S]*?)<\/new_description>/)
    let shortened: string
    if (shortenMatch) {
      shortened = shortenMatch[1].trim().replace(/^"|"$/g, '')
    } else {
      shortened = shortenText.trim().replace(/^"|"$/g, '')
    }

    transcript.rewrite_prompt = shortenPrompt
    transcript.rewrite_response = shortenText
    transcript.rewrite_description = shortened
    transcript.rewrite_char_count = shortened.length
    description = shortened
  }

  transcript.final_description = description

  // Write transcript to log directory if provided
  if (logDir) {
    Deno.mkdirSync(logDir, { recursive: true })
    const logFile = join(logDir, `improve_iter_${iteration ?? 'unknown'}.json`)
    Deno.writeTextFileSync(logFile, JSON.stringify(transcript, null, 2))
  }

  return description
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(Deno.args, {
    string: ['skill-path', 'eval-results', 'test-results', 'model', 'log-dir', 'history'],
    default: {
      iteration: 0,
    },
    alias: { h: 'help' },
    boolean: ['help'],
  })

  if (args.help) {
    console.log(`Usage: improve_description.ts --skill-path <path> --eval-results <path> [options]

Required:
  --skill-path      Path to the skill directory
  --eval-results    Path to eval results JSON file

Options:
  --test-results    Path to test results JSON file
  --model           Model override for claude -p
  --log-dir         Directory to write transcripts to
  --history         Path to history JSON file (array of previous attempts)
  --iteration       Iteration number (default: 0)
  --help            Show this help message`)
    Deno.exit(0)
  }

  const skillPath = args['skill-path']
  const evalResultsPath = args['eval-results']

  if (!skillPath || !evalResultsPath) {
    console.error('Error: --skill-path and --eval-results are required.')
    console.error('Run with --help for usage information.')
    Deno.exit(1)
  }

  // Parse skill
  const { name: skillName, description: currentDescription, content: skillContent } = parseSkillMd(skillPath)

  // Read eval results
  const evalResults: EvalOutput = JSON.parse(Deno.readTextFileSync(evalResultsPath))

  // Read test results if provided
  let testResults: EvalOutput | undefined
  const testResultsPath = args['test-results']
  if (testResultsPath) {
    testResults = JSON.parse(Deno.readTextFileSync(testResultsPath))
  }

  // Read history if provided
  let history: HistoryEntry[] = []
  const historyPath = args['history']
  if (historyPath) {
    history = JSON.parse(Deno.readTextFileSync(historyPath))
  }

  const model = args['model'] || undefined
  const logDir = args['log-dir'] || undefined
  const iteration = Number(args['iteration']) || 0

  const newDescription = await improveDescription({
    skillName,
    skillContent,
    currentDescription,
    evalResults,
    history,
    model,
    testResults,
    logDir,
    iteration,
  })

  console.log(newDescription)
}

if (import.meta.main) {
  main()
}
