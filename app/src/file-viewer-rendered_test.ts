import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32 } from 'node:zlib'
import test from 'node:test'
import { build, createServer, preview, type Plugin, type ViteDevServer } from 'vite'
import config from '../vite.config.ts'

const repository = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const viewerRequire = createRequire(createRequire(new URL('../package.json', import.meta.url)).resolve('@open-file-viewer/core'))
const { build: bundleMain } = desktopRequire('esbuild') as typeof import('esbuild')

function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name)
    const bytes = Buffer.from(text)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc32(bytes), 14)
    local.writeUInt32LE(bytes.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(filename.length, 26)
    locals.push(local, filename, bytes)
    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt32LE(crc32(bytes), 16)
    directory.writeUInt32LE(bytes.length, 20)
    directory.writeUInt32LE(bytes.length, 24)
    directory.writeUInt16LE(filename.length, 28)
    directory.writeUInt32LE(offset, 42)
    central.push(directory, filename)
    offset += local.length + filename.length + bytes.length
  }
  const index = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(index.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, index, end])
}

function pdf(): Buffer {
  const stream = 'BT /F1 24 Tf 72 700 Td (Synthetic PDF report) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let source = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source))
    source += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const start = Buffer.byteLength(source)
  source += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  source += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`
  return Buffer.from(source)
}

const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships'
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const types = (part: string, content: string) => `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${part}" ContentType="${content}"/></Types>`
const fixtures = new Map([
  ['report.pdf', pdf()],
  ['bundle.zip', zip({
    'notes.txt': 'Synthetic archive entry',
    'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#245bc1"/></svg>',
    'large.txt': `<script>window.unsafeArchiveEntry = true</script>\n${'x'.repeat(70000)}`,
  })],
  ['report.docx', zip({
    '[Content_Types].xml': types('word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'),
    '_rels/.rels': `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic Word report</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
    'word/_rels/document.xml.rels': `<Relationships xmlns="${relationships}"/>`,
  })],
  ['report.xlsx', zip({
    '[Content_Types].xml': types('xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'),
    '_rels/.rels': `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${office}"><sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${office}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Synthetic sheet cell</t></is></c></row></sheetData></worksheet>',
  })],
  ['message.eml', Buffer.from('From: sender@example.invalid\r\nTo: recipient@example.invalid\r\nSubject: Synthetic message\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSynthetic mail body')],
  ['drawing.dxf', Buffer.from('0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nSynthetic\n10\n0\n20\n0\n11\n100\n21\n100\n0\nENDSEC\n0\nEOF\n')],
  ['shape.excalidraw', Buffer.from(JSON.stringify({ type: 'excalidraw', elements: [{
    id: 'box', type: 'rectangle', x: 0, y: 0, width: 160, height: 100, angle: 0,
    strokeColor: '#245bc1', backgroundColor: '#eaf1ff', fillStyle: 'solid', strokeWidth: 2, opacity: 100,
  }] }))],
  ['area.geojson', Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [{
    type: 'Feature', properties: { name: 'Synthetic map area' }, geometry: {
      type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
    },
  }] }))],
  ['module.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])],
])

