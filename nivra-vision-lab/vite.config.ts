import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Port of the local fight + owner API. Overridable so a second copy can run beside the live demo.
const fightApi = `http://127.0.0.1:${process.env.NIVRA_FIGHT_PORT ?? '18765'}`

const mediapipeWasmDirectory = fileURLToPath(
  new URL('./public/mediapipe/wasm/', import.meta.url),
)
const mediapipeWasmFiles = new Set([
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_module_internal.js',
  'vision_wasm_module_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
])

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'nivra-mediapipe-dev-assets',
      configureServer(server) {
        server.middlewares.use('/__nivra_wasm', (request, response, next) => {
          const fileName = request.url?.split('?')[0].split('/').pop()
          if (!fileName || !mediapipeWasmFiles.has(fileName)) {
            next()
            return
          }

          response.statusCode = 200
          response.setHeader(
            'Content-Type',
            fileName.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
          )
          response.end(readFileSync(`${mediapipeWasmDirectory}${fileName}`))
        })
      },
    },
  ],
  optimizeDeps: {
    exclude: ['@mediapipe/tasks-vision'],
  },
  worker: {
    format: 'es',
  },
  server: {
    proxy: { '/api/fight': { target: fightApi, rewrite: path => path.replace(/^\/api\/fight/, '') } },
    // No cross-origin isolation: MediaPipe runs without it, and it would block the embedded Google Map.
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin' },
  },
  preview: {
    // The public site (nivra.aestrum.in) is this preview server: app, API and guard pages on one origin.
    allowedHosts: true,
    proxy: {
      '/api/fight': { target: fightApi, rewrite: path => path.replace(/^\/api\/fight/, '') },
      '/guard': { target: `http://127.0.0.1:${process.env.NIVRA_GUARD_PORT ?? '18766'}` },
    },
    // No cross-origin isolation: MediaPipe runs without it, and it would block the embedded Google Map.
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin' },
  },
})
