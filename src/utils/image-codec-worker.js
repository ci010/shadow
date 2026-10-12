// Kept as a JS asset so the same worker URL works in source and the Node build.
import { parentPort, workerData } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import decode, { init as initPng } from '@jsquash/png/decode.js'
import encode, { init as initWebp } from '@jsquash/webp/encode.js'

// wasm-bindgen's PNG decoder only needs this browser value container.
globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    this.data = data
    this.width = width
    this.height = height
  }
}

try {
  // Explicit bytes avoid browser fetch(file://) and work in Node/Electron packages.
  await initPng(await readFile(new URL(import.meta.resolve('@jsquash/png/codec/pkg/squoosh_png_bg.wasm'))))
  const wasmBinary = await readFile(new URL(import.meta.resolve('@jsquash/webp/codec/enc/webp_enc.wasm')))
  // Both Emscripten loaders expose the same C API; the portable WASM binary
  // also works when init selects its SIMD-capable JS loader.
  await initWebp({ wasmBinary })
  const image = await decode(workerData.bytes.buffer)
  if (image.width !== workerData.width || image.height !== workerData.height) throw new Error('Decoded dimensions mismatch')
  const result = await encode(image, {
    lossless: 1, near_lossless: 100, exact: 1, quality: 75, method: 3, low_memory: 1,
  })
  parentPort.postMessage(new Uint8Array(result), [result])
} catch {
  parentPort.postMessage(null)
}
