import { IPC_CHANNELS } from './ipc-contract.js'
import { requireLaunchToken, requireLoopbackOrigin } from './control/connection.js'
import type { RuntimeAuthorization } from './runtime-authorization.js'
import { parseDesktopWebPairing, type DesktopWebPairing } from './web-pairing-contract.js'
import type { WindowControlTarget, WindowControlsIpc } from './window-controls.js'

type PairingWindow = Pick<WindowControlTarget, 'isDestroyed' | 'once' | 'removeListener'> & {
  readonly webContents: Pick<WindowControlTarget['webContents'], 'mainFrame' | 'isDestroyed'>
}

async function requestPairing(authorization: RuntimeAuthorization, signal: AbortSignal, request: typeof fetch): Promise<DesktopWebPairing> {
  try {
    const origin = requireLoopbackOrigin(authorization.apiBase)
    const token = requireLaunchToken(authorization.launchToken)
    const response = await request(`${origin}/local/v1/web-pairing`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal,
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error('Pairing unavailable')
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        length += part.value.byteLength
        if (length > 4096) throw new Error('Pairing response too large')
        chunks.push(part.value)
      }
    } finally { await reader.cancel() }
    const result = parseDesktopWebPairing(JSON.parse(Buffer.concat(chunks).toString('utf8')), origin)
    if (result.code.includes(token)) throw new Error('Invalid pairing code')
    return result
  } catch {
    throw new Error('Could not generate a pairing code. Check that Main is running, then retry.')
  }
}

export function installWebPairing(
  ipc: WindowControlsIpc,
  window: PairingWindow,
  authorization: () => RuntimeAuthorization | null,
  request: typeof fetch = fetch,
): () => void {
  const lifetime = new AbortController()
  let pending = false
  ipc.handle(IPC_CHANNELS.createWebPairing, async (event, ...args) => {
    if (lifetime.signal.aborted || window.isDestroyed() || window.webContents.isDestroyed()
      || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new TypeError('Browser pairing requires the Main window')
    }
    if (args.length) throw new TypeError('Browser pairing accepts no arguments')
    const current = authorization()
    if (!current) throw new Error('Main is not ready. Wait for it to start, then retry.')
    if (pending) throw new Error('A pairing code is already being generated.')
    pending = true
    try {
      const result = await requestPairing(current, AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]), request)
      if (lifetime.signal.aborted || authorization() !== current) throw new Error('Main changed. Generate a new pairing code.')
      return result
    } finally { pending = false }
  })
  const dispose = () => {
    if (lifetime.signal.aborted) return
    lifetime.abort()
    ipc.removeHandler(IPC_CHANNELS.createWebPairing)
    window.removeListener('closed', dispose)
  }
  window.once('closed', dispose)
  return dispose
}
