import { installPresence } from './presence.js'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  powerMonitor,
  protocol,
  Menu,
  nativeImage,
  Notification,
  session,
  shell,
  Tray,
  utilityProcess,
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
import { type EnsureRuntimeResult, BootstrapCoordinator } from './bootstrap/coordinator.js'
import { assertRoleDataIsolation } from './bootstrap/role-data-isolation.js'
import { DesktopRoleProfiles, parseRoleSwitchArguments } from './bootstrap/role-profiles.js'
import { RuntimeStartup } from './bootstrap/runtime-startup.js'
import { createUtilityProcessSpawn } from './sidecar/utility-process.js'
import { createBackendPairingCommand, FileChildBootstrap } from './bootstrap/child.js'
import { handlePairChild, handleSelectMainDirectoryPath } from './ipc-main-handlers.js'
import {
  handleEnsureRuntime,
  handleGetMainDirectorySelection,
  handleInitializeMain,
  handlePrepareProvider,
  handleOpenCopilotLogin,
  IPC_CHANNELS,
  parseLaunchMainOptions,
  parseSelectionId,
  parseNoArguments,
} from './ipc-contract.js'
import {
  type RendererTarget,
  resolveRendererTarget,
} from './renderer-target.js'
import { createNavigationPolicy, isAllowedExternalUrl } from './security-policy.js'
import { installNavigationPolicy } from './navigation.js'
import {
  createProductionRuntimeHost,
  registerRuntimeHostQuitLifecycle,
} from './sidecar/runtime-host.js'
import { installRuntimeRequestAuthorization, isPairedApiUrl, type RuntimeAuthorization } from './runtime-authorization.js'
import { parseWizardEvent } from './wizard/state-machine.js'
import { resolveDesktopMainDirectory, resolveDesktopUserDataPath } from './development-profile.js'
import { desktopIconPath, desktopTrayIconPath, framelessWindowOptions, installWindowControls, MAIN_WINDOW_MAX_LISTENERS, removeNativeMenus } from './window-controls.js'
import { createTrayImage, installTrayMenu } from './tray.js'
import { createDevelopmentRestart } from './development-restart.js'
import { buildDevelopmentBackend, DevelopmentBackendRestart } from './development-backend-restart.js'
import { installBackgroundWindow } from './background-window.js'
import { installFolderDirectoryPicker } from './folder-directories.js'
import { installFileExplorer } from './file-explorer.js'
import { installChatContextPickers } from './chat-context.js'
import { installDocumentTabShortcuts } from './document-tabs.js'
import { installMediaPermissions } from './media-permissions.js'
import { startupLogPath } from './sidecar/startup-diagnostics.js'
import { installStartupDiagnostics } from './startup-diagnostics-ipc.js'
import { TaskbarActivity } from './taskbar-activity.js'
import { DesktopConnectionStore, RuntimeConnectionPublication } from './control/publication.js'
import type { RuntimeEndpointMessage } from './control/runtime-endpoint.js'
import { DesktopMicroApps } from './micro-apps.js'
import { createMicroAppWindow } from './micro-app-window.js'
import { CHILD_MICRO_APP_SCHEME, parseMicroAppArguments, type MicroAppIdentity } from './micro-app-contract.js'
import { installMicroAppIpc } from './micro-app-ipc.js'
import { desktopReleaseReadiness } from './release-readiness.js'
import { readManagedDeploymentProfile, type ManagedDeploymentProfile } from './deployment-profile.js'
import { installTaskNotifications } from './task-notifications.js'
import { installClipboardFiles, readClipboardFiles, readClipboardPaths } from './clipboard-files.js'

protocol.registerSchemesAsPrivileged([{ scheme: CHILD_MICRO_APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])

export { secureWebPreferences } from './window-controls.js'

let mainWindow: BrowserWindow | null = null
let mainTray: Tray | null = null
let reopenMainWindow: (() => BrowserWindow) | undefined
let managedDeployment: ManagedDeploymentProfile | undefined
let openTaskApp: ((identity: MicroAppIdentity) => Promise<void>) | undefined
const pendingTaskApps: MicroAppIdentity[] = []

function rendererLoadErrorCode(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'errno' in error && typeof error.errno === 'number') return error.errno
  if (!(error instanceof Error)) return undefined
  const match = /\((-?\d+)\) loading /u.exec(error.message)
  return match ? Number(match[1]) : undefined
}

function showMainWindow(): void {
  const window = mainWindow ?? reopenMainWindow?.()
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show(); window.focus()
}

