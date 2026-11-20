export function addStand(THREE, root) {
  const steel = new THREE.MeshStandardMaterial({ color: 0x687b95, metalness: 0.35, roughness: 0.45 });
  const grip = new THREE.MeshStandardMaterial({ color: 0x35aac0, roughness: 0.55 });
  function box(id, name, size, position, material = steel) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.name = name;
    mesh.userData.objectId = `stand.${id}`;
    mesh.position.set(...position);
    root.add(mesh);
  }
  box('base', 'Base plate', [3.3, 0.2, 2.5], [0, 0.1, 0]);
  box('pedestal', 'Pedestal', [0.85, 0.75, 0.85], [0, 0.55, 0]);
  for (const [side, z] of [['front', 0.86], ['rear', -0.86]]) {
    for (const [hand, x] of [['left', -0.76], ['right', 0.76]]) {
      box(`${side}.${hand}`, `${side} ${hand} claw`, [0.24, 0.75, 0.3], [x, 0.58, z], grip);
    }
  }
  box('badge', 'Badge', [0.8, 0.12, 0.035], [0, 0.12, 1.26], grip);
}
