import type { OpenFile } from './file-workbench.ts'

/** Relative Markdown links address files in the conversation's owning workdir. */
export function conversationFileLink(href: string): OpenFile | undefined {
  if (!href || /^[\\/#?]|^[a-z][a-z\d+.-]*:/i.test(href)) return
  let value: string
  try { value = decodeURIComponent(href.split(/[?#]/, 1)[0]!) } catch { return }
  value = value.replace(/\\/g, '/')
  if (!value || value.startsWith('/') || /[:\u0000-\u001f\u007f]/.test(value) || value.endsWith('/')) return
  const parts: string[] = []
  for (const part of value.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return
      parts.pop()
    } else parts.push(part)
  }
  const name = parts.at(-1)
  if (!name) return
  const dot = name.lastIndexOf('.')
  return { path: parts.join('/'), entry: {
    name, type: 'file', ext: dot > 0 ? name.slice(dot) : '', size: 0, mtime: null,
  } }
}
