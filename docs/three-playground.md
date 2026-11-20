# glTF Viewer and file-based Three.js Playground

Open a `.gltf` or `.glb` in Shadow's Files pane to inspect the asset. It is not a modeling project: the viewer does not run JS, infer a source file, or decompile the asset. For a `.gltf` with sidecars, keep its relative `.bin`, `.png` and `.jpg` files under the model directory. Attachments and archive entries must be self-contained. Unsupported encodings or extensions produce a diagnostic rather than a network request. See the [viewer import profile](../packages/three-viewer/README.md).

For a first model without a Shadow source checkout, ask the agent to make an editable desk lamp. The built-in `v:skills/three-playground` guide includes a complete two-file starter and explains when to inspect an imported asset instead.

## Try the cube and stand

1. Open a conversation with access to the project folder. In Files, open [`examples/three-playground/cube-stand/playground.three.json`](../examples/three-playground/cube-stand/playground.three.json). Opening `main.mjs` as text does **not** execute it.
2. Choose **Back**, then left-drag a box around the stand. Left-click picks a single surface; Shift/Ctrl/Command-click toggles. A box selects mesh bounds centers in its screen rectangle, including occluded parts. The selection outlines and **Controls and selection** identify the objects included. Right-drag looks around, middle-drag pans, and the wheel zooms. **Fly camera** enables WASD, Shift, Space and Ctrl on the focused canvas only; Escape exits.
3. Click **Add to chat** and ask, for example, “把后面的支爪再抬高一点，只改 `stand.mjs`，然后从背面检查。” Each chip carries the file owner, asset ID, exact build version and logical object ID. The agent edits real files with Shadow's existing file tools; you can also save them in your filesystem editor. Do not send script source or a replacement scene to the viewer. Keep the document open (optionally in the other editor group).
4. The preview loads the **exported GLB**, retaining the camera and surviving selected IDs. Missing IDs are reported, even when a different mesh has the same name. The chip still describes the version you originally referenced. **Save view** saves the visible model frame. **Download GLB** saves the last successful, independently viewable model, not the marker or a screenshot.
5. Try a syntax error in a copy of `stand.mjs`. The bad file stays on disk; the diagnostic shows the attempted snapshot and the viewer keeps the previous good build. Correct the file or choose **Rebuild** to retry. An earlier build cannot replace a newer request.

## Find a part in the model hierarchy

With a `.gltf`, `.glb` or Playground file tab focused, open **Files** (or click **Outline** in the model toolbar). The file sidebar shows the current model's hierarchy alongside the file roots. Picking or box-selecting in the canvas highlights the same objects in the tree. Selecting renderable parts in the tree updates the viewer and **Add to chat** without moving the camera. Groups can be expanded to reach their parts. The sidebar follows the focused split, not the last model to finish loading. Standalone previews without a file sidebar open the outline next to the canvas instead.

## Author a project

`playground.three.json` is the project marker and input allowlist. Paths are relative to its directory; include all local JS dependencies, even when using dynamic relative imports. Only declared assets are supplied to the VM. The shader entries read files as text, not JS modules.

```json
{
  "files": ["main.mjs", "cube.mjs", "stand.mjs"],
  "assets": [],
  "shaders": [{ "objectId": "stand.badge", "slot": 0,
    "vertex": "shaders/badge.vert", "fragment": "shaders/badge.frag" }]
}
```

```js
// main.mjs
import { addStand } from './stand.mjs';
export async function build({ THREE, root, assets, random }) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0x3877aa }));
  mesh.userData.objectId = 'cube.center';
  root.add(mesh);
  addStand(THREE, root); // Your own module; give each mesh a unique, explicit objectId.
}
```

Each build gets Three.js **r180**, an empty root, `assets.has(path)` / `assets.read(path)` (a byte copy), and a seeded `random()` helper. IDs must describe logical objects across builds, not sibling order, display names or Three.js UUIDs. Do not recycle an ID for a different object. All model geometry and base materials are exported beneath the root; lighting and cameras belong to the viewer. Shader bindings address an explicit ID and authored material slot. They affect the preview only. A bad binding/compile does not silently replace the working view. As with other GPU programs, open custom GLSL from trusted project sources.

The app checks the marker, declared modules, resources and shader files with conditional requests (normally once per second). A change invalidates obsolete work immediately and starts a replacement build after a 180 ms debounce. The host checks input identity/size/timestamps around the snapshot read. A fresh, terminable browser Worker runs the source **inside QuickJS WASM**: no DOM, host filesystem, native imports, network, shell or host callbacks. The app allows 8 s guest execution and a 15 s external worker deadline. Server limits include 32 modules / 1 MiB source, 16 assets / 1 MiB bytes and 16 shader bindings / 256 KiB source. See [builder limits and supported geometry/materials](../packages/three-playground/README.md).

## Agent inspection

A direct owner Web turn submitted from the same client with a unique bound viewer can discover `v:tools/capture_view`. Use the chip's exact `assetId`:

```js
invoke_tool({ name: 'capture_view', args: { assetId, mode: 'current' } })
invoke_tool({ name: 'capture_view', args: { assetId, mode: 'back', afterVersion: previousVersion } })
invoke_tool({ name: 'capture_view', args: { assetId, mode: 'custom', position: [2, 1, -3], target: [0, 0.5, 0] } })
```

The tool returns an inline image plus the rendered build, camera and selected IDs. `current` captures the actual model canvas. A retained editor uses its last visible viewport size when chat is in front; this is never a screenshot of the chat or the desktop. `front`, `back`, `top` and custom views use a separate camera and offscreen target. `version` requires an exact build; `afterVersion` rejects the previous build rather than passing off an old frame as evidence of an edit. A closed viewer, different tab/owner, ambiguous binding or stale capture fails closed. It is not a tool for modifying the model or the user's camera.

File roots and client location are distinct. Playground snapshots require a Main-local registered folder, local session workdir or session file space. Remote workdir and LayerFS **do not** read a same-named path on Main. The check is local to the root's owning backend, regardless of which supported client displays the viewer. This feature does not restart an existing desktop installation.

[Reproducible Electron/WebGL acceptance and measurements](three-viewer-measurements.md) · [Generic viewer package](../packages/three-viewer/README.md) · [Sandbox package](../packages/three-playground/README.md)
