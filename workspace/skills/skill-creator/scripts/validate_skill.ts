#!/usr/bin/env -S deno run --allow-read
/**
 * Quick validation script for skills - minimal version
 *
 * Usage:
 *   deno run --allow-read scripts/validate_skill.ts <skill_directory>
 *
 * Example:
 *   deno run --allow-read scripts/validate_skill.ts skills/public/my-skill
 */

import { existsSync } from 'jsr:@std/fs@^1.0.0/exists'
import { join, resolve } from 'jsr:@std/path@^1.1.2'
import { parse } from 'jsr:@std/yaml@^1.0.9'

const MAX_SKILL_NAME_LENGTH = 64

/**
 * Validate a skill directory.
 */
export function validateSkill(skillPathArg: string): { valid: boolean; message: string } {
  const skillPath = resolve(skillPathArg)

  const skillMd = join(skillPath, 'SKILL.md')
  if (!existsSync(skillMd)) {
    return { valid: false, message: 'SKILL.md not found' }
  }

  const content = Deno.readTextFileSync(skillMd)
  if (!content.startsWith('---')) {
    return { valid: false, message: 'No YAML frontmatter found' }
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) {
    return { valid: false, message: 'Invalid frontmatter format' }
  }

  const frontmatterText = match[1]

  let frontmatter: unknown
  try {
    frontmatter = parse(frontmatterText)
    if (typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter)) {
      return { valid: false, message: 'Frontmatter must be a YAML dictionary' }
    }
  } catch (e) {
    return { valid: false, message: `Invalid YAML in frontmatter: ${(e as Error).message}` }
  }

  const data = frontmatter as Record<string, unknown>
  const allowedProperties = new Set(['name', 'description', 'license', 'allowed-tools', 'metadata', 'compatibility'])

  const unexpectedKeys = Object.keys(data).filter((key) => !allowedProperties.has(key)).sort()
  if (unexpectedKeys.length > 0) {
    const allowed = Array.from(allowedProperties).sort().join(', ')
    const unexpected = unexpectedKeys.join(', ')
    return {
      valid: false,
      message: `Unexpected key(s) in SKILL.md frontmatter: ${unexpected}. Allowed properties are: ${allowed}`,
    }
  }

  if (!('name' in data)) {
    return { valid: false, message: "Missing 'name' in frontmatter" }
  }
  if (!('description' in data)) {
    return { valid: false, message: "Missing 'description' in frontmatter" }
  }

  const rawName = data.name
  if (typeof rawName !== 'string') {
    return { valid: false, message: `Name must be a string, got ${typeof rawName}` }
  }
  const name = rawName.trim()
  if (name) {
    if (!/^[a-z0-9-]+$/.test(name)) {
      return {
        valid: false,
        message: `Name '${name}' should be hyphen-case (lowercase letters, digits, and hyphens only)`,
      }
    }
    if (name.startsWith('-') || name.endsWith('-') || name.includes('--')) {
      return {
        valid: false,
        message: `Name '${name}' cannot start/end with hyphen or contain consecutive hyphens`,
      }
    }
    if (name.length > MAX_SKILL_NAME_LENGTH) {
      return {
        valid: false,
        message: `Name is too long (${name.length} characters). Maximum is ${MAX_SKILL_NAME_LENGTH} characters.`,
      }
    }
  }

  const rawDescription = data.description
  if (typeof rawDescription !== 'string') {
    return { valid: false, message: `Description must be a string, got ${typeof rawDescription}` }
  }
  const description = rawDescription.trim()
  if (description) {
    if (description.includes('<') || description.includes('>')) {
      return { valid: false, message: 'Description cannot contain angle brackets (< or >)' }
    }
    if (description.length > 1024) {
      return {
        valid: false,
        message: `Description is too long (${description.length} characters). Maximum is 1024 characters.`,
      }
    }
  }

  const compatibility = data.compatibility
  if (compatibility !== undefined) {
    if (typeof compatibility !== 'string') {
      return { valid: false, message: `Compatibility must be a string, got ${typeof compatibility}` }
    }
    if (compatibility.length > 500) {
      return {
        valid: false,
        message: `Compatibility is too long (${compatibility.length} characters). Maximum is 500 characters.`,
      }
    }
  }

  return { valid: true, message: 'Skill is valid!' }
}

function main() {
  const args = Deno.args

  if (args.length !== 1 || args[0] === '--help' || args[0] === '-h') {
    console.log('Usage: deno run --allow-read scripts/validate_skill.ts <skill_directory>')
    Deno.exit(args[0] === '--help' || args[0] === '-h' ? 0 : 1)
  }

  const { valid, message } = validateSkill(args[0])
  console.log(message)
  Deno.exit(valid ? 0 : 1)
}

if (import.meta.main) {
  main()
}
