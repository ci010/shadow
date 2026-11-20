import { addCube } from './cube.mjs';
import { addStand } from './stand.mjs';

export async function build({ THREE, root, assets, random }) {
  addStand(THREE, root);
  addCube(THREE, root);
}
