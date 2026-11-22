import { lstat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const usage = 'Usage: run.mjs capture <marker> <new.png> --position x,y,z --target x,y,z';

export async function captureArgs(args) {
  const [marker, output, ...options] = args;
  if (!marker || !output || extname(output).toLowerCase() !== '.png' || options.length !== 4) throw new Error(usage);
  const camera = {};
  for (let i = 0; i < options.length; i += 2) {
    const key = options[i] === '--position' ? 'position' : options[i] === '--target' ? 'target' : null;
    if (!key || Object.hasOwn(camera, key)) throw new Error(usage);
    const parts = options[i + 1].split(',').map(part => part.trim());
    const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
    const values = parts.map(Number);
    if (parts.length !== 3 || !parts.every(part => decimal.test(part)) || !values.every(n => Number.isFinite(n) && Math.abs(n) <= 1e15)) {
      throw new Error(`${options[i]} requires three finite decimal coordinates with magnitude at most 1e15`);
    }
    camera[key] = values;
  }
  if (camera.position.every((n, i) => n === camera.target[i])) throw new Error('Camera position equals target');
  const screenshot = resolve(output);
  // Fail early for existing files, including dangling links; the writer also uses
  // exclusive creation so a destination created during rendering is not replaced.
  const existing = await lstat(screenshot).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing) throw new Error(`Screenshot already exists: ${screenshot}`);
  return { marker: resolve(marker), screenshot, camera };
}
