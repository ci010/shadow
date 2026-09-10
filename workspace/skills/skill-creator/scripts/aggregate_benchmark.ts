#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Aggregate individual run results into benchmark summary statistics.
 *
 * Reads grading.json files from run directories and produces:
 * - run_summary with mean, stddev, min, max for each metric
 * - delta between with_skill and without_skill configurations
 *
 * Usage:
 *     deno run --allow-read --allow-write scripts/aggregate_benchmark.ts <benchmark_dir> \
 *         [--skill-name <name>] [--skill-path <path>] [-o <output>]
 *
 * The script supports two directory layouts:
 *
 *     Workspace layout (from skill-creator iterations):
 *     <benchmark_dir>/
 *     └── eval-N/
 *         ├── with_skill/
 *         │   ├── run-1/grading.json
 *         │   └── run-2/grading.json
 *         └── without_skill/
 *             ├── run-1/grading.json
 *             └── run-2/grading.json
 *
 *     Legacy layout (with runs/ subdirectory):
 *     <benchmark_dir>/
 *     └── runs/
 *         └── eval-N/
 *             ├── with_skill/
 *             │   └── run-1/grading.json
 *             └── without_skill/
 *                 └── run-1/grading.json
 */

import { parseArgs } from "jsr:@std/cli@^1.0.21/parse-args";
import { existsSync } from "jsr:@std/fs@^1.0.0";
import { join, resolve, basename } from "jsr:@std/path@^1.1.2";

// ── Helpers ──────────────────────────────────────────────────────────────────

interface Stats {
  mean: number;
  stddev: number;
  min: number;
  max: number;
}

function calculateStats(values: number[]): Stats {
  if (values.length === 0) {
    return { mean: 0.0, stddev: 0.0, min: 0.0, max: 0.0 };
  }
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  let stddev = 0.0;
  if (n > 1) {
    const variance =
      values.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (n - 1);
    stddev = Math.sqrt(variance);
  }
  return {
    mean: round4(mean),
    stddev: round4(stddev),
    min: round4(Math.min(...values)),
    max: round4(Math.max(...values)),
  };
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** Return sorted sub-directories of `dir` whose names match the glob `prefix*`. */
function globDirs(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return [];
  const entries: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (entry.isDirectory && entry.name.startsWith(prefix)) {
      entries.push(join(dir, entry.name));
    }
  }
  entries.sort();
  return entries;
}

/** Return sorted immediate sub-directories of `dir`. */
function listDirs(dir: string): string[] {
  const entries: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (entry.isDirectory) {
      entries.push(join(dir, entry.name));
    }
  }
  entries.sort();
  return entries;
}

