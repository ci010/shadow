# Build an editable miniature scene

The viewer supplies orbit, pan, zoom and inspection. Author the world, not a page or a renderer. Design the silhouette first, then the interior and close-up details. Keep all geometry within the intended base. No characters, HUD or labels floating outside the scene unless requested.

Prefer direct Three.js modeling in `main.mjs`: create named `THREE.Group` assemblies and generate their parts with functions and loops. Only the marker is mandatory JSON; scene geometry does not need a JSON schema or a second file of data.

Model in object-local space, not just a flat list of world-coordinate primitives. For example, return a bicycle group with its own wheel, frame and handlebar assemblies; use a curve and `TubeGeometry` for a bent handlebar, then place and rotate the complete bicycle at the storefront. Use shelf-local slots and product silhouettes (a triangular rice ball, a rimmed bento tray, a bottle with a neck), not dozens of recolored cubes. Boxes are appropriate for the shelf itself. Geometry, material and the relationship between objects must carry the design.

Choose the camera in the scene's own coordinates. Aim `target` at the feature you want to judge; move `position` toward it for a detail shot, or sideways/upward to reveal depth. With a bound viewer, pass those two vectors and the chip's asset ID to `capture_view`. Without a binding, in a permitted Shadow source checkout run `pnpm exec node --import tsx scripts/three-viewer-check/run.mjs capture "$MARKER" "$NEW_PNG" --position "$EYE_XYZ" --target "$AIM_XYZ"`. Supply each vector as three comma-separated numbers, e.g. `--position 3,2,5 --target 0,1,0`; these are world units, not prescribed shots. Use a fresh output filename. This builds the actual marker, not a separate approximation. **Read the PNG**; move the camera or revise the model based on what you see. Keep the pose for before/after comparisons and check the reported version. Do not mistake enlarging a screenshot for moving in close.

## Precision pass: build one bay before filling the block

For a collectible miniature, start with a scale anchor and a viewing side. For example, use a roughly 2 m doorway to set the height of the sign, counter, bicycle and curb. Reserve the door's clear opening and a view through the glass before placing stock. Split a complex scene into shell, fitted interior and street furniture; give them the same floor heights, openings, palette and coordinates. This works in one module or several.

Build a slice all the way from roof edge to street. At a shop window, set a pane **inside** a frame with a sill; turn the fascia and roof cap around the corner rather than ending them flush on the front. Join roof ribs to the cap. Give rooftop equipment feet, a vent face and a conduit that actually reaches the unit. Place a low display behind the pane and taller stock on the rear wall. From an oblique view the frame, front display and rear stock should shift against each other. If they read as one bright rectangle, fix their spacing, mullion width or glass material before adding products.

Spend fine detail where it explains a construction or use. A vending machine has a recessed display, selection strip and a reachable dispensing pocket; it isn't just a luminous face. Repeat a *finished* bottle or tray in shelf-local rows with dividers and price strips. Use rhythm rather than noise: a family of aligned packages with a few deliberate gaps reads as stock; random confetti does not. Thin bands, inset panels and simple geometric marks can suggest printed graphics at miniature scale. Don't outline every face or put equally strong contrast on every seam.

Check three reads in the shared viewer: **whole base** (is there one focal subject and a readable route?), **working distance** (can you trace the join around the corner and see into the room?), **close** (can you identify a fixture by how its parts fit, without its label?). Orbit off the hero angle to expose a floating part, blocked doorway or paper-thin side. Compare against the reference at comparable framing. Fix the first scale or assembly error you can point to, then revisit the same view. Add rain, reflection breakup and flicker after the dry, still model reads; they should reveal the construction, not hide it. These are methods, not a mandatory shop inventory: for another subject choose its characteristic joint, opening or mechanism instead.

## Optional: a JSON-driven starting point

These three files are a complete, deliberately small scene. `scene.json` is **your** scene vocabulary consumed by **your** builder, not a universal object format. Scale up with named groups, reusable factories and compact procedural descriptions in the data. Use literal IDs that survive reordering. Judge the result in the shared preview. If a standalone export is requested, inspect it separately.

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
- Build the static look from a limited palette, flat facets, slim trim, warm emissive signs and cool low-roughness pavement. Emissive materials do not light neighboring objects. For spill from a shop window, add a warm `THREE.PointLight` near the glass and inspect the counter and pavement from the user's view. Use a `SpotLight` for a shaped beam or a `DirectionalLight` for moonlight. For cool sky and warmer ground bounce, try `root.add(new THREE.HemisphereLight(0xc3d7ff, 0xa99385, 0.8))`. This is authored in JS, not duplicated in the marker; inspect its effect on lit materials in the shared preview. The portable GLB omits this fill. Only the active scene's lights contribute; if it has no authored lights the viewer supplies neutral inspection lighting. For display contrast the marker can include `"preview":{"toneMapping":"aces","exposure":1.16}`. This is part of the shared preview, not part of a GLB download. Stylized reflection streaks on the ground are not real-time mirror reflections.
- For subtle **preview-only** motion use local GLSL files bound to an object and authored material slot. Example marker addition: `"shaders":[{"objectId":"shop.sign","slot":0,"vertex":"shaders/sign.vert","fragment":"shaders/sign.frag"}]`. The ID must exist. GLSL paths go in `shaders`, not JS `files`. Use `uniform float playgroundTime;` (seconds) in the vertex or fragment shader. E.g. a sign fragment: `uniform float playgroundTime; void main(){ float k=0.93+0.07*sin(3.0*playgroundTime); gl_FragColor=vec4(vec3(1.0,0.54,0.19)*k,1.0); }`. A matching vertex shader: `void main(){ gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`.
- For translucent rain panes author the base PBR material with `transparent: true`, low `opacity` and (if needed) `side: THREE.DoubleSide`. The bound shader inherits blending/side/depth state, not PBR lighting. Declare `uniform float playgroundOpacity;` and multiply your fragment alpha by it. Use only declared `shaders/*.vert` / `shaders/*.frag` files. Start with one tested effect before layering others (at most 16 bindings).
- Vary rain streak phases, draw expanding ripple rings, scroll drops down window UVs or offset the vertices of a sliding door leaf. If mesh geometry is shared, the shader is still bound to the explicit object ID. GPU deformation is cosmetic: picking/bounds remain at the base pose. Keep displacements small and preserve base PBR materials. No `requestAnimationFrame`, authored render loop, live scene callback, timers, or networking. Standalone GLB export is static, not a recording of preview-only motion.
- Deliver the marker together with all declared modules/assets/shaders. Check marker paths, IDs and slot targets; build the actual file snapshot when the builder is available. If a viewer is bound, inspect both the composition and a second view, and compare frames at a fixed camera to verify motion. Report separately what was built, what was observed and what is approximated.
