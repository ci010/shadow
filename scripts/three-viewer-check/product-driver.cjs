const assert = require('node:assert/strict');
const browserPointer = require('./pointer.cjs');
const { performance } = require('node:perf_hooks');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function productDriver(contents) {
  const call = expression => contents.executeJavaScript(`window.product.${expression}`, true);
  const workloads = [];
  const input = browserPointer(contents);
  const stats = values => call(`stats(${JSON.stringify(values)})`);
  const device = await call('device');
  for (const unique of [false, true]) {
    const { canvas, ...info } = await call(`init(${unique})`);
    function send(type, x, y, button = 'left') {
      return input(type, Math.round(canvas.x + x * canvas.width), Math.round(canvas.y + y * canvas.height), button);
    }
    await call('reset()'); await pause(150);
    await call('drain()');
    const before = await call('camera()');
    for (let i = 0; i < 50; i++) {
      await send('wheel', .5, .5, i % 2 === 0 ? 15 : -15);
      await pause(17);
    }
    await send('wheel', .5, .5, 65);
    await pause(100);
    const renders = await call('drain()');
    assert(renders.length > 10, `too few live WebGL frames during camera movement: ${renders.length}`);
    assert.notDeepEqual(await call('camera()'), before, 'camera input did not move');
    const pick = [], box = [], reload = [];
    let lastPickCount, lastBoxCount;
    async function selected(min) {
      const end = performance.now() + 2000;
      do {
        const ids = await call('selected()');
        if (ids.length >= min) return ids.length;
        await pause(2);
      } while (performance.now() < end);
      throw new Error(`selection did not reach ${min} IDs`);
    }
    for (let i = 0; i < 10; i++) {
      await call('reset()');
      const [x, y] = await call('pickPoint()');
      await send('move', x, y);
      const t = performance.now();
      await send('down', x, y); await send('up', x, y);
      lastPickCount = await selected(1);
      pick.push(performance.now() - t);
      await call('reset()');
      await send('move', .27, .27); await send('down', .27, .27);
      for (let move = 1; move <= 5; move++) {
        await send('move', .27 + move * .092, .27 + move * .092);
        await pause(12);
      }
      const finished = performance.now();
      await send('up', .73, .73);
      lastBoxCount = await selected(2);
      box.push(performance.now() - finished);
    }
    for (let i = 0; i < 5; i++) {
      const { elapsed, count } = await call('reload()');
      assert.equal(count, info.meshes);
      reload.push(elapsed);
    }
    workloads.push({ ...info, lastPickCount, lastBoxCount, drawCalls: renders.at(-1).drawCalls, cameraCpuRender: await stats(renders.map(frame => frame.renderMs)), cameraRenderInterval: await stats(renders.slice(1).map((frame, i) => frame.time - renders[i].time)), pickDispatchToObservedSelection: await stats(pick), boxMouseUpToObservedSelection: await stats(box), viewerLoadAndTwoAnimationFrames: await stats(reload) });
  }
  await call('dispose()');
  return { device, workloads };
};
