const { app, BrowserWindow } = require('electron');
const { join } = require('node:path');
const { readFile } = require('node:fs/promises');
const [fixture, mode, fixtureScene, url] = process.argv.slice(2);
app.setPath('userData', join(fixture, 'electron-profile'));
app.setPath('sessionData', join(fixture, 'electron-session'));
app.setPath('downloads', fixture);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1100, height: 800, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  const contents = window.webContents;
  contents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
  let download;
  contents.session.on('will-download', (_event, item) => {
    const output = join(fixture, 'capture.glb');
    item.setSavePath(output);
    download = new Promise((resolve, reject) => item.once('done', (_event, state) => state === 'completed' ? resolve(readFile(output)) : reject(new Error(`Download ${state}`))));
  });
  await window.loadURL(url);
  window.show(); window.focus(); contents.focus();

  const result = mode === 'ui'
    ? await require('./ui-driver.cjs')(contents, fixtureScene)
    : mode === 'outline' ? await require('./outline-driver.cjs')(contents)
    : mode === 'product' ? await require('./product-driver.cjs')(contents) : await contents.executeJavaScript(mode === 'worker' ? 'window.runThreeWorkerCheck()' : 'window.runThreeCheck()', true);
  if (!['product', 'outline'].includes(mode)) {
    const deadline = Date.now() + 5000;
    while (!download && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (!download) throw new Error('No browser download observed');
    const data = await download;
    result.download = await contents.executeJavaScript(`window.readDownloadedGlb(${JSON.stringify(data.toString('base64'))})`);
    if (mode === 'ui' && Math.abs(result.download.rearLeftCenter[1] - .76) > .0001) throw new Error('Downloaded geometry did not include repaired rear claw edit');
  }
  console.log(JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, ...result }, null, 2));
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
