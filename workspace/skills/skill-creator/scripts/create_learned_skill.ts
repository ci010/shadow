#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Learned Skill Creator - Scaffolds a new learned skill from real experience
 *
 * Learned skills are regular skills that also carry a `related` frontmatter field
 * linking back to the original skills or topics this knowledge was derived from.
 * They live flat in the skills/ directory alongside other skills.
 *
 * Usage:
 *   deno run --allow-read --allow-write scripts/create_learned_skill.ts <skill-name> [options]
 *
 * Options:
 *   --path <dir>          Output directory for the skill (default: skills/)
 *   --related <skills>    Comma-separated list of related skill names
 *   --description <text>  Short description override (can be edited after creation)
 *
 * Examples:
 *   deno run --allow-read --allow-write scripts/create_learned_skill.ts deno-watchfs --related cron,skill-learning
 *   deno run --allow-read --allow-write scripts/create_learned_skill.ts zhihu-login --path workspace/skills --related agent-browser
 */

import { existsSync } from 'jsr:@std/fs@^1.0.0/exists'
import { join, resolve } from 'jsr:@std/path@^1.1.2'
import { parseArgs } from 'jsr:@std/cli@^1.0.21/parse-args'

const MAX_SKILL_NAME_LENGTH = 64

function normalizeSkillName(skillName: string): string {
  let normalized = skillName.trim().toLowerCase()
  normalized = normalized.replace(/[^a-z0-9]+/g, '-')
  normalized = normalized.replace(/^-+|-+$/g, '')
  return normalized
}

function toTitleCase(skillName: string): string {
  return skillName
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function generateLearnedSkillMd(skillName: string, skillTitle: string, related: string[]): string {
  const now = new Date().toISOString()
  const relatedLine = related.length > 0 ? `\nrelated: ${related.join(',')}` : ''

  return `---
name: ${skillName}
description: [TODO: Describe what you learned and when this skill should be used. Be specific about triggers — what scenario or task benefits from this knowledge?]${relatedLine}
learnedAt: ${now}
version: 1
---

# ${skillTitle} (Learned)

> This is a learned skill based on real execution experience.${related.length > 0 ? `\n> Related: ${related.join(', ')}` : ''}

## What Actually Works

[TODO: Document the specific commands, paths, and approaches that worked in your environment.
Be concrete — include exact commands, actual file paths, and real outputs.]

## Key Insights

[TODO: What did you discover that wasn't obvious from documentation alone?
- Gotchas or surprising behavior
- Environment-specific nuances
- Things that failed and why]

## Working Example

\`\`\`bash
# TODO: Replace with an actual command or code snippet that you verified works
\`\`\`

## References

[TODO: Link to relevant documentation, source skills, or files you consulted]
`
}

async function main() {
  const args = parseArgs(Deno.args, {
    string: ['path', 'related', 'description'],
    alias: { p: 'path', r: 'related', d: 'description' },
  })

  const skillNameRaw = args._[0] as string | undefined
  if (!skillNameRaw) {
    console.error('Error: skill name is required.')
    console.error('Usage: create_learned_skill.ts <skill-name> [--path <dir>] [--related <skills>]')
    Deno.exit(1)
  }

  const skillName = normalizeSkillName(skillNameRaw)
  if (skillName.length === 0) {
    console.error('Error: skill name is empty after normalization.')
    Deno.exit(1)
  }
  if (skillName.length > MAX_SKILL_NAME_LENGTH) {
    console.error(`Error: skill name "${skillName}" exceeds ${MAX_SKILL_NAME_LENGTH} characters.`)
    Deno.exit(1)
  }

  const outputDir = args.path ? resolve(args.path) : resolve('skills')
  const skillDir = join(outputDir, skillName)

  if (existsSync(skillDir)) {
    console.error(`Error: directory already exists: ${skillDir}`)
    Deno.exit(1)
  }

  const related = args.related
    ? args.related.split(',').map((s: string) => s.trim()).filter(Boolean)
    : []

  const skillTitle = toTitleCase(skillName)

  // Create directory and SKILL.md
  await Deno.mkdir(skillDir, { recursive: true })

  const skillMd = generateLearnedSkillMd(skillName, skillTitle, related)
  await Deno.writeTextFile(join(skillDir, 'SKILL.md'), skillMd)

  console.log(`✅ Learned skill created: ${skillDir}/SKILL.md`)
  if (related.length > 0) {
    console.log(`   Related skills: ${related.join(', ')}`)
  }
  console.log('')
  console.log('Next steps:')
  console.log('  1. Edit SKILL.md — fill in the TODO sections with your real experience')
  console.log('  2. Update the description to accurately describe when to use this skill')
  console.log('  3. Add working code examples and gotchas from your actual execution')
}

main()
