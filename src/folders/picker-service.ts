import { browseDirectories, parseDirectoryListing, pickerPath, FOLDER_BROWSE_OPERATION, FOLDER_SELECT_OPERATION } from './picker.ts'
import { parseLiveWorkdirRef } from '../sessions/locality.ts'
import type { NodeInventoryResponse } from '../cluster/node-inventory.ts'
import type { Executor } from '../execution/executor.ts'
import { executeRemoteNodeText } from '../execution/remote-filesystem-client.ts'
import { FolderError, type FolderRegistry } from './registry.ts'

export interface FolderPickerOptions { inventory: () => NodeInventoryResponse; executor: Executor }

/** Shared owner/agent device selection: never resolve a Child path on Main. */
type PickerServiceOptions = { picker?: FolderPickerOptions; registry: Pick<FolderRegistry, 'register' | 'registerRemote'> }
export function pickFolder(options: PickerServiceOptions, action: 'select', body: Record<string, unknown>, signal: AbortSignal, description?: string): Promise<{ folder: import('./contracts.ts').FolderRecord }>
export function pickFolder(options: PickerServiceOptions, action: 'browse' | 'select', body: Record<string, unknown>, signal: AbortSignal, description?: string): Promise<{ folder: import('./contracts.ts').FolderRecord } | { listing: import('./picker-contract.ts').DirectoryListing }>
export async function pickFolder(options: { picker?: FolderPickerOptions; registry: Pick<FolderRegistry, 'register' | 'registerRemote'> }, action: 'browse' | 'select', body: Record<string, unknown>, signal: AbortSignal, description?: string) {
  if (Object.keys(body).sort().join(',') !== 'nodeId,path' || typeof body.nodeId !== 'string' ||
    typeof body.path !== 'string' || body.path.length > 4096 || /[\0\r\n]/.test(body.path)) {
    throw new FolderError('invalid_picker_request', 'Provide a device identity and directory path.')
  }
  const picker = options.picker
  const node = picker?.inventory().nodes.find(n => n.nodeId === body.nodeId)
  if (!picker || !node || node.connection !== 'connected') throw new FolderError('picker_device_offline', 'The selected device is offline. Reconnect and retry.', 503)
  if (node.role === 'main') {
    if (action === 'browse') return { listing: await browseDirectories(body.path, signal) }
    return { folder: await options.registry.register(pickerPath(body.path), signal, description) }
  }
  if (node.executionProtocol !== 'compatible' || (!node.support.operations.includes(FOLDER_BROWSE_OPERATION) || !node.support.operations.includes(FOLDER_SELECT_OPERATION))) {
    throw new FolderError('picker_unsupported', 'Update the selected device to support folder browsing, then reconnect.', 409)
  }
  if (description !== undefined) throw new FolderError('invalid_description', 'Remote folder descriptions are not supported.')
  // The path remains opaque on Main; only its owning Child validates/canonicalizes it.
  const output = await executeRemoteNodeText({ executor: picker.executor, nodeId: node.nodeId,
    sessionId: 'owner-folder-picker', turnId: crypto.randomUUID(),
    signal }, action === 'browse' ? FOLDER_BROWSE_OPERATION : FOLDER_SELECT_OPERATION, { path: body.path }, 2_000_000)
  if (output.length > 2_000_000) throw new Error('Picker result too large')
  const value: unknown = JSON.parse(output)
  if (action === 'browse') return { listing: parseDirectoryListing(value) }
  const ref = parseLiveWorkdirRef(value)
  if (!ref || !value || typeof value !== 'object' || !('version' in value) || value.version !== 2 || ref.nodeId !== node.nodeId || !/^picked-v1:[a-f0-9]{64}$/.test(ref.workdirId)) throw new Error('Invalid selected folder')
  return { folder: await options.registry.registerRemote(ref, signal) }
}
