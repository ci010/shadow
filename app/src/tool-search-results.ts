export interface ToolSearchResult {
  heading?: string
  files: { path: string; matches: { line: number; text: string }[] }[]
  notices: string[]
}

/** Parse only the known grep display formats; leave other providers and old output intact. */
export function parseToolSearchResult(source: string): ToolSearchResult | undefined {
  const lines = source.split(/\r?\n/)
  const heading = /^Found \d+ match(?:es)?(?: \(showing \d+-\d+\))?$/.test(lines[0]) ? lines.shift() : undefined
  const result: ToolSearchResult = { heading, files: [], notices: [] }
  let file: ToolSearchResult['files'][number] | undefined
  let noticesStarted = false
  for (const line of lines) {
    if (!line) continue
    if (/^\(Showing \d+ of \d+ results; continue with offset: \d+\.\)$/.test(line)
      || !heading && /^Warning: /.test(line)) {
      result.notices.push(line)
      noticesStarted = true
      continue
    }
    if (noticesStarted) return
    const match = heading ? /^ {2}Line (\d+): (.*)$/.exec(line) : /^(v:[^\r\n]+?): {2}Line (\d+): (.*)$/.exec(line)
    if (match) {
      const path = heading ? file?.path : match[1]
      const number = Number(match[heading ? 1 : 2])
      if (!path || !Number.isSafeInteger(number) || number < 1) return
      if (!file || file.path !== path) {
        file = { path, matches: [] }
        result.files.push(file)
      }
      file.matches.push({ line: number, text: match[heading ? 2 : 3] })
    } else if (heading && line.endsWith(':') && !line.startsWith('  Line ')) {
      if (file && !file.matches.length) return
      file = { path: line.slice(0, -1), matches: [] }
      result.files.push(file)
    } else {
      return
    }
  }
  if (!result.files.length || result.files.some(file => !file.path || !file.matches.length)) return
  return result
}
