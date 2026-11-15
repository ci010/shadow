import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { bootstrapMacOSScript } from './bootstrap-macos.ts'
import { bootstrapPins } from './bootstrap-script.ts'

// Syntax/static contract checks, never executes the provisioning script.
test('macOS recipe has valid Bash and Python syntax without provisioning', () => {
  const bash = spawnSync('/bin/bash', ['-n'], { input: bootstrapMacOSScript, encoding: 'utf8' })
  assert.equal(bash.status, 0, bash.stderr)
  const python = bootstrapMacOSScript.split("<<'SHADOW_LAYERFS_PY'\n")[1]!.split('\nSHADOW_LAYERFS_PY')[0]!
  const parsed = spawnSync('python3', ['-I', '-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: python, encoding: 'utf8' })
  assert.equal(parsed.status, 0, parsed.stderr)
})

test('macOS recipe uses exact official Linux build, native pinned images and sealed API', () => {
  assert.ok(bootstrapMacOSScript.includes(bootstrapPins.revision))
  for (const reference of [bootstrapPins.buildImage, bootstrapPins.runtimeImage]) assert.ok(bootstrapMacOSScript.includes(reference))
  assert.match(bootstrapMacOSScript, /'pull', '--platform', 'linux\/' \+ ARCH/)
  assert.match(bootstrapMacOSScript, /info\['Architecture'\] == ARCH/)
  assert.match(bootstrapMacOSScript, /IMAGE_DIGEST_MISMATCH/)
  assert.match(bootstrapMacOSScript, /--depth=1', '--no-tags', 'origin', REVISION/)
  assert.match(bootstrapMacOSScript, /'prepare', '--resources', resources, '--platform', 'linux'/)
  assert.match(bootstrapMacOSScript, /'build', '--resources', resources,\n\s*'--platform', 'linux', '--profile', 'release'/)
  assert.match(bootstrapMacOSScript, /BUNDLE_HASH_MISMATCH/)
  assert.match(bootstrapMacOSScript, /HOST_API_HASH_MISMATCH/)
  assert.doesNotMatch(bootstrapMacOSScript, /windowsIdentityMirror|NODE_RUNTIME_INCOMPATIBLE|wsl\.exe|WSL2_REQUIRED|BOOKWORM_COMPATIBLE_GLIBC_REQUIRED|FUSE_REQUIRED|\/var\/lib\/shadow-layerfs-bootstrap|docker\('rm'/)
})

test('macOS prerequisites precede reservation and retained failures remain unknown', () => {
  const reserve = bootstrapMacOSScript.indexOf('RESERVED = True')
  for (const prerequisite of ['MACOS_USER_REQUIRED', 'NATIVE_ARCH_REQUIRED', 'LOCAL_DOCKER_SOCKET_REQUIRED', 'DOCKER_API_148_REQUIRED', 'LOCAL_ROOTFUL_DOCKER_REQUIRED', 'DEFAULT_DOCKER_ROOT_REQUIRED']) assert.ok(bootstrapMacOSScript.indexOf(prerequisite) < reserve)
  assert.match(bootstrapMacOSScript, /'unknown' if RESERVED else 'not_started'/)
  assert.match(bootstrapMacOSScript, /root.mkdir\(mode=0o700\)/)
  assert.match(bootstrapMacOSScript, /no_symlinks\(output\)/)
  assert.match(bootstrapMacOSScript, /DOCKER_CONFIG=str\(root \/ 'docker-config'\)/)
  assert.match(bootstrapMacOSScript, /'DOCKER_HOST': 'unix:\/\/' \+ SOCKET/)
  assert.doesNotMatch(bootstrapMacOSScript.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n'), /sudo |modprobe |docker restart|docker system prune|shutil\.rmtree/)
})
