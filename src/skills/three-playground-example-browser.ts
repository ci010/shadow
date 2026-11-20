import { buildPlayground } from '../../packages/three-playground/index.ts'

// Only imported by the browser fixture. Example sources reach the public
// builder as snapshot data, never as Vite modules or renderer script text.
export async function buildExample() {
  const response = await fetch('/__example-snapshot')
  if (!response.ok) throw new Error(`Example snapshot: HTTP ${response.status}`)
  const [files, jsonAssets]: [Record<string, string>, Record<string, string>] = await response.json()
  const assets = Object.fromEntries(Object.entries(jsonAssets).map(([name, text]) =>
    [name, new TextEncoder().encode(text).buffer]))
  const { glb } = await buildPlayground({ files, assets }, { timeoutMs: 10_000 })
  return Array.from(new Uint8Array(glb))
}
