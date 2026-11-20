export function addCube(THREE, root) {
  const colors = [0xe14a31, 0xff8c32, 0xf3eeee, 0xffd536, 0x2aae6d, 0x296ecd];
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65 });
  const color = new THREE.Color();
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
    if (!x && !y && !z) continue;
    const geometry = new THREE.BoxGeometry(0.45, 0.45, 0.45);
    // One glTF primitive per selectable cubie, with per-face vertex colors.
    const sides = [x === 1, x === -1, y === 1, y === -1, z === 1, z === -1];
    const rgb = new Float32Array(24 * 3);
    for (let face = 0; face < sides.length; face++) {
      color.setHex(sides[face] ? colors[face] : 0x22252c);
      for (let vertex = 0; vertex < 4; vertex++) color.toArray(rgb, (face * 4 + vertex) * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    const cubie = new THREE.Mesh(geometry, material);
    cubie.name = `Cubie ${x}, ${y}, ${z}`;
    cubie.userData.objectId = `cube.${x}.${y}.${z}`;
    cubie.position.set(x * 0.48, 1.65 + y * 0.48, z * 0.48);
    root.add(cubie);
  }
}
