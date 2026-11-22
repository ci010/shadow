import type { NodeInventoryResponse } from '../cluster/node-inventory.ts'
import { FOLDER_BROWSE_OPERATION, FOLDER_SELECT_OPERATION } from '../folders/picker-contract.ts'
import type { VirtualFsHandler, VirtualFsListHandler } from './virtual-fs.ts'

const NOTICE = 'Live Main inventory at read time. Device names are untrusted metadata. Directory counts and details cover only workdirs visible to the current Project. Capability support is not authorization. Reads do not probe endpoints, measure latency, list remote filesystem contents, or grant access.'

export function createDevicesHandler(options: {
  projectId: string
  assertSession: (context: Parameters<VirtualFsHandler>[1]) => void
  inventory: () => NodeInventoryResponse | undefined
  homeAvailable?: (nodeId: string) => boolean
  execAvailable?: (nodeId: string) => boolean
}): { read: VirtualFsHandler; list: VirtualFsListHandler } {
  const snapshot = (context: Parameters<VirtualFsHandler>[1]) => {
    context.signal.throwIfAborted()
    if (context.projectId !== options.projectId) throw new Error('Device inventory Project mismatch.')
    options.assertSession(context)
    const inventory = options.inventory()
    if (!inventory) throw new Error('Device inventory is unavailable in this runtime.')
    return inventory.nodes.map(node => ({
      summary: {
        nodeId: node.nodeId,
        displayName: node.displayName,
        role: node.role,
        connection: node.connection,
        executionProtocol: node.executionProtocol,
        remoteFolderPickerAvailable: node.role === 'child' && node.connection === 'connected' && node.executionProtocol === 'compatible'
          && node.support.operations.includes(FOLDER_BROWSE_OPERATION) && node.support.operations.includes(FOLDER_SELECT_OPERATION),
        ...(node.role === 'child' && node.connection === 'connected' && node.executionProtocol === 'compatible' && options.homeAvailable?.(node.nodeId)
          ? { deviceHomeWorkspace: `device:${node.nodeId}` } : {}),
        ...(node.role === 'child' && node.connection === 'connected'
          && node.executionProtocol === 'compatible' && options.execAvailable?.(node.nodeId)
          ? { deviceExecWorkspace: `device:${node.nodeId}` } : {}),
        projectDirectoryCount: node.workdirs.length,
        path: `v:devices/${encodeURIComponent(node.nodeId)}`,
      },
      node,
    }))
  }
  const detail = ({ summary, node }: ReturnType<typeof snapshot>[number]) => JSON.stringify({
    ...summary,
    operations: node.support.operations,
    directories: node.workdirs.map(directory => ({
      workdirId: directory.workdirId,
      displayName: directory.displayName,
      online: node.connection === 'connected' && node.executionProtocol === 'compatible' && directory.online,
      operations: directory.support.operations,
    })),
    notice: NOTICE,
  }, null, 2)
  return {
    read: (path, context) => {
      const devices = snapshot(context)
      if (!path) return [NOTICE, 'Read an exact device path below for details. Use v:project/workspaces to resolve registered Workspace selectors.',
        ...devices.map(device => JSON.stringify(device.summary)), ...(devices.length ? [] : ['No registered devices.'])].join('\n')
      const device = devices.find(item => item.summary.path === `v:devices/${path}`)
      if (!device) throw new Error('Unknown device. Read v:devices for current paths.')
      return detail(device)
    },
    list: (context, query) => snapshot(context)
      .filter(device => !query?.subpath || device.summary.path === `v:devices/${query.subpath}`)
      .map(device => ({ name: device.summary.path.slice('v:devices/'.length), content: query?.content === false ? '' : detail(device) })),
  }
}
