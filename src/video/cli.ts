import { writeFile, open, rm } from 'node:fs/promises'
import path from 'node:path'
import { assertLocalPath } from './media-profile.ts'
import type { OtioPreviewManifest } from '../shared/otio-effects.ts'
import { initialTimeline, plan, render, revisionOf } from './index.ts'
export async function runVideoCli(args: string[], options: { signal?: AbortSignal } = {}) {
  const [command, file, ...rest] = args
  if (!command || command === '--help') return { usage: 'project-video init FILE [--duration 5 --rate 24] | validate/plan FILE [--ffmpeg PATH --ffprobe PATH] | preview/export FILE --output FILE.mp4 --revision SHA256 [--start SECONDS --end SECONDS --width N --height N --ffmpeg PATH --ffprobe PATH] [preview only: --manifest NEW.json]', security: 'Runs on this execution device with caller filesystem authority; local files only. No remote-to-Main mapping, no downloads or installs.', limitations: 'Video tracks alpha composite bottom to top. Strict shadow effects and SMPTE_Dissolve/Custom wiperight only. Audio tracks mix additively; absent Audio tracks use visible video embedded audio. Video cuts must be frame-aligned. Three shots must be pre-rendered to media.' }
  if (!file || file.startsWith('--')) throw new Error('Missing OTIO filename; use --help')
  const flags = new Map<string, string>()
  const allowed: Record<string, string[]> = { init: ['duration', 'rate'], plan: ['ffmpeg', 'ffprobe'], validate: ['ffmpeg', 'ffprobe'], preview: ['manifest', 'output', 'revision', 'start', 'end', 'width', 'height', 'ffmpeg', 'ffprobe'], export: ['output', 'revision', 'start', 'end', 'width', 'height', 'ffmpeg', 'ffprobe'] }
  if (!allowed[command]) throw new Error(`Unknown command: ${command}`)
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!.replace(/^--/, ''), value = rest[i+1]
    if (!rest[i]!.startsWith('--') || !allowed[command]!.includes(key) || !value || value.startsWith('--') || flags.has(key)) throw new Error(`Invalid/duplicate option: ${rest[i]}`)
    flags.set(key, value)
  }
  const number = (key: string, fallback?: number) => {
    if (!flags.has(key)) return fallback
    const n = Number(flags.get(key)); if (!Number.isFinite(n)) throw new Error(`Invalid --${key}`); return n
  }
  assertLocalPath(file)
  const manifest = flags.get('manifest')
  if (manifest) assertLocalPath(manifest)
  if (flags.has('output')) assertLocalPath(flags.get('output')!)
  if (command === 'init') {
    const text = JSON.stringify(initialTimeline(number('duration', 5), number('rate', 24)), null, 2) + '\n'
    options.signal?.throwIfAborted()
    await writeFile(file, text, { flag: 'wx' })
    return { file, revision: revisionOf(text) }
  }
  const common = { ...options, ffprobe: flags.get('ffprobe'), ffmpeg: flags.get('ffmpeg') }
  if (command === 'validate' || command === 'plan') {
    const p = await plan(file, common)
    return { profileVersion: 1, requiresCompositePreview: p.profile.requiresCompositePreview, diagnostics: p.profile.diagnostics, effects: p.profile.effects, transitions: p.profile.transitions, revision: p.revision, duration: p.duration, rate: p.rate, pictures: p.pictures, audio: p.audio, audioPolicy: p.audioPolicy, assets: p.assets }
  }
  if (!flags.has('output') || !flags.has('revision')) throw new Error('--output and --revision are required; run plan first')
  if (command === 'preview' && (!flags.has('start') || !flags.has('end'))) throw new Error('preview requires explicit --start and --end interval')
  if (manifest && path.extname(manifest).toLowerCase() !== '.json') throw new Error('--manifest must use .json')
  const result = await render(file, flags.get('output')!, { ...common, revision: flags.get('revision')!, start: number('start'), end: number('end'), width: number('width', command === 'preview' ? 640 : 1280), height: number('height', command === 'preview' ? 360 : 720) })
  if (!manifest) return result
  const receipt: OtioPreviewManifest = { version: 1, profileVersion: 1, sourceSha256: result.revision, media: path.relative(path.dirname(path.resolve(manifest)), result.output).split(path.sep).join('/'), start: result.start, end: result.end, rate: result.rate, frames: result.frames }
  let created = false
  try {
    options.signal?.throwIfAborted()
    const handle = await open(manifest, 'wx')
    created = true
    try { await handle.writeFile(JSON.stringify(receipt, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
  } catch (error) {
    if (created) await rm(manifest, { force: true })
    throw new Error(`Preview video retained at ${result.output}, but manifest failed: ${String(error)}`)
  }
  return { ...result, manifest: path.resolve(manifest) }
}
