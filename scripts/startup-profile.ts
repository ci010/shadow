import { unlinkSync } from 'node:fs'
import { resolve } from 'node:path'

/** Dev-only, one-shot arming. Builds and tests do not consume the marker. */
export function consumeStartupProfileArm(root: string, environment: NodeJS.ProcessEnv): string | undefined {
  if (environment.SHADOW_STARTUP_PROFILE === '0') return undefined
  try {
    unlinkSync(resolve(root, '.logs/startup-profile.arm'))
    return resolve(root, '.logs/startup-profiles')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
}
