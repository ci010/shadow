type MaterialIcon = `i-material-icon-theme-${string}`

function associations<T>(groups: Record<string, T>): ReadonlyMap<string, T> {
  return new Map(Object.entries(groups).flatMap(([names, value]) => names.split(' ').map(name => [name, value] as const)))
}

// Keep complete class names so UnoCSS includes these icons in offline builds.
const fileNames = associations<MaterialIcon>({
  'package.json package-lock.json npm-shrinkwrap.json .npmrc': 'i-material-icon-theme-npm',
  'pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs': 'i-material-icon-theme-pnpm',
  'yarn.lock .yarnrc .yarnrc.yml': 'i-material-icon-theme-yarn',
  'bun.lock bun.lockb bunfig.toml': 'i-material-icon-theme-bun',
  'deno.json deno.jsonc deno.lock': 'i-material-icon-theme-deno',
  'tsconfig.json': 'i-material-icon-theme-tsconfig',
  'jsconfig.json': 'i-material-icon-theme-jsconfig',
  '.gitignore .gitattributes .gitmodules .gitkeep': 'i-material-icon-theme-git',
  '.editorconfig': 'i-material-icon-theme-editorconfig',
  '.eslintrc .eslintignore': 'i-material-icon-theme-eslint',
  '.prettierrc .prettierignore': 'i-material-icon-theme-prettier',
  'dockerfile containerfile .dockerignore docker-compose.yml docker-compose.yaml compose.yml compose.yaml': 'i-material-icon-theme-docker',
  'license license.md license.txt licence licence.md licence.txt copying': 'i-material-icon-theme-license',
  'readme readme.md readme.txt readme.rst': 'i-material-icon-theme-readme',
  'changelog changelog.md changelog.txt': 'i-material-icon-theme-changelog',
  'contributing.md': 'i-material-icon-theme-contributing',
  'code_of_conduct.md': 'i-material-icon-theme-conduct',
  'agents.md agent.md': 'i-material-icon-theme-agent',
  'skill.md': 'i-material-icon-theme-skill',
  'claude.md': 'i-material-icon-theme-claude',
  'makefile gnumakefile': 'i-material-icon-theme-makefile',
  'cmakelists.txt': 'i-material-icon-theme-cmake',
  'go.mod go.sum': 'i-material-icon-theme-go-mod',
  'cargo.toml cargo.lock': 'i-material-icon-theme-rust',
  'requirements.txt pyproject.toml pipfile': 'i-material-icon-theme-python-misc',
  'poetry.lock': 'i-material-icon-theme-poetry',
  'uv.lock': 'i-material-icon-theme-uv',
  'gemfile gemfile.lock': 'i-material-icon-theme-gemfile',
})

const extensions = associations<MaterialIcon>({
  'ts mts cts': 'i-material-icon-theme-typescript',
  'd.ts d.mts d.cts': 'i-material-icon-theme-typescript-def',
  'tsx': 'i-material-icon-theme-react-ts',
  'js mjs cjs': 'i-material-icon-theme-javascript',
  'jsx': 'i-material-icon-theme-react',
  'vue': 'i-material-icon-theme-vue',
  'svelte': 'i-material-icon-theme-svelte',
  'astro': 'i-material-icon-theme-astro',
  'html htm': 'i-material-icon-theme-html',
  'css': 'i-material-icon-theme-css',
  'scss sass': 'i-material-icon-theme-sass',
  'less': 'i-material-icon-theme-less',
  'json jsonc json5 jsonl ndjson': 'i-material-icon-theme-json',
  'yaml yml': 'i-material-icon-theme-yaml',
  'toml': 'i-material-icon-theme-toml',
  'xml xsl xsd': 'i-material-icon-theme-xml',
  'md markdown': 'i-material-icon-theme-markdown',
  'mdx': 'i-material-icon-theme-mdx',
  'txt text rtf': 'i-material-icon-theme-document',
  'py pyw pyi': 'i-material-icon-theme-python',
  'ipynb': 'i-material-icon-theme-jupyter',
  'rs': 'i-material-icon-theme-rust',
  'go': 'i-material-icon-theme-go',
  'java class': 'i-material-icon-theme-java',
  'kt kts': 'i-material-icon-theme-kotlin',
  'c': 'i-material-icon-theme-c',
  'h': 'i-material-icon-theme-h',
  'cpp cc cxx': 'i-material-icon-theme-cpp',
  'hpp hxx': 'i-material-icon-theme-hpp',
  'cs csx': 'i-material-icon-theme-csharp',
  'rb': 'i-material-icon-theme-ruby',
  'php': 'i-material-icon-theme-php',
  'swift': 'i-material-icon-theme-swift',
  'dart': 'i-material-icon-theme-dart',
  'lua': 'i-material-icon-theme-lua',
  'r rmd': 'i-material-icon-theme-r',
  'sh bash zsh fish bat cmd': 'i-material-icon-theme-console',
  'ps1 psm1 psd1': 'i-material-icon-theme-powershell',
  'sql db sqlite sqlite3': 'i-material-icon-theme-database',
  'graphql gql': 'i-material-icon-theme-graphql',
  'proto': 'i-material-icon-theme-proto',
  'wasm': 'i-material-icon-theme-webassembly',
  'png jpg jpeg gif webp avif bmp tiff tif ico heic': 'i-material-icon-theme-image',
  'svg': 'i-material-icon-theme-svg',
  'mp3 wav ogg flac m4a aac': 'i-material-icon-theme-audio',
  'mp4 webm mov avi mkv': 'i-material-icon-theme-video',
  'pdf': 'i-material-icon-theme-pdf',
  'zip tar gz bz2 xz tgz 7z rar': 'i-material-icon-theme-zip',
  'woff woff2 ttf otf eot': 'i-material-icon-theme-font',
  'csv tsv xls xlsx ods': 'i-material-icon-theme-table',
  'doc docx odt': 'i-material-icon-theme-word',
  'ppt pptx odp': 'i-material-icon-theme-powerpoint',
  'log': 'i-material-icon-theme-log',
  'lock': 'i-material-icon-theme-lock',
  'ini conf cfg properties': 'i-material-icon-theme-settings',
  'pem crt cer': 'i-material-icon-theme-certificate',
  'key': 'i-material-icon-theme-key',
  'diff patch': 'i-material-icon-theme-diff',
})

