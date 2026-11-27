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

Edit the actual OTIO file using normal file tools or a validated local script. Retain unaffected tracks, clips, source references and metadata. Split and ripple operations must update every intended linked item, not just move the visible picture. Read diagnostics again and validate the same revision before rendering.

Unsupported effects, transitions or track semantics must be reported, not silently flattened. Viewer track solo, visibility and mute controls are review state, not persisted editing decisions. Never claim these transient controls changed the exported movie.

## Commands

In a source checkout, use `pnpm exec node --import tsx scripts/video.ts --help`. With a built backend, use `node dist/src/index.js project-video --help`. Resolve the actual installation/checkout path rather than assuming it is the user's working directory. File arguments resolve from the executing process's cwd.

```sh
# Creates a valid gap-only timeline; never replaces an existing file.
node dist/src/index.js project-video init edit.otio --duration 5 --rate 24

# After adding local ExternalReference clips, probe and compile the edit.
node dist/src/index.js project-video plan edit.otio

# Substitute the revision returned by plan; boundaries are timeline seconds.
node dist/src/index.js project-video preview edit.otio --revision SHA256 --start 0 --end 2 --output preview-v1.mp4
node dist/src/index.js project-video export edit.otio --revision SHA256 --output final-v1.mp4
```

`plan`/`validate` explicitly probe media using ffprobe; these are not passive file reads. `preview` requires an explicit interval. The baseline uses the timeline rate, supports even output dimensions, and rejects frame-misaligned cuts. It does not silently retime or approximate unsupported effects. No final output is published if the source timeline changes during rendering.

## Preview, then deliver

Use the video command's help for current arguments; do not invent flags. Generate a short low-resolution preview of the changed range, inspect stills at cuts and representative moments, and review the audio when sound is part of the task. State when visual or audio review was unavailable. A successful encoder exit alone is not creative acceptance.

Export from the same timeline revision and time interpretation as the preview. Save each revision to a distinct output. Report actual output path, dimensions, frame rate/duration, audio policy, unsupported content, and checks performed. Do not equate viewer playback with frame-accurate final export.

## Three shots

Read `v:skills/three-playground` before creating or modifying a scene. Render the original marker snapshot with its lights, shaders and preview settings; do not substitute a portable GLB and assume preview fidelity. Frame sampling uses explicit time rather than recording wall-clock playback. A pre-rendered shot can be referenced as ordinary OTIO external media; the `.otio` still owns order, placement and trim. Object animation, live Three references and camera motion are supported only if the installed render command explicitly implements them.

For the source-checkout renderer only (not the packaged backend), the command is:

```sh
pnpm exec node --import tsx scripts/three-viewer-check/run.mjs video scenes/product/playground.three.json shot-v1.mp4 --position 4,3,6 --target 0,1,0 --width 960 --height 680 --fps 30 --duration 2 --timeout 120
```

All options shown are required. Choose camera position/target for the actual subject; these numbers are not a framing preset. This needs the checkout's existing Vite/Electron/tsx and PATH FFmpeg. It renders a fixed camera with explicit shader time, without audio, camera animation or general geometry animation. Do not promise this command exists in a packaged installation. The parent output directory must exist and the output must be new.

## Execution boundaries

Run commands on the selected execution device, with its local paths and installed media tools. A Child path is never a Main path. CLI process permissions are not a sandbox and VFS links grant no new file access. Do not install FFmpeg or dependencies implicitly, fetch remote media, or fall back to another device. Cancel rendering through its owning execution and wait for cleanup before reusing its output path.
