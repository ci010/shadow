const registry = 'https://packagefeedproxy.microsoft.io/npm/'

function proxyTarball(tarball) {
  if (!tarball || tarball.startsWith(registry)) return tarball
  const url = new URL(tarball)
  if (url.username || url.password) throw new Error('Registry tarball URLs must not contain credentials.')
  if (url.hostname === 'registry.npmjs.org') return registry + url.pathname.slice(1)
  const marker = '/npm/registry/'
  if (url.hostname.endsWith('.pkgs.visualstudio.com') && url.pathname.includes(marker)) {
    return registry + url.pathname.split(marker)[1]
  }
  throw new Error(`Unexpected registry tarball host: ${url.hostname}`)
}

module.exports = {
  hooks: {
    afterAllResolved(lockfile) {
      for (const pkg of Object.values(lockfile.packages ?? {})) {
        if (pkg.resolution?.tarball) {
          proxyTarball(pkg.resolution.tarball)
          // Registry packages use the configured registry plus their retained integrity.
          delete pkg.resolution.tarball
        }
      }
      return lockfile
    },
  },
  fetchers: [{
    canFetch(_id, resolution) {
      return typeof resolution.tarball === 'string' && !resolution.tarball.startsWith(registry)
    },
    fetch(_cafs, resolution) {
      // The proxy's metadata advertises its upstream feed; keep downloads on the proxy.
      return { delegate: { ...resolution, tarball: proxyTarball(resolution.tarball) } }
    },
  }],
}
