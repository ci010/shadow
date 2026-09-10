#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-run

import { parseArgs } from "jsr:@std/cli@^1.0.21/parse-args";
import {
  join,
  resolve,
  relative,
  dirname,
  basename,
  extname,
  fromFileUrl,
} from "jsr:@std/path@^1.1.2";
import { existsSync, walkSync } from "jsr:@std/fs@^1.0.0";
import { encodeBase64 } from "jsr:@std/encoding@^1.0.0/base64";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const METADATA_FILES = ["transcript.md", "user_notes.md", "metrics.json"];

const TEXT_EXTENSIONS = [
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".py",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".css",
  ".sh",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".sql",
  ".r",
  ".toml",
];

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"];

const MIME_OVERRIDES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext in MIME_OVERRIDES) return MIME_OVERRIDES[ext];

  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".xml": "application/xml",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".py": "text/x-python",
    ".ts": "text/typescript",
    ".tsx": "text/tsx",
    ".jsx": "text/jsx",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".sh": "text/x-shellscript",
    ".rb": "text/x-ruby",
    ".go": "text/x-go",
    ".rs": "text/x-rust",
    ".java": "text/x-java",
    ".c": "text/x-c",
    ".cpp": "text/x-c++",
    ".h": "text/x-c",
    ".hpp": "text/x-c++",
    ".sql": "text/x-sql",
    ".r": "text/x-r",
    ".toml": "text/toml",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx":
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };

  return map[ext] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// embedFile
// ---------------------------------------------------------------------------

interface EmbeddedText {
  name: string;
  type: "text";
  content: string;
}

interface EmbeddedImage {
  name: string;
  type: "image";
  mime: string;
  data_uri: string;
}

interface EmbeddedPdf {
  name: string;
  type: "pdf";
  data_uri: string;
}

interface EmbeddedXlsx {
  name: string;
  type: "xlsx";
  data_b64: string;
}

interface EmbeddedBinary {
  name: string;
  type: "binary";
  mime: string;
  data_uri: string;
}

type EmbeddedFile =
  | EmbeddedText
  | EmbeddedImage
  | EmbeddedPdf
  | EmbeddedXlsx
  | EmbeddedBinary;

function embedFile(path: string): EmbeddedFile {
  const name = basename(path);
  const ext = extname(path).toLowerCase();

  if (TEXT_EXTENSIONS.includes(ext)) {
    const content = Deno.readTextFileSync(path);
    return { name, type: "text", content };
  }

  if (IMAGE_EXTENSIONS.includes(ext)) {
    const raw = Deno.readFileSync(path);
    const mime = getMimeType(path);
    const data_uri = `data:${mime};base64,${encodeBase64(raw)}`;
    return { name, type: "image", mime, data_uri };
  }

  if (ext === ".pdf") {
    const raw = Deno.readFileSync(path);
    const data_uri = `data:application/pdf;base64,${encodeBase64(raw)}`;
    return { name, type: "pdf", data_uri };
  }

  if (ext === ".xlsx") {
    const raw = Deno.readFileSync(path);
    const data_b64 = encodeBase64(raw);
    return { name, type: "xlsx", data_b64 };
  }

  // binary fallback
  const raw = Deno.readFileSync(path);
  const mime = getMimeType(path);
  const data_uri = `data:${mime};base64,${encodeBase64(raw)}`;
  return { name, type: "binary", mime, data_uri };
}

// ---------------------------------------------------------------------------
// buildRun
// ---------------------------------------------------------------------------

interface RunObject {
  id: string;
  prompt: string;
  eval_id: string;
  outputs: EmbeddedFile[];
  grading: Record<string, unknown> | null;
}

