import { writeFile } from 'node:fs/promises'
import { initialTimeline, plan, render, revisionOf } from './index.ts'
export async function runVideoCli(args: string[], options: { signal?: AbortSignal } = {}) {
  const [command, file, ...rest] = args
  if (!command || command === '--help') return { usage: 'project-video init FILE [--duration 5 --rate 24] | validate/plan FILE | preview/export FILE --output FILE.mp4 --revision SHA256 [--start SECONDS --end SECONDS --width N --height N --ffmpeg PATH --ffprobe PATH]', security: 'Runs on this execution device with caller filesystem authority; local files only. No remote-to-Main mapping, no downloads or installs.', limitations: 'Opaque highest Video track wins (not alpha compositing); enabled Audio tracks mix additively without normalization, otherwise visible video embedded audio. Effects/transitions rejected. Video cuts must be frame-aligned. Three shots must be pre-rendered to media.' }
  if (!file || file.startsWith('--')) throw new Error('Missing OTIO filename; use --help')
  const flags = new Map<string, string>()
  const allowed: Record<string, string[]> = { init: ['duration', 'rate'], plan: ['ffprobe'], validate: ['ffprobe'], preview: ['output', 'revision', 'start', 'end', 'width', 'height', 'ffmpeg', 'ffprobe'], export: ['output', 'revision', 'start', 'end', 'width', 'height', 'ffmpeg', 'ffprobe'] }
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
  if (command === 'init') {
    const text = JSON.stringify(initialTimeline(number('duration', 5), number('rate', 24)), null, 2) + '\n'
    options.signal?.throwIfAborted()
    await writeFile(file, text, { flag: 'wx' })
    return { file, revision: revisionOf(text) }
  }
  const common = { ...options, ffprobe: flags.get('ffprobe'), ffmpeg: flags.get('ffmpeg') }
  if (command === 'validate' || command === 'plan') {
    const p = await plan(file, common)
    return { revision: p.revision, duration: p.duration, rate: p.rate, pictures: p.pictures, audio: p.audio, audioPolicy: p.audioPolicy, assets: p.assets }
  }
  if (!flags.has('output') || !flags.has('revision')) throw new Error('--output and --revision are required; run plan first')
  if (command === 'preview' && (!flags.has('start') || !flags.has('end'))) throw new Error('preview requires explicit --start and --end interval')
  return await render(file, flags.get('output')!, { ...common, revision: flags.get('revision')!, start: number('start'), end: number('end'), width: number('width', command === 'preview' ? 640 : 1280), height: number('height', command === 'preview' ? 360 : 720) })
}
