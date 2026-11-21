# Electron Three.js viewer checks

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
