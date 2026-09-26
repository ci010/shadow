---
name: download
description: "Use Shadow's pinned, bundled aria2c for user-approved, resumable HTTPS downloads; select trusted revisions, verify SHA-256 and reuse existing caches before downloading."
core: true
metadata:
  category: tools
---

# Verified, resumable downloads

Shadow bundles a pinned `aria2c` with the desktop application; it does not
silently use the system `PATH`. Use `download` through `invoke_tool` (find its
contract with `search(query="download", space="grep:v:tools")`). Run
`download status` to check the bundled binary and version. A missing or
different version is a packaging error; do not silently run another binary.
Local development without a package can set the absolute
`SHADOW_ARIA2C_PATH` to an **explicitly trusted copy of the pinned version**.
Remote workdirs cannot use Main's local binary or downloaded files.

Prefer what the user already has. Before downloading, inspect the relevant
Skill and discover existing model caches, local release archives and
application-specific directories. Use the official HF or ModelScope client
for repo browsing, authentication, snapshot metadata and revision resolution;
aria2 transfers **individual HTTPS files**, not repository snapshots
or login sessions. It does not bypass the GFW: when Hugging Face is blocked,
prefer a verified ModelScope repository and revision instead of an untrusted
mirror. Never copy into HF's internal blob/snapshot layout by hand.

For each file, identify its exact repository, revision, official origin,
expected SHA-256, optional byte count, license, free space and destination.
Obtain the user's consent to the network request, license and disk usage
before using `approved: true`. No download happens at startup. Use a
persistent user-chosen directory, not a session temp directory or the source
repository. The `download` action accepts `url`, `directory`, `filename`,
`sha256`, optional `bytes` and `approved: true`. Prefer `action: "start"`
for large downloads: it immediately returns a `bg:` execution ID and a raw
`taskId`. On the current background-task API, read `v:bg/<taskId>` for
progress or call `kill({task_id: taskId})` to stop the transfer. Where the
execution-ID API is available, use `v:bg/<executionId>` and
`cancel({executionId})` instead. Cancellation preserves resumable partial
data. `action: "download"` waits for completion and is intended only for
short files. Both actions stage under
`<filename>.shadow-part` with aria2 resume metadata, checks the final length
and SHA-256, then exposes the named file. The same destination and file name
can resume after interruption. A different file already at the final path
is never overwritten; a checksum mismatch discards bad partial data and
returns an error. An already verified file is reused.

HTTP range support and stable file identity determine whether a transfer
can resume. If a signed link expires, reacquire it from the same trusted
repository and revision; **do not combine unrelated revisions or URLs**
into one partial file. If resume fails or a server ignores range requests,
report the error and retry only after checking the source and disk state.
Do not log signed URLs, tokens, cookies or authorization headers; signed
links are passed to aria2 through stdin rather than command-line arguments. This
tool does not accept credentials. Avoid arbitrary download scripts, insecure
TLS flags, unaudited installer commands or unauthenticated aria2 RPC
servers. It spawns one bounded local CLI process without a shell and
supports cancellation while preserving resumable partial files.
