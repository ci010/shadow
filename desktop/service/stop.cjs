'use strict'

// WinSW 2.12 ignores stoptimeout when stoparguments is present. Run this plain
// Node helper under Shadow.exe, not a .ps1 file blocked by LocalService's usual
// Restricted execution policy. The only PowerShell use is bounded inline native
// process inspection/termination; no script file, profile, or policy override.
const { spawnSync } = require('node:child_process')
const { readFile } = require('node:fs/promises')
const { win32: path } = require('node:path')

const GRACE_MS = 25_000
const REQUEST_TIMEOUT_MS = 2_000
const PROCESS_TIMEOUT_MS = 3_000

function samePath(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase()
}

function localPath(value) {
  return typeof value === 'string' && /^[A-Za-z]:\\/.test(value)
    && !/[\x00-\x1f"%]/.test(value) && path.normalize(value) === value
}

function exactObject(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

async function loadContext(connectionPath, read) {
  if (!localPath(connectionPath)) throw new Error('Invalid service connection path')
  const control = path.dirname(connectionPath)
  const descriptor = JSON.parse(await read(connectionPath))
  const configPath = path.join(control, 'runtime-config.v1.json')
  const credentialPath = path.join(control, 'launch-token')
  if (!exactObject(descriptor, ['version', 'serviceName', 'role', 'apiBase', 'port', 'credentialPath', 'configPath'])
    || descriptor.version !== 1 || descriptor.serviceName !== 'ShadowService' || descriptor.role !== 'main'
    || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535
    || descriptor.apiBase !== `http://127.0.0.1:${descriptor.port}`
    || !samePath(descriptor.configPath, configPath) || !samePath(descriptor.credentialPath, credentialPath)) {
    throw new Error('Invalid service connection')
  }
  const installation = JSON.parse(await read(path.join(control, 'installation.v1.json')))
  if (!exactObject(installation, ['version', 'executablePath', 'entryPath', 'desktopSid'])
    || installation.version !== 1 || !localPath(installation.executablePath)
    || !localPath(installation.entryPath) || typeof installation.desktopSid !== 'string') {
    throw new Error('Invalid service installation')
  }
  const args = `"${installation.entryPath}" server start --config "${configPath}" --service`
  return {
    descriptor,
    credentialPath,
    wrapperPath: path.join(control, 'ShadowService.exe'),
    executablePath: installation.executablePath,
    commandLines: [`"${installation.executablePath}" ${args}`, `${installation.executablePath} ${args}`],
  }
}

function validProcess(value) {
  return exactObject(value, ['pid', 'parentPid', 'executablePath', 'commandLine', 'created'])
    && Number.isSafeInteger(value.pid) && value.pid > 0
    && Number.isSafeInteger(value.parentPid) && value.parentPid >= 0
    && typeof value.executablePath === 'string' && typeof value.commandLine === 'string'
    && typeof value.created === 'string' && value.created.length > 0
}

function captureBackend(processes, context, wrapperPid, selfPid, originalWrapper) {
  if (!Array.isArray(processes) || processes.some((entry) => !validProcess(entry))) {
    throw new Error('Invalid process inspection response')
  }
  const wrapper = processes.find((entry) => entry.pid === wrapperPid)
  if (!wrapper || !samePath(wrapper.executablePath, context.wrapperPath)
    || (originalWrapper && wrapper.created !== originalWrapper.created)) {
    throw new Error('Stop helper is not owned by its installed service wrapper')
  }
  const children = processes.filter((entry) => entry.parentPid === wrapperPid && entry.pid !== selfPid)
  const backend = children.filter((entry) => samePath(entry.executablePath, context.executablePath)
    && context.commandLines.some((command) => samePath(entry.commandLine.trim(), command)))
  if (backend.length > 1 || (backend.length === 0 && children.length > 0)) {
    throw new Error('Cannot identify a unique owned backend process')
  }
  return { wrapper, backend: backend[0] }
}

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function createWindowsProcessControl({
  run = spawnSync,
  systemRoot = process.env.SystemRoot,
} = {}) {
  if (!localPath(systemRoot)) throw new Error('Windows system directory is unavailable')
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  function command(source, timeout = PROCESS_TIMEOUT_MS) {
    const utf8Source = '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\n' + source
    const result = run(powershell, ['-NoProfile', '-NonInteractive', '-Command', utf8Source], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout, maxBuffer: 128 * 1024,
    })
    if (result.error || result.status !== 0) throw new Error('Owned service process operation failed')
    return result.stdout.trim()
  }
  return {
    inspect(wrapperPid) {
      if (!Number.isSafeInteger(wrapperPid) || wrapperPid <= 0) throw new Error('Invalid wrapper PID')
      const result = command(`
        $ErrorActionPreference='Stop'
        $items=@(Get-CimInstance Win32_Process -Filter "ProcessId=${wrapperPid} OR ParentProcessId=${wrapperPid}" |
          ForEach-Object { @{
            pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId
            executablePath=[string]$_.ExecutablePath; commandLine=[string]$_.CommandLine
            created=$_.CreationDate.ToUniversalTime().ToString('o')
          } })
        ConvertTo-Json -InputObject $items -Compress
      `)
      return JSON.parse(result)
    },
    terminate(backend, wrapper, context) {
      if (!validProcess(backend) || !validProcess(wrapper)) throw new Error('Invalid process identity')
      // Re-check all identities in the same native operation that kills the exact
      // PID tree. Hold a process handle during the check to guard against PID reuse.
      command(`
        $ErrorActionPreference='Stop'
        $process=Get-Process -Id ${backend.pid} -ErrorAction SilentlyContinue
        if ($null -eq $process) { exit 0 }
        try {
          $handle=$process.Handle
          $child=Get-CimInstance Win32_Process -Filter "ProcessId=${backend.pid}"
          if ($null -eq $child) { exit 0 }
          if ($child.CreationDate.ToUniversalTime().ToString('o') -cne ${psLiteral(backend.created)}) { exit 0 }
          $parent=Get-CimInstance Win32_Process -Filter "ProcessId=${wrapper.pid}"
          if ($null -eq $parent -or $parent.CreationDate.ToUniversalTime().ToString('o') -cne ${psLiteral(wrapper.created)} -or
              $parent.ExecutablePath -ine ${psLiteral(context.wrapperPath)} -or
              $child.ParentProcessId -ne ${wrapper.pid} -or $child.ExecutablePath -ine ${psLiteral(context.executablePath)} -or
              $child.CommandLine.Trim() -ine ${psLiteral(backend.commandLine.trim())}) {
            throw 'Backend ownership changed; refusing process termination.'
          }
          & (Join-Path $env:SystemRoot 'System32\\taskkill.exe') /PID ${backend.pid} /T /F | Out-Null
          if ($LASTEXITCODE -ne 0 -and -not $process.HasExited) { throw 'Owned backend termination failed.' }
        } finally { $process.Dispose() }
      `, 5_000)
    },
  }
}

async function requestShutdown(context, {
  read, request, timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const credential = (await read(context.credentialPath)).trim()
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(credential)) throw new Error('Invalid service credential')
  const controller = new AbortController()
  let timer
  try {
    await Promise.race([
      (async () => {
        const response = await request(`${context.descriptor.apiBase}/local/v1/shutdown`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { authorization: `Bearer ${credential}`, accept: 'application/json' },
        })
        if (response.status !== 202 || response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          throw new Error('Shutdown was not accepted')
        }
        const body = await response.json()
        if (!exactObject(body, ['version', 'accepted']) || body.version !== 1 || body.accepted !== true) {
          throw new Error('Invalid shutdown response')
        }
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('Shutdown request timed out'))
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function stopService(connectionPath, {
  read = (path) => readFile(path, 'utf8'),
  request = globalThis.fetch,
  processControl = createWindowsProcessControl(),
  wrapperPid = process.ppid,
  selfPid = process.pid,
  now = () => Date.now(),
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  graceMs = GRACE_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  warn = (message) => console.error(message),
} = {}) {
  const context = await loadContext(connectionPath, read)
  const deadline = now() + graceMs
  let initial
  let inspectionFailed = false
  try {
    initial = captureBackend(await processControl.inspect(wrapperPid), context, wrapperPid, selfPid)
  } catch {
    inspectionFailed = true
  }
  if (initial && !initial.backend) return { outcome: 'graceful' }
  try {
    await requestShutdown(context, { read, request, timeoutMs: requestTimeoutMs })
  } catch {
    warn('Authenticated shutdown was unavailable; waiting for bounded owned-process fallback.')
  }
  while (now() < deadline) {
    try {
      const current = captureBackend(await processControl.inspect(wrapperPid), context, wrapperPid, selfPid, initial?.wrapper)
      inspectionFailed = false
      if (!current.backend || (initial?.backend &&
        (current.backend.pid !== initial.backend.pid || current.backend.created !== initial.backend.created))) {
        return { outcome: 'graceful' }
      }
      initial ??= current
    } catch {
      inspectionFailed = true
    }
    await delay(Math.min(200, Math.max(0, deadline - now())))
  }
  if (!initial?.backend || inspectionFailed) {
    throw new Error('Cannot verify service process ownership; no process was terminated')
  }
  warn('Backend exceeded the shutdown grace period; terminating its verified owned process tree.')
  await processControl.terminate(initial.backend, initial.wrapper, context)
  return { outcome: 'forced' }
}

module.exports = { captureBackend, createWindowsProcessControl, loadContext, requestShutdown, stopService }
if (require.main === module) {
  stopService(process.argv[2]).catch(() => {
    console.error('Service shutdown failed safely. Check SCM state, protected logs, and native process-inspection availability.')
    process.exitCode = 1
  })
}
