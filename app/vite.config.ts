import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { fileURLToPath } from 'node:url'
import { SCOPED_BACKEND_PATTERN } from '../src/gateway/route-kind.ts'

// Default backend gateway (the Shadow bot). Override with VITE_API_TARGET if
// you run the bot on a non-default host/port.
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:3123'

export default defineConfig({
  base: './',
  plugins: [vue(), UnoCSS({
    configFile: fileURLToPath(new URL('./unocss.config.ts', import.meta.url)),
  })],
  server: {
    host: true,
    port: 5273,
    strictPort: true,
    proxy: {
      // Content calls retain their org prefix; project pages still belong to Vite.
      [SCOPED_BACKEND_PATTERN]: {
        target: API_TARGET,
        changeOrigin: true,
        ws: true,
      },
      // OTLP ingest + query + SSE streams (now served by shadow's gateway)
      '/v1': {
        target: API_TARGET,
        changeOrigin: true,
        ws: false,
      },
      // Bot config / REST API
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        ws: true,
      },
      '/nodes/v1': {
        target: API_TARGET,
        changeOrigin: true,
      },
      // Internal debug endpoints
      '/debug': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
})
