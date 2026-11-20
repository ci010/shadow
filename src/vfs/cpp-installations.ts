import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { isNotFoundError } from '../utils/runtime.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { VirtualFs } from './virtual-fs.ts'

const runtime = z.enum(['audio-cpp', 'diffusion-cpp'])
const text = z.string().trim().min(1).max(2048)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
// Device paths are metadata, never resolved or opened by Main. Reject drive-relative
// and single-backslash Windows paths, which depend on a working directory/drive.
const absolute = text.refine(path => !/[\u0000-\u001f]/.test(path) &&
  (/^\/(?!\/)/.test(path) || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(path)),
'Expected an absolute device path')
const artifact = z.object({
  path: absolute,
  source: text.nullable(),
  expectedSha256: digest.nullable(),
  observedSha256: digest,
}).strict()
const record = z.object({
  schemaVersion: z.literal(1),
  projectId: text,
  node: z.object({ kind: z.enum(['local', 'child']), id: text }).strict(),
  runtime,
  binary: artifact.extend({ version: text }),
  weights: z.array(artifact.extend({ role: text })).max(128),
}).strict()

export function mountCppInstallations(vfs: VirtualFs, projectHome: string, projectId: string, localNodeId: string) {
  const root = join(projectHome, 'cpp-installations')
  function node(context: ExecutionContext) {
    context.signal.throwIfAborted()
    if (context.projectId !== projectId || context.layerfsWorkdir) {
      throw new Error('CPP installations require the owning Project and a device execution scope.')
    }
    const child = context.remoteWorkdir?.nodeId
    return child === undefined ? { kind: 'local', id: localNodeId } : { kind: 'child', id: child }
  }
  function scope(path: string, context: ExecutionContext) {
    const target = node(context)
    const name = runtime.parse(path)
    const key = createHash('sha256').update(JSON.stringify(target)).digest('hex')
    return { target, name, file: join(root, `${key}-${name}.json`) }
  }
  function validate(content: string, selected: ReturnType<typeof scope>) {
    if (Buffer.byteLength(content) > 256 * 1024) throw new Error('CPP installation record exceeds 256 KiB.')
    const value = record.parse(JSON.parse(content))
    if (value.projectId !== projectId || value.node.kind !== selected.target.kind ||
        value.node.id !== selected.target.id || value.runtime !== selected.name) {
      throw new Error('CPP installation record does not match the selected Project, device or runtime.')
    }
    return value
  }
  const read = async (path: string, context: ExecutionContext) => {
    const target = node(context)
    if (!path) return `CPP installation inventory for ${JSON.stringify(target)}. Read v:cpp-installations/audio-cpp or v:cpp-installations/diffusion-cpp.`
    const selected = scope(path, context)
    let content: string
    try { content = await readFile(selected.file, { encoding: 'utf8', signal: context.signal }) }
    catch (error) {
      if (!isNotFoundError(error)) throw error
      return JSON.stringify({ schemaVersion: 1, projectId, node: target, runtime: selected.name, installed: false }, null, 2)
    }
    return JSON.stringify(validate(content, selected), null, 2)
  }
  vfs.mount('v:cpp-installations', 'Project inventory for audio.cpp and stable-diffusion.cpp on the selected execution device', read,
    async (context, options) => {
      node(context)
      return await Promise.all(runtime.options.filter(name => !options?.subpath || options.subpath === name)
        .map(async name => ({ name, content: options?.content === false ? '' : await read(name, context) })))
    }, async (path, request, context) => {
      const selected = scope(path, context)
      if (request.match !== undefined || request.replaceAll) throw new Error('Write the complete CPP installation JSON record.')
      const value = validate(request.content, selected)
      await mkdir(root, { recursive: true, mode: 0o700 })
      const temporary = join(root, `${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600, signal: context.signal })
        context.signal.throwIfAborted()
        await rename(temporary, selected.file)
      } finally {
        await rm(temporary, { force: true })
      }
      return `Saved v:cpp-installations/${selected.name} for ${JSON.stringify(selected.target)}.`
    })
}
