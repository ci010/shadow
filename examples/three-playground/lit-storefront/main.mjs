export function build({ THREE, root }) {
  const material = color => new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  const teal = material(0x254751), ivory = material(0xe4dbba), wood = material(0x945738);
  const slate = material(0x363e48), clay = material(0xd68651), leaf = material(0x4c784e);
  function part(id, name, geometry, position, surface) {
    const mesh = new THREE.Mesh(geometry, surface);
    mesh.name = name;
    mesh.userData.objectId = `store.${id}`;
    mesh.position.set(...position);
    root.add(mesh);
    return mesh;
  }
  const box = (id, name, size, position, surface) => part(id, name, new THREE.BoxGeometry(...size), position, surface);
  box('base', 'Pavement plinth', [3.7, .18, 2.3], [0, -.09, 0], slate);
  box('back', 'Ivory display backing', [3.2, 2.25, .16], [0, 1.125, -.84], ivory);
  box('sill', 'Oak display sill', [3.2, .15, .95], [0, .52, -.29], wood);
  box('apron', 'Recessed lower panel', [3.16, .45, .16], [0, .225, .16], teal);
  box('header', 'Cornice', [3.44, .35, 1.12], [0, 2.13, -.3], teal);
  box('sign', 'Ivory nameplate', [1.32, .15, .035], [0, 2.13, .28], ivory);
  for (const [side, x] of [['left', -1.53], ['right', 1.53]]) {
    box(`post.${side}`, `${side} jamb`, [.15, 2.1, .2], [x, 1.05, .13], teal);
    box(`trim.${side}`, `${side} sign inlay`, [.12, .035, .04], [x * .52, 2.13, .28], clay);
  }
  for (let i = 0; i < 7; i++) {
    const x = (i - 3) * .46;
    box(`awning.${i}`, 'Striped awning', [.45, .06, .63], [x, 1.94, .42], i % 2 ? teal : ivory).rotation.x = .27;
  }
  for (const [id, x, height, radius] of [['large', -.89, .37, .16], ['small', -.38, .25, .11], ['tall', .79, .48, .13]]) {
    part(`pot.${id}`, `${id} terracotta pot`, new THREE.CylinderGeometry(radius, radius * .7, height, 20), [x, .595 + height / 2, -.36], clay);
    for (const dir of [-1, 0, 1]) {
      const sprig = part(`sprig.${id}.${dir}`, 'Leaf', new THREE.SphereGeometry(radius, 12, 8), [x + dir * radius * .65, .63 + height + radius, -.36], leaf);
      sprig.scale.set(.42, 1.5, .42);
      sprig.rotation.z = -dir * .58;
    }
  }

  const point = new THREE.PointLight(0xff9f58, 2.4, 2.3, 2);
  point.name = 'Amber display bulb';
  point.position.set(-.94, 1.48, -.04);
  const spot = new THREE.SpotLight(0x8dbbff, 8, 3.2, .37, .4, 2);
  spot.name = 'Blue window spotlight';
  spot.position.set(1.02, 1.76, .23);
  spot.target.position.set(.66, .72, -.47);
  const sun = new THREE.DirectionalLight(0xb6cbff, .42);
  sun.name = 'Cool street fill';
  sun.position.set(-2, 3, 4);
  sun.target.position.set(0, .65, 0);
  // Three aims these lights at their targets; glTF encodes the same directions as local -Z.
  root.add(point, spot, spot.target, sun, sun.target);
}
