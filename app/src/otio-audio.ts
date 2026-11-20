import type { OtioModel, OtioNode } from './otio-model.ts'
import { mediaPosition } from './otio-review.ts'

export function otioAudioTracks(model: OtioModel) {
  const tracks = new Map<string, string>()
  const clips: { node: OtioNode; track: string }[] = []
  let explicit = false
  for (const node of model.nodes) {
    const parent = node.parentId === null ? undefined : tracks.get(node.parentId)
    const track = node.kind === 'Track' && node.trackKind === 'Audio' ? node.id : parent
    if (!track) continue
    tracks.set(node.id, track)
    if (node.id === track) explicit = true
    if (node.kind === 'Clip' && node.enabled && node.sourceStart && node.targetUrl) clips.push({ node, track })
  }
  return { explicit, clips }
}

export interface OtioAudioVoice { id: string; url: string; seconds: number }

export function createOtioAudio(makeMedia: () => HTMLAudioElement = () => new Audio()) {
  const live = new Map<string, { media: HTMLAudioElement; url: string; seconds: number; attempted: boolean }>()
  function sync(voices: readonly OtioAudioVoice[]) {
    const next = new Map(voices.map(voice => [voice.id, voice]))
    for (const [id, voice] of live) {
      if (next.get(id)?.url === voice.url) continue
      live.delete(id)
      voice.media.onloadedmetadata = null
      voice.media.pause()
      voice.media.removeAttribute('src')
      voice.media.load()
    }
    for (const { id, url, seconds } of voices) {
      let voice = live.get(id)
      if (!voice) {
        const media = makeMedia()
        const entry = { media, url, seconds, attempted: false }
        live.set(id, entry)
        media.preload = 'auto'
        media.onloadedmetadata = () => {
          if (live.get(id) === entry) update(entry)
        }
        media.src = url
        voice = entry
      }
      voice.seconds = seconds
      update(voice)
    }
  }
  function update(voice: { media: HTMLAudioElement; seconds: number; attempted: boolean }) {
    const { media, seconds } = voice
    if (media.readyState < 1) return
    if (seconds >= media.duration) { media.pause(); return }
    if (!voice.attempted || Math.abs(media.currentTime - seconds) > 0.18) media.currentTime = seconds
    if (!voice.attempted) {
      voice.attempted = true
      void media.play().catch(() => { /* Browser policy or unsupported media; do not retry every frame. */ })
    }
  }
  return { sync, stop: () => sync([]) }
}

export function otioAudioPosition(node: OtioNode, seconds: number) {
  const position = mediaPosition(node, seconds)
  return position !== null && position >= 0 ? position : null
}
