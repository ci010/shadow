---
name: three-playground
description: "Build editable 3D models and orbitable scenes (三维建模、微缩景观、街角、室内外场景), including stylized materials and ambient motion, in Shadow’s JSON-entry Three.js Playground. Inspect existing glTF/GLB without running source."
metadata:
  category: tools
---

# Getting started with 3D modeling

For “做一盏台灯”, “raise the rear support”, or another editable polygonal model, use a small file-based Playground unless the user needs a different workflow. Don't substitute GLB for requested CAD/STEP, print-ready solids, rigged animation, or an existing Blender project. If the task is just to inspect a `.gltf` or `.glb`, open the asset directly: it has no implied JS source. An explanation alone does not require creating files.

## Scenes, not webpages

For an orbitable diorama, room, street corner or collectible miniature, deliver a **`playground.three.json` project** by default. “No UI” means no HUD, controls or menus *authored into the artwork*; the viewer's own tools stay outside the model. Orbit/drag/zoom are viewer features. Rain, ripples, flickering lights and other ambient motion are not a reason to silently switch to HTML, a game engine, an image, or a static GLB alone. If a standalone webpage or another format is explicitly required, respect it. If a required effect is unsupported, explain the specific tradeoff instead of changing the deliverable without agreement.

For a multi-part scene **read `v:skills/three-playground/reference/scene.md`** before authoring. Build the scene directly in `main.mjs` or relative modeling modules: construct `THREE.Group`, meshes and materials and add them to `root`. `playground.three.json` is the project marker, not a serialization of those objects. A separate `scene.json` is optional: use it only when a data table is clearer or the user requests data-driven editing; declare it under `assets` and read it with `assets.json('scene.json')`. Use local time-driven shaders for ambient effects; exported GLB is the static base. Do not copy the tiny starter and call it a finished scene.

Respect the working-context destination policy. Without a selected Workspace, build a working copy in the current **Session files** so the marker can be opened there, and save the complete final project at the required durable destination. Link/name the marker, not a lone JSON attachment without its siblings. A remote client is not necessarily a remote file root.

## First model: a desk lamp

Use the requested destination in a supported Main-local file root. Don't overwrite an existing project. Playground cannot build from remote workdirs or LayerFS; don't silently write to Main instead. In a new model directory create these two sibling files with the normal file tools. No npm install, browser page or dev server is needed.

`playground.three.json`:
```json
{"files":["main.mjs"],"assets":[]}
```

`main.mjs`:
```js
export function build({ THREE, root }) {
  const metal = new THREE.MeshStandardMaterial({ color: 0x526378 });
  const enamel = new THREE.MeshStandardMaterial({ color: 0xf2bc68 });
  function part(id, geometry, material, y) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.objectId = id;
    mesh.position.y = y;
    root.add(mesh);
  }
  part('lamp.base', new THREE.CylinderGeometry(0.7, 0.8, 0.16, 32), metal, 0.08);
  part('lamp.stem', new THREE.CylinderGeometry(0.07, 0.07, 1.5, 16), metal, 0.91);
  part('lamp.shade', new THREE.CylinderGeometry(0.24, 0.62, 0.48, 32), enamel, 1.9);
}
```

Open **playground.three.json** in Shadow Files, not `main.mjs`. The preview renders the exported GLB. Use **Download GLB** for the standalone asset; keep the two source files for later edits. For a larger example in a Shadow source checkout, open `examples/three-playground/cube-stand/playground.three.json`: the cube and stand are separate modules and the badge has a preview-only shader. Don't assume that checkout exists in the user's project.

## Iterate on a part

- Give each renderable a unique, stable `userData.objectId`. Preserve it when changing the same part; never use a display name or array index as a substitute. Keep related parts in relative modules and list every dependency in the marker's `files`.
- Use the supplied `THREE`, `root`, `assets` and seeded `random`. Author geometry and untextured PBR materials, not viewer lights, cameras or ground. The build has no npm imports, DOM, network or host filesystem.
- Select a part in the viewer and use **Add to chat**. Follow the chip's asset, version and object ID to the source; change the real file, not a runtime mesh. A successful rebuild retains the camera and surviving IDs. A failed build leaves the last good preview visible: fix the diagnostic before claiming success.
- If `capture_view` is available on the submitting client, use the chip's exact `assetId`, `mode: 'back'` (or `'current'`) and `afterVersion` set to the pre-edit version. Inspect the returned frame and version. If no viewer is bound, tell the user which marker to open; don't report an unobserved preview.
