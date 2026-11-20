import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createServer } from 'vite'
import { getBuiltinSkills } from './builtins.ts'
import { SkillDisclosure } from './disclosure.ts'

async function buildExample(files: Record<string, string>, jsonAssets: Record<string, string> = {}) {
  const requireDesktop = createRequire(new URL('../../desktop/package.json', import.meta.url))
  const electron: string = requireDesktop('electron')
  const driver = fileURLToPath(new URL('./three-playground-example-electron.cjs', import.meta.url))
  const dir = await mkdtemp(join(tmpdir(), 'shadow-playground-example-'))
  try {
    const server = await createServer({
      root: fileURLToPath(new URL('../../', import.meta.url)),
      configFile: false, envDir: false, cacheDir: join(dir, 'vite'),
      optimizeDeps: { noDiscovery: true },
      server: { host: '127.0.0.1', port: 0, hmr: false },
      plugins: [{ name: 'playground-example-fixture', configureServer(server) {
        server.middlewares.use('/__example-snapshot', (_req, res) => {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify([files, jsonAssets]))
        })
        server.middlewares.use('/__example', (_req, res) => {
          res.setHeader('content-type', 'text/html')
          res.end('<!doctype html><meta charset="utf-8"><title>Playground example</title>')
        })
      } }],
    })
    try {
      await server.listen()
      const address = server.httpServer?.address()
      assert.ok(address && typeof address !== 'string')
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      await promisify(execFile)(electron, [driver, dir, `http://127.0.0.1:${address.port}/__example`], {
        env, timeout: 45_000, killSignal: 'SIGKILL',
      })
      const glb = await readFile(join(dir, 'result.glb'))
      assert.equal(glb.readUInt32LE(0), 0x46546c67, 'Expected binary glTF output')
      return JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)))
    } finally {
      await server.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('general modeling is discoverable in a cold prompt only when the skill is visible', async () => {
  const skills = await getBuiltinSkills()
  const disclosure = new SkillDisclosure()
  const hint = 'read("v:skills/three-playground")'
  assert.ok(disclosure.summary([...skills.values()]).includes(hint))
  skills.delete('three-playground')
  assert.ok(!disclosure.summary([...skills.values()]).includes(hint))
})

test('the bundled getting-started files build a GLB with individually editable lamp parts', async () => {
  const body = (await getBuiltinSkills()).get('three-playground')!.body
  const marker = JSON.parse(/```json\s+([^`]+)```/.exec(body)![1]!)
  assert.deepEqual(marker.files, ['main.mjs'])
  const source = /```js\s+([^`]+)```/.exec(body)![1]!
  const json = await buildExample({ 'main.mjs': source })
  const ids = json.nodes.map((node: {extras?: {objectId?: string}}) => node.extras?.objectId).filter(Boolean)
  assert.deepEqual(ids.sort(), ['lamp.base', 'lamp.shade', 'lamp.stem'])
})

test('diorama guidance links a JSON scene whose editable data actually drives the exported model', async () => {
  const body = (await getBuiltinSkills()).get('three-playground')!.body
  const ref = /v:skills\/three-playground\/(reference\/scene\.md)/.exec(body)![1]!
  const guide = await readFile(new URL(`./builtin/three-playground/${ref}`, import.meta.url), 'utf8')
  const [marker, scene] = [...guide.matchAll(/```json\s+([^`]+)```/g)].map(m => JSON.parse(m[1]!))
  assert.deepEqual(marker.assets, ['scene.json'])
  const source = /```js\s+([^`]+)```/.exec(guide)![1]!
  scene.parts[1].name = '验证：另一盏灯'
  const json = await buildExample({ [marker.files[0]]: source }, { 'scene.json': JSON.stringify(scene) })
  assert.ok(json.nodes.some((n: { name?: string; extras?: { objectId?: string } }) => n.name === scene.parts[1].name && n.extras?.objectId === 'shop.counter'))
})
