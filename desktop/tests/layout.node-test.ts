import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const sourceDirectory = dirname(fileURLToPath(import.meta.url))
const repository = resolve(sourceDirectory, '..', '..')
const require = createRequire(import.meta.url)

test('external Markdown links open in the system browser without navigating Electron', { timeout: 150_000 }, async (t) => {
  await runFixture(t, 'external-links-smoke')
})

test('branding assets decode in the built renderer and native desktop window', { timeout: 150_000 }, async (t) => {
  await runFixture(t, 'branding-smoke')
})

test('shared button styles reach Project settings and preserve component controls in both themes', { timeout: 150_000 }, async (t) => {
  await runFixture(t, 'button-styles-smoke')
})

test('built Vue layout stays bounded in isolated hidden Electron viewports', {
  timeout: 150_000,
}, async (t) => {
  await runFixture(t, 'layout-smoke')
})

test('session diagnosis preserves conversations and isolates trace navigation', { timeout: 150_000 }, async (t) => {
  await runFixture(t, 'diagnosis-smoke')
})

test('session handoffs stay distinct from human messages in chat and trace', { timeout: 150_000 }, async (t) => {
  await runFixture(t, 'diagnosis-smoke', ['--message-source'])
})

test('conversation summaries collapse lazily and use readable bounded Markdown without nested scrolling', { timeout: 150_000 }, async (t) => {
  await runFixture(t, 'diagnosis-smoke', ['--conversation-summary'])
})

for (const mode of ['built', 'dev']) {
  test(`conversation alignment fills desktop, mobile and split panes on ${mode} cold load`, { timeout: 150_000 }, async (t) => {
    await runFixture(t, 'diagnosis-smoke', [`--conversation-layout=${mode}`])
  })
}

test('image annotations attach original or marked pixels without changing source files', { timeout: 150_000 }, async (t) => {
  await runFixture(t, 'image-annotation-smoke')
})

test('composer file drops attach mixed types and send file-only messages on desktop and mobile', { timeout: 150_000 }, async (t) => {
  await runFixture(t, 'image-annotation-smoke', ['--file-attachments'])
})

test('Windows Explorer clipboard files paste into the Electron composer and upload only on send', {
  timeout: 150_000, skip: process.platform !== 'win32',
}, async t => {
  await runFixture(t, 'image-annotation-smoke', ['--clipboard-files'])
})

test('model menu combines model and effort without changing conversation drafts', { timeout: 150_000 }, async (t) => {
  await runFixture(t, 'model-menu-smoke')
})

test('slash command completion preserves composer input and stays bounded in normal and embedded chats', { timeout: 150_000 }, async (t) => {
  const scratch = join(repository, '.tmp')
  await mkdir(scratch, { recursive: true })
  const artifacts = await mkdtemp(join(scratch, 'slash-command-artifacts-'))
  t.diagnostic(`Slash command screenshots and results: ${artifacts}`)
  await runFixture(t, 'slash-command-smoke', [`--slash-artifacts=${artifacts}`])
})

test('command results persist outside model messages and preserve active requests in scratch chats', { timeout: 150_000 }, async (t) => {
  const scratch = join(repository, '.tmp')
  await mkdir(scratch, { recursive: true })
  const artifacts = await mkdtemp(join(scratch, 'command-result-artifacts-'))
  t.diagnostic(`Command result screenshots and evidence: ${artifacts}`)
  await runFixture(t, 'command-result-smoke', [`--command-artifacts=${artifacts}`])
})

test('execution locations retain project folders and defer remote scratch allocation', { timeout: 150_000 }, async (t) => {
  await runFixture(t, 'execution-location-smoke')
})

test('bot sidebar groups exact instances and preserves disclosure, selection and deletion across Projects', { timeout: 150_000 }, async (t) => {
  await runFixture(t, 'bot-sidebar-smoke')
})

test('sidebar selection highlights only the current chat, preserving folder drafts and disclosures', { timeout: 150_000 }, async (t) => {
  await runFixture(t, 'bot-sidebar-smoke', ['--selection-only'])
})

test('reflection selection and folder clicks preserve layout and cached Home rows', { timeout: 150_000 }, async (t) => {
  await runFixture(t, 'reflection-stability-smoke')
})

test('cached chats release connections so Nodes and Settings remain responsive', { timeout: 150_000 }, async (t) => {
  await runFixture(t, 'chat-connections-smoke')
})

