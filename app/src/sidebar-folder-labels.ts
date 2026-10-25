import type { FolderRecord } from './folders-client.ts'
import type { NodeInventoryEntry } from './node-inventory.ts'

/** Keep single-device labels compact, but never hide a folder's execution device. */
export function sidebarFolderLabels(folders: readonly FolderRecord[], nodes: readonly NodeInventoryEntry[], localLabel: string): Map<string, string> {
  const main = nodes.find(node => node.role === 'main')
  const deviceNames = new Map(nodes.map(node => [node.nodeId, node.displayName]))
  const multiDevice = nodes.length > 1 || folders.some(folder => folder.kind === 'remote')
  const names = new Map<string, number>()
  for (const folder of folders) names.set(folder.name, (names.get(folder.name) ?? 0) + 1)
  const labels = folders.map(folder => {
    const device = folder.kind === 'remote'
      ? deviceNames.get(folder.workdir.nodeId) || folder.workdir.nodeId
      : main?.displayName || localLabel
    return { folder, label: multiDevice || names.get(folder.name)! > 1 ? `${folder.name} · ${device}` : folder.name }
  })
  // Same device can also contain two folders with the same basename.
  const counts = new Map<string, number>()
  for (const { label } of labels) counts.set(label, (counts.get(label) ?? 0) + 1)
  return new Map(labels.map(({ folder, label }) => [folder.id, counts.get(label)! > 1 ? `${label} · ${folder.path}` : label]))
}

/** Assign distinct palette slots to namesakes, independent of registry order. */
export function sidebarFolderTones(folders: readonly FolderRecord[]): Map<string, number> {
  const groups = new Map<string, FolderRecord[]>()
  for (const folder of folders) {
    const group = groups.get(folder.name) ?? []
    group.push(folder)
    groups.set(folder.name, group)
  }
  const tones = new Map<string, number>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    group.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    group.forEach((folder, index) => tones.set(folder.id, index % 8))
  }
  return tones
}
