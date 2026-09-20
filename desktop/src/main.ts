import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  Tray,
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
  normalizeMainDirectoryPath,
} from './bootstrap/runtime-config.js'
import {
  AtomicLaunchProfileStore,
  launchProfilePath,
} from './bootstrap/launch-profile.js'
import { AtomicMainAgentConfigInitializer } from './bootstrap/main-agent-config.js'
import { BootstrapCoordinator } from './bootstrap/coordinator.js'
import {
  handleEnsureRuntime,
  handleGetMainDirectorySelection,
  handleInitializeMain,
  handleOpenCopilotLogin,
  handleSelectMainDirectoryPath,
  IPC_CHANNELS,
  parseLaunchMainOptions,
  parseSelectionId,
  parseNoArguments,
} from './ipc-contract.js'
import {
  type RendererTarget,
  resolveRendererTarget,
} from './renderer-target.js'
import { isAllowedExternalUrl } from './security-policy.js'
import { installNavigationPolicy } from './navigation.js'
import {
  createProductionRuntimeHost,
  registerRuntimeHostQuitLifecycle,
} from './sidecar/runtime-host.js'
import { installRuntimeRequestAuthorization, type RuntimeAuthorization } from './runtime-authorization.js'
import { type WizardEvent } from './wizard/state-machine.js'
import { resolveDesktopMainDirectory, resolveDesktopUserDataPath } from './development-profile.js'
import { desktopIconPath, framelessWindowOptions, installWindowControls, removeNativeMenus } from './window-controls.js'
import { installTrayMenu } from './tray.js'
import { installFolderDirectoryPicker } from './folder-directories.js'
import { installChatContextPickers } from './chat-context.js'
import { installDocumentTabShortcuts } from './document-tabs.js'
import { installMediaPermissions } from './media-permissions.js'
import { loadServiceConnection, selectServiceConnectionPath } from './service/connection.js'
import { createServiceBootstrapCoordinator } from './service/bootstrap.js'
import { installStartupDiagnostics } from './startup-diagnostics-ipc.js'
import { startupLogPath } from './sidecar/startup-diagnostics.js'
import { TaskbarActivity } from './taskbar-activity.js'
import { DesktopConnectionStore, RuntimeConnectionPublication } from './control/publication.js'
import type { RuntimeEndpointMessage } from './control/runtime-endpoint.js'
import { installWebPairing } from './web-pairing.js'

export { secureWebPreferences } from './window-controls.js'

let mainWindow: BrowserWindow | null = null
let mainTray: Tray | null = null

export function enforceNavigationPolicy(
  webContents: WebContents,
  target: RendererTarget,
): void {
  installNavigationPolicy(webContents, target, (url) => shell.openExternal(url), () => {
    console.error('[desktop] Failed to open an external link in the system browser.')
    dialog.showErrorBox(
      'Unable to open link',
      'The system browser could not be opened. Copy the link and open it manually.',
    )
  })
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
  ipcMain.handle(
    IPC_CHANNELS.getMainDirectorySelection,
    (_event, ...rawArguments: unknown[]) =>
      handleGetMainDirectorySelection(coordinator, rawArguments),
  )
  ipcMain.handle(
    IPC_CHANNELS.selectMainDirectoryPath,
    (_event, ...rawArguments: unknown[]) =>
      handleSelectMainDirectoryPath(coordinator, rawArguments),
  )
  ipcMain.handle(IPC_CHANNELS.selectDirectory, async (_event, ...rawArguments: unknown[]) => {
    parseNoArguments(rawArguments)
    const current = await coordinator.getMainDirectorySelection()
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      ...(current.displayPath ? { defaultPath: current.displayPath } : {}),
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    const selectedPath = result.filePaths[0]
    if (result.canceled || selectedPath === undefined) return null
    return await coordinator.selectMainDirectoryPath(selectedPath)
  })
  ipcMain.handle(IPC_CHANNELS.openExternal, async (_event, url: unknown) => {
    if (typeof url !== 'string' || !isAllowedExternalUrl(url)) {
      throw new TypeError('External URL must use HTTP or HTTPS')
    }
    await shell.openExternal(url)
  })
  ipcMain.handle(
    IPC_CHANNELS.openCopilotLogin,
    (_event, ...rawArguments: unknown[]) =>
      handleOpenCopilotLogin((url) => shell.openExternal(url), rawArguments),
  )
}

