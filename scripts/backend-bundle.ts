import { builtinModules, createRequire } from 'node:module'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { build, type Plugin } from 'vite'
import { transform } from 'esbuild'
import { copyAgentDesktopAssets } from './agent-desktop-assets.ts'

// Keep every out-of-graph process entry: Node cannot discover these from imports.
export const backendEntries = [
  'index', 'a2a/mcp-cli', 'script-runtime/worker', 'channels/feishu-worker',
  'channels/source-reader-process',
  'execution/processes/guardian-worker', 'execution/processes/posix-controller',
  'execution/network/proxy-preload', 'utils/image-codec-worker',
  'runtime/startup-profile-preload', 'script-runtime/runtime', 'channels/feishu-transport',
  'execution/computer/agent-desktop-worker',
]
// Copy these packages intact: adjacent WASM/compiler/native assets and the Chrome
// adapter child entry (with its bundled dependencies and license notices) are not
// discoverable as ordinary imports in the backend graph.
export const backendExternals = ['@jsquash/png', '@jsquash/webp', 'typescript', 'esbuild', 'chrome-devtools-mcp']

/** Compile direct TS entries into the same relocatable layout used in dev and production.
 * Additional entries are useful for native-Node integration tests of exported APIs.
 */
export async function compileBackend(root: string, output: string, entries = backendEntries): Promise<void> {
  root = resolve(root)
  output = resolve(output)
  if (output === root || root.startsWith(output + sep) || output === join(root, 'src')
    || output.startsWith(join(root, 'src') + sep)) {
    throw new Error('Bundle output must be separate from the source tree')
  }
  const src = join(root, 'src')
  const packageDirectories = new Set<string>()
  const locations: Plugin = {
    name: 'shadow-module-locations',
    // Vite must erase TS before the JS AST parser sees type annotations.
    enforce: 'post',
    transform(code, id) {
      const normalized = id.replaceAll('\\', '/')
      for (const match of normalized.matchAll(/\/node_modules\/((?:@[^/]+\/)?[^/.][^/]*)\//g)) {
        packageDirectories.add(normalized.slice(0, match.index! + match[0].length - 1))
      }
      if (!id.replaceAll('\\', '/').startsWith(src.replaceAll('\\', '/') + '/')) return
      const path = relative(root, id).replaceAll('\\', '/').replace(/\.ts$/, '.js')
      // Bundled code still locates assets/child entries as if at its original compiled path.
      const changes: Array<{ start: number; end: number; text: string }> = []
      // Parse rather than replacing text inside comments or user-script strings.
      const visit = (node: any): void => {
        if (!node || typeof node !== 'object') return
        if (node.type === 'MemberExpression' && !node.computed && node.object?.type === 'MetaProperty'
          && node.object.meta?.name === 'import' && node.object.property?.name === 'meta'
          && ['url', 'dirname'].includes(node.property?.name)) {
          changes.push({ start: node.start, end: node.end,
            text: `__shadow_module_${node.property.name === 'url' ? 'url' : 'dir'}__(${JSON.stringify(path)})` })
          return
        }
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) value.forEach(visit)
          else if (value && typeof value === 'object') visit(value)
        }
      }
      visit(this.parse(code))
      for (const change of changes.sort((a, b) => b.start - a.start)) {
        code = code.slice(0, change.start) + change.text + code.slice(change.end)
      }
      return code
    },
    async generateBundle() {
      const notices: string[] = []
      for (const directory of [...packageDirectories].sort()) {
        const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
        notices.push(`## ${metadata.name}@${metadata.version} (${metadata.license ?? 'see package license'})`)
        for (const file of (await readdir(directory)).sort()) {
          if (/^(licen[sc]e|copying|notice)(\.|$)/i.test(file)) {
            notices.push(await readFile(join(directory, file), 'utf8'))
          }
        }
      }
      this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY-NOTICES.txt', source: notices.join('\n\n') + '\n' })
    },
    renderChunk(code, chunk) {
      let directoryUsed = false
      const rendered = code.replace(/__shadow_module_(url|dir)__\("([^"]+)"\)/g, (_, kind, path) => {
        const location = relative(dirname(chunk.fileName), path).replaceAll('\\', '/')
        const expression = `new URL(${JSON.stringify(location.startsWith('.') ? location : './' + location)}, import.meta.url)`
        if (kind === 'url') return `${expression}.href`
        directoryUsed = true
        return `__shadow_file_url_to_path__(new URL('.', ${expression})).replace(/[\\\\/]+$/, '')`
      })
      return directoryUsed ? `import { fileURLToPath as __shadow_file_url_to_path__ } from 'node:url';\n${rendered}` : rendered
    },
  }
  await build({
    root, configFile: false, publicDir: false,
    plugins: [{
      name: 'shadow-typescript-decorators',
      enforce: 'pre',
      // Oxc currently preserves standard decorators, which Node cannot execute.
      // Lower them in Vite's source pipeline without a tsc emit stage.
      async transform(code, id) {
        if (id.endsWith('.ts') && id.replaceAll('\\', '/').startsWith(src.replaceAll('\\', '/') + '/')) {
          return transform(code, { loader: 'ts', sourcefile: id, target: 'node24', format: 'esm', sourcemap: false })
        }
      },
    }, locations],
    build: {
      ssr: true, target: 'node24', outDir: output, emptyOutDir: true,
      minify: false, sourcemap: false,
      rollupOptions: {
        input: Object.fromEntries(entries.map(name => ['src/' + name,
          join(src, name + (['utils/image-codec-worker', 'execution/computer/agent-desktop-worker'].includes(name) ? '.js' : '.ts'))])),
        external: id => id.startsWith('node:') || builtinModules.includes(id)
          || backendExternals.some(name => id === name || id.startsWith(name + '/')),
        output: { format: 'es', entryFileNames: '[name].js', chunkFileNames: '_chunks/[name]-[hash].js' },
        onwarn(warning, warn) {
          if (warning.code === 'UNRESOLVED_IMPORT') throw new Error(warning.message)
          warn(warning)
        },
      },
    },
    ssr: { noExternal: true },
  })
  await copyAssets(join(root, 'src'), join(output, 'src'))
  await copyAgentDesktopAssets(root, output)
  const copied = new Map<string, string>()
  async function copyPackage(name: string, from: string): Promise<void> {
    const manifest = createRequire(join(from, 'package.json')).resolve(name + '/package.json')
    const metadata = JSON.parse(await readFile(manifest, 'utf8'))
    if (copied.has(name)) {
      if (copied.get(name) !== metadata.version) throw new Error(`Conflicting external package versions: ${name}`)
      return
    }
    copied.set(name, metadata.version)
    const packageRoot = dirname(manifest)
    await cp(packageRoot, join(output, 'node_modules', name), { recursive: true, dereference: true })
    for (const dependency of Object.keys(metadata.dependencies ?? {})) await copyPackage(dependency, packageRoot)
    if (name === 'esbuild') await copyPackage(`@esbuild/${process.platform}-${process.arch}`, packageRoot)
  }
  for (const name of backendExternals) await copyPackage(name, root)
  await writeFile(join(output, 'package.json'), JSON.stringify({ name: '@shadow/backend-bundle', private: true, type: 'module' }, null, 2) + '\n')
}

