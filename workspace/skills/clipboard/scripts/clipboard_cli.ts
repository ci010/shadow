import {
  availableFormats,
  clear,
  getHtml,
  getText,
  hasHtml,
  hasText,
  setHtml,
  setText,
  startWatch,
} from 'npm:@crosscopy/clipboard'

function usage() {
  console.log(`Usage:
  deno run -A clipboard_cli.ts read
  deno run -A clipboard_cli.ts write "text"
  deno run -A clipboard_cli.ts read-html
  deno run -A clipboard_cli.ts write-html "<b>hello</b>"
  deno run -A clipboard_cli.ts clear
  deno run -A clipboard_cli.ts formats
  deno run -A clipboard_cli.ts watch [seconds]
`)
}

async function readText() {
  if (!hasText()) {
    console.log('Clipboard has no text content.')
    return
  }
  console.log(await getText())
}

async function writeText(text: string | undefined) {
  if (!text) {
    console.error('Missing text for write command.')
    usage()
    Deno.exit(1)
  }
  await setText(text)
  console.log('Clipboard text written.')
}

async function readHtml() {
  if (!hasHtml()) {
    console.log('Clipboard has no HTML content.')
    return
  }
  console.log(await getHtml())
}

async function writeHtml(html: string | undefined) {
  if (!html) {
    console.error('Missing HTML for write-html command.')
    usage()
    Deno.exit(1)
  }
  await setHtml(html)
  console.log('Clipboard HTML written.')
}

async function watchClipboard(seconds: number) {
  let count = 0
  const watcher = startWatch(async () => {
    count++
    try {
      const text = hasText() ? await getText() : '(non-text content)'
      console.log(`[${count}] changed: ${text}`)
    } catch {
      console.log(`[${count}] changed`)
    }
  })

  console.log(`Watching clipboard for ${seconds}s...`)
  console.log('Press Ctrl+C to stop early.')

  await new Promise((resolve) => setTimeout(resolve, seconds * 1000))

  watcher.stop()
  console.log('Watcher stopped.')
}

if (import.meta.main) {
  const [command, ...rest] = Deno.args

  if (!command) {
    usage()
    Deno.exit(1)
  }

  switch (command) {
    case 'read':
      await readText()
      break
    case 'write':
      await writeText(rest.join(' '))
      break
    case 'read-html':
      await readHtml()
      break
    case 'write-html':
      await writeHtml(rest.join(' '))
      break
    case 'clear':
      await clear()
      console.log('Clipboard cleared.')
      break
    case 'formats':
      console.log(availableFormats())
      break
    case 'watch': {
      const secondsRaw = rest[0] ?? '10'
      const seconds = Number(secondsRaw)
      if (!Number.isFinite(seconds) || seconds <= 0) {
        console.error('watch seconds must be a positive number.')
        Deno.exit(1)
      }
      await watchClipboard(seconds)
      break
    }
    default:
      console.error(`Unknown command: ${command}`)
      usage()
      Deno.exit(1)
  }
}