function buildRun(root: string, runDir: string): RunObject {
  const rel = relative(root, runDir);
  const id = rel.replace(/\\/g, "/");

  // Try to get prompt from eval_metadata.json first, fall back to transcript.md
  let prompt = "";
  const metadataPath = join(runDir, "eval_metadata.json");
  const transcriptPath = join(runDir, "transcript.md");
  if (existsSync(metadataPath)) {
    try {
      const meta = JSON.parse(Deno.readTextFileSync(metadataPath));
      prompt = meta.prompt ?? meta.task ?? "";
    } catch {
      // ignore parse errors
    }
  }
  if (!prompt && existsSync(transcriptPath)) {
    try {
      prompt = Deno.readTextFileSync(transcriptPath);
    } catch {
      // ignore read errors
    }
  }

  // Determine eval_id: parent directory name relative to root,
  // or use the first path segment of the relative id
  const parts = id.split("/");
  const eval_id = parts.length > 1 ? parts.slice(0, -1).join("/") : id;

  // Embed output files from outputs/ subdirectory
  const outputsDir = join(runDir, "outputs");
  const outputs: EmbeddedFile[] = [];
  if (existsSync(outputsDir)) {
    try {
      for (const entry of walkSync(outputsDir, {
        includeDirs: false,
        followSymlinks: false,
      })) {
        try {
          outputs.push(embedFile(entry.path));
        } catch {
          // skip files that cannot be read
        }
      }
    } catch {
      // ignore walk errors
    }
  }

  // Also embed metadata files from the run directory itself
  for (const mf of METADATA_FILES) {
    const mfPath = join(runDir, mf);
    if (existsSync(mfPath)) {
      try {
        outputs.push(embedFile(mfPath));
      } catch {
        // skip
      }
    }
  }

  // Load grading
  let grading: Record<string, unknown> | null = null;
  const gradingPath = join(runDir, "grading.json");
  if (existsSync(gradingPath)) {
    try {
      grading = JSON.parse(Deno.readTextFileSync(gradingPath));
    } catch {
      // ignore
    }
  }

  return { id, prompt, eval_id, outputs, grading };
}

// ---------------------------------------------------------------------------
// findRuns
// ---------------------------------------------------------------------------

function findRuns(workspace: string): RunObject[] {
  const root = resolve(workspace);
  const runs: RunObject[] = [];

  function recurse(dir: string): void {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }
    // Check if this directory has an outputs/ subdirectory
    const hasOutputs = entries.some(
      (e) => e.isDirectory && e.name === "outputs"
    );
    if (hasOutputs) {
      runs.push(buildRun(root, dir));
      return; // don't recurse deeper once we found a run
    }
    // Recurse into subdirectories
    for (const entry of entries) {
      if (entry.isDirectory) {
        recurse(join(dir, entry.name));
      }
    }
  }

  recurse(root);

  // Sort by (eval_id, id)
  runs.sort((a, b) => {
    const cmp = a.eval_id.localeCompare(b.eval_id);
    if (cmp !== 0) return cmp;
    return a.id.localeCompare(b.id);
  });

  return runs;
}

// ---------------------------------------------------------------------------
// loadPreviousIteration
// ---------------------------------------------------------------------------

interface PreviousIteration {
  feedback: Record<string, unknown> | null;
  outputs: EmbeddedFile[];
}

function loadPreviousIteration(workspace: string): PreviousIteration | null {
  const root = resolve(workspace);

  // Load feedback.json
  let feedback: Record<string, unknown> | null = null;
  const feedbackPath = join(root, "feedback.json");
  if (existsSync(feedbackPath)) {
    try {
      feedback = JSON.parse(Deno.readTextFileSync(feedbackPath));
    } catch {
      // ignore
    }
  }

  // Load outputs from the workspace
  const outputsDir = join(root, "outputs");
  const outputs: EmbeddedFile[] = [];
  if (existsSync(outputsDir)) {
    try {
      for (const entry of walkSync(outputsDir, {
        includeDirs: false,
        followSymlinks: false,
      })) {
        try {
          outputs.push(embedFile(entry.path));
        } catch {
          // skip
        }
      }
    } catch {
      // ignore
    }
  }

  if (!feedback && outputs.length === 0) return null;

  return { feedback, outputs };
}

// ---------------------------------------------------------------------------
// generateHtml
// ---------------------------------------------------------------------------