function requestTaskApp(identity: MicroAppIdentity): void {
  if (!openTaskApp) { pendingTaskApps.push(identity); return }
  void openTaskApp(identity).catch(() => {
    showMainWindow()
    dialog.showErrorBox('Unable to open app', 'Open Shadow Apps to check the Project, current version and its authorization.')
  })
}

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

export function registerIpcHandlers(coordinator: BootstrapCoordinator, startup: RuntimeStartup, prepareRenderer: (result: EnsureRuntimeResult, retry?: boolean) => Promise<EnsureRuntimeResult> = async result => result): void {
  const assertBootstrapSender = (event: Electron.IpcMainInvokeEvent): void => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('Bootstrap commands require the desktop main frame')
    }
  }
  ipcMain.handle(IPC_CHANNELS.childSetup, (event, ...args: unknown[]) => {
    assertBootstrapSender(event)
    parseNoArguments(args)
    return coordinator.childSetup()
  })
  ipcMain.handle(IPC_CHANNELS.pairChild, async (event, ...args: unknown[]) => {
    assertBootstrapSender(event)
    const result = await handlePairChild(coordinator, args)
    if (result.ok) void startup.start()
    return result
  })
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
    async (event, rawOptions: unknown) => {
      assertBootstrapSender(event)
      const result = await coordinator.launchMain(parseLaunchMainOptions(rawOptions))
      if (result.ok) await startup.start()
      return result
    },
  )
  ipcMain.handle(IPC_CHANNELS.prepareProvider, (event, ...rawArguments: unknown[]) => {
    assertBootstrapSender(event)
    return handlePrepareProvider({
      prepareProvider: options => startup.start(() => coordinator.prepareProvider(options)),
    }, rawArguments)
  })
  ipcMain.handle(
    IPC_CHANNELS.ensureRuntime,
    (event, ...rawArguments: unknown[]) => {
      assertBootstrapSender(event)
      return handleEnsureRuntime({ ensureRuntime: async () => prepareRenderer(await startup.current()) }, rawArguments)
    },
  )
  ipcMain.handle(IPC_CHANNELS.retryRuntime, (event, ...args: unknown[]) => {
    assertBootstrapSender(event)
    parseNoArguments(args)
    return startup.start().then(result => prepareRenderer(result, true))
  })
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

export function createMainWindow(target: RendererTarget, showOnReady = true, runtimeUserDataPath = app.getPath('userData')): BrowserWindow {
  const window = new BrowserWindow(framelessWindowOptions(join(import.meta.dirname, 'preload.cjs'), app.isPackaged))
  window.setMaxListeners(MAIN_WINDOW_MAX_LISTENERS)
  installMediaPermissions(ipcMain, window, target, {
    getDisplaySources: () => desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 480, height: 270 },
      fetchWindowIcons: false,
    }),
  })
  removeNativeMenus(Menu, window)
  installWindowControls(ipcMain, window)
  installFileExplorer(ipcMain, window, target, path => shell.showItemInFolder(path))
  installStartupDiagnostics(ipcMain, window, () => {
    const path = startupLogPath(runtimeUserDataPath)
    if (!existsSync(path)) throw new Error('Startup log is not available')
    shell.showItemInFolder(path)
  })
  installDocumentTabShortcuts(window)
  installClipboardFiles(ipcMain, window, target, async () => readClipboardFiles(await readClipboardPaths(clipboard)))
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
  window.once('ready-to-show', () => { if (showOnReady) window.show() })
  return window
}

