import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { videoArgs } from './three-viewer-check/video-args.mjs';
import video from './three-viewer-check/video-driver.cjs';
const options = ['--position', '4,3,6', '--target', '0,1,0', '--width', '320', '--height', '240', '--fps', '4', '--duration', '1', '--timeout', '30'];
test('video bounds and exclusive destination', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.tmp-three-video-test-'));
  try {
    const output = join(dir, 'new.mp4');
    const parsed = await videoArgs(['marker.json', output, ...options]);
    assert.equal(parsed.camera.fps * parsed.camera.duration, 4);
    for (const [key, value] of [['--width', '321'], ['--fps', '0'], ['--duration', '0.1'], ['--timeout', 'NaN'], ['--height', '9000']]) {
      const args = [...options]; args[args.indexOf(key) + 1] = value;
      await assert.rejects(videoArgs(['marker.json', output, ...args]));
    }
    await writeFile(output, 'keep');
    await assert.rejects(videoArgs(['marker.json', output, ...options]), /already exists/);
    assert.equal(await readFile(output, 'utf8'), 'keep');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('renderer failure cleans own reservation, never existing output', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.tmp-three-video-test-'));
  const output = join(dir, 'new.mp4');
  const contents = { executeJavaScript: async source => { if (source.includes('startThreeVideo')) throw new Error('build failed'); }, isDestroyed: () => false };
  try {
    await assert.rejects(video(contents, dir, output, { timeout: 1 }), /build failed/);
    await assert.rejects(readFile(output), { code: 'ENOENT' });
    await writeFile(output, 'keep');
    await assert.rejects(video(contents, dir, output, { timeout: 1 }), { code: 'EEXIST' });
    assert.equal(await readFile(output, 'utf8'), 'keep');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

import { EventEmitter } from 'node:events';
import { open } from 'node:fs/promises';
import { waitForChild } from './three-viewer-check/child-lifecycle.mjs';

test('parent watchdog escalates TERM to KILL and waits for close', async () => {
  const child = new EventEmitter();
  const signals = [];
  let settled = false;
  child.kill = signal => {
    signals.push(signal);
    if (signal === 'SIGKILL') {
      child.emit('exit', null, signal);
      assert.equal(settled, false);
      setImmediate(() => child.emit('close', null, signal));
    }
  };
  const result = waitForChild(child, 5, 5).finally(() => { settled = true; });
  await assert.rejects(result, /Electron timeout/);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('cancellation during publishing write or sync fails and removes owned output', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.tmp-three-video-test-'));
  try {
    for (const phase of ['write', 'sync']) {
      const output = join(dir, `${phase}.mp4`);
      let destroyed = false;
      const contents = { executeJavaScript: async source => source.includes('startThreeVideo') ? {} : '', destroy: () => { destroyed = true; }, isDestroyed: () => destroyed };
      const spawn = () => {
        const encoder = new EventEmitter();
        encoder.stderr = new EventEmitter();
        encoder.stdin = new EventEmitter();
        encoder.stdin.end = () => queueMicrotask(() => encoder.emit('close', 0));
        encoder.kill = () => {};
        return encoder;
      };
      const openOutput = async (...args) => {
        const handle = await open(...args);
        return {
          write: async (...args) => { const result = await handle.write(...args); if (phase === 'write') process.emit('SIGINT'); return result; },
          sync: async () => { await handle.sync(); if (phase === 'sync') process.emit('SIGINT'); },
          close: () => handle.close(),
        };
      };
      await assert.rejects(video(contents, dir, output, { timeout: 1, duration: 0, fps: 1 }, {
        spawn, open: openOutput, createReadStream: async function* () { yield Buffer.from('encoded'); yield Buffer.from('tail'); },
      }), /Video cancelled/);
      assert.equal(destroyed, true);
      await assert.rejects(readFile(output), { code: 'ENOENT' });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
