# @shadow/three-viewer

Browser/WebGL 2 package. Import `ThreeViewer` from `@shadow/three-viewer` and provide an app-owned canvas with a CSS layout size. The package does not read files, run Playground source, or mount a toolbar. Use `dispose()` when the editor closes.

## Loading and identity

```ts
const viewer = new ThreeViewer(canvas, {
  background: '#ededed',
  ground: true,
  ariaLabel: 'Model preview', instructions: localizedInstructions,
  onSelectionChange: ({ selection, removed, reason }) => updateSelection(selection, removed, reason),
  onPlayerModeChange: enabled => updateToolbar(enabled),
});
const { objectIds } = await viewer.load({ bytes, resources, version, signal });
```

- `load({ bytes, version, resources?, identity?, identityScope?, signal?, shaders?, preview?, previewLights? })` accepts `ArrayBuffer` or `Uint8Array`. `resources` is a `ReadonlyMap<string, Uint8Array>`, keyed by each exact glTF URI, not a path or URL resolver. Bounded embedded base64 is decoded locally. The loader only sees temporary blob references created from approved bytes and cannot fetch host or remote resources.
- `preview: { toneMapping?: 'none' | 'aces', exposure?: number }` changes the live preview and both capture paths without writing to the glTF/GLB. Every load defaults to `none` and exposure `1`; exposure must be finite and in `[0.1, 4]` and affects ACES only. Settings are snapshotted and committed with the model; failed and superseded loads do not change them. A custom fragment shader can opt into tone mapping by using `<tonemapping_fragment>` before `<colorspace_fragment>`.
- For a Playground build, pass `buildPlayground`'s `previewLights` alongside its GLB bytes in the same `load({ identity: 'playground', ... })`. These are in-memory ambient and hemisphere lights, not a glTF extension. The viewer validates and snapshots up to 16 records with finite linear RGB in `[0, 1]`, intensity in `[0, 1000000]`, and (for hemisphere lights) a unit direction and ground RGB. They commit atomically with the model and light both the canvas and offscreen captures. Active punctual and preview lights may coexist; the built-in studio lights are used only when neither is present, even when authored intensity is zero. Include preview-only inputs in your revision identity (e.g. hash the author snapshot as well as the bytes).
- `version` is an immutable asset revision supplied by the caller (use a digest covering the document and resources). A newer request supersedes pending work; a pre-aborted input is not admitted. Superseded, aborted and disposed loads reject with `AbortError`. At most one decode and the latest queued input are held; an already-running browser decode can finish internally but cannot commit. Validation, decode and shader compile/link must succeed before the new scene is swapped in. Failures leave the visible model, camera, shaders, and selection unchanged. The first successful load is framed automatically if nonempty; subsequent replacements keep the camera/target. A successful replacement drops unavailable selected references and reports them as `removed` with `reason: 'load'`.
- The default `identity: 'gltf'` uses opaque, reproducible IDs from scope, version, authored glTF node index and primitive index. Two nodes using the same mesh definition have distinct IDs. The same asset revision can be reopened without renumbering. Scope or version changes invalidate previous references; use an asset-specific `identityScope` if supplied versions are not globally content-addressed. `viewer.objectIds` lists all current referenceable IDs, and `labelFor(id)` gives a display label (or `undefined`). Do not parse IDs to resolve or display them.
- `identity: 'playground'` uses the author's `mesh.userData.objectId`, exported by GLTFExporter as `node.extras.objectId`. It must be a nonempty string, unique across authored mesh nodes in the default scene. A node without an ID is rendered but cannot be referenced. A node with several primitives still has one logical ID; all its primitives pick that same ID and contribute to its outline. Only reuse stable IDs for the same logical objects. Use a distinct `identityScope` when reusing one viewer for another Playground.
- Snapshot `shaders: [{ objectId, slot, vertex, fragment }]` bind only in Playground mode, in memory, and are not written to the GLB. The GLB retains its authored independent materials. A single ordinary glTF primitive uses viewer slot 0. For a Playground mesh with grouped materials, have the exporter set `node.extras.shadowMaterialSlots` to one authored slot per emitted primitive, in emitted order (`geometry.groups.map(g => g.materialIndex)` for Three r180's default exporter). This mapping supports out-of-order slots, duplicate groups for a slot, and unused slots. Single-material meshes can omit the mapping (slot 0); for multiple primitives without a mapping, selection works but shader binding fails instead of guessing. A compile/link or invalid binding error names the binding and preserves the previous preview. `bindShader(id, slot, shader)` borrows a caller-owned `ShaderMaterial`, and `bindShader(id, slot, null)` restores the imported material. Snapshot shader source is size-limited; callers must trust sources allowed to execute on the GPU. Use Three's `<colorspace_fragment>` shader chunk for consistent output color conversion.

`viewer.outline` is a read-only, depth-first pre-order snapshot of the loaded scene's authored nodes, excluding the scene wrapper and viewer helpers. Each `ModelOutlineRow` has a `key`, `parentKey` (`null` at the top level), `label`, and an optional selectable `objectId`. Default glTF multi-primitive nodes have child rows for their selectable primitives; Playground primitives share their node's selection ID. Keys link rows within a snapshot; use `objectId`, not `key`, with `viewer.setSelection(ids)`. The snapshot changes only on a successful replacement and is empty before loading or after disposal.

### Supported import profile

Static glTF 2.0 triangle geometry and the default scene. Core PBR, unlit, texture transform, and Three r180's material-only KHR extensions for clearcoat, dispersion, IOR, sheen, specular, transmission, iridescence, anisotropy, volume and emissive strength are supported. These do not open loaders for additional resource or decoder types. No Draco, meshopt, Basis/KTX2, GPU instancing extension, skinning, animation, morph targets, sparse accessors or points/lines. Regular glTF nodes sharing a mesh are supported. PNG and baseline/progressive JPEG are supported; nonessential PNG ancillary metadata is removed before decode and APNG is rejected. Limits include 32 MiB document, 2 MiB JSON, 64 MiB provided bytes, 128 explicit resources, 4,096 nodes, 4,096 drawn primitives and 3,000,000 draw elements, plus aggregate decode and vertex/texture upload budgets (see `limits` and `src/input.ts`).

`KHR_lights_punctual` is supported in both glTF and GLB: directional, point, and spot lights use the authored node transforms, linear RGB, intensity, and applicable range and cone angles. The extension must be declared in `extensionsUsed`, with definitions at the document root and references on nodes only. The viewer validates all definitions and references, including those outside the active scene, and allows up to 16 definitions and 16 light instances in the active scene. Only active instances replace the built-in studio lighting; unused definitions and lights in other scenes do not. This also applies to active zero-intensity lights. Light-only nodes remain in the outline but have no selectable object ID, and lights do not contribute to fit bounds or picking. A node that also has a mesh follows the usual mesh identity rules. The lights illuminate lit materials but do not add shadow maps.

## Preview ground

`ground: true` enables a bounded neutral reference grid beneath the model. The viewer centers and scales it from the model bounds on each successful load. It appears in previews and captures, but never changes framing or participates in picking, selection, exported model data, or object IDs. The default is `false`.

## Input and capture

`selection` is a readonly list; `setSelection(iterable)` replaces it (unknown IDs throw). Left click picks a visible surface; Shift/Ctrl/Meta-click toggles. Left drag selects objects whose projected bounds centers fall inside the rectangle; a modifier extends the existing selection. Orbit uses right drag, middle pan and wheel zoom. `setPlayerMode(true)` enables fly controls for the focused canvas only: right drag to look, WASD, Shift for faster motion, Space to rise, Ctrl to descend. Escape and toolbar presets exit player mode and notify `onPlayerModeChange`. Losing focus clears held inputs.

- `fit()` frames the model while retaining view direction. `setView('front' | 'back' | 'top')` frames and changes the visible camera. Front is +Z, back is −Z, and top is +Y.
- `getCamera(view?)` returns `{ position, target }`. `captureFrame(view?)` returns `{ image: Blob, camera: { position, target }, objectIds, version }` for a single rendered snapshot. **The frame's IDs are the selection, not the scene inventory.** With no `view`, PNG comes from the actual canvas. Presets and explicit `{ position, target }` use an independent camera and a WebGL render target, without drawing to the user canvas or changing their camera. Both use the viewer's opaque baked-in background. A hidden canvas retains its last visible drawing size and aspect. PNG encoding may complete after a later model swap, but the result still describes the frame that was taken.

### Explicit-time video frames

`await viewer.captureVideoFrame({ position, target }, timeSeconds)` returns the same `CameraFrame` shape as capture, with an explicit nonnegative shader clock. It uses an independent camera and the inspection renderer: no selection/grid overlays, with the loaded preview lights, tone mapping and exposure. The canvas CSS dimensions determine resolution under the existing renderer limits. `objectIds` is empty because this is footage rather than a selection capture.

The method restores the interactive shader clock before awaiting PNG encoding and rejects concurrent capture or a lost WebGL context. It does not encode a movie, animate arbitrary JavaScript/geometry, or provide a general simulation clock. The source-checkout [video helper](../../scripts/three-viewer-check/README.md) samples `time = frame / fps` and streams frames to FFmpeg without depending on an open editor.

## Focused checks

From the repository root:

```sh
pnpm --filter @shadow/three-playground generate
pnpm exec tsc --noEmit --allowImportingTsExtensions --target es2022 --module nodenext --strict --skipLibCheck --lib ES2022,DOM packages/three-viewer/src/index.ts packages/three-viewer/test/*.ts
pnpm exec node --import tsx --test packages/three-viewer/test/input_test.ts
CHROMIUM=/path/to/chromium node packages/three-viewer/test/run-browser.mjs
```

### File shader animation (preview only)

Declare `uniform float playgroundTime;` in either GLSL stage that uses it. No
manifest change is needed: the existing object ID and material slot select the
shader files. The viewer supplies elapsed seconds (zero on the first frame of
an accepted load); captures use the most recent preview time. A successful
replacement starts a new clock, while a failed or superseded load leaves the
active preview running. Direct `bindShader` materials do not receive this clock.
There are no shader-authored per-frame JavaScript callbacks.

Use time for fragment effects (rain, ripples, changing lights) or small vertex
offsets. Keep offsets small: camera framing, selection outlines, culling and
picking still use the original CPU geometry. Shader motion and output are not
baked into the GLB; only the authored static geometry and PBR materials export.

File shaders inherit the imported primitive's transparency mode (`transparent`),
side and depth test/write/function. Declare `uniform float playgroundOpacity;`
and use it in your fragment alpha to honor the authored opacity. The shader
controls color and alpha; PBR shading, maps and alpha masking are not applied
for you. For example, bind the following two files to a UV plane whose authored
material is double-sided and uses glTF `alphaMode: "BLEND"` (Three's glTF loader
sets depth writes off for this mode, leaving depth testing on):

Vertex:

```glsl
varying vec2 vRainUV;
void main() {
  vRainUV = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
```

Fragment:

```glsl
uniform float playgroundTime;
uniform float playgroundOpacity;
varying vec2 vRainUV;
void main() {
  float x = vRainUV.x * 64.0;
  float seed = fract(sin(floor(x) * 127.1) * 43758.5453);
  float y = fract(vRainUV.y * 7.0 + playgroundTime * (2.0 + seed) + seed);
  float width = 1.0 - smoothstep(0.06, 0.18, abs(fract(x) - 0.5));
  float streak = smoothstep(0.65, 0.95, y) * width;
  gl_FragColor = vec4(0.42, 0.68, 0.95, streak * playgroundOpacity);
  #include <colorspace_fragment>
}
```
