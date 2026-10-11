export const DEVELOPMENT_RESTART_MESSAGE = { type: 'shadow:dev-restart' } as const

export function isDevelopmentRestartMessage(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1
    && (value as Record<string, unknown>).type === DEVELOPMENT_RESTART_MESSAGE.type
}

/** Only the pnpm dev supervisor can restart the main process safely. */
export function createDevelopmentRestart(
  packaged: boolean,
  channel: {
    env: NodeJS.ProcessEnv
    connected?: boolean
    send?: (message: typeof DEVELOPMENT_RESTART_MESSAGE, callback: (error: Error | null) => void) => unknown
  },
  quit: () => void,
  onError: (error: Error) => void,
): (() => void) | undefined {
  if (packaged || channel.env.SHADOW_DESKTOP_DEV_IPC !== '1' || !channel.connected || !channel.send) return undefined
  let requested = false
  return () => {
    if (requested || !channel.connected) return
    requested = true
    try {
      channel.send!(DEVELOPMENT_RESTART_MESSAGE, error => {
        if (error) { requested = false; onError(error) }
        else quit() // Existing before-quit lifecycle stops the backend before exiting.
      })
    } catch (error) {
      requested = false
      onError(error instanceof Error ? error : new Error(String(error)))
    }
  }
}
