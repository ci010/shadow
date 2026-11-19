import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function buildDevelopmentBackend(root: string, stage: string, node: string, pnpm: string): Promise<void> {
  const args = ['build', '--development', '--desktop-stage', stage]
  const script = /\.(?:cjs|mjs|js)$/i.test(pnpm)
  return new Promise((resolve, reject) => {
    const child = spawn(script ? node : pnpm, script ? [pnpm, ...args] : args, {
      cwd: root, stdio: 'inherit', shell: false,
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`pnpm build failed (${signal ?? code})`))
    })
  })
}

/** A generation is private until the build succeeds and the old process has stopped. */
export class DevelopmentBackendRestart {
  private attempt: Promise<void> | undefined
  private activeStage: string | undefined
  private closing = false

  constructor(
    private readonly build: (stage: string) => Promise<void>,
    private readonly replace: (entry: string, activate: () => void) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  request(): Promise<void> | undefined {
    if (this.closing) return undefined
    return this.attempt ??= this.run().catch(error => {
      if (!this.closing) this.onError(error)
    }).finally(() => { this.attempt = undefined })
  }

  async close(stop: () => Promise<void>): Promise<void> {
    this.closing = true
    await this.attempt
    await stop()
    if (this.activeStage) await this.remove(this.activeStage)
  }

  private async run(): Promise<void> {
    const stage = await mkdtemp(join(tmpdir(), 'shadow-dev-backend-'))
    const previous = this.activeStage
    try {
      if (this.closing) return
      await this.build(stage)
      if (!this.closing) await this.replace(join(stage, 'dist', 'src', 'index.js'), () => { this.activeStage = stage })
    } finally {
      if (this.activeStage !== stage) await this.remove(stage)
      else if (previous) await this.remove(previous)
    }
  }

  private async remove(stage: string): Promise<void> {
    await rm(stage, { recursive: true, force: true }).catch(error => {
      console.warn('[desktop] Could not remove a staged development backend:', error)
    })
  }
}