async function start(): Promise<void> {
  const initialApp = parseMicroAppArguments(process.argv)
  const userDataPath = app.getPath('userData')
  if (app.commandLine.hasSwitch('service-connection') || process.env.SHADOW_SERVICE_CONNECTION !== undefined) {
    throw new Error('Desktop service attachment is no longer supported. Configure this desktop as Main or Child.')
  }
  const roles = await DesktopRoleProfiles.load(userDataPath)
  const roleUserDataPath = roles.userDataPath
  const configPath = runtimeConfigPath(roleUserDataPath)
  const storage = new AtomicFileBootstrapStateStorage(
    bootstrapStatePath(roleUserDataPath),
  )
  const otherRoleConfigPath = async (role: 'main' | 'child'): Promise<string> => {
    // Before the first switch, the original wizard may select either role.
    const current = (await storage.load())?.mode ?? roles.role
    return runtimeConfigPath(roles.explicit ? roles.pathFor(role)
      : current === role ? userDataPath : join(userDataPath, 'roles', role))
  }
  const onAuthorizationChanged = installRuntimeRequestAuthorization(
    session.defaultSession,
    (details) => mainWindow !== null && details.webContentsId === mainWindow.webContents.id &&
      createNavigationPolicy(target).isAllowed(mainWindow.webContents.getURL()),
  )
  let taskbarActivity: TaskbarActivity | undefined
  let microApps: DesktopMicroApps | undefined
  let activityAuthorization: RuntimeAuthorization | null = null
  let rendererAuthorization: RuntimeAuthorization | null = null
  const sendRuntimeEndpoint = (message: RuntimeEndpointMessage): void => {
    if (process.env.SHADOW_DESKTOP_DEV_IPC === '1' && process.connected) {
      process.send?.(message, () => {})
    }
  }
  const publication = new RuntimeConnectionPublication({
    store: new DesktopConnectionStore(userDataPath),
    isReady: (authorization) => runtimeHost.status.phase === 'ready'
      && runtimeHost.status.role === 'main' && runtimeHost.apiBase === authorization.apiBase,
    onPublished: () => {}, // The protected descriptor remains available to native mobile management CLI.
    onError: () => console.error('[desktop] Local management connection could not be published.'),
    onUnavailable: () => sendRuntimeEndpoint({ type: 'shadow:runtime-stopped' }),
  })
  const restart = createDevelopmentRestart(app.isPackaged, process, () => app.quit(),
    error => console.error('[desktop] Development restart request failed:', error))
  const runtimeHost = createProductionRuntimeHost({
    executablePath: process.execPath,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: roleUserDataPath,
    packaged: app.isPackaged,
  }, (authorization): void => {
    onAuthorizationChanged(authorization)
    rendererAuthorization = authorization
    const status = runtimeHost.status
    activityAuthorization = status.phase === 'ready' && status.role === 'main' ? authorization : null
    taskbarActivity?.setAuthorization(activityAuthorization)
    microApps?.setAuthorization(authorization)
    sendRuntimeEndpoint(activityAuthorization
      ? { type: 'shadow:runtime-ready', apiBase: activityAuthorization.apiBase }
      : { type: 'shadow:runtime-stopped' })
    void publication.setAuthorization(activityAuthorization)
  }, createUtilityProcessSpawn((entry, args, options) => utilityProcess.fork(entry, args, options), undefined, restart))
  const childPairingCommand = createBackendPairingCommand({
    executablePath: process.execPath, appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath, userDataPath: roleUserDataPath, packaged: app.isPackaged,
  })
  const coordinator = new BootstrapCoordinator(
    storage,
    new AtomicRuntimeConfigWriter(configPath),
    new AtomicMainAgentConfigInitializer(configPath),
    runtimeHost,
    new AtomicLaunchProfileStore(launchProfilePath(roleUserDataPath)),
    new FileRuntimeConfigReader(configPath),
    () => resolveDesktopMainDirectory(
      app.getAppPath(),
      app.isPackaged,
      process.env.SHADOW_DESKTOP_DEV_MAIN_DIRECTORY,
    ),
    new FileChildBootstrap(configPath, childPairingCommand, undefined, undefined,
      async paths => assertRoleDataIsolation(paths, await otherRoleConfigPath('main'), 'main')),
    async paths => assertRoleDataIsolation(paths, await otherRoleConfigPath('child'), 'child'),
  )
  if (roles.explicit) {
    const state = await coordinator.load()
    if (managedDeployment && roles.role !== 'main') throw new Error('Managed deployments require the Main role')
    if (state.mode === null) await coordinator.dispatch({ type: 'select-role', mode: roles.role })
    else if (state.mode !== roles.role) throw new Error('Saved role selection and setup disagree; existing profiles were not changed')
  }
  if (managedDeployment) {
    const state = await coordinator.load()
    if (state.mode === null) await coordinator.dispatch({ type: 'select-role', mode: 'main' })
    else if (state.mode !== 'main') throw new Error('Managed Main profile contains a different role; existing configuration was not changed')
  }
  const startup = new RuntimeStartup(() => coordinator.ensureRuntime(), () => runtimeHost.status)
  const devNode = process.env.SHADOW_DESKTOP_DEV_NODE
  const devPnpm = process.env.npm_execpath
  const backendRestart = restart && process.env.NODE_ENV !== 'production' && devNode && devPnpm
    ? new DevelopmentBackendRestart(
      stage => buildDevelopmentBackend(join(app.getAppPath(), '..'), stage, devNode, devPnpm),
      async (entry, activate) => {
        let replaced = false
        const result = await startup.start(() => coordinator.restartRuntime(async () => {
          await runtimeHost.replaceDevelopmentBuild(entry)
          activate()
          replaced = true
        }))
        // Re-bootstrap the existing window with the new authorization and SSE connection.
        // On startup failure, bootstrap instead displays the normal recovery screen.
        if (replaced) mainWindow?.webContents.reload()
        if (!result.ok) throw new Error(`Development backend restart failed: ${result.code}`)
      },
      error => {
        console.error('[desktop] Development backend restart failed:', error)
        dialog.showErrorBox('无法重启开发后端', '请查看运行 pnpm dev 的终端了解失败原因。')
      },
    ) : undefined
  const stop = async () => {
    try {
      await microApps?.shutdown()
      await Promise.all([runtimeHost.stop(), childPairingCommand.stop()])
    } finally { await publication.close() }
  }
  registerRuntimeHostQuitLifecycle(app, {
    stop: () => backendRestart ? backendRestart.close(stop) : stop(),
  })
  if ((await coordinator.load()).step === 'complete') void startup.start()
  ipcMain.handle(IPC_CHANNELS.switchRole, async (event, ...args: unknown[]) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('Role switching requires the desktop main frame')
    }
    if (managedDeployment) throw new Error('Managed Main deployments cannot switch roles')
    const targetRole = parseRoleSwitchArguments(args)
    await startup.current() // A pending startup must finish before the stop boundary.
    await coordinator.switchRole(targetRole, async current => {
      await microApps?.shutdown()
      await Promise.all([runtimeHost.stop(), childPairingCommand.stop()])
      await roles.select(targetRole, current)
    })
    // User initiated only. The normal quit lifecycle completes before another runtime starts.
    setTimeout(() => {
      if (restart) restart()
      else { if (app.isPackaged) app.relaunch(); app.quit() }
    }, 200)
    return { restart: app.isPackaged || !!restart }
  })
  const developmentUrl = process.env.VITE_DEV_URL?.trim()
  const localTarget = resolveRendererTarget({
    rendererDistPath: app.isPackaged
      ? join(process.resourcesPath, 'app-dist')
      : join(app.getAppPath(), '..', 'app', 'dist'),
    ...(developmentUrl ? { developmentUrl } : {}),
  })
  const target = localTarget
  session.defaultSession.webRequest.onCompleted({ urls: ['<all_urls>'] }, details => {
    if (!rendererAuthorization?.deviceGrant || details.statusCode !== 401 ||
      details.webContentsId !== mainWindow?.webContents.id ||
      !isPairedApiUrl(details.url, details.method, rendererAuthorization)) return
    const invalid = Object.entries(details.responseHeaders ?? {}).some(([key, values]) =>
      key.toLowerCase() === 'x-shadow-device-session' && values.includes('invalid'))
    if (invalid) runtimeHost.invalidateChildGrant()
  })
  registerIpcHandlers(coordinator, startup)
  for (const [channel, operation] of [[IPC_CHANNELS.childLocalStatus, 'status'], [IPC_CHANNELS.childLocalInventory, 'inventory']] as const) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      parseNoArguments(args)
      if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
        !createNavigationPolicy(target).isAllowed(event.senderFrame.url)) throw new Error('Child control requires the trusted desktop main frame')
      return runtimeHost.requestChildLocal(operation)
    })
  }
  microApps = new DesktopMicroApps({
    userDataPath, executablePath: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged,
    defaultIconPath: desktopIconPath(),
    createWindow: input => createMicroAppWindow(options => new BrowserWindow(options), input),
    decodeIcon: bytes => {
      const image = nativeImage.createFromBuffer(bytes)
      if (image.isEmpty()) throw new Error('App icon could not be decoded; publish a valid PNG')
      const size = image.getSize()
      if (size.width > 512 || size.height > 512) throw new Error('App icon exceeds 512 pixels')
      const scale = Math.min(1, 256 / Math.max(size.width, size.height))
      const resized = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) })
      return { png: resized.toPNG(), ...resized.getSize() }
    },
    setUserTasks: tasks => app.setUserTasks(tasks),
    onError: message => console.error('[desktop] Micro Apps:', message),
  })
  microApps.setAuthorization(rendererAuthorization)
  const disposeAppIpc = installMicroAppIpc(ipcMain, () => mainWindow, microApps)
  openTaskApp = async identity => {
    const runtime = await startup.current()
    if (!runtime.ok || !rendererAuthorization) throw new Error('Connected Main is unavailable')
    await microApps!.open(identity)
  }
  const openWindow = (showOnReady: boolean) => {
    const window = mainWindow = createMainWindow(target, showOnReady, roleUserDataPath)
    installTaskNotifications(ipcMain, window, target, {
      supported: () => Notification.isSupported(),
      create: message => new Notification({ ...message, icon: desktopIconPath(), silent: true }),
      onError: message => console.error('[desktop] Task notification failed:', message),
    })
    installBackgroundWindow(app, window)
    installPresence(ipcMain, window, powerMonitor)
    taskbarActivity = new TaskbarActivity(window)
    taskbarActivity.setAuthorization(activityAuthorization)
    window.once('closed', () => {
      taskbarActivity?.dispose()
      taskbarActivity = undefined
      mainWindow = null
    })
    const loaded = localTarget.kind === 'url' ? window.loadURL(localTarget.url) : window.loadFile(localTarget.filePath)
    return { window, loaded }
  }
  const initialWindow = openWindow(!initialApp)
  reopenMainWindow = () => {
    const { window, loaded } = openWindow(false)
    void loaded.catch(error => {
      if (window === mainWindow && rendererLoadErrorCode(error) !== -3) {
        dialog.showErrorBox('Unable to open Shadow', 'The desktop page could not load. Close it and try opening it again from the tray.')
      }
    })
    return window
  }
  mainTray = new Tray(createTrayImage(desktopTrayIconPath(app.isPackaged), nativeImage))
  const disposeTray = installTrayMenu(mainTray, Menu, {
    show: showMainWindow,
    release: () => mainWindow?.destroy(),
    openDevTools: () => mainWindow?.webContents.openDevTools({ mode: 'detach' }),
  }, () => app.quit(), restart, !app.isPackaged, backendRestart ? () => { void backendRestart.request() } : undefined)
  const activate = () => { if (!mainWindow) showMainWindow() }
  app.on('activate', activate)
  app.on('before-quit', () => { reopenMainWindow = undefined })
  app.once('will-quit', () => {
    app.removeListener('activate', activate)
    disposeTray()
    mainTray = null
    openTaskApp = undefined
    disposeAppIpc()
  })
  await initialWindow.loaded.catch(error => {
    if (!initialWindow.window.isDestroyed()) throw error
  })
  if (initialApp) requestTaskApp(initialApp)
  for (const identity of pendingTaskApps.splice(0)) requestTaskApp(identity)
  if (app.isPackaged && process.env.SHADOW_DESKTOP_RELEASE_IPC === '1' && process.connected) {
    const manifest: unknown = JSON.parse(await readFile(join(process.resourcesPath, 'release-manifest.v1.json'), 'utf8'))
    const readiness = await desktopReleaseReadiness(manifest,
      { pid: process.pid, executablePath: process.execPath }, await coordinator.load(), () => startup.current())
    process.send?.(readiness)
  }
}

