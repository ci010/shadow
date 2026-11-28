---
name: video-editing
description: "Edit, preview and export video with OpenTimelineIO (OTIO、视频剪辑、时间线、视频导出). Read file-subpath projections, preserve the original timeline, review frames and sound, and render on the explicit execution device."
metadata:
  category: tools
---

# Agent video editing

## One editable source

The `.otio` file is the edit's source of truth. Keep source media and Three Playground projects alongside it or at explicit accessible references. A Shadow Project can contain several timelines: do not invent a separate video-project registration or assume the currently open viewer identifies the requested edit.

Use the user's selected file/reference. Otherwise find candidate `.otio` files in the authorized working directory; ask if multiple candidates remain ambiguous. Create a new timeline only at an authorized destination and never overwrite an existing edit or render without permission.

## Read the file as a tree

Read `edit.otio/overview` to discover its stateless, read-only projections and follow the returned paths. Reading `edit.otio` itself still returns original JSON. No mount, project ID or session-held registration is necessary. A virtual child is not a real directory and is not writable.

The overview and child responses carry a source revision. Element IDs based on JSON pointers identify elements in that revision, not permanent identities across reorder/split operations. Re-read after editing. Preserve original unknown fields and metadata: the parsed model is a lossy view and must not be serialized as a replacement timeline.

Use the explicit RationalTime values/rates for editing; rounded seconds are for reading. Distinguish timeline position, source time and actual decoded presentation time. Media information not already analyzed is unknown, not zero or absent. Reading must not silently initiate a transcode, download or expensive analysis.

## Make an edit

Prefer `project-video edit SOURCE.otio --patch changes.json --revision SOURCE_SHA256 --output NEXT.otio` for a revision-checked, non-destructive edit. The patch is a JSON array of `add`, `remove`, `replace` or `test` operations with JSON-pointer paths into the original document. Operations apply in order to a private copy and the complete supported profile is validated before publishing a new file beside the source. Never serialize the lossy parsed model as the edit. The output must be new; no automatic replacement of the user's source. The hash is not a lock against external writers. Ordinary file tools remain possible when explicitly appropriate, but must preserve unknown metadata and existing user edits.

Retain unaffected tracks, clips, source references and metadata. Split and ripple operations must update every intended linked item, not just move the visible picture. Re-read the new file's pointers and diagnostics after editing; `edit` does not probe media or validate actual source handles. Run `plan` on the new revision before rendering.

Unsupported effects, transitions or track semantics must be reported, not silently flattened. Viewer track solo, visibility and mute controls are review state, not persisted editing decisions. Never claim these transient controls changed the exported movie.

## Effects and compositing

Before adding transitions, opacity, transforms, crop, color or audio effects, read `v:skills/video-editing/reference/effects.md`. Use the validated Shadow profile, not invented OTIO plugin names or raw FFmpeg expressions. Inspect `/effects`, `/transitions` and `/diagnostics` after editing. Multi-layer alpha and profile effects require an accurate rendered preview; the legacy highest-source picture is not the final composite.

## Commands

In a source checkout, use `pnpm exec node --import tsx scripts/video.ts --help`. With a built backend, use `node dist/src/index.js project-video --help`. Resolve the actual installation/checkout path rather than assuming it is the user's working directory. File arguments resolve from the executing process's cwd.

```sh
# Creates a valid gap-only timeline; never replaces an existing file.
node dist/src/index.js project-video init edit.otio --duration 5 --rate 24

# After adding local ExternalReference clips, probe and compile the edit.
node dist/src/index.js project-video plan edit.otio

# Substitute the revision returned by plan; boundaries are timeline seconds.
node dist/src/index.js project-video preview edit.otio --revision SHA256 --start 0 --end 2 --output preview-v1.mp4 --manifest edit.otio.preview.json
node dist/src/index.js project-video export edit.otio --revision SHA256 --output final-v1.mp4
```

