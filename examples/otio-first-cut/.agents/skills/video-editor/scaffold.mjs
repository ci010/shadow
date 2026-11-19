// Run from the intended workspace with Node; no packages, network access or media generation.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const help = 'Usage: node .agents/skills/video-editor/scaffold.mjs "new-folder-name"\nCreates a NEW child of the current directory. Existing files or directories are never reused.'
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--help') {
  console.log(help)
} else {
  try { await scaffold(args) }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}

async function scaffold(args) {
  const [name] = args
  // One portable leaf, not a path. Avoid Windows reserved names even when running on another OS.
  if (args.length !== 1 || name.length > 64 || !/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(name) || name !== name.trim()
      || /^(?:aux|con|nul|prn|com[0-9¹²³]|lpt[0-9¹²³])$/i.test(name)) throw new Error(help)
  const root = join(process.cwd(), name)
  try { await mkdir(root) } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`Already exists; nothing was changed: ${root}`)
    throw error
  }
  const rate = 24
  const time = value => ({ OTIO_SCHEMA: 'RationalTime.1', value, rate })
  const slots = [['01 · 建立场景', 48], ['02 · 主镜头', 96], ['03 · 收束', 48]]
  const item = (schema, name, extra) => ({ OTIO_SCHEMA: schema, name, metadata: {}, source_range: null, effects: [], markers: [], enabled: true, ...extra })
  const children = slots.map(([name, frames]) => item('Gap.1', name, {
    source_range: { OTIO_SCHEMA: 'TimeRange.1', start_time: time(0), duration: time(frames) },
  }))
  const timeline = { OTIO_SCHEMA: 'Timeline.1', name, metadata: {}, global_start_time: time(0),
    tracks: item('Stack.1', name, { children: [item('Track.1', 'V1 · 画面', { kind: 'Video', children })] }),
  }
  try {
    await mkdir(join(root, 'media'))
    await writeFile(join(root, 'cut-v001.otio'), JSON.stringify(timeline, null, 2) + '\n', { flag: 'wx' })
    await writeFile(join(root, 'shots.md'), `# ${name} · 分镜\n\n一句话写下你想拍什么：\n\n| 镜头 | 粗剪预留 | 想看到的画面 | 已有素材 |\n| --- | --- | --- | --- |\n| 01 建立场景 | 2 秒 | | |\n| 02 主镜头 | 4 秒 | | |\n| 03 收束 | 2 秒 | | |\n\n打开 cut-v001.otio 可以选中这三个占位；它们是 Gap，还没有画面。先选一个镜头，说清想用哪个素材、从哪里开始、保留多长。请 AI 将第一版有画面的粗剪另存为 cut-v002.otio，原片不动。\n`, { flag: 'wx' })
  } catch (error) {
    throw new Error(`Scaffold incomplete at ${root}; created files were left in place. ${error.message}`)
  }
  console.log(`${join(root, 'cut-v001.otio')}\n24 fps · 8 s · 3 planned shots (gaps), no linked media. Start with shots.md.`)
}
