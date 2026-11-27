# Agent video editing and export

The edit is an OpenTimelineIO `.otio` file, not a separately registered video project. Agents edit the original JSON, inspect stateless [file-subpath views](otio-file-vfs.md), generate previews, and export a new media file. The built-in `video-editing` skill describes the workflow and execution boundaries.

## Source and review

Keep timeline media references accessible on the execution device. The existing OTIO Viewer remains a review surface: selecting elements, navigating time and referencing marked pictures into chat. Track solo/mute/visibility used for review does not modify the source timeline and must not silently affect a render.

The shared structural OTIO parser and validated [composition profile](otio-effects.md) are used by the Viewer, file projections and export planner. The render compiler composites video layers with alpha and executes supported clip effects and transitions. The legacy source-picture model still chooses a single clip for source inspection; it is not used as a substitute for accurate composite preview. Unknown effects and unsupported combinations fail explicitly. Source time is distinct from file seek time when a media reference has a nonzero available-range origin.

Source JSON must retain unknown metadata. A parsed model is a lossy index, not a replacement serialization. JSON-pointer element IDs belong to a source revision; reorder and split edits require reading the new revision.

## Execution

`project-video` is a standalone backend CLI route, before full Main startup. Media commands execute on the device running the CLI; they do not remotely map paths or provision an encoder. FFmpeg and ffprobe must already be available through explicit configuration or PATH. Missing tools are errors, not an instruction to install them silently.

Previews and final exports use the same timeline compiler. Outputs must be distinct from existing user files. Commands must support cancellation and clean up their own temporary files, never unrelated source media. A completed encoder process is technical output verification, not visual or audio acceptance.

## Commands

From a source checkout:

```sh
pnpm exec node --import tsx scripts/video.ts --help
pnpm exec node --import tsx scripts/video.ts init edit.otio --duration 5 --rate 24
pnpm exec node --import tsx scripts/video.ts plan edit.otio
```

The built equivalent is `node dist/src/index.js project-video ...`. Run from the intended working directory or use absolute file arguments. `init` creates a gap-only timeline; populate its clips with local OTIO ExternalReferences using normal file edits. `plan` and `validate` explicitly run ffprobe and return a SHA-256 source revision and media/render information. For VP8/VP9 media they also check the existing FFmpeg build for an alpha-preserving libvpx decoder; `--ffmpeg` and `--ffprobe` can select installed executables. They are execution commands, not passive VFS reads.

Use the returned revision for rendering:

```sh
node dist/src/index.js project-video preview edit.otio --revision SHA256 --start 0 --end 2 --output preview-v1.mp4 --manifest edit.otio.preview.json
node dist/src/index.js project-video export edit.otio --revision SHA256 --output final-v1.mp4
```

`preview` requires an explicit interval. Both commands accept `--width`, `--height`, `--ffmpeg` and `--ffprobe`. Output dimensions are even integers; cuts and interval boundaries must align to the timeline's frame grid. The baseline uses H.264 video and AAC audio, mixing enabled explicit Audio tracks when present and otherwise using visible video embedded sound. Tracks mix additively without normalization. A silent timeline still receives a silent AAC track. File extensions and demuxers are restricted to the supported local-media profile; remote URLs are not fetched. A source revision mismatch prevents publishing the result.

For effects/transitions or potentially transparent layers, the Viewer requires a matching rendered preview. It reads `<timeline>.preview.json` on load/refresh, checks its source SHA-256 and same-owner media path, and maps timeline time into the preview interval. A missing/stale/invalid or out-of-range preview is not permission to show a highest-layer approximation. Sidecar reading never launches a render. See the [composition profile](otio-effects.md) for exact effect names, units, transition handles and unsupported combinations.

## Three footage

A Three Playground scene is authored separately from the edit. A shot render samples the original marker snapshot at explicit frame times, preserving supported preview lights, shaders and display settings. The resulting video becomes an ordinary OTIO external media reference; the OTIO file continues to own ordering and trimming.

Portable GLB alone does not retain every preview feature. Deterministic shader sampling is not a general object animation or physics system. Independently hosted browser rendering is not the same as recording the user's open viewer, and source-checkout rendering helpers must not be described as fully packaged desktop capabilities.

The source-checkout command (not a packaged desktop renderer) is:

```sh
pnpm exec node --import tsx scripts/three-viewer-check/run.mjs video \
  scenes/product/playground.three.json shot-v1.mp4 \
  --position 4,3,6 --target 0,1,0 \
  --width 960 --height 680 --fps 30 --duration 2 --timeout 120
```

All seven options are required. The output parent must exist; the destination must not exist. This starts an independent sandbox Electron host and streams PNG frames to an existing PATH `ffmpeg`. It requires the source checkout's Vite/Electron/tsx dependencies. It does not depend on a user's open viewer. The current shot has a fixed camera and shader-only temporal motion, no audio or general object animation. Add its generated MP4 as an ordinary OTIO ExternalReference. See [the renderer helper contract](../scripts/three-viewer-check/README.md).

## Verification boundaries

Check cut boundaries, gaps, nonzero media origins, fractional frame rates, final duration, and sound policy. Inspect images from the real output; listen when sound is part of the task. Record unavailable checks explicitly. Remote filesystem support, codec availability and production packaging are separate from parser tests and local rendering success.
