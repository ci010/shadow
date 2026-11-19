import { withinMediaDuration } from './otio-monitor.ts'

function waitFor(target: HTMLMediaElement | HTMLImageElement, name: string, signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const clean = () => {
      target.removeEventListener(name, ready); target.removeEventListener('error', fail)
      signal.removeEventListener('abort', abort)
    }
    const ready = () => { clean(); resolve() }
    const fail = () => { clean(); reject(new Error('Picture unavailable')) }
    const abort = () => { clean(); reject(signal.reason) }
    target.addEventListener(name, ready); target.addEventListener('error', fail)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Work is owned by one visible card, using only the already-resolved viewer media URL. */
export async function drawStoryboardPicture(canvas: HTMLCanvasElement, url: string, kind: 'video' | 'image', position: number, cancelled: AbortSignal) {
  const signal = AbortSignal.any([cancelled, AbortSignal.timeout(8000)])
  const width = 320, height = 180
  canvas.width = width; canvas.height = height
  const draw = (source: CanvasImageSource, w: number, h: number) => {
    signal.throwIfAborted()
    const ctx = canvas.getContext('2d')
    if (!ctx || !w || !h) throw new Error('Picture unavailable')
    const scale = Math.min(width / w, height / h)
    const dw = w * scale, dh = h * scale
    ctx.drawImage(source, (width - dw) / 2, (height - dh) / 2, dw, dh)
    // Do not display pixels that the monitor's authorized request could not read.
    ctx.getImageData(0, 0, 1, 1)
  }
  if (kind === 'image') {
    const image = new Image()
    image.crossOrigin = 'anonymous'; image.referrerPolicy = 'no-referrer'
    try {
      const ready = waitFor(image, 'load', signal)
      image.src = url
      await ready
      draw(image, image.naturalWidth, image.naturalHeight)
    } finally { image.removeAttribute('src') }
    return
  }
  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'; video.muted = true; video.preload = 'auto'; video.playsInline = true
  try {
    const metadata = waitFor(video, 'loadedmetadata', signal)
    video.src = url
    await metadata
    if (!withinMediaDuration(position, video.duration)) throw new Error('Picture unavailable')
    if (position !== video.currentTime) {
      const seek = waitFor(video, 'seeked', signal)
      video.currentTime = position
      await seek
    }
    if (video.readyState < 2) await waitFor(video, 'loadeddata', signal)
    draw(video, video.videoWidth, video.videoHeight)
  } finally { video.removeAttribute('src'); video.load() }
}

const waiting = new Map<AbortSignal, () => void>()
let running = 0
function pump() {
  while (running < 2 && waiting.size) {
    const [signal, run] = waiting.entries().next().value!
    waiting.delete(signal)
    if (!signal.aborted) run()
  }
}
export function queueStoryboardPicture(signal: AbortSignal, draw: () => Promise<void>) {
  if (signal.aborted) return
  const cancel = () => waiting.delete(signal)
  signal.addEventListener('abort', cancel, { once: true })
  waiting.set(signal, () => {
    signal.removeEventListener('abort', cancel)
    running++
    void draw().finally(() => { running--; pump() })
  })
  pump()
}
