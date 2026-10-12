import { t } from './i18n.ts'
export interface ImagePreview {
  src: string
  name: string
  downloadUrl?: string
  trigger?: HTMLElement
  /** Draft attachment identity and stable original for the annotation dialog. */
  attachmentKey?: string
  localFile?: File
}

export function isPreviewImageUrl(src: string): boolean {
  return /^(?:https?:\/\/|blob:|data:image\/)/i.test(src)
}

/** Called after sanitization; only adds keyboard affordances to existing images. */
export function imagePreviewMarkup(html: string): string {
  if (!html.includes('<img')) return html
  const template = document.createElement('template')
  template.innerHTML = html
  for (const image of template.content.querySelectorAll('img')) {
    if (!image.getAttribute('src')) continue
    const anchor = image.closest('a')
    const trigger = anchor && anchor.children.length === 1 && !anchor.textContent?.trim() ? anchor : image
    if (anchor && trigger === image) continue
    if (!anchor) {
      image.tabIndex = 0
      image.setAttribute('role', 'button')
    }
    trigger.setAttribute('aria-haspopup', 'dialog')
    trigger.setAttribute('aria-label', `View image: ${image.alt || 'Image'}`)
    trigger.setAttribute('data-image-preview', '')
  }
  return template.innerHTML
}

export function imagePreviewFromEvent(event: MouseEvent | KeyboardEvent): ImagePreview | undefined {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
  if (event instanceof KeyboardEvent) {
    if (event.key !== 'Enter' && event.key !== ' ') return
  } else if (event.button !== 0) return
  const target = event.target
  if (!(target instanceof Element)) return
  const trigger = target.closest<HTMLElement>('[data-image-preview]')
  if (!trigger) return
  const image = trigger instanceof HTMLImageElement ? trigger : trigger.querySelector('img')
  if (!image?.getAttribute('src')) return
  const src = image.currentSrc || image.src
  if (!isPreviewImageUrl(src)) return
  return { src, name: image.alt || t('Image'), trigger }
}
