const assert = require('node:assert/strict');
const browserPointer = require('./pointer.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function outlineDriver(contents) {
  const pointer = browserPointer(contents);
  const call = (method, ...args) => contents.executeJavaScript(`window.outlineCheck?.${method}(...${JSON.stringify(args)})`, true);
  async function until(read, predicate, label) {
    const deadline = Date.now() + 15000;
    let last;
    do {
      last = await read();
      if (predicate(last)) return last;
      await pause(50);
    } while (Date.now() < deadline);
    assert.fail(`${label}: ${JSON.stringify(last)}`);
  }
  const state = (predicate, label) => until(() => call('state'), value => value && predicate(value), label);
  async function clickAt([x, y]) {
    await pointer('move', x, y);
    await pointer('down', x, y);
    await pointer('up', x, y);
  }
  async function click(selector, label) {
    await clickAt(await until(() => call('control', selector, label), Boolean, `visible control ${label}`));
  }
  const ids = side => [1, 2].map(n => `${side} box ${n}`);
  const same = (actual, expected) => actual?.length === expected.length && expected.every(id => actual.includes(id));
  const tree = '.project-file-explorer .model-outline-dock [role="treeitem"]';
  const focused = (side, expected, label) => state(s => s.panes === 1 && s.file === `${side}.glb`
    && same(s.rows, ids(side)) && same(s.selectedRows, expected) && same(s.canvases[side].selection, expected), label);

  await state(s => Object.values(s.canvases).every(c => c.version && c.width > 100), 'both live split canvases loaded');
  await click('button', 'Toggle files');
  await focused('left', [], 'left outline automatically projected into ProjectFileExplorer');
  await click(tree, ids('left')[1]);
  const fromOutline = await focused('left', [ids('left')[1]], 'outline row selects exact viewer object');
  assert.match(fromOutline.canvases.left.status, /1 selected/);
  assert.deepEqual(fromOutline.canvases.right.selection, []);

  await click('[data-editor-id="left"] button', 'Front');
  const [[x1, y1], [x2, y2]] = await call('projected', 'left');
  await clickAt([x1, y1]);
  await focused('left', [ids('left')[0]], 'trusted canvas pick replaces outline selection');
  const lo = [Math.min(x1, x2) - 16, Math.min(y1, y2) - 16];
  const hi = [Math.max(x1, x2) + 16, Math.max(y1, y2) + 16];
  await pointer('move', ...lo);
  await pointer('down', ...lo);
  for (let i = 1; i <= 5; i++) await pointer('move', ...lo.map((p, index) => p + (hi[index] - p) * i / 5));
  await pointer('up', ...hi);
  await focused('left', ids('left'), 'trusted canvas box selects both outline rows');

  await click('[role="tab"]', 'right.glb');
  const right = await focused('right', [], 'right focus replaces the outline without leaking left selection');
  assert.deepEqual([...right.canvases.left.selection].sort(), ids('left'));
  assert(right.canvases.left.width > 100 && right.canvases.right.width > 100);
  await click(tree, ids('right')[1]);
  await focused('right', [ids('right')[1]], 'right outline routes to right viewer');
  await click('[role="tab"]', 'left.glb');
  const left = await focused('left', ids('left'), 'returning focus restores left selected outline rows');
  assert.deepEqual(left.canvases.right.selection, [ids('right')[1]]);
  return { passed: ['ProjectFileExplorer outline projection', 'outline → live viewer', 'trusted canvas pick + box → outline', 'split focus and independent retained selection'] };
};
