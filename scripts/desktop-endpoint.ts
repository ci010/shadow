import type { ChildProcess } from 'node:child_process'
import { parseRuntimeEndpointMessage } from '../desktop/src/control/runtime-endpoint.ts'

export function forwardDesktopEndpoint(electron: ChildProcess, vite: ChildProcess): void {
  const forward = (value: unknown) => {
    const message = parseRuntimeEndpointMessage(value)
    if (message && vite.connected) vite.send(message, () => {})
  }
  electron.on('message', forward)
  const disconnected = () => forward({ type: 'shadow:runtime-stopped' })
  electron.once('exit', () => {
    electron.off('message', forward)
    electron.off('disconnect', disconnected)
    forward({ type: 'shadow:runtime-stopped' })
  })
  electron.once('disconnect', disconnected)
}
