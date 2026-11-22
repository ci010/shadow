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