export function createMainWindow(target: RendererTarget): BrowserWindow {
  const window = new BrowserWindow(framelessWindowOptions(join(import.meta.dirname, 'preload.cjs')))
  installMediaPermissions(ipcMain, window, target, {
    getDisplaySources: () => desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 480, height: 270 },
      fetchWindowIcons: false,
    }),
  })
  removeNativeMenus(Menu, window)
  installWindowControls(ipcMain, window)
  installStartupDiagnostics(ipcMain, window, () => {
    const path = startupLogPath(app.getPath('userData'))
    if (!existsSync(path)) throw new Error('Startup log is not available')
    shell.showItemInFolder(path)
  })
  installDocumentTabShortcuts(window)
  installFolderDirectoryPicker(ipcMain, window, async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
    })
    const selectedPath = result.filePaths[0]
    return result.canceled || selectedPath === undefined
      ? null
      : normalizeMainDirectoryPath(selectedPath)
  })
  installChatContextPickers(ipcMain, window, {
    selectFiles: async () => {
      const result = await dialog.showOpenDialog(window, {
        properties: ['openFile', 'multiSelections'],
      })
      return result.canceled ? [] : result.filePaths
    },
    selectFolders: async () => {
      const result = await dialog.showOpenDialog(window, {
        properties: ['openDirectory', 'multiSelections'],
      })
      return result.canceled ? [] : result.filePaths
    },
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
  const serviceConnectionPath = selectServiceConnectionPath(
    app.commandLine.hasSwitch('service-connection')
      ? app.commandLine.getSwitchValue('service-connection')
      : undefined,
    process.env.SHADOW_SERVICE_CONNECTION,
  )
  const serviceConnection = serviceConnectionPath === undefined
    ? undefined
    : await loadServiceConnection(serviceConnectionPath)
  const configPath = runtimeConfigPath(userDataPath)
  const storage = new AtomicFileBootstrapStateStorage(
    bootstrapStatePath(userDataPath),
  )
  const onAuthorizationChanged = installRuntimeRequestAuthorization(
    session.defaultSession,
    (details) => details.webContentsId === mainWindow?.webContents.id,
  )
  let taskbarActivity: TaskbarActivity | undefined
  let activityAuthorization: RuntimeAuthorization | null = null
  const sendRuntimeEndpoint = (message: RuntimeEndpointMessage): void => {
    if (process.env.SHADOW_DESKTOP_DEV_IPC === '1' && process.connected) {
      process.send?.(message, () => {})
    }
  }
  const publication = new RuntimeConnectionPublication({
    store: new DesktopConnectionStore(userDataPath),
    isReady: (authorization) => runtimeHost.status.phase === 'ready'
      && runtimeHost.status.role === 'main' && runtimeHost.apiBase === authorization.apiBase,
    onPublished: (path) => {
      const quote = (value: string) => `'${value.replace(/'/gu, process.platform === 'win32' ? "''" : "'\\''")}'`
      if (app.isPackaged) {
        console.info('[desktop] Web access: with ELECTRON_RUN_AS_NODE=1, run:')
        console.info(`& ${quote(process.execPath)} ${quote(join(process.resourcesPath, 'backend', 'dist', 'src', 'index.js'))} web pair --connection ${quote(path)}`)
      } else console.info(`[desktop] Web access: pnpm web:pair --connection ${quote(path)}`)
    },
    onError: () => console.error('[desktop] Web pairing connection publication failed; desktop runtime status is unchanged.'),
    onUnavailable: () => sendRuntimeEndpoint({ type: 'shadow:runtime-stopped' }),
    ...(serviceConnectionPath ? { serviceConnectionPath } : {}),
  })
  const runtimeHost = createProductionRuntimeHost({
    executablePath: process.execPath,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath,
    packaged: app.isPackaged,
  }, (authorization): void => {
    onAuthorizationChanged(authorization)
    const status = runtimeHost.status
    activityAuthorization = status.phase === 'ready' && status.role === 'main' ? authorization : null
    taskbarActivity?.setAuthorization(activityAuthorization)
    sendRuntimeEndpoint(activityAuthorization
      ? { type: 'shadow:runtime-ready', apiBase: activityAuthorization.apiBase }
      : { type: 'shadow:runtime-stopped' })
    void publication.setAuthorization(activityAuthorization)
  }, serviceConnection)
  const coordinator = serviceConnection
    ? createServiceBootstrapCoordinator(serviceConnection.descriptor, runtimeHost)
    : new BootstrapCoordinator(
    storage,
    new AtomicRuntimeConfigWriter(configPath),
    new AtomicMainAgentConfigInitializer(configPath),
    runtimeHost,
    new AtomicLaunchProfileStore(launchProfilePath(userDataPath)),
    new FileRuntimeConfigReader(configPath),
    () => resolveDesktopMainDirectory(
      app.getAppPath(),
      app.isPackaged,
      process.env.SHADOW_DESKTOP_DEV_MAIN_DIRECTORY,
    ),
  )
  registerRuntimeHostQuitLifecycle(app, {
    stop: async () => {
      try { await runtimeHost.stop() } finally { await publication.close() }
    },
  })
  if (serviceConnection) {
    const result = await coordinator.ensureRuntime()
    if (!result.ok) {
      throw new Error('Service attachment failed; start the installed service or correct its connection descriptor. No sidecar was launched.')
    }
  }
  registerIpcHandlers(coordinator)
  const developmentUrl = process.env.VITE_DEV_URL?.trim()
  const target = resolveRendererTarget({
    rendererDistPath: app.isPackaged
      ? join(process.resourcesPath, 'app-dist')
      : join(app.getAppPath(), '..', 'app', 'dist'),
    ...(developmentUrl ? { developmentUrl } : {}),
  })
  mainWindow = createMainWindow(target)
  mainTray = new Tray(desktopIconPath())
  const disposeTray = installTrayMenu(mainTray, Menu, mainWindow, () => app.quit())
  app.once('will-quit', () => {
    disposeTray()
    mainTray = null
  })
  installWebPairing(ipcMain, mainWindow, () => activityAuthorization)
  taskbarActivity = new TaskbarActivity(mainWindow)
  taskbarActivity.setAuthorization(activityAuthorization)
  mainWindow.on('closed', () => {
    taskbarActivity?.dispose()
    taskbarActivity = undefined
    mainWindow = null
  })
  if (target.kind === 'url') await mainWindow.loadURL(target.url)
  else await mainWindow.loadFile(target.filePath)
}

if (!process.env.SHADOW_DESKTOP_DISABLE_AUTO_START) {
  const profilePath = resolveDesktopUserDataPath(
    app.getAppPath(),
    app.isPackaged,
    process.env.SHADOW_DESKTOP_USER_DATA || app.commandLine.getSwitchValue('user-data-dir'),
  )
  if (profilePath) {
    mkdirSync(profilePath, { recursive: true })
    app.setPath('userData', profilePath)
  }
  app.whenReady().then(start).catch((error: unknown) => {
    console.error('[desktop] Failed to start', error)
    if (app.commandLine.hasSwitch('service-connection') || process.env.SHADOW_SERVICE_CONNECTION !== undefined) {
      dialog.showErrorBox(
        'Shadow service connection failed',
        'The explicitly selected service could not be attached. Check its descriptor, credential permissions, and authenticated readiness with manage.ps1 -Action Start. No local sidecar was launched.',
      )
    }
    app.quit()
  })
  app.on('window-all-closed', () => app.quit())
}
