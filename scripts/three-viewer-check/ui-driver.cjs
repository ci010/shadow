const browserPointer = require('./pointer.cjs');
const { readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function checkUi(contents, fixtureScene) {
  const pointer = browserPointer(contents);
  const exec = js => contents.executeJavaScript(js, true);
  async function until(read, test, label) {
    let last;
    const end = Date.now() + 15000;
    do {
      last = await read();
      if (test(last)) return last;
      await pause(80);
    } while (Date.now() < end);
    throw new Error(`Timed out: ${label}; last state ${JSON.stringify(last)}`);
  }
  const state = () => exec('window.threeUi?.state()');
  async function click(label) {
    const [x, y] = await until(() => exec(`window.threeUi.button(${JSON.stringify(label)})`), Boolean, `enabled button ${label}`);
    await pointer('move', x, y);
    await pointer('down', x, y);
    await pointer('up', x, y);
    await pause(80);
  }
  const capture = view => exec(`window.threeUi.capture(${JSON.stringify(view)})`);
  const requests = () => exec('window.threeUi.requests()');
  await click('Open cube stand');
  const { canvas } = await until(state, value => value?.canvas?.width > 100 && /Download GLB/i.test(value.text), 'loaded preview');
  await click('Back');
  const firstVersion = (await requests()).findLast(row => !row.unchanged).version;
  const back = await capture();
  assert(back.version.startsWith(`${firstVersion}:`));
  assert(back.imageBytes > 0);
  function input(type, x, y) {
    return pointer(type, Math.round(canvas.x + x * canvas.width), Math.round(canvas.y + y * canvas.height));
  }
  await input('move', .30, .58);
  await input('down', .30, .58);
  for (let i = 1; i <= 8; i++) {
    await input('move', .30 + i * .05, .58 + i * .025);
    await pause(20);
  }
  await input('up', .70, .78);
  await pause(250);
  await click('Add to chat');
  const { drafts } = await until(state, value => !value.active && value.drafts.length > 0, 'selected objects delivered to synthetic draft');
  assert(drafts.some(ref => /^stand\.rear\./.test(ref.objectId)), 'Back box does not include a rear claw');
  assert(drafts.every(ref => ref.buildVersion === back.version), 'Draft linked to wrong snapshot');
  const stand = join(fixtureScene, 'stand.mjs');
  const original = await readFile(stand, 'utf8');
  const fragment = '[x, 0.58, z]';
  const moved = "[x, side === 'rear' ? 0.76 : 0.58, z]";
  await until(() => exec('window.threeUi.bindingReady()'), Boolean, 'real capture bridge ready');
  const { requestId } = await exec("window.threeUi.admit('Inspect both rear claws after editing stand.mjs.')");
  assert(requestId);
  const tool = (name, args) => `window.threeUi.tool(${JSON.stringify(requestId)}, ${JSON.stringify(name)}, ${JSON.stringify(args)})`;
  async function edit(match, content) {
    const result = await exec(tool('write', { match, content }));
    assert(result.receipt && !result.receipt.startsWith('Error:'), JSON.stringify(result));
  }
  async function toolFrame(mode, version, afterVersion) {
    const invocation = tool('capture_view', { assetId: drafts[0].assetId, mode, version, afterVersion });
    return exec(`(async () => window.threeUi.capturedToolResult(await ${invocation}))()`);
  }
  const polled = await until(requests, rows => rows.some(row => row.unchanged), 'conditional poll returns 304');
  assert.equal(polled.find(row => row.unchanged).etag, polled[0].etag);
  assert.equal((await exec('window.threeUi.buildStarts()')).length, 1, '304 initiated an unnecessary rebuild');
  const beforeEdit = await toolFrame('current', back.version);
  assert.equal(beforeEdit.version, back.version);
  assert.match((await toolFrame('current', undefined, back.version)).error, /previous asset version/);
  try {
    await edit(fragment, moved);
    assert.equal(await readFile(stand, 'utf8'), original.replace(fragment, moved));
    const changed = await until(requests, rows => rows.some(row => row.status === 200 && row.version !== firstVersion), 'single-file snapshot refresh');
    const version = changed.findLast(row => !row.unchanged).version;
    const current = await until(capture, value => value.version?.startsWith(`${version}:`), 'new build committed to viewer');
    assert.deepEqual(current.camera, back.camera, 'refresh changed the live camera');
    assert.notEqual(current.imageHash, beforeEdit.imageHash, 'rear-claw edit did not change capture');
    const starts = await exec('window.threeUi.buildStarts()');
    assert.equal(starts.length, 2, 'one changed snapshot should trigger one build');
    const debounceToBuildMs = starts[1] - changed.find(row => row.version === version).time;
    assert(debounceToBuildMs >= 150, `hot reload bypassed debounce: ${debounceToBuildMs}ms`);
    const carried = await until(() => toolFrame('current', undefined, back.version), frame => frame.version === current.version, 'real capture_view tool following updated version');
    assert.deepEqual(carried.camera, current.camera);
    assert(carried.objectIds.includes('stand.rear.left') && carried.objectIds.includes('stand.rear.right'));
    const front = await toolFrame('front', current.version);
    assert.equal(front.version, current.version);
    assert(carried.bytes > 0 && front.bytes > 0);
    assert.notDeepEqual(front.camera, current.camera);
    assert.notEqual(front.imageHash, carried.imageHash);
    assert.deepEqual(await exec('window.threeUi.camera()'), current.camera, 'separate capture changed the live camera');
    const badge = "box('badge'";
    const broken = `function {\n  ${badge}`;
    await edit(badge, broken);
    await until(requests, rows => rows.some(row => row.status === 200 && row.version !== firstVersion && row.version !== version), 'broken source fetched');
    await until(state, value => /preview unchanged.*build failed/i.test(value.alert ?? ''), 'build error surfaced');
    const retained = await capture();
    assert.equal(retained.version, current.version, 'broken build replaced previous viewer version');
    assert.deepEqual(retained.camera, current.camera);
    assert.deepEqual(retained.objectIds, current.objectIds);
    assert(retained.imageBytes > 0);
    // The error panel can resize the canvas, so hashes need not match here.
    await edit(broken, `// Repaired build.\n  ${badge}`);
    const recovered = await until(capture, value => value.version !== current.version, 'valid source recovers');
    assert.deepEqual(recovered.camera, current.camera);
    assert.equal(recovered.imageHash, current.imageHash);
    await until(state, value => !value.alert, 'error panel clears');
    await exec('window.threeUi.activate()');
    await click('Download GLB');
    const viewerLoads = await exec('window.threeUi.viewerLoads()');
    const buildStarts = await exec('window.threeUi.buildStarts()');
    assert.equal(viewerLoads.length, 3, 'broken syntax should never reach the viewer');
    assert.equal(buildStarts.length, 4, 'expected initial, edited, broken and repaired builds');
    const buildToCommittedModelMs = viewerLoads.map((entry, i) => entry.committed - buildStarts[i === 2 ? 3 : i]);
    const selection = () => exec('window.threeUi.selection()');
    const stableIds = drafts.map(ref => ref.objectId).sort();
    assert.deepEqual((await selection()).sort(), stableIds, 'successful and failed reloads should retain unchanged selected IDs');
    const removed = 'stand.pedestal';
    assert(stableIds.includes(removed), 'box fixture must include the object whose ID is replaced');
    const repairedSource = await readFile(stand, 'utf8');
    const pedestal = "box('pedestal'";
    assert(repairedSource.includes(pedestal));
    await writeFile(stand, repairedSource.replace(pedestal, "box('pedestal-renamed'"));
    await until(state, value => value.text.includes(`No longer in this build: ${removed}`), 'missing selection warning after ID change');
    const afterRename = await capture();
    assert.notEqual(afterRename.version, recovered.version);
    const survivors = stableIds.filter(id => id !== removed);
    assert.deepEqual((await selection()).sort(), survivors, 'replaced ID must be removed without clearing surviving selections');
    return { draftIds: stableIds, firstVersion, version, debounceToBuildMs, buildToCommittedModelMs, capture: { version: carried.version, current: carried.size, front: front.size }, selectionReload: { version: afterRename.version, removed, survivors }, snapshotRequests: await requests() };
  } finally { await writeFile(stand, original); }
};
