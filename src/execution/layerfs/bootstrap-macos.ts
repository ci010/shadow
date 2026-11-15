/** Pinned official worktree Linux build on a macOS host. Builds in Docker,
 * never builds a Darwin addon: the official Runtime owns a Linux worker container.
 * Invoked only after the durable host-verified bootstrap decision. No WSL, sudo,
 * OS-package install, daemon restart, cleanup/replay or mutable image tags.
 */
import { bootstrapPins } from './bootstrap-script.ts'

export const bootstrapMacOSScript = String.raw`set -euo pipefail
umask 077
if [ "$#" -ne 4 ] || ! [[ "$1" =~ ^[a-f0-9]{32}$ ]]; then
  printf '%s\n' 'SHADOW_LAYERFS_BOOTSTRAP_BLOCKED={"code":"INVALID_ARGUMENTS"}'
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' 'SHADOW_LAYERFS_BOOTSTRAP_BLOCKED={"code":"PYTHON3_REQUIRED"}'
  exit 2
fi
exec python3 -I - "$@" <<'SHADOW_LAYERFS_PY'
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys

REVISION = '${bootstrapPins.revision}'
REPOSITORY = '${bootstrapPins.repository}'
BUILD_IMAGE = '${bootstrapPins.buildImage}'
RUNTIME_IMAGE = '${bootstrapPins.runtimeImage}'
BASE = Path(sys.argv[2]).parent / 'artifacts'
SOCKET = sys.argv[3]
ARCH = sys.argv[4]
PHASE = 'prerequisites'
RESERVED = False
ENV = {
    'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    'LANG': 'en_US.UTF-8', 'LC_ALL': 'en_US.UTF-8',
    'HOME': '/nonexistent', 'DOCKER_HOST': 'unix://' + SOCKET,
    'DOCKER_CONFIG': '/nonexistent', 'GIT_CONFIG_NOSYSTEM': '1',
    'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0',
    'PYTHONNOUSERSITE': '1', 'PYTHONDONTWRITEBYTECODE': '1',
}

class Refusal(Exception):
    pass

def require(ok, code):
    if not ok:
        raise Refusal(code)

def emit(prefix, value):
    print(prefix + json.dumps(value, separators=(',', ':')), flush=True)

def run(args, capture=False, timeout=None):
    result = subprocess.run([str(a) for a in args], env=ENV, check=True,
                            stdout=subprocess.PIPE if capture else None,
                            text=True, timeout=timeout)
    return result.stdout.strip() if capture else None

def docker(*args, capture=False, timeout=None):
    return run(['docker', '-H', 'unix://' + SOCKET, *args], capture, timeout)

def regular(path):
    return stat.S_ISREG(path.lstat().st_mode)

def absolute(raw):
    require(isinstance(raw, str) and raw.startswith('/') and not raw.startswith('//')
            and not any(ord(c) < 32 or ord(c) == 127 for c in raw)
            and '\\' not in raw and all(p not in ('', '.', '..') for p in raw.split('/')[1:]),
            'INVALID_PATH')
    return Path(raw)

def no_symlinks(path):
    for item in [*reversed(path.parents), path]:
        require(not item.is_symlink(), 'SYMLINK_PATH')

def sha(path):
    h = hashlib.sha256()
    # Never dereference a copied artifact's symlink, even after inventory.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), 'NONREGULAR_ARTIFACT')
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def copy_new(source, destination):
    no_symlinks(source)
    no_symlinks(destination)
    with os.fdopen(os.open(source, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as src:
        require(stat.S_ISREG(os.fstat(src.fileno()).st_mode), 'NONREGULAR_ARTIFACT')
        with destination.open('xb') as dst:
            shutil.copyfileobj(src, dst)
    require(sha(source) == sha(destination), 'COPY_HASH_MISMATCH')

def save(path, value):
    # All receipts are new files, never replacements of uncertain state.
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())

def image(reference):
    info = json.loads(docker('image', 'inspect', reference, capture=True, timeout=30))[0]
    require(info['Os'] == 'linux' and info['Architecture'] == ARCH, 'IMAGE_PLATFORM_MISMATCH')
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', info['Id']), 'INVALID_IMAGE_ID')
    # Docker canonicalizes docker.io/library/foo as foo in RepoDigests.
    expected = reference.split('@', 1)[1]
    repository = reference.split('@', 1)[0].rsplit('/', 1)[1]
    allowed = (repository, 'library/' + repository, 'docker.io/library/' + repository)
    require(any(d.split('@', 1)[0] in allowed and d.split('@', 1)[-1] == expected
                for d in info.get('RepoDigests', [])), 'IMAGE_DIGEST_MISMATCH')
    return info['Id']

def main():
    global PHASE, RESERVED
    require(len(sys.argv) == 5 and re.fullmatch(r'[a-f0-9]{32}', sys.argv[1]), 'INVALID_ARGUMENTS')
    key = sys.argv[1]
    output = absolute(sys.argv[2])
    root = BASE / key
    no_symlinks(root)
    no_symlinks(output)
    require(output != BASE and BASE not in output.parents and output not in BASE.parents,
            'OUTPUT_OVERLAPS_LINUX_STATE')
    require(output.parent.is_dir() and not output.exists(), 'NEW_OUTPUT_LEAF_REQUIRED')
    require(not root.exists(), 'EXISTING_STATE_REQUIRES_INSPECTION')
    require(sys.version_info >= (3, 9), 'PYTHON39_REQUIRED')
    require(sys.platform == 'darwin' and os.geteuid() != 0, 'MACOS_USER_REQUIRED')
    require(ARCH in ('arm64', 'amd64') and
            platform.machine() == ('arm64' if ARCH == 'arm64' else 'x86_64'), 'NATIVE_ARCH_REQUIRED')
    require(absolute(SOCKET).is_socket(), 'LOCAL_DOCKER_SOCKET_REQUIRED')
    for command in ('git', 'docker', 'python3'):
        require(shutil.which(command, path=ENV['PATH']), command.upper() + '_REQUIRED')
    server = json.loads(docker('version', '--format', '{{json .Server}}', capture=True, timeout=30))
    require(re.fullmatch(r'[0-9]+\.[0-9]+', server.get('ApiVersion', ''))
            and tuple(map(int, server['ApiVersion'].split('.'))) >= (1, 48), 'DOCKER_API_148_REQUIRED')
    engine = json.loads(docker('info', '--format', '{{json .}}', capture=True, timeout=30))
    require(engine.get('OSType') == 'linux' and engine.get('Architecture') in
            (('aarch64', 'arm64') if ARCH == 'arm64' else ('x86_64', 'amd64'))
            and not any('rootless' in v for v in engine.get('SecurityOptions', [])), 'LOCAL_ROOTFUL_DOCKER_REQUIRED')
    # The official macOS worker mounts this VM directory, not a Mac /var/lib path.
    require(engine.get('DockerRootDir') == '/var/lib/docker', 'DEFAULT_DOCKER_ROOT_REQUIRED')
    if BASE.exists():
        info = BASE.stat()
        require(BASE.is_dir() and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700,
                'PRIVATE_BOOTSTRAP_ROOT_REQUIRED')
    # Prerequisites above precede every download and resource allocation. No package
    # install, daemon restart, socket forwarding, FUSE modprobe or Docker reconfigure.
    PHASE = 'reserve'
    RESERVED = True  # Any failure from the first mutation onward is uncertain.
    if not BASE.exists():
        BASE.mkdir(mode=0o700)
    root.mkdir(mode=0o700)
    save(root / 'started.json', {'key': key, 'revision': REVISION, 'output': str(output)})
    output.mkdir(mode=0o700)
    (root / 'home').mkdir(mode=0o700)
    (root / 'docker-config').mkdir(mode=0o700)
    (root / 'bin').mkdir(mode=0o700)
    (root / 'licenses').mkdir(mode=0o700)
    ENV.update(HOME=str(root / 'home'), DOCKER_CONFIG=str(root / 'docker-config'))
    PHASE = 'pull'
    docker('pull', '--platform', 'linux/' + ARCH, BUILD_IMAGE)
    build_image = image(BUILD_IMAGE)
    docker('pull', '--platform', 'linux/' + ARCH, RUNTIME_IMAGE)
    runtime_image = image(RUNTIME_IMAGE)
    save(root / 'images.json', {'build': build_image, 'runtime': runtime_image,
                               'references': [BUILD_IMAGE, RUNTIME_IMAGE]})
    PHASE = 'source'
    source = root / 'source'
    # Fetch exactly the approved commit; do not execute mutable default-branch code,
    # Git hooks, submodules, LFS filters or caller Git configuration.
    run(['git', 'init', '--template=', source])
    run(['git', '-C', source, 'remote', 'add', 'origin', REPOSITORY])
    run(['git', '-C', source, 'fetch', '--depth=1', '--no-tags', 'origin', REVISION])
    run(['git', '-C', source, '-c', 'core.autocrlf=false', 'checkout', '--detach', REVISION])
    require(run(['git', '-C', source, 'rev-parse', 'HEAD'], capture=True) == REVISION, 'SOURCE_REVISION_MISMATCH')
    require(regular(source / 'LICENSE'), 'SOURCE_LICENSE_REQUIRED')
    copy_new(source / 'LICENSE', root / 'licenses' / 'layerfs-LICENSE')
    PHASE = 'register'
    tool = source / 'tools' / 'worktree.py'
    resources = absolute(run(['python3', tool, 'register', '--worktree', source,
                             '--root', root / 'resources', '--owner', 'shadow-' + key,
                             '--build-image', build_image, '--runtime-image', runtime_image,
                             '--sandbox-image', runtime_image], capture=True))
    no_symlinks(resources)
    require(root / 'resources' in resources.parents and resources.name == 'resources.json', 'INVALID_RESOURCE_PATH')
    record = json.loads(resources.read_text())
    state = absolute(record['state'])
    require(resources == state / 'resources.json' and record['version'] == 1
            and record['worktree'] == str(source) and record['owner'] == 'shadow-' + key
            and record['toolchain'] == '1.85.1'
            and record['images'] == {'build': build_image, 'runtime': runtime_image, 'sandbox': runtime_image},
            'RESOURCE_IDENTITY_MISMATCH')
    save(root / 'registration.json', {'resources': str(resources)})
    PHASE = 'prepare'
    run(['python3', tool, 'prepare', '--resources', resources, '--platform', 'linux'])
    PHASE = 'build'
    bundle = absolute(run(['python3', tool, 'build', '--resources', resources,
                           '--platform', 'linux', '--profile', 'release', '--jobs', '2'], capture=True))
    no_symlinks(bundle)
    require(bundle.parent == state / 'artifacts', 'INVALID_BUNDLE_PATH')
    require(not (bundle / 'manifest.json').is_symlink() and regular(bundle / 'manifest.json'), 'INVALID_MANIFEST')
    manifest = json.loads((bundle / 'manifest.json').read_text())
    require(manifest['version'] == 1 and manifest['status'] == 'sealed' and manifest['platform'] == 'linux'
            and manifest['profile'] == 'release' and manifest['source']['head'] == REVISION
            and manifest['toolchain'] == '1.85.1' and manifest['images'] == record['images']
            and manifest['worktree_id'] == record['id'] and manifest['build_id'] == bundle.name,
            'BUNDLE_IDENTITY_MISMATCH')
    files = manifest['files']
    require(isinstance(files, dict) and files, 'INVALID_BUNDLE_FILES')
    actual = set()
    for path in bundle.rglob('*'):
        require(not path.is_symlink() and (path.is_dir() or regular(path)), 'NONREGULAR_ARTIFACT')
        if path.is_file() and path != bundle / 'manifest.json':
            actual.add(path.relative_to(bundle).as_posix())
    require(actual == set(files), 'BUNDLE_NAMESPACE_MISMATCH')
    for relative, expected in files.items():
        require(isinstance(relative, str) and not relative.startswith('/')
                and all(p not in ('', '.', '..') for p in relative.split('/')) and '\\' not in relative
                and re.fullmatch(r'[a-f0-9]{64}', expected), 'INVALID_BUNDLE_FILE')
        require(sha(bundle / relative) == expected, 'BUNDLE_HASH_MISMATCH')
    for entry in ('layerfs-daemon', 'layerfs.node', 'api/package.json',
                  'api/agent/src/index.js', 'api/agent/src/internal.js', 'api/runtime/src/index.js',
                  'api/runtime/src/worker/server.js', 'api/backend/src/index.js',
                  'api/node_modules/@layerfs/agent/index.js', 'api/node_modules/@layerfs/agent/internal.js',
                  'api/node_modules/@layerfs/runtime/index.js', 'api/node_modules/@layerfs/backend/index.js'):
        require(entry in files, 'BUNDLE_LAYOUT_MISMATCH')
    PHASE = 'stage-api'
    # Copy the SEALED tree including upstream's ordinary-file resolution shims.
    # Never regenerate shims, run npm, copy from a different checkout, or link into
    # Linux source. The original bundle and its manifest remain byte-for-byte intact.
    api_files = {name: digest for name, digest in files.items() if name.startswith('api/')}
    for relative, expected in sorted(api_files.items()):
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        copy_new(bundle / relative, destination)
        require(sha(destination) == expected, 'HOST_API_HASH_MISMATCH')
    copy_new(source / 'LICENSE', output / 'LICENSE')
    # Provenance only: the host API-only copy is not itself a sealed Linux bundle.
    copy_new(bundle / 'manifest.json', output / 'sealed-bundle-manifest.json')
    save(output / 'bootstrap-receipt.json', {'revision': REVISION, 'bundle': str(bundle),
                                            'files': api_files, 'platform': 'darwin', 'architecture': ARCH})
    result = {'bundle': str(bundle), 'docker': SOCKET, 'image': runtime_image, 'revision': REVISION}
    save(root / 'completed.json', result)
    emit('SHADOW_LAYERFS_BOOTSTRAP_RESULT=', result)

try:
    main()
except Exception as error:
    # Do not leak credentials/CLI diagnostics into the structured protocol. Detailed
    # command output is for the host's bounded private job log. No cleanup on error:
    # a failed upstream build may have a container/volume still needing inspection.
    code = str(error) if isinstance(error, Refusal) else 'OPERATION_FAILED'
    emit('SHADOW_LAYERFS_BOOTSTRAP_FAILED=' if RESERVED else 'SHADOW_LAYERFS_BOOTSTRAP_BLOCKED=',
         {'code': code, 'phase': PHASE, 'state': 'unknown' if RESERVED else 'not_started'})
    sys.exit(1)
SHADOW_LAYERFS_PY
`
