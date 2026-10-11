import type { ChildProcess } from 'node:child_process'
import { isDevelopmentRestartMessage } from '../desktop/src/development-restart.ts'
import { forwardDesktopEndpoint } from './desktop-endpoint.ts'

/** Owns Vite, every Electron generation, and rebuild subprocesses until shutdown. */
export function superviseDesktopDevelopment(options: {
  vite: ChildProcess
  ready: (signal: AbortSignal) => Promise<void>
  spawnElectron: () => ChildProcess
  spawnBuild: (args: string[]) => ChildProcess
  signals?: NodeJS.Process
}) {
  const signals = options.signals ?? process
  const startupAbort = new AbortController()
  const owned = new Map<ChildProcess, Promise<number>>()
  let stopped = false
  let killTimeout: ReturnType<typeof setTimeout> | undefined
  let failure: Error | undefined
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  const track = (child: ChildProcess): Promise<number> => {
    const exit = new Promise<number>(resolve => {
      child.once('error', error => { failure ??= error; stop(); resolve(1) })
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
    })
    owned.set(child, exit)
    void exit.then(() => owned.delete(child))
    return exit
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    startupAbort.abort()
    for (const child of owned.keys()) child.kill('SIGTERM')
    killTimeout = setTimeout(() => {
      for (const child of owned.keys()) child.kill('SIGKILL')
    }, 5_000)
    finish()
  }
  signals.once('SIGINT', stop)
  signals.once('SIGTERM', stop)
  void track(options.vite).then(code => {
    if (!stopped) { signals.exitCode = code; stop() }
  })
  const run = async () => {
    try {
      await Promise.race([options.ready(startupAbort.signal), done])
      while (!stopped) {
        const electron = options.spawnElectron()
        const exited = track(electron)
        let restart = false
        let restartTimeout: ReturnType<typeof setTimeout> | undefined
        const request = (value: unknown) => {
          if (!stopped && !restart && electron.connected && isDevelopmentRestartMessage(value)) {
            restart = true
            restartTimeout = setTimeout(() => {
              failure ??= new Error('Development restart: Electron did not finish graceful shutdown within 30 seconds')
              stop()
            }, 30_000)
          }
        }
        electron.on('message', request)
        forwardDesktopEndpoint(electron, options.vite)
        const code = await exited
        if (restartTimeout) clearTimeout(restartTimeout)
        electron.off('message', request)
        if (stopped) break
        if (!restart || code !== 0) { signals.exitCode = code; stop(); break }
        // Exit is required before rebuilding: backend has stopped and the single-instance lock is free.
        for (const args of [['build'], ['--filter', '@shadow/desktop', 'build']]) {
          if (stopped) break
          const code = await track(options.spawnBuild(args))
          if (!stopped && code !== 0) throw new Error(`Development restart: pnpm ${args.join(' ')} exited with code ${code}`)
        }
      }
      if (failure) throw failure
    } finally {
      stop()
      try { await Promise.all(owned.values()) } finally {
        if (killTimeout) clearTimeout(killTimeout)
        signals.off('SIGINT', stop)
        signals.off('SIGTERM', stop)
      }
    }
  }
  return { run, stop }
}
