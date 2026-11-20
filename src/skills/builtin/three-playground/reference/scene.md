# Build an editable miniature scene

The viewer supplies orbit, pan, zoom and inspection. Author the world, not a page or a renderer. Design the silhouette first, then the interior and close-up details. Keep all geometry within the intended base. No characters, HUD or labels floating outside the scene unless requested.

## A JSON-driven starting point

These three files are a complete, deliberately small scene. `scene.json` is **your** scene vocabulary consumed by **your** builder, not a universal object format. Scale up with named groups, reusable factories and compact procedural descriptions in the data. Use literal IDs that survive reordering. Keep the final GLB useful without shaders.

`playground.three.json` — the entry users open:
```json
{"files":["main.mjs"],"assets":["scene.json"]}
```

`scene.json` — actual editable content:
```json
{"parts":[{"id":"street.base","name":"街角底座","size":[6,0.2,6],"at":[0,0.1,0],"color":"#38465b"},{"id":"shop.counter","name":"木质柜台","size":[1.6,0.8,0.6],"at":[0,0.6,0],"color":"#d3a070"}]}
```

`main.mjs`:
```js
export function build({ THREE, root, assets }) {
  const { parts } = assets.json('scene.json');
  const box = new THREE.BoxGeometry(1, 1, 1);
  for (const p of parts) {
    const mesh = new THREE.Mesh(box, new THREE.MeshStandardMaterial({ color: p.color }));
    mesh.scale.set(...p.size); mesh.position.set(...p.at);
    mesh.name = p.name; mesh.userData.objectId = p.id; root.add(mesh);
  }
}
```

## Art direction and motion

- Use real meshes grouped by subject. Reuse geometries/materials; for tiny repeated stock, markings or drops, combine geometry into logical meshes rather than creating a node for every detail. Prefer triangles, not Lines, Points, InstancedMesh, texture maps or runtime canvas textures. Give selectable objects stable IDs. Real transparent glazing, visible aisles and stocked shelves read better than an opaque box with a store painted on it.
- Build the static look from a limited palette, flat facets, slim trim, warm emissive signs and cool low-roughness pavement. Emissive materials do not cast light on their neighbors: color nearby geometry deliberately. Stylized reflection streaks on the ground are not real-time mirror reflections.
- For subtle **preview-only** motion use local GLSL files bound to an object and authored material slot. Example marker addition: `"shaders":[{"objectId":"shop.sign","slot":0,"vertex":"shaders/sign.vert","fragment":"shaders/sign.frag"}]`. The ID must exist. GLSL paths go in `shaders`, not JS `files`. Use `uniform float playgroundTime;` (seconds) in the vertex or fragment shader. E.g. a sign fragment: `uniform float playgroundTime; void main(){ float k=0.93+0.07*sin(3.0*playgroundTime); gl_FragColor=vec4(vec3(1.0,0.54,0.19)*k,1.0); }`. A matching vertex shader: `void main(){ gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`.
- For translucent rain panes author the base PBR material with `transparent: true`, low `opacity` and (if needed) `side: THREE.DoubleSide`. The bound shader inherits blending/side/depth state, not PBR lighting. Declare `uniform float playgroundOpacity;` and multiply your fragment alpha by it. Use only declared `shaders/*.vert` / `shaders/*.frag` files. Start with one tested effect before layering others (at most 16 bindings).
- Vary rain streak phases, draw expanding ripple rings, scroll drops down window UVs or offset the vertices of a sliding door leaf. If mesh geometry is shared, the shader is still bound to the explicit object ID. GPU deformation is cosmetic: picking/bounds remain at the base pose. Keep displacements small and preserve base PBR materials. No `requestAnimationFrame`, authored render loop, live scene callback, timers, or networking. Standalone GLB export is static, not a recording of preview-only motion.
- Deliver the marker together with all declared modules/assets/shaders. Check marker paths, IDs and slot targets; build the actual file snapshot when the builder is available. If a viewer is bound, inspect both the composition and a second view, and compare frames at a fixed camera to verify motion. Report separately what was built, what was observed and what is approximated.
