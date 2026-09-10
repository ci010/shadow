#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Skill Packager - Creates a distributable .skill file of a skill folder
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-env scripts/package_skill.ts <path/to/skill-folder> [output-directory]
 *
 * Example:
 *   deno run --allow-read --allow-write --allow-env scripts/package_skill.ts skills/public/my-skill
 *   deno run --allow-read --allow-write --allow-env scripts/package_skill.ts skills/public/my-skill ./dist
 */

import { existsSync, walkSync } from 'jsr:@std/fs@^1.0.0'
import { basename, dirname, join, relative, resolve } from 'jsr:@std/path@^1.1.2'
import JSZip from 'npm:jszip@^3.10.1'
import { validateSkill } from './validate_skill.ts'

/** Directories excluded everywhere in the tree. */
const EXCLUDE_DIRS = new Set(['__pycache__', 'node_modules'])
/** Glob patterns for files to skip. */
const EXCLUDE_GLOBS = ['*.pyc']
/** Exact file names to skip. */
const EXCLUDE_FILES = new Set(['.DS_Store'])
/** Directories excluded only at the skill root (not nested deeper). */
const ROOT_EXCLUDE_DIRS = new Set(['evals'])

function matchGlob(name: string, pattern: string): boolean {
  const re = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')
  return re.test(name)
}

function shouldExclude(relPath: string, skillDirName: string): boolean {
  const parts = relPath.split(/[\\/]/)
  if (parts.some((p) => EXCLUDE_DIRS.has(p))) return true
  // parts[0] is the skill folder name, parts[1] is the first subdir
  if (parts[0] === skillDirName && parts.length > 1 && ROOT_EXCLUDE_DIRS.has(parts[1])) return true
  const name = parts[parts.length - 1]
  if (EXCLUDE_FILES.has(name)) return true
  return EXCLUDE_GLOBS.some((pat) => matchGlob(name, pat))
}

/**
 * Get all files in a directory recursively.
 */
function getAllFiles(dir: string): Array<{ path: string; relativePath: string }> {
  const files: Array<{ path: string; relativePath: string }> = []

  for (const entry of walkSync(dir, { includeDirs: false })) {
    if (entry.isFile) {
      files.push({
        path: entry.path,
        relativePath: relative(dir, entry.path),
      })
    }
  }

  return files
}

/**
 * Package a skill folder into a .skill file.
 */
async function packageSkill(skillPathArg: string, outputDir: string | null): Promise<string | null> {
  const skillPath = resolve(skillPathArg)

  if (!existsSync(skillPath)) {
    console.error(`[ERROR] Skill folder not found: ${skillPath}`)
    return null
  }

  const stat = Deno.statSync(skillPath)
  if (!stat.isDirectory) {
    console.error(`[ERROR] Path is not a directory: ${skillPath}`)
    return null
  }

  const skillMd = join(skillPath, 'SKILL.md')
  if (!existsSync(skillMd)) {
    console.error(`[ERROR] SKILL.md not found in ${skillPath}`)
    return null
  }

  console.log('Validating skill...')
  const { valid, message } = validateSkill(skillPath)
  if (!valid) {
    console.error(`[ERROR] Validation failed: ${message}`)
    console.error('   Please fix the validation errors before packaging.')
    return null
  }
  console.log(`[OK] ${message}\n`)

  const skillName = basename(skillPath)
  const outputPath = outputDir ? resolve(outputDir) : Deno.cwd()
  if (outputDir) {
    Deno.mkdirSync(outputPath, { recursive: true })
  }

  const skillFilename = join(outputPath, `${skillName}.skill`)

  try {
    const zip = new JSZip()
    const files = getAllFiles(skillPath)
    const parentDir = dirname(skillPath)
    const skillDirName = basename(skillPath)

    for (const file of files) {
      const arcname = relative(parentDir, file.path)
      if (shouldExclude(arcname, skillDirName)) {
        console.log(`   Skipped: ${arcname}`)
        continue
      }
      const content = Deno.readFileSync(file.path)
      zip.file(arcname, content)
      console.log(`   Added: ${arcname}`)
    }

    const bytes = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    })
    Deno.writeFileSync(skillFilename, bytes)

    console.log(`\n[OK] Successfully packaged skill to: ${skillFilename}`)
    return skillFilename
  } catch (e) {
    console.error(`[ERROR] Error creating .skill file: ${(e as Error).message}`)
    return null
  }
}

async function main() {
  const args = Deno.args

  if (args.length < 1 || args[0] === '--help' || args[0] === '-h') {
    console.log(`Usage: deno run --allow-read --allow-write --allow-env scripts/package_skill.ts <path/to/skill-folder> [output-directory]

Example:
  deno run --allow-read --allow-write --allow-env scripts/package_skill.ts skills/public/my-skill
  deno run --allow-read --allow-write --allow-env scripts/package_skill.ts skills/public/my-skill ./dist`)
    Deno.exit(args[0] === '--help' || args[0] === '-h' ? 0 : 1)
  }

  const skillPath = args[0]
  const outputDir = args[1] || null

  console.log(`Packaging skill: ${skillPath}`)
  if (outputDir) {
    console.log(`   Output directory: ${outputDir}`)
  }
  console.log()

  const result = await packageSkill(skillPath, outputDir)

  Deno.exit(result ? 0 : 1)
}

if (import.meta.main) {
  main()
}
