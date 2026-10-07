import { t } from './i18n.ts'
import type { HighlighterCore } from 'shiki/core'

const languages = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
} as const
type FileLanguage = keyof typeof languages

const extensions: Record<string, FileLanguage> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', jsonc: 'jsonc', py: 'python', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  ps1: 'powershell', css: 'css', scss: 'scss', vue: 'vue', html: 'html', htm: 'html',
  md: 'markdown', markdown: 'markdown', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', sql: 'sql', go: 'go', rs: 'rust',
  java: 'java', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  rb: 'ruby', php: 'php', diff: 'diff', patch: 'diff',
}
const filenames: Record<string, FileLanguage> = {
  '.gitmodules': 'ini', '.gitconfig': 'ini', '.npmrc': 'ini', '.yarnrc': 'ini',
  '.editorconfig': 'ini', '.env': 'ini', '.bashrc': 'shellscript', '.zshrc': 'shellscript',
  dockerfile: 'dockerfile', containerfile: 'dockerfile',
}

export function fileLanguage(path: string): FileLanguage | 'text' {
  const name = path.replaceAll('\\', '/').split('/').at(-1)!.toLowerCase()
  const dot = name.lastIndexOf('.')
  return filenames[name] ?? (name.startsWith('.env.') ? 'ini' : extensions[dot >= 0 ? name.slice(dot + 1) : '']) ?? 'text'
}

export interface FileHighlightToken {
  text: string
  light?: string
  dark?: string
}

let highlighter: Promise<HighlighterCore> | undefined
const loadingLanguages = new Map<FileLanguage, Promise<void>>()

function sharedHighlighter(): Promise<HighlighterCore> {
  return highlighter ??= Promise.all([
    import('shiki/core'), import('shiki/engine/javascript'),
    import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs'),
  ]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark]) =>
    createHighlighterCore({ engine: createJavaScriptRegexEngine(), themes: [light, dark], langs: [] }))
    .catch(error => { highlighter = undefined; throw error })
}

/** Shiki offsets refer to the original source; gaps retain its exact line endings. */
export function preserveHighlightSource(source: string, tokens: readonly {
  content: string
  offset: number
  htmlStyle?: Record<string, string>
}[]): FileHighlightToken[] {
  let offset = 0
  const result: FileHighlightToken[] = []
  for (const token of tokens) {
    if (token.offset < offset || source.slice(token.offset, token.offset + token.content.length) !== token.content) {
      throw new Error(t('Syntax tokens do not match the source text.'))
    }
    if (token.offset > offset) result.push({ text: source.slice(offset, token.offset) })
    if (token.content) result.push({
      text: token.content, light: token.htmlStyle?.color, dark: token.htmlStyle?.['--shiki-dark'],
    })
    offset = token.offset + token.content.length
  }
  if (offset < source.length) result.push({ text: source.slice(offset) })
  return result
}

export async function highlightFile(
  source: string,
  path: string,
  options: { tokenizeTimeLimit?: number; lineNumbers?: boolean } = {},
): Promise<FileHighlightToken[]> {
  if (options.lineNumbers) {
    const lines = source.split('\n')
    const prefixes = lines.map(line => /^ *\d+ {2}/.exec(line)?.[0] ?? '')
    const code = lines.map((line, index) => line.slice(prefixes[index].length)).join('\n')
    const highlighted = await highlightFile(code, path, { ...options, lineNumbers: false })
    const result: FileHighlightToken[] = []
    let line = 0
    if (prefixes[0]) result.push({ text: prefixes[0] })
    for (const token of highlighted) {
      const parts = token.text.split('\n')
      for (let index = 0; index < parts.length; index++) {
        if (index) {
          result.push({ text: '\n' })
          line++
          if (prefixes[line]) result.push({ text: prefixes[line] })
        }
        if (parts[index]) result.push({ ...token, text: parts[index] })
      }
    }
    return result
  }
  const language = fileLanguage(path)
  if (language === 'text' || !source) return [{ text: source }]
  const engine = await sharedHighlighter()
  if (!engine.getLoadedLanguages().includes(language)) {
    let loading = loadingLanguages.get(language)
    if (!loading) {
      loading = engine.loadLanguage(languages[language]()).catch(error => {
        loadingLanguages.delete(language)
        throw error
      })
      loadingLanguages.set(language, loading)
    }
    await loading
  }
  const { tokens } = engine.codeToTokens(source, {
    lang: language, themes: { light: 'github-light', dark: 'github-dark' },
    tokenizeMaxLineLength: 2000, tokenizeTimeLimit: options.tokenizeTimeLimit ?? 50,
  })
  return preserveHighlightSource(source, tokens.flat())
}
