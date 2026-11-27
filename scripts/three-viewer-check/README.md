# Electron Three.js viewer checks

## Capture a scene from a custom camera

From the repository root (with dependencies installed):

```sh
pnpm exec node --import tsx scripts/three-viewer-check/run.mjs capture \
  examples/three-playground/lit-storefront/playground.three.json '/existing/output/directory/store.png' \
  --position 4,3,6 --target 0,1,0
```

`--position` is the camera's world-space location and `--target` is the point it looks at. Supply both as comma-separated decimal triples (negative coordinates and scientific notation are accepted). Coordinates must be finite, have magnitude at most `1e15`, and the two points must differ. Relative paths resolve from your current directory. The output must be a new `.png` in an existing directory; the command never overwrites an existing file.

This runs the real Playground snapshot/build/ThreeViewer pipeline in a hidden Electron window. No running Shadow UI or shader count is needed. It captures one frame, including for static scenes, and prints JSON with the rendered `version` (the same source + built-scene fingerprint used by the app), actual `camera` position/target, PNG byte count, and absolute `screenshot` path. Repeat with another camera and a different output filename to compare viewpoints; matching versions identify the same build, not merely the same source files.

## Marker regression check

From the repository root, build a synthetic Playground containing only a marker and `main.mjs` (no `scene.json`):

```sh
pnpm exec node --import tsx scripts/three-viewer-check/run.mjs marker
```

To check a specific local project, pass its marker, expected shader count and, optionally, a new PNG output path:

```sh
pnpm exec node --import tsx scripts/three-viewer-check/run.mjs marker '/path/to/playground.three.json' 12 '/existing/output/directory/frame.png'
```

The localhost server reads the selected marker and its declared inputs through the real snapshot endpoint. It does not expose the scene directory as a static root, execute project modules in Node, or write project files. A sandboxed Electron renderer runs the app's build adapter, loads the resulting GLB and links the shader bindings in ThreeViewer, then captures two frames from the same camera. When the expected shader count is nonzero, the two frame hashes must differ. The optional PNG is the second capture; existing files are not overwritten.

Use `ui` for the live preview, edit/rebuild, failed-build retention, and capture-tool checks against a disposable copy of the cube-stand fixture.

Use `lighting` to validate the compact lit storefront against the isolated browser builder and real Viewer:

```sh
pnpm exec node --import tsx scripts/three-viewer-check/run.mjs lighting
```

The check copies `examples/three-playground/lit-storefront` to a disposable directory and exports its marker to GLB. It verifies `KHR_lights_punctual` node bindings, then reads the three imported lights back with GLTFLoader (including range, cone and local −Z aim) alongside the storefront IDs. At a fixed front camera, it compares the authored render to controls that mute each light in turn, mute all lights while keeping them present, and remove all light bindings. This checks that each authored light changes visible pixels and that the Viewer only restores its default illumination when no authored lights are present. No screenshot or GLB is left behind.

The storefront marker also requests ACES tone mapping at exposure 1.16. The check fetches a second real snapshot with only `preview` changed to neutral (`none`, exposure 1), asserts different snapshot versions and ETags but byte-identical exported GLBs, then verifies separate tone-mapping and ACES exposure pixel differences at the same camera. Open the storefront's `playground.three.json` directly in Shadow Files to view the authored result.

## Offline video (source checkout / development CLI)

```sh
pnpm exec node --import tsx scripts/three-viewer-check/run.mjs video \
  examples/three-playground/lit-storefront/playground.three.json '/existing/output/directory/scene.mp4' \
  --position 4,3,6 --target 0,1,0 \
  --width 960 --height 680 --fps 30 --duration 2 --timeout 120
```

All seven options are required (order is arbitrary). Requires installed checkout dev dependencies (Vite, Electron, tsx) and `ffmpeg` with `libx264` on PATH. This is not a packaged Shadow command, hosted render service, or permission grant. Run only against scene files you are authorized to read/execute; source modules run in the existing isolated browser builder, not host Node.

The command freezes one real marker snapshot/build, camera and preview tone mapping/exposure, then renders frames at `t = i / fps`, starting at zero, excluding the duration endpoint. Only shader `playgroundTime` is clocked: arbitrary wall-clock/random/network behavior is not made deterministic. Static exported geometry, authored preview lights and shader bindings use the same Viewer as capture. Editor grid and selection are excluded. Dimensions must be even, 2–4096, at most 8,388,608 pixels; fps is an integer 1–60; duration is positive, <=600 seconds and must yield an integral frame count. Timeout is 1–3600 seconds.

One PNG at a time crosses Electron to ffmpeg stdin, with write backpressure; no frame array or frame-directory cache is retained. The silent H.264/yuv420p MP4 is encoded in the invocation-owned temporary directory and copied in bounded chunks into an exclusively reserved new output. Existing files/symlinks are never overwritten. Normal failure/cancellation removes that reservation; a hard OS/process kill may leave a partial output. SIGINT/SIGTERM cancel and terminate the encoder; timeout/build/WebGL/PNG/ffmpeg errors fail the command. The parent watchdog sends TERM then escalates to KILL after five seconds and waits for child `close` before temporary-directory cleanup. Publishing checks cancellation before each write, after sync and after closing the reservation; cancellation during publishing removes that invocation's output rather than reporting success. Only the invocation temp directory is recursively cleaned. JSON on success reports absolute `video`, snapshot/build `version`, camera, preview, dimensions, fps, duration and frame count. Use that ordinary MP4 path as OTIO external media; there is no live Three custom reference, audio, camera animation or geometry animation export.

Checks: `node --test scripts/three-video_test.mjs` exercises bounds and exclusive/failure cleanup; Viewer browser tests include explicit-clock replay assertions. Visual composition still requires human acceptance on a suitable GUI/GPU.
