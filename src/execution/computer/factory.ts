import { AgentDesktopComputerDesktop } from './agent-desktop.ts'
import type { ComputerDesktop } from './contracts.ts'

/** The sole Windows backend; availability never grants desktop access. */
export function createComputerDesktop(): ComputerDesktop {
  return new AgentDesktopComputerDesktop()
}