function readJson(path: string): unknown | undefined {
  try {
    const text = Deno.readTextFileSync(path);
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

interface Expectation {
  text?: string;
  passed?: boolean;
  evidence?: string;
  [key: string]: unknown;
}

interface RunResult {
  eval_id: number | string;
  run_number: number;
  pass_rate: number;
  passed: number;
  failed: number;
  total: number;
  time_seconds: number;
  tokens: number;
  tool_calls: number;
  errors: number;
  expectations: Expectation[];
  notes: string[];
}

interface RunSummary {
  [config: string]: {
    pass_rate: Stats;
    time_seconds: Stats;
    tokens: Stats;
  } | {
    pass_rate: string;
    time_seconds: string;
    tokens: string;
  };
}

interface Benchmark {
  metadata: {
    skill_name: string;
    skill_path: string;
    executor_model: string;
    analyzer_model: string;
    timestamp: string;
    evals_run: (number | string)[];
    runs_per_configuration: number;
  };
  runs: {
    eval_id: number | string;
    configuration: string;
    run_number: number;
    result: {
      pass_rate: number;
      passed: number;
      failed: number;
      total: number;
      time_seconds: number;
      tokens: number;
      tool_calls: number;
      errors: number;
    };
    expectations: Expectation[];
    notes: string[];
  }[];
  run_summary: RunSummary;
  notes: string[];
}

// ── Core Logic ───────────────────────────────────────────────────────────────

function loadRunResults(benchmarkDir: string): Record<string, RunResult[]> {
  const runsDir = join(benchmarkDir, "runs");
  let searchDir: string;

  if (existsSync(runsDir)) {
    searchDir = runsDir;
  } else if (globDirs(benchmarkDir, "eval-").length > 0) {
    searchDir = benchmarkDir;
  } else {
    console.log(
      `No eval directories found in ${benchmarkDir} or ${join(benchmarkDir, "runs")}`,
    );
    return {};
  }

  const results: Record<string, RunResult[]> = {};

  const evalDirs = globDirs(searchDir, "eval-");

  for (let evalIdx = 0; evalIdx < evalDirs.length; evalIdx++) {
    const evalDir = evalDirs[evalIdx];

    // Determine eval_id
    let evalId: number | string = evalIdx;
    const metadataPath = join(evalDir, "eval_metadata.json");
    if (existsSync(metadataPath)) {
      const meta = readJson(metadataPath) as Record<string, unknown> | undefined;
      if (meta && meta.eval_id !== undefined) {
        evalId = meta.eval_id as number | string;
      } else {
        evalId = evalIdx;
      }
    } else {
      const parts = basename(evalDir).split("-");
      if (parts.length >= 2) {
        const parsed = parseInt(parts[1], 10);
        evalId = isNaN(parsed) ? evalIdx : parsed;
      }
    }

    // Iterate config dirs
    const configDirs = listDirs(evalDir);
    for (const configDir of configDirs) {
      // Check if it has run-* subdirectories
      const runDirs = globDirs(configDir, "run-");
      if (runDirs.length === 0) continue;

      const config = basename(configDir);
      if (!(config in results)) {
        results[config] = [];
      }

      for (const runDir of runDirs) {
        const runParts = basename(runDir).split("-");
        const runNumber = runParts.length >= 2 ? parseInt(runParts[1], 10) : 0;

        const gradingFile = join(runDir, "grading.json");
        if (!existsSync(gradingFile)) {
          console.log(`Warning: grading.json not found in ${runDir}`);
          continue;
        }

        const grading = readJson(gradingFile) as Record<string, unknown> | undefined;
        if (!grading) {
          console.log(`Warning: Invalid JSON in ${gradingFile}`);
          continue;
        }

        const summary = (grading.summary ?? {}) as Record<string, unknown>;
        const result: RunResult = {
          eval_id: evalId,
          run_number: runNumber,
          pass_rate: (summary.pass_rate as number) ?? 0.0,
          passed: (summary.passed as number) ?? 0,
          failed: (summary.failed as number) ?? 0,
          total: (summary.total as number) ?? 0,
          time_seconds: 0,
          tokens: 0,
          tool_calls: 0,
          errors: 0,
          expectations: [],
          notes: [],
        };

        // Timing from grading
        const timing = (grading.timing ?? {}) as Record<string, unknown>;
        result.time_seconds = (timing.total_duration_seconds as number) ?? 0.0;

        // Fallback to timing.json
        const timingFile = join(runDir, "timing.json");
        if (result.time_seconds === 0.0 && existsSync(timingFile)) {
          const timingData = readJson(timingFile) as Record<string, unknown> | undefined;
          if (timingData) {
            result.time_seconds =
              (timingData.total_duration_seconds as number) ?? 0.0;
            result.tokens = (timingData.total_tokens as number) ?? 0;
          }
        }

        // Execution metrics
        const metrics = (grading.execution_metrics ?? {}) as Record<string, unknown>;
        result.tool_calls = (metrics.total_tool_calls as number) ?? 0;
        if (!result.tokens) {
          result.tokens = (metrics.output_chars as number) ?? 0;
        }
        result.errors = (metrics.errors_encountered as number) ?? 0;

        // Expectations
        const rawExpectations = (grading.expectations ?? []) as Expectation[];
        for (const exp of rawExpectations) {
          if (!("text" in exp) || !("passed" in exp)) {
            console.log(
              `Warning: expectation in ${gradingFile} missing required fields (text, passed, evidence): ${JSON.stringify(exp)}`,
            );
          }
        }
        result.expectations = rawExpectations;

        // Notes
        const notesSummary = (grading.user_notes_summary ?? {}) as Record<string, string[]>;
        const notes: string[] = [];
        if (notesSummary.uncertainties) notes.push(...notesSummary.uncertainties);
        if (notesSummary.needs_review) notes.push(...notesSummary.needs_review);
        if (notesSummary.workarounds) notes.push(...notesSummary.workarounds);
        result.notes = notes;

        results[config].push(result);
      }
    }
  }

  return results;
}

function aggregateResults(results: Record<string, RunResult[]>): RunSummary {
  const runSummary: RunSummary = {};
  const configs = Object.keys(results);

  for (const config of configs) {
    const runs = results[config] ?? [];
    if (runs.length === 0) {
      runSummary[config] = {
        pass_rate: { mean: 0.0, stddev: 0.0, min: 0.0, max: 0.0 },
        time_seconds: { mean: 0.0, stddev: 0.0, min: 0.0, max: 0.0 },
        tokens: { mean: 0, stddev: 0, min: 0, max: 0 },
      };
      continue;
    }

    const passRates = runs.map((r) => r.pass_rate);
    const times = runs.map((r) => r.time_seconds);
    const tokens = runs.map((r) => r.tokens ?? 0);

    runSummary[config] = {
      pass_rate: calculateStats(passRates),
      time_seconds: calculateStats(times),
      tokens: calculateStats(tokens),
    };
  }

  // Compute delta
  let primary: Record<string, Stats> = {};
  let baseline: Record<string, Stats> = {};

  if (configs.length >= 2) {
    primary = runSummary[configs[0]] as unknown as Record<string, Stats>;
    baseline = runSummary[configs[1]] as unknown as Record<string, Stats>;
  } else if (configs.length >= 1) {
    primary = runSummary[configs[0]] as unknown as Record<string, Stats>;
    baseline = {};
  }

  const deltaPassRate =
    ((primary.pass_rate as Stats)?.mean ?? 0) -
    ((baseline.pass_rate as Stats)?.mean ?? 0);
  const deltaTime =
    ((primary.time_seconds as Stats)?.mean ?? 0) -
    ((baseline.time_seconds as Stats)?.mean ?? 0);
  const deltaTokens =
    ((primary.tokens as Stats)?.mean ?? 0) -
    ((baseline.tokens as Stats)?.mean ?? 0);

  runSummary["delta"] = {
    pass_rate: (deltaPassRate >= 0 ? "+" : "") + deltaPassRate.toFixed(2),
    time_seconds: (deltaTime >= 0 ? "+" : "") + deltaTime.toFixed(1),
    tokens: (deltaTokens >= 0 ? "+" : "") + Math.round(deltaTokens).toString(),
  };

  return runSummary;
}

function generateBenchmark(
  benchmarkDir: string,
  skillName = "",
  skillPath = "",
): Benchmark {
  const results = loadRunResults(benchmarkDir);
  const runSummary = aggregateResults(results);

  const runs: Benchmark["runs"] = [];
  for (const config of Object.keys(results)) {
    for (const result of results[config]) {
      runs.push({
        eval_id: result.eval_id,
        configuration: config,
        run_number: result.run_number,
        result: {
          pass_rate: result.pass_rate,
          passed: result.passed,
          failed: result.failed,
          total: result.total,
          time_seconds: result.time_seconds,
          tokens: result.tokens ?? 0,
          tool_calls: result.tool_calls ?? 0,
          errors: result.errors ?? 0,
        },
        expectations: result.expectations,
        notes: result.notes,
      });
    }
  }

  // Collect unique eval_ids, sorted
  const evalIdSet = new Set<number | string>();
  for (const config of Object.values(results)) {
    for (const r of config) {
      evalIdSet.add(r.eval_id);
    }
  }
  const evalIds = [...evalIdSet].sort((a, b) => {
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b));
  });

  const now = new Date();
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");

  const benchmark: Benchmark = {
    metadata: {
      skill_name: skillName || "<skill-name>",
      skill_path: skillPath || "<path/to/skill>",
      executor_model: "<model-name>",
      analyzer_model: "<model-name>",
      timestamp,
      evals_run: evalIds,
      runs_per_configuration: 3,
    },
    runs,
    run_summary: runSummary,
    notes: [],
  };

  return benchmark;
}

