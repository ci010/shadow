import type { ImageAlignmentDocument } from './image-alignment.ts'

export interface LibraryImage {
  id: string
  file: File
  url: string
  prompt: string
  keywords: string[]
  demo: boolean
  visited: boolean
  applied?: ImageAlignmentDocument
  candidateUrl?: string
}
export function parseKeywords(value: string): string[] {
  return [...new Set(value.split(/[,，\n]/).map(word => word.trim()).filter(Boolean))]
}
export function imagePromptExport(image: Pick<LibraryImage, 'file' | 'prompt' | 'keywords' | 'demo'>): string {
  return JSON.stringify({ image: image.file.name, provenance: image.demo ? 'synthetic-demo' : 'manually-entered', prompt: image.prompt, keywords: image.keywords }, null, 2)
}
export function releaseLibraryImage(image: LibraryImage, revoke = URL.revokeObjectURL): void {
  revoke(image.url)
  if (image.candidateUrl) revoke(image.candidateUrl)
}
