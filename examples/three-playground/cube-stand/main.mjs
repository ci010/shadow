import { addCube } from './cube.mjs';
import { addStand } from './stand.mjs';

export async function build({ THREE, root, assets, random }) {
  const stand = new THREE.Group();
  stand.name = 'Stand';
  const cube = new THREE.Group();
  cube.name = 'Cube';
  root.add(stand, cube);
  addStand(THREE, stand);
  addCube(THREE, cube);
}