test('Open File Viewer renders protected files with local assets in dev and built desktop/mobile viewports', {
  timeout: 240_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const scratch = resolve(repository, '.test-artifacts')
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, 'file-viewer-'))
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const requested: string[] = []
  const leafletCss = await readFile(viewerRequire.resolve('leaflet/dist/leaflet.css'))
  let inspectedBundle = false
  const fixturePlugin: Plugin = {
    name: 'shadow-file-viewer-fixture',
    configureServer: middleware,
    configurePreviewServer: middleware,
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter(output => output.type === 'chunk')
      const sdk = chunks.find(chunk => Object.keys(chunk.modules).some(id => id.replaceAll('\\', '/').includes('/@open-file-viewer/core/dist/index.js')))
      assert(sdk, 'Inspect the actual SDK production chunk')
      const code = chunks.map(chunk => chunk.code).join('\n')
      for (const name of ['image', 'text', 'video', 'audio', 'xmind']) {
        assert.doesNotMatch(code, new RegExp(`function ${name}Plugin\\d*\\(`), `${name} SDK plugin is eliminated`)
      }
      for (const name of ['cad', 'gis', 'asset', 'office', 'archive']) {
        assert.match(sdk.code, new RegExp(`function ${name}Plugin\\d*\\(`), `${name} SDK plugin is retained`)
      }
      const modules = chunks.flatMap(chunk => Object.entries(chunk.modules).filter(([, module]) => module.renderedLength > 0).map(([id]) => id.replaceAll('\\', '/')))
      assert(!modules.some(id => /\/(?:heic2any|hls\.js|prismjs)\//.test(id)), 'Unused SDK conversion, streaming and code dependencies have no emitted code')
      assert(modules.some(id => id.includes('/utif/')), 'Office retains the shared decoder for embedded PPTX TIFF images')
      inspectedBundle = true
    },
  }
  function middleware(server: Pick<ViteDevServer, 'middlewares'>) {
    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname === '/__viewer/leaflet.css') {
        response.setHeader('Content-Type', 'text/css')
        response.end(leafletCss)
        return
      }
      if (url.pathname === '/__viewer/tile.png') {
        response.setHeader('Content-Type', 'image/png')
        response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6WQAAAAASUVORK5CYII=', 'base64'))
        return
      }
      if (url.pathname !== '/api/sessions/web%3Aviewer-fixture/raw') return next()
      const path = url.searchParams.get('path') ?? ''
      requested.push(path)
      response.setHeader('Content-Type', 'application/json')
      if (request.headers['x-viewer-fixture'] !== 'authorized') {
        response.statusCode = 401; response.end(JSON.stringify({ error: 'unauthorized' })); return
      }
      if (path === 'offline.docx') {
        response.statusCode = 503
        response.end(JSON.stringify({ error: 'workdir_unavailable', reason: 'node-offline', nodeId: 'child', capabilityId: 'folder' }))
        return
      }
      if (path === 'denied.docx') { response.statusCode = 403; response.end(JSON.stringify({ error: 'denied' })); return }
      const bytes = fixtures.get(path)
      if (!bytes) { response.statusCode = 404; response.end(JSON.stringify({ error: 'file_not_found' })); return }
      response.setHeader('Content-Type', extname(path) === '.pdf' ? 'application/pdf' : 'application/octet-stream')
      response.end(bytes)
    })
  }
  const common = {
    ...config, configFile: false as const, envFile: false as const,
    root: resolve(repository, 'app'), logLevel: 'error' as const,
    cacheDir: join(directory, 'cache'),
    plugins: [...config.plugins!, fixturePlugin],
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false as const, proxy: {} },
    preview: { host: '127.0.0.1', port: 0, strictPort: false, proxy: {} },
    build: { ...config.build, minify: false as const, outDir: join(directory, 'built'), rollupOptions: {
      ...config.build?.rollupOptions, input: resolve(repository, 'app', 'src', 'file-viewer-fixture.html'),
    } },
  }
  await bundleMain({
    entryPoints: [resolve(repository, 'desktop', 'tests', 'fixtures', 'file-viewer-smoke.ts')],
    outfile: join(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron'], logLevel: 'silent',
  })
  for (const mode of ['dev', 'built']) {
    if (mode === 'built') await build(common)
    const server = mode === 'dev' ? await createServer(common) : await preview(common)
    if (mode === 'dev' && 'listen' in server) await server.listen()
    try {
      const base = server.resolvedUrls?.local[0]
      assert(base)
      const assetRoot = mode === 'dev' ? '/@shadow/pdfjs/' : '/assets/pdfjs/'
      for (const name of ['cmaps/Adobe-Japan1-UCS2.bcmap', 'standard_fonts/LiberationSans-Regular.ttf', 'wasm/openjpeg.wasm']) {
        const response = await fetch(new URL(assetRoot + name, base))
        assert.equal(response.status, 200, `${mode} bundles ${name}`)
        assert((await response.arrayBuffer()).byteLength > 100)
      }
      const env: NodeJS.ProcessEnv = {
        VIEWER_FIXTURE_URL: new URL('src/file-viewer-fixture.html', base).href,
        VIEWER_SCREENSHOTS: process.env.VIEWER_SCREENSHOTS ? join(process.env.VIEWER_SCREENSHOTS, mode) : undefined,
      }
      const profile = join(directory, `profile-${mode}`)
      await mkdir(profile)
      for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
        if (process.env[key] !== undefined) env[key] = process.env[key]
      }
      for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = profile
      const child = spawn(desktopRequire('electron') as string, [join(directory, 'main.cjs')], {
        cwd: profile, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let log = ''
      child.stdout.setEncoding('utf8').on('data', chunk => { log += chunk })
      child.stderr.setEncoding('utf8').on('data', chunk => { log += chunk })
      const timer = setTimeout(() => child.kill(), 90_000)
      t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
      const [code] = await once(child, 'close')
      clearTimeout(timer)
      assert.equal(code, 0, `${mode}\n${log}`)
      assert.match(log, /FILE_VIEWER_SMOKE_OK/)
    } finally {
      if ('close' in server) await server.close()
      else await new Promise<void>((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()))
    }
  }
  for (const name of fixtures.keys()) assert(requested.includes(name), `${name} uses the owning raw endpoint`)
  assert(inspectedBundle)
})
