import assert from 'node:assert/strict'
import test from 'node:test'
import { fileIcon, folderIcon } from './file-icons.ts'

test('file icons recognize common source, document, media, and archive extensions', () => {
  const cases = {
    'main.ts': 'typescript',
    'main.mts': 'typescript',
    'main.cjs': 'javascript',
    'App.tsx': 'react-ts',
    'App.jsx': 'react',
    'App.vue': 'vue',
    'main.py': 'python',
    'main.rs': 'rust',
    'main.go': 'go',
    'styles.scss': 'sass',
    'notes.md': 'markdown',
    'events.jsonl': 'json',
    'settings.yaml': 'yaml',
    'Photo.PNG': 'image',
    'logo.svg': 'svg',
    'report.pdf': 'pdf',
    'backup.tar.gz': 'zip',
    'data.sqlite': 'database',
    'data.csv': 'table',
    'deploy.ps1': 'powershell',
  }
  for (const [name, icon] of Object.entries(cases)) {
    assert.equal(fileIcon(name), `i-material-icon-theme-${icon}`, name)
  }
})

test('file names and config patterns take precedence over extensions', () => {
  const cases = {
    'package.json': 'npm',
    'pnpm-lock.yaml': 'pnpm',
    'tsconfig.app.json': 'tsconfig',
    'vite.config.ts': 'vite',
    'vitest.config.mts': 'vitest',
    'unocss.config.ts': 'unocss',
    'eslint.config.js': 'eslint',
    '.eslintrc.json': 'eslint',
    '.prettierrc.yaml': 'prettier',
    '.env': 'tune',
    '.env.production.local': 'tune',
    '.gitignore': 'git',
    'README.md': 'readme',
    'LICENSE': 'license',
    'Dockerfile': 'docker',
    'Dockerfile.dev': 'docker',
    'docker-compose.yml': 'docker',
    'Makefile': 'makefile',
    'AGENTS.md': 'agent',
    'SKILL.md': 'skill',
    'Cargo.toml': 'rust',
    'types.d.ts': 'typescript-def',
    'types.d.mts': 'typescript-def',
    'types.d.cts': 'typescript-def',
    'vite.config.ts.backup': 'document',
    'notes.env': 'document',
  }
  for (const [name, icon] of Object.entries(cases)) {
    assert.equal(fileIcon(name), `i-material-icon-theme-${icon}`, name)
  }
})

test('unknown files and dotfiles always have a document fallback', () => {
  for (const name of ['unknown.xyz', 'unknown', '.custom', '', 'constructor', 'toString', '__proto__', 'file.']) {
    assert.equal(fileIcon(name), 'i-material-icon-theme-document', name)
  }
})

test('folders use their own mapping and expose closed and expanded icons', () => {
  for (const [name, icon] of [['src', 'src'], ['DOCS', 'docs'], ['__tests__', 'test'], ['node_modules', 'node'], ['.github', 'github']] as const) {
    assert.equal(folderIcon(name), `i-material-icon-theme-folder-${icon}`)
    assert.equal(folderIcon(name, true), `i-material-icon-theme-folder-${icon}-open`)
  }
  for (const name of ['custom', 'file.ts', '.unknown', 'constructor', '__proto__', '']) {
    assert.equal(folderIcon(name), 'i-material-icon-theme-folder-base')
    assert.equal(folderIcon(name, true), 'i-material-icon-theme-folder-base-open')
  }
  assert.equal(fileIcon('src'), 'i-material-icon-theme-document')
})
