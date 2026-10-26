import { fileURLToPath } from 'node:url'
import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { CHROME_MCP_PACKAGE } from './chrome-contract.ts'

/** Resolve only from application code, never cwd, NODE_PATH or a package launcher. */
export function bundledChromeAdapter() {
  try {
    // The source checkout and relocated backend both have src/browser two levels
    // below their own node_modules. Do not fall back to an ancestor installation.
    const manifestPath = fileURLToPath(new URL('../../node_modules/chrome-devtools-mcp/package.json', import.meta.url))
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (`${manifest.name}@${manifest.version}` !== CHROME_MCP_PACKAGE ||
      manifest.bin?.['chrome-devtools-mcp'] !== './build/src/bin/chrome-devtools-mcp.js') {
      throw new Error('Unexpected adapter version or executable entry')
    }
    const cwd = dirname(manifestPath)
    const entry = resolve(cwd, manifest.bin['chrome-devtools-mcp'])
    if (!statSync(entry).isFile()) throw new Error('Adapter entry is not a file')
    return { command: process.execPath, args: [entry], cwd,
      // Electron's executable is also our Node runtime. Never inherit preload injection.
      env: { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '', NODE_PATH: '' } }
  } catch (cause) {
    throw new Error(`Chrome requires the bundled reviewed ${CHROME_MCP_PACKAGE} adapter; repair the application installation.`, { cause })
  }
}
