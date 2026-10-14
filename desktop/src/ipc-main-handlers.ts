import { parseChildPairInput, type ChildPairInput } from './bootstrap/child.js'
import type { BootstrapCommandResult } from './bootstrap/coordinator.js'
import { normalizeMainDirectoryPath } from './bootstrap/runtime-config.js'
import type { MainDirectorySelector, NativeDirectorySelection } from './ipc-contract.js'

export function handlePairChild(
  coordinator: { pairChild(input: ChildPairInput): Promise<BootstrapCommandResult> },
  rawArguments: readonly unknown[],
): Promise<BootstrapCommandResult> {
  if (rawArguments.length !== 1) throw new TypeError('Child pairing requires one options object')
  return coordinator.pairChild(parseChildPairInput(rawArguments[0]))
}

export function handleSelectMainDirectoryPath(
  coordinator: MainDirectorySelector,
  rawArguments: readonly unknown[],
): Promise<NativeDirectorySelection> {
  if (rawArguments.length !== 1) throw new TypeError('Main directory selection requires one absolute path')
  return coordinator.selectMainDirectoryPath(normalizeMainDirectoryPath(rawArguments[0]))
}