const configNames: readonly [RegExp, MaterialIcon][] = [
  [/^\.env(?:\.|$)/, 'i-material-icon-theme-tune'],
  [/^tsconfig(?:\..+)?\.json$/, 'i-material-icon-theme-tsconfig'],
  [/^(?:eslint\.config|\.eslintrc)\.(?:[cm]?[jt]s|json|ya?ml)$/, 'i-material-icon-theme-eslint'],
  [/^(?:prettier\.config|\.prettierrc)\.(?:[cm]?[jt]s|json|json5|ya?ml|toml)$/, 'i-material-icon-theme-prettier'],
  [/^vite\.config\.[cm]?[jt]s$/, 'i-material-icon-theme-vite'],
  [/^vitest\.config\.[cm]?[jt]s$/, 'i-material-icon-theme-vitest'],
  [/^webpack\.config\.[cm]?[jt]s$/, 'i-material-icon-theme-webpack'],
  [/^rollup\.config\.[cm]?[jt]s$/, 'i-material-icon-theme-rollup'],
  [/^tailwind\.config\.[cm]?[jt]s$/, 'i-material-icon-theme-tailwindcss'],
  [/^(?:uno|unocss)\.config\.[cm]?[jt]s$/, 'i-material-icon-theme-unocss'],
  [/^dockerfile\./, 'i-material-icon-theme-docker'],
]

const folders = associations<readonly [MaterialIcon, MaterialIcon]>({
  'src source': ['i-material-icon-theme-folder-src', 'i-material-icon-theme-folder-src-open'],
  'app apps': ['i-material-icon-theme-folder-app', 'i-material-icon-theme-folder-app-open'],
  'components': ['i-material-icon-theme-folder-components', 'i-material-icon-theme-folder-components-open'],
  'docs doc documentation': ['i-material-icon-theme-folder-docs', 'i-material-icon-theme-folder-docs-open'],
  'test tests __tests__': ['i-material-icon-theme-folder-test', 'i-material-icon-theme-folder-test-open'],
  'assets images img': ['i-material-icon-theme-folder-images', 'i-material-icon-theme-folder-images-open'],
  'public static': ['i-material-icon-theme-folder-public', 'i-material-icon-theme-folder-public-open'],
  'scripts': ['i-material-icon-theme-folder-scripts', 'i-material-icon-theme-folder-scripts-open'],
  'styles css': ['i-material-icon-theme-folder-css', 'i-material-icon-theme-folder-css-open'],
  'config configs .config': ['i-material-icon-theme-folder-config', 'i-material-icon-theme-folder-config-open'],
  'dist build out': ['i-material-icon-theme-folder-dist', 'i-material-icon-theme-folder-dist-open'],
  'node_modules': ['i-material-icon-theme-folder-node', 'i-material-icon-theme-folder-node-open'],
  '.git': ['i-material-icon-theme-folder-git', 'i-material-icon-theme-folder-git-open'],
  '.github': ['i-material-icon-theme-folder-github', 'i-material-icon-theme-folder-github-open'],
  '.vscode': ['i-material-icon-theme-folder-vscode', 'i-material-icon-theme-folder-vscode-open'],
  'lib libs': ['i-material-icon-theme-folder-lib', 'i-material-icon-theme-folder-lib-open'],
  'utils helpers': ['i-material-icon-theme-folder-utils', 'i-material-icon-theme-folder-utils-open'],
  'types typings': ['i-material-icon-theme-folder-typescript', 'i-material-icon-theme-folder-typescript-open'],
  'api': ['i-material-icon-theme-folder-api', 'i-material-icon-theme-folder-api-open'],
  'packages': ['i-material-icon-theme-folder-packages', 'i-material-icon-theme-folder-packages-open'],
  'skills': ['i-material-icon-theme-folder-skills', 'i-material-icon-theme-folder-skills-open'],
})

export function matchedFileIcon(name: string): MaterialIcon | undefined {
  const normalized = name.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''
  const exact = fileNames.get(normalized)
  if (exact) return exact
  for (const [pattern, icon] of configNames) {
    if (pattern.test(normalized)) return icon
  }
  // Longest suffix first: declaration files should not look like ordinary TS.
  for (let dot = normalized.indexOf('.'); dot >= 0; dot = normalized.indexOf('.', dot + 1)) {
    const icon = extensions.get(normalized.slice(dot + 1))
    if (icon) return icon
  }
}

export function fileIcon(name: string): MaterialIcon {
  return matchedFileIcon(name) ?? 'i-material-icon-theme-document'
}

export function folderIcon(name: string, expanded = false): MaterialIcon {
  const icons = folders.get(name.toLowerCase())
  return icons?.[expanded ? 1 : 0] ?? (expanded ? 'i-material-icon-theme-folder-base-open' : 'i-material-icon-theme-folder-base')
}
