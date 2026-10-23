import type { WebContents } from 'electron'
import type { RendererTarget } from './renderer-target.js'
import { createNavigationPolicy, isAllowedExternalUrl } from './security-policy.js'

export function installNavigationPolicy(
  webContents: Pick<WebContents, 'on' | 'setWindowOpenHandler'>,
  target: RendererTarget,
  openExternal: (url: string) => Promise<void>,
  onOpenError: (error: unknown) => void,
): void {
  const policy = createNavigationPolicy(target)
  async function openOutside(url: string): Promise<void> {
    if (policy.isAllowed(url) || !isAllowedExternalUrl(url)) return
    try {
      await openExternal(url)
    } catch (error) {
      onOpenError(error)
    }
  }

  webContents.on('will-navigate', (event, url) => {
    if (policy.isAllowed(url)) return
    event.preventDefault()
    void openOutside(url)
  })
  webContents.setWindowOpenHandler(({ url }) => {
    void openOutside(url)
    return { action: 'deny' }
  })
}
