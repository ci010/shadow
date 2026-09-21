import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'

export function runPnpm(args: string[]): Promise<void> {
  const { command, commandArgs } = pnpmInvocation(process.env.npm_execpath, args)
  const child = spawn(command, commandArgs, { stdio: 'inherit', shell: false })
  return waitForExit(child).then((code) => {
    if (code !== 0) throw new Error(`pnpm ${args.join(' ')} exited with code ${code}`)
  })
}

export function pnpmInvocation(cli: string | undefined, args: readonly string[]) {
  if (!cli) throw new Error('Run this script through pnpm.')
  // pnpm 12 ships extensionless native executables on macOS and Linux.
  const nodeScript = /\.(?:cjs|mjs|js)$/i.test(cli)
  return {
    command: nodeScript ? process.execPath : cli,
    commandArgs: nodeScript ? [cli, ...args] : [...args],
  }
}

export function startNode(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): ChildProcess {
  return spawn(process.execPath, args, {
    cwd: options.cwd,
    stdio: 'inherit',
    env: { ...process.env, ...options.env },
    shell: false,
  })
}

export async function waitForExit(child: ChildProcess): Promise<number> {
  if (child.exitCode !== null) return child.exitCode
  if (child.signalCode !== null) return 1
  const [code, signal] = await once(child, 'exit')
  return typeof code === 'number' ? code : signal ? 1 : 0
}

export function manageChildren(children: ChildProcess[]) {
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    stopping ??= Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
      try {
        await exited
      } finally {
        clearTimeout(timeout)
      }
    })).then(() => undefined)
    return stopping
  }
  const onSignal = () => { void stop() }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  return {
    stop,
    async wait() {
      try {
        const code = await Promise.race(children.map(waitForExit))
        if (!stopping) process.exitCode = code
      } finally {
        await stop()
        process.off('SIGINT', onSignal)
        process.off('SIGTERM', onSignal)
      }
    },
  }
}
