import type { ShadowDesktopApi } from './desktop-bootstrap.ts'

export function observeDesktopWindow(
  controls: NonNullable<ShadowDesktopApi['windowControls']>,
  changed: (maximized: boolean) => void,
  failed: () => void,
): () => void {
  let disposed = false
  let revision = 0
  const unsubscribe = controls.onStateChanged((state) => {
    revision++
    if (!disposed) changed(state.maximized)
  })
  void controls.getState().then((state) => {
    if (!disposed && revision === 0) changed(state.maximized)
  }).catch(() => { if (!disposed) failed() })
  return () => { disposed = true; unsubscribe() }
}
