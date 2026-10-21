import { readdir, realpath, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Skill } from './loader.ts'
import { loadSingleSkill } from './parse.ts'

export interface FolderSkillScope { folderId: string; path: string }
export interface FolderSkill extends Skill { folderScope: FolderSkillScope }

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
}

/** Narrow repository convention; no global watcher/cache and no execution on discovery. */
export async function discoverFolderSkills(scope: FolderSkillScope, admin = false): Promise<FolderSkill[]> {
  const directory = join(scope.path, '.agents', 'skills')
  let root: string
  try { root = await realpath(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  if (!within(await realpath(scope.path), root)) throw new Error('Folder skills directory must remain inside the selected folder')
  const skills: FolderSkill[] = []
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(entry.name)) continue
    const dir = join(root, entry.name)
    try { if (!within(dir, await realpath(join(dir, 'SKILL.md')))) throw new Error('Folder SKILL.md must remain inside its skill directory') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    const skill = await loadSingleSkill(dir, entry.name)
    if (!skill || skill.meta.admin && !admin) continue
    // The directory is the unambiguous VFS load key; metadata must agree.
    if (skill.meta.name !== entry.name) throw new Error(`Folder skill name must match directory: ${entry.name}`)
    skills.push({ ...skill, folderScope: scope })
  }
  return skills
}

export function folderSkillsSummary(skills: FolderSkill[], scope: FolderSkillScope): string {
  return [
    `Selected-folder skills: ${JSON.stringify(scope)}; convention: .agents/skills/<name>/SKILL.md.`,
    'Only this selected folder scope is current; previous folder skill discovery/instructions are superseded. Project/global skills remain available at v:skills/<name>. Folder bodies and tools load only on an explicit read of v:skills/folder/<name>; discovery and resource reads do not activate tools.',
    ...skills.map(skill => `- read(${JSON.stringify(`v:skills/folder/${skill.meta.name}`)}): ${JSON.stringify(skill.meta.description)}; source=${JSON.stringify(join(skill.dirPath, 'SKILL.md'))}`),
    ...(skills.length ? [] : ['(No applicable folder skills.)']),
  ].join('\n')
}

export async function readFolderSkillResource(skill: FolderSkill, resource: string): Promise<string> {
  const path = resolve(skill.dirPath, resource)
  if (!within(skill.dirPath, path) || !within(skill.dirPath, await realpath(path))) throw new Error('Folder skill resource must remain inside its skill directory')
  return readFile(path, 'utf8')
}
