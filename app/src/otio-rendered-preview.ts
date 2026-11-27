import { OTIO_PROFILE_VERSION, type OtioPreviewManifest } from '../../src/shared/otio-effects.ts'
import { resolveOtioMedia } from './otio-review.ts'

export interface RenderedOtioPreview { manifest: OtioPreviewManifest; manifestPath: string; path: string; url: string }
/** Fail closed: the ordinary owner file endpoint remains responsible for authorization and symlinks. */
export function validateOtioPreview(value: unknown, sourceSha256: string | undefined, documentPath: string, duration: number, rate: number): Omit<RenderedOtioPreview, 'url'> {
  const m = value as OtioPreviewManifest
  if (!m || typeof m !== 'object' || m.version !== 1 || m.profileVersion !== OTIO_PROFILE_VERSION) throw new Error('Unsupported composite preview version.')
  if (!sourceSha256 || !/^[a-f0-9]{64}$/.test(m.sourceSha256) || m.sourceSha256 !== sourceSha256) throw new Error('Composite preview is stale. Generate it again for this timeline.')
  if (![m.start, m.end, m.rate, m.frames].every(n => typeof n === 'number' && Number.isFinite(n)) || m.start < 0 || m.end <= m.start || m.end > duration + 1e-8 || m.rate !== rate || !Number.isSafeInteger(m.frames) || m.frames <= 0 || Math.abs((m.end - m.start) * m.rate - m.frames) > 1e-6 || Math.abs(m.start * rate - Math.round(m.start * rate)) > 1e-6) throw new Error('Invalid composite preview interval or frame count.')
  // No absolute paths, URL schemes, escaping encodings, or alternate resource namespaces.
  if (typeof m.media !== 'string' || !/\.mp4$/i.test(m.media) || /[\\%:#?\x00-\x1f\x7f]/.test(m.media) || m.media.startsWith('/') || m.media.split('/').some(p => !p || p === '.')) throw new Error('Unsafe composite preview media path.')
  const manifestPath = `${documentPath}.preview.json`
  const media = resolveOtioMedia(manifestPath, m.media)
  if (!media || media.kind !== 'video') throw new Error('Unsafe composite preview media path.')
  return { manifest: m, manifestPath, path: media.path }
}
export function renderedPreviewPosition(preview: RenderedOtioPreview | null | undefined, seconds: number): number | null {
  return preview && seconds >= preview.manifest.start && seconds < preview.manifest.end ? seconds - preview.manifest.start : null
}
