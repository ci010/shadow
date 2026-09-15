import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, nativeImage, session } from 'electron'

function argument(name: string): string {
  const value = process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  assert.ok(value)
  return resolve(value)
}

const directory = argument('layout-root')
const assets = argument('layout-assets')
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps'] as const) {
  mkdirSync(join(directory, name), { recursive: true })
  app.setPath(name, join(directory, name))
}
app.setPath('home', directory)
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.on('window-all-closed', () => {})

async function within<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  await within(app.whenReady(), 'Electron readiness')
  const assetPrefix = pathToFileURL(assets + sep).href
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    done({ cancel: !details.url.startsWith(assetPrefix) })
  })
  const icon = join(assets, '..', '..', 'desktop', 'assets', 'icon.ico')
  if (process.platform === 'win32') {
    assert.equal(nativeImage.createFromPath(icon).isEmpty(), false, 'Windows must decode the icon')
  }
  const window = new BrowserWindow({
    show: false,
    icon,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  try {
    await within(window.loadFile(join(assets, 'index.html'), { hash: '/nodes' }), 'built renderer load')
    for (const width of [1280, 960]) {
      window.setSize(width, 800)
      const result = await within(window.webContents.executeJavaScript(`(async () => {
        const logo = document.querySelector('img.desktop-brand');
        if (!(logo instanceof HTMLImageElement)) throw new Error('Header logo is missing');
        await logo.decode();
        const faviconLink = document.querySelector('link[rel="icon"]');
        const favicon = new Image();
        favicon.src = faviconLink.href;
        await favicon.decode();
        const bounds = logo.getBoundingClientRect();
        const titleBar = document.querySelector('.desktop-title-bar').getBoundingClientRect();
        const canvas = document.createElement('canvas');
        canvas.width = logo.naturalWidth;
        canvas.height = logo.naturalHeight;
        const context = canvas.getContext('2d');
        context.drawImage(logo, 0, 0);
        return {
          width: logo.naturalWidth, height: logo.naturalHeight,
          displayedWidth: bounds.width, displayedHeight: bounds.height,
          insideHeader: bounds.top >= titleBar.top && bounds.bottom <= titleBar.bottom,
          faviconWidth: favicon.naturalWidth, faviconHeight: favicon.naturalHeight,
          cornerAlpha: context.getImageData(0, 0, 1, 1).data[3],
        };
      })()`), 'renderer logo decoding')
      assert.deepEqual(result, {
        width: 512, height: 512,
        displayedWidth: 24, displayedHeight: 24,
        insideHeader: true,
        faviconWidth: 64, faviconHeight: 64,
        cornerAlpha: 0,
      })
    }
  } finally {
    window.destroy()
  }
  console.log('LAYOUT_RESULT {"ok":true,"brandingViewports":2}')
  app.exit(0)
}

void main().catch(error => {
  console.error(error)
  console.log(`LAYOUT_RESULT ${JSON.stringify({ ok: false, error: String(error) })}`)
  app.exit(1)
})
