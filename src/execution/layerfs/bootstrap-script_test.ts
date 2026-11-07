import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { bootstrapPins, bootstrapScript as script } from './bootstrap-script.ts'

// Static/synthetic contracts only: importing a recipe must not spawn bash,
// WSL, Docker, a worker, or download/build anything. Live provisioning is outside
// this suite. Metadata expectations are sourced from the pinned upstream files:
// tools/worktree.py, tools/worktree_resources.py, tools/worktree_build.py, and
// api/runtime/src/{worker/server,platform/windows/index}.js.
const includes = (text: string) => assert.ok(script.includes(text), `missing contract: ${text}`)
const before = (first: string, last: string) => {
  includes(first); includes(last)
  assert.ok(script.indexOf(first) < script.indexOf(last), `${first} must precede ${last}`)
}
const section = (start: string, end: string) => {
  before(start, end)
  return script.slice(script.indexOf(start), script.indexOf(end))
}

test('exports only immutable, explicit official revision and image references', () => {
  assert.deepEqual(Object.keys(bootstrapPins).sort(), ['buildImage', 'repository', 'revision', 'runtimeImage'])
  assert.ok(Object.isFrozen(bootstrapPins))
  assert.equal(bootstrapPins.revision, '73d974dea8a8d0b056a16dc6b2380d89438ce484')
  assert.equal(bootstrapPins.repository, 'https://github.com/Ephemeral-AI-Lab/layerfs.git')
  assert.equal(bootstrapPins.buildImage, 'docker.io/library/rust@sha256:bf7d87666c4da6eace19e06d21bc4859c6e2a5c97a21ac273b0e082112753cf0')
  assert.equal(bootstrapPins.runtimeImage, 'docker.io/library/node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5')
  for (const pin of Object.values(bootstrapPins)) includes(pin)
  assert.doesNotMatch(script, /\$\{bootstrapPins|rust:latest|node:latest|rust:1\.85|node:22/)
})

test('bash accepts precisely key and output path; no shell construction from either argument', () => {
  includes('set -euo pipefail\numask 077')
  includes('[ "$#" -ne 2 ] || ! [[ "$1" =~ ^[a-f0-9]{32}$ ]]')
  includes('exec python3 -I - "$@" <<\'SHADOW_LAYERFS_PY\'')
  includes("len(sys.argv) == 3 and re.fullmatch(r'[a-f0-9]{32}', sys.argv[1])")
  includes("output = absolute(sys.argv[2])")
  includes("root = BASE / key")
  assert.doesNotMatch(script, /shell=True|\beval\b|bash -c|sh -c/)
  assert.equal(script.split("<<'SHADOW_LAYERFS_PY'").length, 2)
  assert.ok(script.endsWith('SHADOW_LAYERFS_PY\n'))
})

test('rejects ambiguous/escaping/symlinked paths and preexisting state', () => {
  includes("raw.startswith('/') and not raw.startswith('//')")
  includes("not any(ord(c) < 32 or ord(c) == 127 for c in raw)")
  includes(String.raw`'\\' not in raw and all(p not in ('', '.', '..') for p in raw.split('/')[1:])`)
  includes("require(not item.is_symlink(), 'SYMLINK_PATH')")
  includes('no_symlinks(root)\n    no_symlinks(output)')
  includes("output.parent.is_dir() and not output.exists(), 'NEW_OUTPUT_LEAF_REQUIRED'")
  includes("not root.exists(), 'EXISTING_STATE_REQUIRES_INSPECTION'")
  includes("output != BASE and BASE not in output.parents and output not in BASE.parents")
  includes('info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700')
  before("'EXISTING_STATE_REQUIRES_INSPECTION'", "PHASE = 'reserve'")
})

test('checks existing supported prerequisites before all mutation/downloads', () => {
  const checks = section('def main():', "PHASE = 'reserve'")
  for (const code of ['PYTHON39_REQUIRED', 'WSL_ROOT_REQUIRED', 'LINUX_AMD64_REQUIRED', 'WSL2_REQUIRED',
    'BOOKWORM_COMPATIBLE_GLIBC_REQUIRED', 'FUSE_REQUIRED', 'LOCAL_DOCKER_SOCKET_REQUIRED',
    'DOCKER_API_148_REQUIRED', 'LOCAL_ROOTFUL_DOCKER_REQUIRED', 'DOCKER_ROOT_NOT_LOCAL']) {
    assert.ok(checks.includes(code), code)
  }
  assert.ok(checks.includes("('git', 'docker', 'stat')"))
  assert.ok(checks.includes("server['ApiVersion'].split('.'))) >= (1, 48)"))
  assert.ok(checks.includes('local_filesystem(docker_root)'))
  includes("kind in ('ext2/ext3', 'ext4', 'xfs', 'btrfs')")
  before("PHASE = 'reserve'", "docker('pull'")
  assert.doesNotMatch(checks, /\.mkdir\(|docker\('(?:pull|create|run|start)'|run\(\['git'/)
})

test('custom Docker roots are blocked before reservation or downloads to match Windows storePath', () => {
  const guard = "require(engine.get('DockerRootDir') == '/var/lib/docker', 'DEFAULT_DOCKER_ROOT_REQUIRED')"
  includes(guard)
  before(guard, "docker_root = absolute(engine['DockerRootDir'])")
  before(guard, "PHASE = 'reserve'")
  before(guard, 'RESERVED = True  #')
  before(guard, 'BASE.mkdir(mode=0o700)')
  before(guard, "docker('pull'")
  const checks = section('def main():', guard)
  assert.doesNotMatch(checks, /\.mkdir\(|docker\('(?:pull|create|run|start)'|run\(\['git'/)
  includes('Conservative compatibility floor for this pinned Rust 1.85.1 Bookworm')
  includes('not a general LayerFS requirement')
  includes('https://packages.debian.org/bookworm/libc6')
})

test('scopes Git and Docker configuration rather than inheriting user credentials or context', () => {
  includes("'DOCKER_HOST': 'unix:///var/run/docker.sock'")
  includes("'GIT_CONFIG_NOSYSTEM': '1'")
  includes("'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0'")
  includes("'PYTHONNOUSERSITE': '1', 'PYTHONDONTWRITEBYTECODE': '1'")
  includes("ENV.update(HOME=str(root / 'home'), DOCKER_CONFIG=str(root / 'docker-config'))")
  includes("['docker', '-H', 'unix:///var/run/docker.sock', *args]")
  assert.doesNotMatch(script, /os\.environ|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|resolv\.conf|daemon\.json/)
})

test('pulls only pinned amd64 manifests and verifies installed immutable IDs and repository digests', () => {
  includes("docker('pull', '--platform', 'linux/amd64', BUILD_IMAGE)")
  includes("docker('pull', '--platform', 'linux/amd64', RUNTIME_IMAGE)")
  includes("info['Os'] == 'linux' and info['Architecture'] == 'amd64'")
  includes("re.fullmatch(r'sha256:[a-f0-9]{64}', info['Id'])")
  includes("allowed = (repository, 'library/' + repository, 'docker.io/library/' + repository)")
  includes("d.split('@', 1)[0] in allowed and d.split('@', 1)[-1] == expected")
  includes("for d in info.get('RepoDigests', [])")
  before('build_image = image(BUILD_IMAGE)', "PHASE = 'register'")
  before('runtime_image = image(RUNTIME_IMAGE)', "PHASE = 'register'")
})

test('fetches exact official commit without checkout hooks, recursive submodules or mutable refs', () => {
  includes("run(['git', 'init', '--template=', source])")
  includes("run(['git', '-C', source, 'remote', 'add', 'origin', REPOSITORY])")
  includes("run(['git', '-C', source, 'fetch', '--depth=1', '--no-tags', 'origin', REVISION])")
  includes("'-c', 'core.autocrlf=false', 'checkout', '--detach', REVISION")
  includes("'rev-parse', 'HEAD'], capture=True) == REVISION")
  assert.doesNotMatch(script, /--recurse-submodules|git.*(?:'pull'|'main'|'master')/)
})

test('uses exact official register, prepare and offline locked native build entrypoints', () => {
  includes("tool = source / 'tools' / 'worktree.py'")
  includes("['python3', tool, 'register', '--worktree', source,")
  includes("'--root', root / 'resources', '--owner', 'shadow-' + key,")
  includes("'--build-image', build_image, '--runtime-image', runtime_image,")
  includes("'--sandbox-image', runtime_image]")
  includes("['python3', tool, 'prepare', '--resources', resources, '--platform', 'linux']")
  includes("['python3', tool, 'build', '--resources', resources,\n                           '--platform', 'linux', '--profile', 'release', '--jobs', '2']")
  before("PHASE = 'register'", "PHASE = 'prepare'")
  before("PHASE = 'prepare'", "PHASE = 'build'")
  assert.doesNotMatch(script, /--dependency-seed|cleanup-scope|--release-caches|--release-failed|cargo install|npm install/)
})

test('registration fields match upstream worktree_resources.py, not inferred artifact names', () => {
  includes("resources.name == 'resources.json'")
  includes("resources == state / 'resources.json' and record['version'] == 1")
  includes("record['worktree'] == str(source) and record['owner'] == 'shadow-' + key")
  includes("record['toolchain'] == '1.85.1'")
  includes("record['images'] == {'build': build_image, 'runtime': runtime_image, 'sandbox': runtime_image}")
  includes("save(root / 'registration.json', {'resources': str(resources)})")
  includes("bundle.parent == state / 'artifacts'")
})

test('sealed metadata matches worktree_build.py and every namespace/hash is verified', () => {
  for (const field of ["manifest['version'] == 1", "manifest['status'] == 'sealed'", "manifest['platform'] == 'linux'",
    "manifest['profile'] == 'release'", "manifest['source']['head'] == REVISION", "manifest['toolchain'] == '1.85.1'",
    "manifest['images'] == record['images']", "manifest['worktree_id'] == record['id']",
    "manifest['build_id'] == bundle.name", "files = manifest['files']"]) includes(field)
  includes("not (bundle / 'manifest.json').is_symlink() and regular(bundle / 'manifest.json')")
  includes("not path.is_symlink() and (path.is_dir() or regular(path))")
  includes("actual == set(files), 'BUNDLE_NAMESPACE_MISMATCH'")
  includes("all(p not in ('', '.', '..') for p in relative.split('/'))")
  includes("sha(bundle / relative) == expected, 'BUNDLE_HASH_MISMATCH'")
  includes('os.O_RDONLY | os.O_NOFOLLOW')
  includes("stat.S_ISREG(os.fstat(stream.fileno()).st_mode)")
  before("'BUNDLE_HASH_MISMATCH'", "PHASE = 'node'")
})

test('matching Windows API copy includes the real files and ordinary-file resolution shims', () => {
  for (const entry of ['layerfs-daemon', 'layerfs.node', 'api/package.json', 'api/agent/src/index.js',
    'api/agent/src/internal.js', 'api/runtime/src/index.js', 'api/runtime/src/worker/server.js',
    'api/backend/src/index.js', 'api/node_modules/@layerfs/agent/index.js',
    'api/node_modules/@layerfs/agent/internal.js', 'api/node_modules/@layerfs/runtime/index.js',
    'api/node_modules/@layerfs/backend/index.js']) includes(`'${entry}'`)
  includes("api_files = {name: digest for name, digest in files.items() if name.startswith('api/')}")
  includes('copy_new(bundle / relative, destination)')
  includes("sha(destination) == expected, 'HOST_API_HASH_MISMATCH'")
  includes("with destination.open('xb') as dst:")
  includes("copy_new(bundle / 'manifest.json', output / 'sealed-bundle-manifest.json')")
  // No symlinks, npm install, rewritten package exports or modified sealed files.
  assert.doesNotMatch(script, /\.symlink_to\(|os\.symlink\(|copytree\(|write_text\(|bundle.*chmod\(/)
})

test('retains MIT copyright/permission notice and fails rather than fabricating a Node license copy', () => {
  includes("copy_new(source / 'LICENSE', root / 'licenses' / 'layerfs-LICENSE')")
  includes("copy_new(source / 'LICENSE', output / 'LICENSE')")
  includes("docker('cp', container + ':/usr/local/LICENSE', root / 'licenses' / 'node-LICENSE')")
  includes("'NODE_LICENSE_REQUIRED'")
  before("'NODE_LICENSE_REQUIRED'", "docker('rm', container)")
})

test('extracts standalone Node without starting a container and removes only known owned stopped ID', () => {
  includes("docker('create', '--platform', 'linux/amd64', '--pull', 'never', '--network', 'none'")
  includes("'--name', name, '--label', 'shadow.layerfs.bootstrap=' + key")
  includes("'--entrypoint', '/bin/true', runtime_image")
  includes("save(root / 'node-container.json', {'id': container, 'name': name, 'image': runtime_image})")
  includes("node = root / 'bin' / 'node'")
  includes("docker('cp', container + ':/usr/local/bin/node', node)")
  includes("not node.is_symlink() and regular(node)")
  includes("run([node, '--version'], capture=True, timeout=15)")
  includes("version == 'v22.23.2'")
  const ownership = section("info = json.loads(docker('inspect', container", "docker('rm', container)")
  for (const expected of ["info['Id'] == container", "info['Name'] == '/' + name", "info['Image'] == runtime_image",
    "info['Config']['Labels'].get('shadow.layerfs.bootstrap') == key", "info['State']['Status'] == 'created'",
    "not info['State']['Running']"]) assert.ok(ownership.includes(expected), expected)
  assert.equal([...script.matchAll(/docker\('rm',/g)].length, 1)
  assert.doesNotMatch(script, /docker\('(?:start|run|kill|stop|prune)'|docker\('rm',.*(?:'-f'|'--force')/)
})

test('single-line result has only agreed installation fields, after durable completion receipt', () => {
  includes("result = {'bundle': str(bundle), 'node': str(node), 'image': runtime_image, 'revision': REVISION}")
  includes("print(prefix + json.dumps(value, separators=(',', ':')), flush=True)")
  before("save(root / 'completed.json', result)", "emit('SHADOW_LAYERFS_BOOTSTRAP_RESULT=', result)")
  assert.equal([...script.matchAll(/emit\('SHADOW_LAYERFS_BOOTSTRAP_RESULT='/g)].length, 1)
  includes("with path.open('x', encoding='utf-8') as stream:")
  includes('os.fsync(stream.fileno())')
})

test('failures retain uncertain state with safe machine-readable codes and never replay/clean broadly', () => {
  includes("'SHADOW_LAYERFS_BOOTSTRAP_FAILED=' if RESERVED else 'SHADOW_LAYERFS_BOOTSTRAP_BLOCKED='")
  includes("'state': 'unknown' if RESERVED else 'not_started'")
  includes("code = str(error) if isinstance(error, Refusal) else 'OPERATION_FAILED'")
  before('RESERVED = True  #', 'BASE.mkdir(mode=0o700)')
  includes("save(root / 'started.json'")
  assert.doesNotMatch(script, /\b(?:sudo|apt-get|dnf|yum|systemctl)\b|rmtree\(|\.unlink\(|docker.*prune|retry\(/)
  assert.doesNotMatch(script, /OfficeAgent|wsl\.exe|--force|--discard|worker.*--stdin/)
  // No shell traps or Python finally cleanup that could discard unknown effects.
  assert.doesNotMatch(script, /\btrap\b|^finally:/m)
})

test('Windows identity mirror fixes pinned shim-relative hash reads without loading a second SDK', async () => {
  includes("relative.startswith('api/agent/src/')")
  includes("mirror = 'api/node_modules/@layerfs/' + relative.removeprefix('api/agent/')")
  includes("'windowsIdentityMirror': identity_mirror")
  includes("sha(destination) == expected, 'HOST_IDENTITY_HASH_MISMATCH'")
  const dir = await mkdtemp(join(process.cwd(), '.layerfs-bootstrap-contract-'))
  const put = async (relative: string, value: string) => {
    const path = join(dir, relative)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, value)
  }
  try {
    const agentFiles = {
      'src/index.js': 'export const identity = {};\n',
      'src/internal.js': 'export { identity } from "./index.js";\n',
    }
    await put('api/package.json', '{"type":"module"}')
    await put('api/agent/package.json', JSON.stringify({
      name: '@layerfs/agent', type: 'module', exports: { '.': './src/index.js', './internal': './src/internal.js' },
    }))
    for (const [file, content] of Object.entries(agentFiles)) await put(`api/agent/${file}`, content)
    // These are exactly copy_sdk/shim's relative package targets, not symlinks.
    await put('api/node_modules/@layerfs/agent/package.json', JSON.stringify({
      name: '@layerfs/agent', type: 'module', exports: { '.': './index.js', './internal': './internal.js' },
    }))
    await put('api/node_modules/@layerfs/agent/index.js', 'export * from "../../../agent/src/index.js";\n')
    await put('api/node_modules/@layerfs/agent/internal.js', 'export * from "../../../agent/src/internal.js";\n')
    await put('api/runtime/src/probe.js', `
      import { identity } from '@layerfs/agent';
      import { identity as internal } from '@layerfs/agent/internal';
      export { identity, internal };
      export const sdkRoot = new URL('../', import.meta.resolve('@layerfs/agent'));
    `)
    const probe = await import(pathToFileURL(join(dir, 'api/runtime/src/probe.js')).href)
    const direct = await import(pathToFileURL(join(dir, 'api/agent/src/index.js')).href)
    assert.equal(probe.identity, direct.identity)
    assert.equal(probe.internal, direct.identity)
    const identityRoot = fileURLToPath(probe.sdkRoot)
    assert.equal(join(identityRoot, 'src/index.js'), join(dir, 'api/node_modules/@layerfs/src/index.js'))
    // Without accommodation the official shim's SDK hash-read path is absent.
    await assert.rejects(readFile(join(identityRoot, 'src/index.js')), { code: 'ENOENT' })
    for (const [file, content] of Object.entries(agentFiles)) {
      await put(`api/node_modules/@layerfs/${file}`, content)
      const sealed = await readFile(join(dir, 'api/agent', file))
      const mirrored = await readFile(join(identityRoot, file))
      assert.deepEqual(mirrored, sealed)
      assert.equal(createHash('sha256').update(mirrored).digest('hex'), createHash('sha256').update(sealed).digest('hex'))
    }
    assert.equal((await import(pathToFileURL(join(dir, 'api/runtime/src/probe.js')).href)).identity, direct.identity)
    assert.equal(await readFile(join(dir, 'api/node_modules/@layerfs/agent/index.js'), 'utf8'),
      'export * from "../../../agent/src/index.js";\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
