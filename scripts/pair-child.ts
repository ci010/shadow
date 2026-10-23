import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { parseBootstrapConfigV1 } from '../src/runtime/bootstrap-config.ts'
import { pairProductionChild } from '../src/runtime/production-child-pairing.ts'
import { deriveRuntimePaths } from '../src/runtime/runtime-cli.ts'

const argumentsValue = parseArguments(process.argv.slice(2))
const rawConfig = JSON.parse(await readFile(argumentsValue.configPath, 'utf8'))
const config = parseBootstrapConfigV1(rawConfig)
if (config.mode !== 'child') throw new TypeError('Pairing requires Child configuration')
const platform = process.platform === 'win32' ? 'windows' : 'posix'
const paths = deriveRuntimePaths(
  argumentsValue.configPath,
  config.dataDir,
  { platform },
)
const pin = await readPin()
const result = await pairProductionChild(config, paths, {
  offerId: argumentsValue.offerId,
  pin,
  displayName: argumentsValue.displayName,
})
console.log(JSON.stringify({
  version: 1,
  state: 'pending',
  pendingId: result.pendingId,
  requestedAt: result.requestedAt,
  deviceIdentityFingerprint: result.reference.deviceIdentityFingerprint,
  credentialReferencePath: paths.childCredentialPath,
}))

function parseArguments(args: readonly string[]): {
  configPath: string
  offerId: string
  displayName: string
} {
  let configPath: string | undefined
  let offerId: string | undefined
  let displayName: string | undefined
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    const value = args[index + 1]
    if (!['--config', '--offer', '--name'].includes(flag) || !value) {
      throw new TypeError(
        'Usage: pair-child --config <path> --offer <id> --name <display name>',
      )
    }
    index++
    if (flag === '--config') configPath = value
    else if (flag === '--offer') offerId = value
    else displayName = value
  }
  if (!configPath || !offerId || !displayName) {
    throw new TypeError(
      'Usage: pair-child --config <path> --offer <id> --name <display name>',
    )
  }
  return { configPath, offerId, displayName }
}

async function readPin(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write('Pairing PIN: ')
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const pin = line.trim()
      if (!/^\d{6}$/.test(pin)) {
        throw new TypeError('Pairing PIN must contain exactly 6 digits')
      }
      return pin
    }
    throw new TypeError('Pairing PIN is required on stdin')
  } finally {
    lines.close()
  }
}