function generateHtml(
  runs: RunObject[],
  skillName: string,
  previous: PreviousIteration | null,
  benchmark: string | null
): string {
  const scriptDir = getScriptDir();
  const templatePath = join(scriptDir, "viewer.html");
  let html = Deno.readTextFileSync(templatePath);

  const data = {
    runs,
    skillName,
    previous,
    benchmark,
  };

  const jsonStr = JSON.stringify(data);
  const injection = `const __DATA__ = ${jsonStr};`;

  html = html.replace("/*__EMBEDDED_DATA__*/", injection);
  return html;
}

// ---------------------------------------------------------------------------
// Script directory helper
// ---------------------------------------------------------------------------

function getScriptDir(): string {
  return dirname(fromFileUrl(import.meta.url));
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function startServer(
  workspace: string,
  port: number,
  skillName: string,
  previousWorkspace: string | null,
  benchmark: string | null
): void {
  const feedbackPath = join(resolve(workspace), "feedback.json");

  console.log(`Serving eval review at http://localhost:${port}`);

  Deno.serve({ port }, (req: Request): Response => {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // GET / or /index.html -> regenerate HTML (re-scan workspace)
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const runs = findRuns(workspace);
      const previous = previousWorkspace
        ? loadPreviousIteration(previousWorkspace)
        : null;
      const html = generateHtml(runs, skillName, previous, benchmark);
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // GET /api/feedback -> serve feedback.json
    if (req.method === "GET" && pathname === "/api/feedback") {
      if (existsSync(feedbackPath)) {
        const content = Deno.readTextFileSync(feedbackPath);
        return new Response(content, {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", {
        headers: { "Content-Type": "application/json" },
      });
    }

    // POST /api/feedback -> save feedback.json
    if (req.method === "POST" && pathname === "/api/feedback") {
      return (async () => {
        try {
          const body = await req.text();
          // Validate it's valid JSON
          JSON.parse(body);
          Deno.writeTextFileSync(feedbackPath, body);
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          return new Response(
            JSON.stringify({ error: String(err) }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
      })();
    }

    // 404 for everything else
    return new Response("Not Found", { status: 404 });
  });
}

// ---------------------------------------------------------------------------
// Open browser (Windows)
// ---------------------------------------------------------------------------

function openBrowser(url: string): void {
  try {
    const cmd = new Deno.Command("cmd", {
      args: ["/c", "start", url],
      stdout: "null",
      stderr: "null",
    });
    cmd.spawn();
  } catch {
    console.error(`Could not open browser. Navigate to: ${url}`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(Deno.args, {
    string: ["port", "skill-name", "previous-workspace", "benchmark", "static"],
    default: {
      port: "3117",
      "skill-name": "",
    },
  });

  const positional = args._ as string[];
  if (positional.length < 1) {
    console.error(
      "Usage: generate_review.ts <workspace> [--port PORT] [--skill-name NAME] [--previous-workspace PATH] [--benchmark PATH] [--static OUTPUT_PATH]"
    );
    Deno.exit(1);
  }

  const workspace = resolve(String(positional[0]));
  const port = parseInt(String(args.port), 10);
  const skillName = String(args["skill-name"] ?? "");
  const previousWorkspace = args["previous-workspace"]
    ? resolve(String(args["previous-workspace"]))
    : null;
  const benchmark = args.benchmark ? resolve(String(args.benchmark)) : null;
  const staticPath = args.static ? resolve(String(args.static)) : null;

  if (!existsSync(workspace)) {
    console.error(`Workspace not found: ${workspace}`);
    Deno.exit(1);
  }

  const runs = findRuns(workspace);
  console.log(`Found ${runs.length} run(s) in ${workspace}`);

  const previous = previousWorkspace
    ? loadPreviousIteration(previousWorkspace)
    : null;

  if (staticPath) {
    // Static mode: write HTML to file and exit
    const html = generateHtml(runs, skillName, previous, benchmark);
    Deno.writeTextFileSync(staticPath, html);
    console.log(`Static review written to ${staticPath}`);
    Deno.exit(0);
  }

  // Server mode: start HTTP server and open browser
  const url = `http://localhost:${port}`;
  openBrowser(url);
  startServer(workspace, port, skillName, previousWorkspace, benchmark);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main();
