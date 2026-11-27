const { spawn } = require('node:child_process');
const { open, unlink } = require('node:fs/promises');
const { join } = require('node:path');
const { createReadStream } = require('node:fs');

module.exports = async function video(contents, fixture, output, config, dependencies = {}) {
  const spawnEncoder = dependencies.spawn ?? spawn;
  const openOutput = dependencies.open ?? open;
  const readVideo = dependencies.createReadStream ?? createReadStream;
  const temporary = join(fixture, 'video.mp4');
  let encoder, completed, failure, destination;
  let stderr = '';
  const abort = reason => {
    failure ??= new Error(reason);
    encoder?.kill('SIGKILL');
    contents.destroy();
  };
  const interrupt = () => abort('Video cancelled');
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const timer = setTimeout(() => abort('Video timeout'), config.timeout * 1000);
  try {
    // Reserve without overwriting even a symlink or a concurrent writer.
    destination = await openOutput(output, 'wx');
    const metadata = await contents.executeJavaScript(`window.startThreeVideo(${JSON.stringify(config)})`);
    const frames = config.duration * config.fps;
    encoder = spawnEncoder('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'image2pipe', '-framerate', String(config.fps), '-vcodec', 'png', '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-frames:v', String(frames), '-movflags', '+faststart', temporary], { stdio: ['pipe', 'ignore', 'pipe'] });
    completed = new Promise((resolve, reject) => {
      encoder.once('error', reject);
      encoder.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code ?? signal}): ${stderr}`)));
    });
    completed.catch(() => {});
    encoder.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8192); });
    encoder.stdin.on('error', error => { failure ??= error; });
    for (let i = 0; i < frames; i++) {
      if (failure) throw failure;
      const png = Buffer.from(await contents.executeJavaScript(`window.nextThreeVideoFrame(${i})`), 'base64');
      // Await each write callback: at most one encoded PNG is retained on the host.
      await new Promise((resolve, reject) => encoder.stdin.write(png, error => error ? reject(error) : resolve()));
    }
    encoder.stdin.end();
    await completed;
    if (failure) throw failure;
    for await (const chunk of readVideo(temporary)) {
      if (failure) throw failure;
      let offset = 0;
      while (offset < chunk.length) {
        if (failure) throw failure;
        const { bytesWritten } = await destination.write(chunk, offset, chunk.length - offset);
        offset += bytesWritten;
      }
    }
    if (failure) throw failure;
    await destination.sync();
    if (failure) throw failure;
    await destination.close();
    if (failure) { await unlink(output); destination = undefined; throw failure; }
    destination = undefined;
    return { ...metadata, video: output, width: config.width, height: config.height, fps: config.fps, duration: config.duration, frames, audio: false };
  } catch (error) {
    encoder?.kill('SIGKILL');
    await completed?.catch(() => {});
    const primary = failure ?? error;
    const cleanupErrors = [];
    if (destination) {
      try { await destination.close(); } catch (cleanup) { cleanupErrors.push(cleanup); }
      try { await unlink(output); } catch (cleanup) { cleanupErrors.push(cleanup); }
      destination = undefined;
    }
    if (cleanupErrors.length) throw new AggregateError([primary, ...cleanupErrors], primary.message);
    throw primary;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    if (!contents.isDestroyed()) await contents.executeJavaScript('window.stopThreeVideo()').catch(() => {});
  }
};
