import type { PowerMonitor } from 'electron'
import type { WindowControlTarget, WindowControlsIpc } from './window-controls.js'

export const PRESENCE_CHANNEL = 'shadow:presence:system'
export interface SystemPresence { idleSeconds: number; locked: boolean | null }
export interface DesktopPresenceApi { system(): Promise<SystemPresence> }

/** Only coarse OS state. Never register global input hooks or read key contents. */
export function installPresence(ipc: WindowControlsIpc, window: Pick<WindowControlTarget, 'webContents' | 'isDestroyed' | 'once'>,
  monitor: Pick<PowerMonitor, 'getSystemIdleTime' | 'getSystemIdleState' | 'on' | 'removeListener'>, platform = process.platform): () => void {
  // No invented startup unlock: use the idle-state query until a lock event is known.
  let locked: boolean | null = null
  const lock = () => { locked = true }
  const unlock = () => { locked = false }
  monitor.on('lock-screen', lock)
  monitor.on('unlock-screen', unlock)
  ipc.handle(PRESENCE_CHANNEL, (event, ...args) => {
    if (args.length || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) throw new TypeError('Presence requires the owning window')
    const idleSeconds = monitor.getSystemIdleTime()
    const state = monitor.getSystemIdleState(120)
    const currentLock = locked ?? (state === 'locked' ? true : state === 'active' || state === 'idle' ? false : null)
    return { idleSeconds, locked: platform === 'darwin' || platform === 'win32' ? currentLock : null }
  })
  const dispose = () => {
    ipc.removeHandler(PRESENCE_CHANNEL)
    monitor.removeListener('lock-screen', lock)
    monitor.removeListener('unlock-screen', unlock)
  }
  window.once('closed', dispose)
  return dispose
}
