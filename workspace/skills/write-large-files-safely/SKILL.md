---
name: write-large-files-safely
description: Use this skill whenever writing large files (HTML reports, documents, generated assets >10KB) to disk. Covers the silent-failure bug in the `write` tool when content is undefined or missing, and the safe pattern using Deno to guarantee correct writes. Also covers file corruption during find-and-replace (`write` with `match`) on large files. Trigger on any task involving generating a large HTML, Markdown, or text file from a template or computed content.
related: coding
learnedAt: 2026-04-14T00:00:00Z
updatedAt: 2026-07-13T00:00:00Z
version: 3
---

# Writing Large Files Safely

## The Problem — Silent Failure in `write` Tool

The `write` tool will silently "succeed" (return no error, writes ~9 bytes) if the `content` parameter is undefined or missing. This causes the file to be corrupted/empty with no indication of failure.

**This is especially dangerous when:**
- Building large HTML/Markdown reports in a variable and passing it to `write`
- Chaining agent steps where content may be lost across turns
- Writing files with computed content that could be `undefined` at runtime

**Symptom:** File exists, is ~9 bytes, and appears to contain `undefined` or is blank.

---

## Problem #2 — File Corruption During Find-and-Replace (`write` with `match`)

The `write` tool with the `match` parameter can silently **corrupt large files**, reducing them to 1 byte (or a few bytes) during find-and-replace text replacement. This has been observed with 21+ KB HTML presentation files. The replacement either swallows the file content or the original file is truncated.

**Symptom:** File size drops to 1–9 bytes, content is unreadable.

**This is especially dangerous when:**
- Performing multiple sequential find-and-replace operations on the same file
- Replacing large blocks of text (e.g., entire SVG blocks, slide sections)
- Working on large generated files (HTML, code, data)

### Safe Pattern — Always Backup Before Match-Based Edits

Before any `write` with `match` on a file larger than a few KB:

```typescript
// In exec(shell:"deno"), backup the file first
const original = await Deno.readTextFile("path/to/file.html");
await Deno.writeTextFile("path/to/file.html.bak", original);
console.log("Backup created:", original.length, "bytes");
```

Then proceed with the match-based edit. If corruption occurs, restore from backup.

### If File Gets Corrupted — Full Reconstruction

When a large file gets corrupted (truncated to 1 byte), do NOT attempt incremental recovery. Abandon the corrupted file and **rebuild from scratch** using `exec shell:deno`:

```typescript
// Build the entire content in one Deno script
const content = `... full file content ...`;
await Deno.writeTextFile("path/to/file.html", content);
const stat = await Deno.stat("path/to/file.html");
console.log("Written:", stat.size, "bytes");
```

This is safer than chaining multiple `write`+`match` operations, each of which risks corruption.

---

## Safe Pattern — Use `exec shell:deno`

For any file larger than a few KB, or anytime the content is built programmatically, write via Deno:

```typescript
// In exec(shell:"deno")
const content = `... your large content here ...`;
await Deno.writeTextFile("path/to/output.html", content);
console.log("Written:", (await Deno.stat("path/to/output.html")).size, "bytes");
```

Always log the byte size after writing to verify the file is non-trivial.

## Verification Step

After writing any important file, verify it:

```typescript
const stat = await Deno.stat("path/to/file");
if (stat.size < 100) throw new Error(`Suspiciously small file: ${stat.size} bytes`);
console.log(`OK: ${stat.size} bytes`);
```

Or use the `read` tool to check the first few lines look correct.

## When `write` Tool Is Fine

- Short files (<1KB) where content is a literal string in the same tool call
- Config files, small JSON, brief Markdown snippets
- `match`-based find-and-replace edits on **small files only** (<5KB, single-line edits)

## Problem #3 — Newline Encoding Mismatch in `match` Strings

When using `write(path, match=..., content=...)` to perform find-and-replace, **escaped newline characters (`\n`) in the `match` string may not match real newlines in the file**.

**Example of the problem (from real experience):**

```typescript
// ❌ FAILS: Escaped \n doesn't match the real newlines in the file
write("presentation.html", {
  match: "<div class=\"card\">\n  <p>内容</p>\n</div>",
  content: "<div class=\"card\">\n  <p>替换内容</p>\n</div>"
});
// Result: No match found, no replacement happens (silent failure)
```

The Deno `write` tool does not normalize `\n` escape sequences in the `match` string to match the actual newline encoding in the file. The literal characters `\n` (backslash + n) are treated as-is, not as newline characters.

**Symptom:** The `write` returns successfully but the file doesn't change. No error is reported.

### Safe Pattern — Verify Exact Match Content First

**Step 1: Read the exact content from the file using `grep` or `read` with context**

```bash
# Use grep with context to find the exact characters around the target
grep -n -B 1 -A 1 "target-text" file.html
# Copy the exact lines — they show the real newlines as actual line breaks
```

**Step 2: Use the exact content from the file in your `match` string**

```typescript
// ✅ WORKS: Paste the exact content (with real line breaks) from the file
const exactMatch = `<div class="card">
  <p>内容</p>
</div>`;

const replacement = `<div class="card">
  <p>替换内容</p>
</div>`;

// Use template literals — they preserve real newlines
write("presentation.html", { match: exactMatch, content: replacement });
```

**Alternative: Use Deno to read, replace, and write (most reliable)**

```typescript
// ✅ BEST: Read the full file, use Deno's replace, write back via exec(shell:"deno")
const content = await Deno.readTextFile("presentation.html");
const updated = content.replace(
  '<div class="card">\n  <p>内容</p>\n</div>',
  '<div class="card">\n  <p>替换内容</p>\n</div>'
);
await Deno.writeTextFile("presentation.html", updated);
```

**Key insight:** When the `write(match=...)` tool silently does nothing, the most likely cause is `\n` encoding mismatch — not that the content doesn't exist in the file. Verify by reading the file and using the exact string you see.

### Key Rules for Match Strings

1. **Use template literals (backticks)** for multi-line match strings — they preserve real newlines
2. **Never construct match strings with `+ '\n' +` or `"\\n"`** — these produce escape characters, not real newlines
3. **If a match operation silently fails**, first verify the content exists in the file with `grep`, then copy-paste the exact file content into your `match` string
4. **For complex replacements**, bypass `write(match=...)` entirely — read the file in Deno, perform the replacement, write back
5. **Always log the count** when doing replacements: `console.log("Replaced:", (content.match(/pattern/g) || []).length, "occurrences")` to verify matches

## Summary

| Scenario | Safe Method |
|---|---|
| Large generated file (HTML report, etc.) | `exec shell:deno` + `Deno.writeTextFile` |
| Small literal file | `write` tool directly |
| Find-and-replace on large file | **Backup first** via Deno, then `write` with `match` |
| File already corrupted | Abandon incremental — rebuild fully from Deno |
