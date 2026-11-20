---
name: three-playground
description: "Create or edit a 3D model (三维建模), prototype a product or prop, adjust a selected part, or export GLB using Shadow’s file-based Three.js Playground. Inspect existing glTF/GLB without running source."
metadata:
  category: tools
---

# Getting started with 3D modeling

For “做一盏台灯”, “raise the rear support”, or another editable polygonal model, use a small file-based Playground unless the user needs a different workflow. Don't substitute GLB for requested CAD/STEP, print-ready solids, rigged animation, or an existing Blender project. If the task is just to inspect a `.gltf` or `.glb`, open the asset directly: it has no implied JS source. An explanation alone does not require creating files.

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
