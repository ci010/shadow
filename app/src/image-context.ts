export interface ImageSource {
  path: string
  modified: boolean
}

export function imageSourcePath(headers: Pick<Headers, 'get'>): string {
  const encoded = headers.get('X-Shadow-Source-Path')
  if (!encoded) throw new Error('The image source is unavailable. Restart Main and reopen the image before attaching it.')
  let path: string
  try {
    path = decodeURIComponent(encoded)
  } catch {
    throw new Error('The image source path is invalid. Reopen the image to retry.')
  }
  if (!/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/i.test(path) || path.includes('\0')) {
    throw new Error('The image source path is invalid. Reopen the image to retry.')
  }
  return path
}

export interface ImageContextUpdate {
  contextKey: string
  sourceKey: string
  file: File | null
  source?: ImageSource
}

export interface ImageContextBusy {
  contextKey: string
  sourceKey: string
  busy: boolean
}

export interface ImageReference {
  sourceKey: string
  file: File
  source: ImageSource
}

export const IMAGE_REFERENCE_MIME = 'application/x-shadow-image-reference'
const references = new Map<string, ImageReference>()

/** Transfer only an in-memory image owned by this renderer, never an arbitrary URL. */
export function startImageReferenceDrag(data: Pick<DataTransfer, 'setData' | 'effectAllowed'>, reference: ImageReference): () => void {
  const token = crypto.randomUUID()
  data.setData(IMAGE_REFERENCE_MIME, token)
  data.effectAllowed = 'copy'
  references.set(token, reference)
  return () => { references.delete(token) }
}

export function hasImageReference(data: Pick<DataTransfer, 'types'> | null): boolean {
  return !!data && Array.from(data.types).includes(IMAGE_REFERENCE_MIME)
}

export function readImageReference(data: Pick<DataTransfer, 'types' | 'getData'> | null): ImageReference | undefined {
  if (!data || !hasImageReference(data)) return
  const reference = references.get(data.getData(IMAGE_REFERENCE_MIME))
  if (!reference) throw new Error('This image reference is no longer available. Drag the image again.')
  return reference
}
