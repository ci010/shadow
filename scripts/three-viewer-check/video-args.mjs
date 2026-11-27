import { captureArgs } from './capture-args.mjs';

export async function videoArgs(args) {
  const [marker, output, ...rest] = args;
  if (!output?.endsWith('.mp4') || rest.length !== 14) throw new Error('Usage: run.mjs video <marker> <new.mp4> --position x,y,z --target x,y,z --width 960 --height 680 --fps 30 --duration 2 --timeout 120');
  const values = {};
  const camera = [];
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (['--position', '--target'].includes(key)) { camera.push(key, rest[i + 1]); continue; }
    if (!['--width', '--height', '--fps', '--duration', '--timeout'].includes(key) || key in values) throw new Error('Unknown or duplicate video option');
    values[key] = Number(rest[i + 1]);
  }
  const { '--width': width, '--height': height, '--fps': fps, '--duration': duration, '--timeout': timeout } = values;
  if (![width, height].every(n => Number.isInteger(n) && n >= 2 && n <= 4096 && n % 2 === 0) || width * height > 8_388_608) throw new Error('Video dimensions must be even, 2..4096, at most 8388608 pixels');
  if (!Number.isInteger(fps) || fps < 1 || fps > 60 || !Number.isFinite(duration) || duration <= 0 || duration > 600 || !Number.isInteger(duration * fps)) throw new Error('Expected fps 1..60 and duration <=600 with an integral frame count');
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 3600) throw new Error('Timeout must be 1..3600 seconds');
  // Reuse the strict camera parser and exclusive destination preflight.
  const parsed = await captureArgs([marker, output, ...camera], '.mp4');
  return { ...parsed, camera: { ...parsed.camera, width, height, fps, duration, timeout }, timeout };
}
