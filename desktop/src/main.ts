import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
  type WebContents,
} from 'electron'
import {
  AtomicFileBootstrapStateStorage,
  bootstrapStatePath,
} from './bootstrap/storage.js'
import {
  AtomicRuntimeConfigWriter,
  FileRuntimeConfigReader,
  runtimeConfigPath,
} from './bootstrap/runtime-config.js'
import {
  AtomicLaunchProfileStore,
  launchProfilePath,
} from './bootstrap/launch-profile.js'
import { AtomicMainAgentConfigInitializer } from './bootstrap/main-agent-config.js'
import { BootstrapCoordinator } from './bootstrap/coordinator.js'
import {
  handleEnsureRuntime,
  handleInitializeMain,
  IPC_CHANNELS,
  parseLaunchMainOptions,
  parseSelectionId,
} from './ipc-contract.js'
import {
  type RendererTarget,
  resolveRendererTarget,
} from './renderer-target.js'
import {
  createNavigationPolicy,
  isAllowedExternalUrl,
} from './security-policy.js'
import {
  createProductionRuntimeHost,
  registerRuntimeHostQuitLifecycle,
} from './sidecar/runtime-host.js'
import { installRuntimeRequestAuthorization } from './runtime-authorization.js'
import { type WizardEvent } from './wizard/state-machine.js'

let mainWindow: BrowserWindow | null = null

export function secureWebPreferences(
  preloadPath: string,
): Electron.WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  }
}

export function enforceNavigationPolicy(
  webContents: WebContents,
  target: RendererTarget,
): void {
  const policy = createNavigationPolicy(target)
  webContents.on('will-navigate', (event, url) => {
    if (!policy.isAllowed(url)) event.preventDefault()
  })
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

export function registerIpcHandlers(coordinator: BootstrapCoordinator): void {
  ipcMain.handle(IPC_CHANNELS.loadWizard, () => coordinator.load())
  ipcMain.handle(
    IPC_CHANNELS.dispatchWizard,
    async (_event, rawEvent: unknown) => {
      const event = parseWizardEvent(rawEvent)
      return await coordinator.dispatch(event)
    },
  )
  ipcMain.handle(IPC_CHANNELS.clearWizard, () => coordinator.clear())
  ipcMain.handle(
    IPC_CHANNELS.commitMainDirectory,
    (_event, rawSelectionId: unknown) =>
      coordinator.commitMainDirectory(parseSelectionId(rawSelectionId)),
  )
  ipcMain.handle(
    IPC_CHANNELS.initializeMain,
    (_event, ...rawArguments: unknown[]) =>
      handleInitializeMain(coordinator, rawArguments),
  )
  ipcMain.handle(
    IPC_CHANNELS.launchMain,
    (_event, rawOptions: unknown) =>
      coordinator.launchMain(parseLaunchMainOptions(rawOptions)),
  )
  ipcMain.handle(
    IPC_CHANNELS.ensureRuntime,
    (_event, ...rawArguments: unknown[]) =>
      handleEnsureRuntime(coordinator, rawArguments),
  )
  ipcMain.handle(IPC_CHANNELS.selectDirectory, async () => {
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    const selectedPath = result.filePaths[0]
    if (result.canceled || selectedPath === undefined) return null
    const selectionId = randomUUID()
    coordinator.registerDirectorySelection(selectionId, selectedPath)
    return { selectionId, displayName: basename(selectedPath) }
  })
  ipcMain.handle(IPC_CHANNELS.openExternal, async (_event, url: unknown) => {
    if (typeof url !== 'string' || !isAllowedExternalUrl(url)) {
      throw new TypeError('External URL must use HTTP or HTTPS')
    }
    await shell.openExternal(url)
  })
}

export function createMainWindow(target: RendererTarget): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    webPreferences: secureWebPreferences(
      join(import.meta.dirname, 'preload.cjs'),
    ),
  })
  enforceNavigationPolicy(window.webContents, target)
  window.once('ready-to-show', () => window.show())
  return window
}

function parseWizardEvent(value: unknown): WizardEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Wizard event must be an object')
  }
  const candidate = value as Record<string, unknown>
  const allowedFields = candidate.type === 'select-role'
    ? ['type', 'mode']
    : ['type']
  if (Object.keys(candidate).some((field) => !allowedFields.includes(field))) {
    throw new TypeError('Wizard event contains unknown fields')
  }
  const eventTypes = new Set<WizardEvent['type']>([
    'select-role',
    'data-directory-selected',
    'main-initialized',
    'provider-configured',
    'local-capabilities-selected',
    'pairing-offer-entered',
    'fingerprint-verified',
    'device-named',
    'child-capabilities-selected',
    'sidecar-ready',
  ])
  if (
    typeof candidate.type !== 'string' ||
    !eventTypes.has(candidate.type as WizardEvent['type'])
  ) {
    throw new TypeError('Unknown wizard event type')
  }
  if (candidate.type === 'select-role') {
    if (candidate.mode !== 'main' && candidate.mode !== 'child') {
      throw new TypeError('select-role requires mode main or child')
    }
    return { type: candidate.type, mode: candidate.mode }
  }
  return { type: candidate.type } as WizardEvent
}

async function start(): Promise<void> {
  const userDataPath = app.getPath('userData')
  const configPath = runtimeConfigPath(userDataPath)
  const storage = new AtomicFileBootstrapStateStorage(
    bootstrapStatePath(userDataPath),
  )
  const onAuthorizationChanged = installRuntimeRequestAuthorization(
    session.defaultSession,
    (details) => details.webContentsId === mainWindow?.webContents.id,
  )
  const runtimeHost = createProductionRuntimeHost({
    executablePath: process.execPath,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath,
    packaged: app.isPackaged,
  }, onAuthorizationChanged)
  const coordinator = new BootstrapCoordinator(
    storage,
    new AtomicRuntimeConfigWriter(configPath),
    new AtomicMainAgentConfigInitializer(configPath),
    runtimeHost,
    new AtomicLaunchProfileStore(launchProfilePath(userDataPath)),
    new FileRuntimeConfigReader(configPath),
  )
  registerRuntimeHostQuitLifecycle(app, runtimeHost)
  registerIpcHandlers(coordinator)
  const developmentUrl = process.env.VITE_DEV_URL?.trim()
  const target = resolveRendererTarget({
    rendererDistPath: app.isPackaged
      ? join(process.resourcesPath, 'app-dist')
      : join(app.getAppPath(), '..', 'app', 'dist'),
    ...(developmentUrl ? { developmentUrl } : {}),
  })
  mainWindow = createMainWindow(target)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  if (target.kind === 'url') await mainWindow.loadURL(target.url)
  else await mainWindow.loadFile(target.filePath)
}

if (!process.env.SHADOW_DESKTOP_DISABLE_AUTO_START) {
  app.whenReady().then(start).catch((error: unknown) => {
    console.error('[desktop] Failed to start', error)
    app.quit()
  })
  app.on('window-all-closed', () => app.quit())
}
