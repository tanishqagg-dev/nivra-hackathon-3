import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('../', import.meta.url))
const python = fileURLToPath(new URL('../../.venv-fight/bin/python', import.meta.url))
if (!existsSync(python)) {
  console.error('Run npm run fight:setup first to install the local fight model.')
  process.exit(1)
}
const fightPort = process.env.NIVRA_FIGHT_PORT ?? '18765'
const vitePort = process.env.NIVRA_VITE_PORT ?? '5173'
const children = new Set()
let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
  setTimeout(() => process.exit(code), 300).unref()
}
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
function run(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env })
  children.add(child)
  child.on('error', error => { console.error(error.message); stop(1) })
  child.on('exit', code => { children.delete(child); if (!stopping) stop(code || 1) })
  return child
}
async function health() {
  try {
    const response = await fetch(`http://127.0.0.1:${fightPort}/health`, { signal: AbortSignal.timeout(1_000) })
    return response.ok ? await response.json() : null
  } catch { return null }
}
const existing = await health()
const revision = 'a744b6af7496f0cbfa4f0ba32acd46b65e52d4e1'
if (existing && (existing.revision !== revision || existing.engine !== 'consensus-v2')) {
  console.error(`Port ${fightPort} is occupied by another service. Stop it or change the configured port.`)
  process.exit(1)
}
if (!existing) run(python, ['-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', fightPort], `${appRoot}/backend`)
const deadline = Date.now() + 90_000
let ready = false
while (Date.now() < deadline && !stopping) {
  const status = await health()
  if (status?.error) { console.error(status.error); stop(1); break }
  if (status?.ready) { ready = true; console.log(`Fight model ready on ${status.device}.`); break }
  await new Promise(resolve => setTimeout(resolve, 500))
}
if (!ready) { console.error('Fight model did not become ready.'); stop(1) }
else if (!stopping) {
  run(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', vitePort, '--strictPort'], appRoot)
  // Public copy for nivra.aestrum.in: the built app plus API and guard routes on port 4180.
  run(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', process.env.NIVRA_PUBLIC_PORT ?? '4180', '--strictPort'], appRoot)
}
