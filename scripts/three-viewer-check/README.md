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