// ── Markdown ─────────────────────────────────────────────────────────────────

function generateMarkdown(benchmark: Benchmark): string {
  const metadata = benchmark.metadata;
  const runSummary = benchmark.run_summary;

  const configs = Object.keys(runSummary).filter((k) => k !== "delta");
  const configA = configs.length >= 1 ? configs[0] : "config_a";
  const configB = configs.length >= 2 ? configs[1] : "config_b";
  const labelA = configA.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const labelB = configB.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  const lines: string[] = [
    `# Skill Benchmark: ${metadata.skill_name}`,
    "",
    `**Model**: ${metadata.executor_model}`,
    `**Date**: ${metadata.timestamp}`,
    `**Evals**: ${metadata.evals_run.map(String).join(", ")} (${metadata.runs_per_configuration} runs each per configuration)`,
    "",
    "## Summary",
    "",
    `| Metric | ${labelA} | ${labelB} | Delta |`,
    "|--------|------------|---------------|-------|",
  ];

  const aSummary = (runSummary[configA] ?? {}) as Record<string, Stats | string>;
  const bSummary = (runSummary[configB] ?? {}) as Record<string, Stats | string>;
  const delta = (runSummary["delta"] ?? {}) as Record<string, string>;

  const aPr = (aSummary.pass_rate ?? {}) as Stats;
  const bPr = (bSummary.pass_rate ?? {}) as Stats;
  lines.push(
    `| Pass Rate | ${((aPr.mean ?? 0) * 100).toFixed(0)}% \u00b1 ${((aPr.stddev ?? 0) * 100).toFixed(0)}% | ${((bPr.mean ?? 0) * 100).toFixed(0)}% \u00b1 ${((bPr.stddev ?? 0) * 100).toFixed(0)}% | ${delta.pass_rate ?? "\u2014"} |`,
  );

  const aTime = (aSummary.time_seconds ?? {}) as Stats;
  const bTime = (bSummary.time_seconds ?? {}) as Stats;
  lines.push(
    `| Time | ${(aTime.mean ?? 0).toFixed(1)}s \u00b1 ${(aTime.stddev ?? 0).toFixed(1)}s | ${(bTime.mean ?? 0).toFixed(1)}s \u00b1 ${(bTime.stddev ?? 0).toFixed(1)}s | ${delta.time_seconds ?? "\u2014"}s |`,
  );

  const aTokens = (aSummary.tokens ?? {}) as Stats;
  const bTokens = (bSummary.tokens ?? {}) as Stats;
  lines.push(
    `| Tokens | ${(aTokens.mean ?? 0).toFixed(0)} \u00b1 ${(aTokens.stddev ?? 0).toFixed(0)} | ${(bTokens.mean ?? 0).toFixed(0)} \u00b1 ${(bTokens.stddev ?? 0).toFixed(0)} | ${delta.tokens ?? "\u2014"} |`,
  );

  if (benchmark.notes && benchmark.notes.length > 0) {
    lines.push("", "## Notes", "");
    for (const note of benchmark.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs(Deno.args, {
    string: ["skill-name", "skill-path", "o"],
    alias: { o: "output" },
    default: {
      "skill-name": "",
      "skill-path": "",
    },
  });

  const positional = args._ as string[];
  if (positional.length < 1) {
    console.error(
      "Usage: aggregate_benchmark.ts <benchmark_dir> [--skill-name <name>] [--skill-path <path>] [-o <output>]",
    );
    Deno.exit(1);
  }

  const benchmarkDir = resolve(String(positional[0]));
  const skillName = args["skill-name"] as string;
  const skillPath = args["skill-path"] as string;
  const outputPath = (args.o ?? args.output ?? "") as string;

  if (!existsSync(benchmarkDir)) {
    console.error(`Error: benchmark directory not found: ${benchmarkDir}`);
    Deno.exit(1);
  }

  const benchmark = generateBenchmark(benchmarkDir, skillName, skillPath);

  const jsonOutput = JSON.stringify(benchmark, null, 2);

  if (outputPath) {
    Deno.writeTextFileSync(resolve(outputPath), jsonOutput);
    console.log(`Benchmark written to ${outputPath}`);
  } else {
    console.log(jsonOutput);
  }

  // Always print the markdown summary to stderr so it is visible even when
  // stdout is redirected to a file.
  const markdown = generateMarkdown(benchmark);
  console.error("");
  console.error(markdown);
}

main();