test('yield questions preserve drafts and route human answers and cancellation independently of chat sends', { timeout: 150_000 }, async (t) => {
  await runFixture(t, 'yield-question-smoke')
})

test('private credential entry and publication approval preserve drafts without chat or answer submission', { timeout: 150_000 }, async (t) => {
  await runFixture(t, 'credential-request-smoke')
})

test('subagent execution modes separate reusable conversations from inspectable tasks and calls', { timeout: 150_000 }, async (t) => {
  await runFixture(t, 'subagent-mode-smoke')
})

test('native window shutdown cleans up shortcuts and IPC without accessing destroyed windows', { timeout: 150_000 }, async (t) => {
  await runFixture(t, 'window-shutdown-smoke')
})

test('settings groups providers and live channel setup with persistent drafts and protected credentials', { timeout: 150_000 }, async (t) => {
  await runFixture(t, 'settings-smoke')
})

test('timeline navigation stays pane-contained and accessible across themes and widths', { timeout: 150_000 }, async (t) => {
  await runFixture(t, 'diagnosis-smoke', ['--timeline-navigation'])
})

async function runFixture(t: TestContext, fixture: string, args: string[] = []): Promise<void> {
  const assets = join(repository, 'app', 'dist')
  await assert.doesNotReject(access(join(assets, 'index.html')), 'Build the renderer with pnpm build:app before the layout test')
  const scratch = join(repository, '.tmp')
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, 'layout-smoke-'))
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))

  await Promise.all(['layout-smoke', 'layout-preload'].map((name) => build({
    entryPoints: [join(sourceDirectory, 'fixtures', `${name === 'layout-smoke' ? fixture : name}.ts`)],
    outfile: join(directory, `${name}.cjs`),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    logLevel: 'silent',
  })))

  // Do not inherit provider credentials, NODE_OPTIONS, or ELECTRON_RUN_AS_NODE.
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) {
    env[name] = directory
  }
  const child = spawn(require('electron') as string, [
    '--enable-logging=stderr',
    `--user-data-dir=${join(directory, 'userData')}`,
    join(directory, 'layout-smoke.cjs'),
    `--layout-assets=${assets}`,
    `--layout-root=${directory}`,
    ...args,
  ], {
    cwd: directory,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (data: string) => { stdout += data })
  child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr += data })
  const closed = once(child, 'close')
  const timeout = setTimeout(() => child.kill(), 125_000)
  t.after(() => clearTimeout(timeout))
  const [code] = await closed
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith('LAYOUT_'))
  for (const line of lines) t.diagnostic(line)
  if (args.includes('--message-source') && process.env.SHADOW_LAYOUT_SCREENSHOTS) {
    const output = resolve(process.env.SHADOW_LAYOUT_SCREENSHOTS)
    await mkdir(output, { recursive: true })
    for (const width of [1400, 390]) {
      for (const view of ['chat', 'trace']) {
        const name = `message-source-${view}-${width}.png`
        try { await access(join(directory, name)) } catch { continue }
        await copyFile(join(directory, name), join(output, name))
      }
    }
  }
  if (fixture === 'button-styles-smoke' && process.env.SHADOW_LAYOUT_SCREENSHOTS) {
    const output = resolve(process.env.SHADOW_LAYOUT_SCREENSHOTS)
    await mkdir(output, { recursive: true })
    for (const width of [1440, 390]) {
      for (const theme of ['light', 'dark']) {
        const name = `buttons-${theme}-${width}.png`
        try { await access(join(directory, name)) } catch { continue }
        await copyFile(join(directory, name), join(output, name))
      }
    }
  }
  if (fixture === 'credential-request-smoke' && process.env.SHADOW_LAYOUT_SCREENSHOTS) {
    const output = resolve(process.env.SHADOW_LAYOUT_SCREENSHOTS)
    await mkdir(output, { recursive: true })
    for (const width of [1440, 390]) {
      for (const prefix of ['credential-request', 'publication-review']) {
        const name = `${prefix}-${width}.png`
        try { await access(join(directory, name)) } catch { continue }
        await copyFile(join(directory, name), join(output, name))
      }
    }
  }
  if (fixture === 'bot-sidebar-smoke' && process.env.SHADOW_LAYOUT_SCREENSHOTS) {
    const output = resolve(process.env.SHADOW_LAYOUT_SCREENSHOTS)
    await mkdir(output, { recursive: true })
    for (const width of [1440, 390]) {
      for (const state of ['bot-sidebar', 'bot-delete', 'bot-delete-error', 'bot-info', 'chat-info']) {
        if (state.endsWith('info')) {
          for (const theme of ['light', 'dark']) {
            const name = `${state}-${width}-${theme}.png`
            try { await access(join(directory, name)) } catch { continue }
            await copyFile(join(directory, name), join(output, name))
          }
          continue
        }
        const name = `${state}-${width}.png`
        try { await access(join(directory, name)) } catch { continue }
        await copyFile(join(directory, name), join(output, name))
      }
    }
  }
  if (fixture === 'chat-connections-smoke' && process.env.SHADOW_LAYOUT_SCREENSHOTS) {
    const output = resolve(process.env.SHADOW_LAYOUT_SCREENSHOTS)
    await mkdir(output, { recursive: true })
    for (const name of ['background-tasks-desktop.png', 'background-tasks-mobile.png',
      'automations-desktop.png', 'automations-mobile.png', 'automation-run-desktop.png', 'automation-run-mobile.png']) {
      if (code !== 0) {
        try { await access(join(directory, name)) } catch { continue }
      }
      await copyFile(join(directory, name), join(output, name))
    }
  }
  if (args.includes('--timeline-navigation') && process.env.SHADOW_LAYOUT_SCREENSHOTS) {
    const output = resolve(process.env.SHADOW_LAYOUT_SCREENSHOTS)
    await mkdir(output, { recursive: true })
    for (const width of [320, 390, 480, 1400]) for (const theme of ['light', 'dark']) {
      const name = `timeline-${width}-${theme}.png`
      try { await access(join(directory, name)) } catch { continue }
      await copyFile(join(directory, name), join(output, name))
    }
  }
  if (args.includes('--timeline-navigation') && process.env.SHADOW_LAYOUT_SCREENSHOTS) {
    for (const width of [390, 1400]) for (const theme of ['light', 'dark']) for (const state of ['older', 'loading', 'limit', 'boundary']) {
      const name = `timeline-${state}-${width}-${theme}.png`
      try { await access(join(directory, name)) } catch { continue }
      await copyFile(join(directory, name), join(resolve(process.env.SHADOW_LAYOUT_SCREENSHOTS), name))
    }
  }
  if (args.length && process.env.SHADOW_LAYOUT_SCREENSHOTS) {
    const output = resolve(process.env.SHADOW_LAYOUT_SCREENSHOTS)
    await mkdir(output, { recursive: true })
    const mode = args[0]!.split('=')[1]
    for (const size of ['1400', '1920', '390', 'split']) {
      const name = `conversation-${mode}-${size}.png`
      try { await access(join(directory, name)) } catch { continue }
      await copyFile(join(directory, name), join(output, name))
    }
  }
  if (fixture === 'diagnosis-smoke' && !args.length && process.env.SHADOW_LAYOUT_SCREENSHOTS) {
    const output = resolve(process.env.SHADOW_LAYOUT_SCREENSHOTS)
    await mkdir(output, { recursive: true })
    const copyScreenshot = async (name: string) => {
      if (code !== 0) {
        try { await access(join(directory, name)) } catch { return }
      }
      await copyFile(join(directory, name), join(output, name))
    }
    for (const name of ['git-changes-desktop.png', 'git-changes-mobile.png', 'folders-rail-hovercard.png']) await copyScreenshot(name)
    for (const name of ['workspace-root-desktop.png', 'workspace-root-mobile.png']) await copyScreenshot(name)
    for (const name of ['sidebar-long-info-desktop.png', 'sidebar-long-info-mobile.png']) await copyScreenshot(name)
    for (const name of ['reflection-home-desktop.png', 'reflection-home-mobile.png']) await copyScreenshot(name)
    for (const name of ['file-overlay-desktop.png', 'file-overlay-mobile.png', 'file-selection-desktop.png', 'file-selection-mobile.png', 'selection-menu-desktop.png', 'selection-menu-mobile.png', 'shared-trees-desktop.png', 'shared-trees-mobile.png', 'tool-activity-desktop.png', 'tool-activity-mobile.png', 'workbench-desktop.png', 'workbench-mobile.png']) await copyScreenshot(name)
    for (const name of ['image-draft-desktop.png', 'image-draft-mobile.png', 'providers-desktop.png', 'providers-mobile.png', 'session-files-desktop.png', 'session-files-mobile.png', 'parallel-conversations-desktop.png', 'parallel-conversations-mobile.png', 'session-heading-desktop.png', 'session-heading-mobile.png', 'diagnosis-desktop.png', 'diagnosis-mobile.png', 'bubble-timestamps.png', 'rounded-chat-desktop.png', 'rounded-chat-light.png', 'rounded-chat-mobile.png', 'nodes-capabilities-desktop.png', 'nodes-capabilities-mobile.png']) await copyScreenshot(name)
  }
  if (fixture === 'image-annotation-smoke' && process.env.SHADOW_LAYOUT_SCREENSHOTS) {
    const output = resolve(process.env.SHADOW_LAYOUT_SCREENSHOTS)
    await mkdir(output, { recursive: true })
    for (const name of ['image-markup-desktop.png', 'image-markup-mobile.png', 'file-scroll-desktop.png', 'file-scroll-mobile.png']) {
      if (code !== 0) {
        try { await access(join(directory, name)) } catch { continue }
      }
      await copyFile(join(directory, name), join(output, name))
    }
  }
  if (fixture === 'model-menu-smoke' && process.env.SHADOW_LAYOUT_SCREENSHOTS) {
    const output = resolve(process.env.SHADOW_LAYOUT_SCREENSHOTS)
    await mkdir(output, { recursive: true })
    for (const name of ['model-menu-desktop.png', 'model-menu-mobile.png', 'model-defaults-desktop.png', 'model-defaults-mobile.png']) {
      if (code !== 0) {
        try { await access(join(directory, name)) } catch { continue }
      }
      if (fixture === 'settings-smoke' && process.env.SHADOW_LAYOUT_SCREENSHOTS) {
        const output = resolve(process.env.SHADOW_LAYOUT_SCREENSHOTS)
        await mkdir(output, { recursive: true })
        for (const viewport of ['desktop', 'mobile']) {
          const name = `settings-channels-${viewport}.png`
          if (code !== 0) {
            try { await access(join(directory, name)) } catch { continue }
          }
          await copyFile(join(directory, name), join(output, name))
        }
      }
      await copyFile(join(directory, name), join(output, name))
    }
  }
  if (fixture === 'yield-question-smoke' && process.env.SHADOW_LAYOUT_SCREENSHOTS) {
    const output = resolve(process.env.SHADOW_LAYOUT_SCREENSHOTS)
    await mkdir(output, { recursive: true })
    const screenshots = [
      'yield-question-desktop.png', 'yield-question-mobile.png',
      'yield-light-1440.png', 'yield-dark-1440.png', 'yield-light-390.png', 'yield-dark-390.png',
      'yield-binary-1440.png', 'yield-binary-390.png',
      'yield-custom-2-1440.png', 'yield-custom-3-1440.png',
      'yield-custom-2-390.png', 'yield-custom-3-390.png',
      'yield-reflector-1440.png', 'yield-reflector-390.png',
      'yield-parent-1440.png', 'yield-parent-390.png',
      'ask-input-1440.png', 'ask-input-390.png',
      ...(code !== 0 ? ['yield-failure-1440.png', 'yield-failure-390.png'] : []),
    ]
    for (const name of screenshots) {
      if (code !== 0) {
        try { await access(join(directory, name)) } catch { continue }
      }
      await copyFile(join(directory, name), join(output, name))
    }
  }
  if (fixture === 'subagent-mode-smoke' && process.env.SHADOW_LAYOUT_SCREENSHOTS) {
    const output = resolve(process.env.SHADOW_LAYOUT_SCREENSHOTS)
    await mkdir(output, { recursive: true })
    for (const viewport of ['desktop', 'mobile']) {
      for (const state of ['cards', 'inspect', 'nested', 'events']) {
        const name = `subagent-mode-${state}-${viewport}.png`
        if (code !== 0) {
          try { await access(join(directory, name)) } catch { continue }
        }
        await copyFile(join(directory, name), join(output, name))
      }
    }
  }
  assert.equal(code, 0, `Hidden Electron fixture failed:\n${lines.join('\n')}\n${stderr.slice(-6_000)}`)
  assert.ok(lines.some((line) => line.startsWith('LAYOUT_RESULT ') && JSON.parse(line.slice(14)).ok === true), 'Fixture must report completed geometry assertions')
}
