import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Plugin } from 'vite'

const moduleId = 'virtual:shadow-pdf-assets'
const resolvedId = `\0${moduleId}`
const prefix = '/@shadow/pdfjs/'

/** Package PDF CMaps/fonts locally, including their upstream license notices. */
export function pdfViewerAssets(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const assets = new Map<string, Buffer>()
  const references = new Map<string, string>()
  let development = false
  return {
    name: 'shadow-pdf-viewer-assets',
    configResolved(config) { development = config.command === 'serve' },
    async buildStart() {
      assets.clear()
      references.clear()
      for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
        for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
          if (!entry.isFile()) continue
          const name = `${directory}/${entry.name}`
          const source = await readFile(join(root, directory, entry.name))
          assets.set(name, source)
          if (!development) references.set(name, this.emitFile({
            type: 'asset', fileName: `assets/pdfjs/${name}`, source,
          }))
        }
      }
    },
    resolveId(id) { if (id === moduleId) return resolvedId },
    load(id) {
      if (id !== resolvedId) return
      if (development) return `export const cMapUrl = ${JSON.stringify(`${prefix}cmaps/`)};
export const standardFontDataUrl = ${JSON.stringify(`${prefix}standard_fonts/`)};
export const wasmUrl = ${JSON.stringify(`${prefix}wasm/`)};`
      const cmap = references.get('cmaps/Adobe-Japan1-UCS2.bcmap')
      const font = references.get('standard_fonts/LiberationSans-Regular.ttf')
      const wasm = references.get('wasm/openjpeg.wasm')
      if (!cmap || !font || !wasm) throw new Error('The installed PDF.js CMaps, fonts or image decoders are missing.')
      return `export const cMapUrl = new URL("./", import.meta.ROLLUP_FILE_URL_${cmap}).href;
export const standardFontDataUrl = new URL("./", import.meta.ROLLUP_FILE_URL_${font}).href;
export const wasmUrl = new URL("./", import.meta.ROLLUP_FILE_URL_${wasm}).href;`
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname
        if (!path.startsWith(prefix)) return next()
        const bytes = assets.get(path.slice(prefix.length))
        if (!bytes) { response.statusCode = 404; response.end(); return }
        response.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
        response.setHeader('Content-Length', bytes.length)
        response.end(bytes)
      })
    },
  }
}
