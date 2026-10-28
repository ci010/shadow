import type { AlignmentSelector } from './alignment-lab-model'

export const MAX_SPATIAL_GLB_BYTES = 32 * 1024 * 1024
export type SpatialSelector = Extract<AlignmentSelector, { type: 'spatial' }>
export interface ModelPoint { x: number; y: number; z: number }

/** Deliberately strict offline GLB subset: all resources must live in the BIN chunk. */
export function validateSpatialGlb(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.byteLength > MAX_SPATIAL_GLB_BYTES || bytes.byteLength < 20) throw new Error('Invalid GLB size')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.length) throw new Error('Invalid GLB header')
  let offset = 12, json: Record<string, unknown> | undefined, binSize = 0, chunks = 0
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error('Truncated GLB chunk')
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true)
    offset += 8
    if (length % 4 || offset + length > bytes.length) throw new Error('Invalid GLB chunk length')
    if (chunks === 0 && type === 0x4e4f534a) {
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + length)))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid GLB JSON')
      json = parsed as Record<string, unknown>
    } else if (chunks === 1 && type === 0x004e4942) binSize = length
    else throw new Error('Unsupported GLB chunk')
    chunks++; offset += length
  }
  if (!json || !binSize) throw new Error('GLB requires embedded geometry')
  const asset = json.asset as { version?: string } | undefined
  if (asset?.version !== '2.0') throw new Error('Unsupported glTF version')
  // No URI (even data URIs), extensions, or alternate resource locations are passed to loaders.
  const inspect = (value: unknown, depth = 0): void => {
    if (depth > 100) throw new Error('GLB nesting too deep')
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (key === 'uri' || key === 'extensions') throw new Error('GLB must contain only embedded core resources')
      inspect(child, depth + 1)
    }
  }
  inspect(json)
  const buffers = json.buffers as { byteLength?: number }[] | undefined
  if (!Array.isArray(buffers) || buffers.length !== 1 || !Number.isSafeInteger(buffers[0]?.byteLength) || buffers[0]!.byteLength! <= 0 || buffers[0]!.byteLength! > binSize || binSize - buffers[0]!.byteLength! > 3) throw new Error('Invalid embedded buffer')
  const views = json.bufferViews
  if (!Array.isArray(views) || views.some(value => {
    if (!value || typeof value !== 'object') return true
    const v = value as { buffer?: number; byteOffset?: number; byteLength?: number }
    const offset = v.byteOffset ?? 0
    return v.buffer !== 0 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(v.byteLength) || v.byteLength! <= 0 || offset + v.byteLength! > buffers[0]!.byteLength!
  })) throw new Error('Invalid embedded buffer views')
  if (json.images !== undefined && (!Array.isArray(json.images) || json.images.some(image => {
    if (!image || typeof image !== 'object') return true
    const value = image as { bufferView?: number; mimeType?: string }
    return !Number.isSafeInteger(value.bufferView) || value.bufferView! < 0 || value.bufferView! >= views.length || !['image/png', 'image/jpeg'].includes(value.mimeType ?? '')
  }))) throw new Error('Only embedded PNG or JPEG images are supported')
  return json
}

export function spatialPointSelector(position: ModelPoint, normal: ModelPoint, surface?: string | null, camera?: SpatialSelector['camera']): SpatialSelector {
  const p: [number, number, number] = [position.x, position.y, position.z]
  const n: [number, number, number] = [normal.x, normal.y, normal.z]
  if (![...p, ...n].every(Number.isFinite) || Math.hypot(...n) < 1e-9) throw new Error('Invalid surface point')
  return { type: 'spatial', position: p, normal: n, ...(surface ? { surface } : {}), ...(camera ? { camera } : {}) }
}

/** Three colored cubes. Coordinates and dimensions are model-local metres. */
export function createSpatialExampleGlb(): Uint8Array {
  const positions: number[] = [], normals: number[] = [], indices: number[] = []
  const faces = [
    [[1,0,0], [[1,-1,-1],[1,1,-1],[1,1,1],[1,-1,1]]],
    [[-1,0,0], [[-1,-1,1],[-1,1,1],[-1,1,-1],[-1,-1,-1]]],
    [[0,1,0], [[-1,1,-1],[-1,1,1],[1,1,1],[1,1,-1]]],
    [[0,-1,0], [[-1,-1,1],[-1,-1,-1],[1,-1,-1],[1,-1,1]]],
    [[0,0,1], [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]]],
    [[0,0,-1], [[1,-1,-1],[-1,-1,-1],[-1,1,-1],[1,1,-1]]],
  ] as const
  for (const [normal, corners] of faces) {
    const base = positions.length / 3
    for (const corner of corners) { positions.push(...corner.map(v => v * .5)); normals.push(...normal) }
    indices.push(base,base+1,base+2,base,base+2,base+3)
  }
  const p = new Float32Array(positions), n = new Float32Array(normals), i = new Uint16Array(indices)
  const binary = new Uint8Array(p.byteLength + n.byteLength + i.byteLength)
  binary.set(new Uint8Array(p.buffer)); binary.set(new Uint8Array(n.buffer), p.byteLength); binary.set(new Uint8Array(i.buffer), p.byteLength+n.byteLength)
  const json = {
    asset: { version: '2.0', generator: 'Shadow offline spatial example' }, scene: 0, scenes: [{ nodes: [0,1,2] }],
    nodes: [{ mesh: 0, translation: [-1.4,0,0] }, { mesh: 1, translation: [0,.5,0] }, { mesh: 2, translation: [1.4,0,0] }],
    meshes: [0,1,2].map(material => ({ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material }] })),
    materials: [[.2,.5,.9,1],[.9,.4,.2,1],[.3,.8,.4,1]].map(baseColorFactor => ({ pbrMetallicRoughness: { baseColorFactor, metallicFactor: 0, roughnessFactor: .8 } })),
    buffers: [{ byteLength: binary.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: p.byteLength }, { buffer: 0, byteOffset: p.byteLength, byteLength: n.byteLength }, { buffer: 0, byteOffset: p.byteLength+n.byteLength, byteLength: i.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-.5,-.5,-.5], max: [.5,.5,.5] }, { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' }, { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' }],
  }
  const encoded = new TextEncoder().encode(JSON.stringify(json)), jsonLength = Math.ceil(encoded.length / 4) * 4
  const bytes = new Uint8Array(12 + 8 + jsonLength + 8 + binary.length), view = new DataView(bytes.buffer)
  view.setUint32(0,0x46546c67,true); view.setUint32(4,2,true); view.setUint32(8,bytes.length,true)
  view.setUint32(12,jsonLength,true); view.setUint32(16,0x4e4f534a,true); bytes.fill(32,20,20+jsonLength); bytes.set(encoded,20)
  view.setUint32(20+jsonLength,binary.length,true); view.setUint32(24+jsonLength,0x004e4942,true); bytes.set(binary,28+jsonLength)
  return bytes
}
