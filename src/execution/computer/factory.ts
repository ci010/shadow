import { AgentDesktopComputerDesktop } from './agent-desktop.ts'
import type { ComputerDesktop } from './contracts.ts'
import { WindowsComputerDesktop } from './windows.ts'

/** Host configuration only; this is not a tool-controlled setting or a grant. */
export function createComputerDesktop(env: { SHADOW_COMPUTER_BACKEND?: string } = process.env): ComputerDesktop {
  const backend = env.SHADOW_COMPUTER_BACKEND
  if (backend === undefined || backend === '' || backend === 'powershell') return new WindowsComputerDesktop()
  if (backend === 'agent-desktop') return new AgentDesktopComputerDesktop()
  // A typo must never silently select another (potentially less restricted) host.
  throw new Error('Invalid SHADOW_COMPUTER_BACKEND; expected powershell or agent-desktop.')
}
