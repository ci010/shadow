import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vite'
import appConfig from './vite.config.ts'

// Build the local-only experiment separately; it is not a new application/router entry.
export default mergeConfig(appConfig, defineConfig({
  build: {
    outDir: 'dist-alignment',
    rollupOptions: { input: fileURLToPath(new URL('./alignment-lab.html', import.meta.url)) },
  },
}))