`plan`/`validate` explicitly probe media using ffprobe; these are not passive file reads. `preview` requires an explicit interval. The baseline uses the timeline rate, supports even output dimensions, and rejects frame-misaligned cuts. Use `init --frames N --rate RATE` (instead of `--duration`) for fractional-rate timelines; edits must use whole output frames. Source media is sampled onto the output rate, potentially dropping or repeating source frames; this is not optical-flow retiming. Unsupported effects are never approximated. Inspect `plan.warnings` and `audioPolicy`: an enabled empty Audio track suppresses embedded video sound; embedded-visible audio follows picture cuts, not an automatic transition crossfade; explicit additive mixes are not normalized and may clip. No final output is published if the source timeline changes during rendering.

## Preview, then deliver

Use the video command's help for current arguments; do not invent flags. Generate a short low-resolution preview of the changed range, inspect stills at cuts and representative moments, and review the audio when sound is part of the task. State when visual or audio review was unavailable. A successful encoder exit alone is not creative acceptance.

The Viewer reads the fixed `<timeline>.preview.json` sidecar. Keep each rendered MP4 new. First publication creates a new sidecar; later publication must explicitly use `--manifest-revision PREVIOUS_MANIFEST_SHA256` with the previous command's `manifestRevision` to update that fixed sidecar. A stale hash or publisher lock fails rather than overwriting another version; do not delete locks to force an update. Refresh the Viewer after success. Publication failure may retain a completed new video: report its actual path, not a successful preview handoff. Sidecar reads/refreshes never start an encoder. A new timeline filename requires its own new sidecar.

Export from the same timeline revision and time interpretation as the preview. Save each revision to a distinct output. Report actual output path, dimensions, frame rate/duration, audio policy, unsupported content, and checks performed. Do not equate viewer playback with frame-accurate final export.

## Title and caption-card footage

In a source checkout only, generate a transparent PNG with the existing Electron helper:

```sh
pnpm exec node scripts/video-title.mjs --text-file title.txt --font fonts/title.ttf --output title-v1.png --width 1280 --height 720 --font-size 48
```

All shown arguments are required; choose an existing local TTF/OTF with appropriate license and glyph coverage. No fonts or runtimes are installed or downloaded. Text is plain UTF-8 with explicit newlines; overflowing layouts fail rather than clip. This helper is not a packaged `project-video` command and does not import SRT/ASS or animate text. Read the checkout's `docs/video-editing.md` for optional layout arguments and boundaries.

Use the PNG as a frame-aligned Video clip above footage. Keep text/font inputs and copy the returned `titleProvenance` into the clip's metadata. A changed title needs a new PNG and matching composite preview. Use explicit Audio clips to preserve underlying dialogue rather than assuming a topmost title image carries the covered video's embedded audio. Inspect the final pixels: `font-coverage-not-verified` means a loaded font can still show missing glyphs, and matching hashes do not promise cross-machine pixel identity.

## Three shots

Read `v:skills/three-playground` before creating or modifying a scene. Render the original marker snapshot with its lights, shaders and preview settings; do not substitute a portable GLB and assume preview fidelity. Frame sampling uses explicit time rather than recording wall-clock playback. A pre-rendered shot can be referenced as ordinary OTIO external media; the `.otio` still owns order, placement and trim. Object animation, live Three references and camera motion are supported only if the installed render command explicitly implements them.

For the source-checkout renderer only (not the packaged backend), the command is:

```sh
pnpm exec node --import tsx scripts/three-viewer-check/run.mjs video scenes/product/playground.three.json shot-v1.mp4 --position 4,3,6 --target 0,1,0 --width 960 --height 680 --fps 30 --duration 2 --timeout 120
```

All options shown are required. Choose camera position/target for the actual subject; these numbers are not a framing preset. This needs the checkout's existing Vite/Electron/tsx and PATH FFmpeg. It renders a fixed camera with explicit shader time, without audio, camera animation or general geometry animation. Do not promise this command exists in a packaged installation. The parent output directory must exist and the output must be new.

## Execution boundaries

Run commands on the selected execution device, with its local paths and installed media tools. A Child path is never a Main path. CLI process permissions are not a sandbox and VFS links grant no new file access. Do not install FFmpeg or dependencies implicitly, fetch remote media, or fall back to another device. Cancel rendering through its owning execution and wait for cleanup before reusing its output path.
