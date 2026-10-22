import {
  assetPlugin, cadPlugin, createViewer, drawingPlugin, emailPlugin,
  epubPlugin, fallbackPlugin, gisPlugin, model3dPlugin, ofdPlugin, officePlugin, pdfPlugin,
  xpsPlugin, type PreviewOptions,
} from '@open-file-viewer/core'
import '@open-file-viewer/core/style.css'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { cMapUrl, standardFontDataUrl, wasmUrl } from 'virtual:shadow-pdf-assets'

const pdf = { workerSrc: pdfWorkerSrc, compatibilityMode: 'modern' as const, cMapUrl, standardFontDataUrl, wasmUrl, webFallbackScripts: 'never' as const }
const plugins = [
  pdfPlugin(pdf), officePlugin({ pdf }), emailPlugin(),
  epubPlugin(), ofdPlugin(), xpsPlugin(), drawingPlugin(),
  cadPlugin({ libreDwg: false, webglDwg: false }), model3dPlugin(), gisPlugin(),
  assetPlugin(), fallbackPlugin(),
]

export function mountFileViewer(options: Pick<PreviewOptions, 'container' | 'file' | 'fileName' | 'theme' | 'onLoad' | 'onError' | 'onUnsupported'>) {
  return createViewer({
    ...options, plugins, width: '100%', height: '100%', locale: 'en-US',
    toolbar: { zoom: true, rotate: true, download: false, fullscreen: false, print: false, search: true },
  })
}