if (!process.env.SHADOW_DESKTOP_DISABLE_AUTO_START) {
  const profileOverride = app.commandLine.getSwitchValue('user-data-dir') || process.env.SHADOW_DESKTOP_USER_DATA
  managedDeployment = profileOverride ? undefined
    : readManagedDeploymentProfile(process.resourcesPath, app.isPackaged, process.platform)
  const profilePath = resolveDesktopUserDataPath(
    app.getAppPath(),
    app.isPackaged,
    profileOverride || managedDeployment?.userDataPath,
  )
  if (profilePath) {
    mkdirSync(profilePath, { recursive: true })
    app.setPath('userData', profilePath)
  }
  if (process.platform === 'win32') {
    app.setAppUserModelId(app.isPackaged ? 'com.shadow.app'
      : `com.shadow.app.dev.${createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 12)}`)
  }
  if (!app.requestSingleInstanceLock()) app.quit()
  else {
    app.on('second-instance', (_event, argv) => {
      try {
        const identity = parseMicroAppArguments(argv)
        if (identity) requestTaskApp(identity)
        else showMainWindow()
      } catch {
        dialog.showErrorBox('Invalid app launch', 'The app task contains an invalid identity. Open it from Shadow Apps instead.')
      }
    })
    app.whenReady().then(start).catch((error: unknown) => {
      console.error('[desktop] Failed to start', error)
      dialog.showErrorBox('Shadow startup failed',
        app.commandLine.hasSwitch('service-connection') || process.env.SHADOW_SERVICE_CONNECTION !== undefined
          ? 'Desktop service attachment is no longer supported. Remove --service-connection and SHADOW_SERVICE_CONNECTION; configure this desktop as Main or Child.'
          : 'Desktop initialization failed. Check the startup diagnostics before retrying.')
      app.quit()
    })
    app.on('window-all-closed', () => {
      if (!mainTray || mainTray.isDestroyed()) app.quit()
    })
  }
}