/** Build a standalone resource directly from TS (also used by relocated integration tests). */
export async function bundleBackend(root: string, target: string): Promise<void> {
  assertResourceTarget(root, target)
  await rm(target, { recursive: true, force: true })
  await compileBackend(root, join(target, 'dist'))
}

/** Packaging reuses exactly the checked dev/prepared output, never recompiles it. */
export async function stageBackend(root: string, target: string): Promise<void> {
  assertResourceTarget(root, target)
  // Check before deleting a previous staged resource.
  await readFile(join(root, 'dist/src/index.js'))
  await rm(target, { recursive: true, force: true })
  await cp(join(root, 'dist'), join(target, 'dist'), { recursive: true })
}

function assertResourceTarget(root: string, target: string): void {
  root = resolve(root)
  target = resolve(target)
  const source = join(root, 'dist')
  if (target === root || root.startsWith(target + sep) || target === source
    || source.startsWith(target + sep) || target.startsWith(source + sep)
    || target === join(root, 'src') || target.startsWith(join(root, 'src') + sep)) {
    throw new Error('Bundle output must be separate from the source tree and prepared output')
  }
}

async function copyAssets(source: string, target: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === '__snapshots__' || entry.name === 'testing' || entry.name.endsWith('.ts')) continue
    const from = join(source, entry.name), to = join(target, entry.name)
    if (entry.isDirectory()) await copyAssets(from, to)
    else if (!entry.name.endsWith('.js') || entry.name === 'sdk.js') {
      await mkdir(target, { recursive: true })
      await cp(from, to)
    }
  }
}
