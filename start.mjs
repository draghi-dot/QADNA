import { spawn } from 'child_process'
import net from 'net'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const ROOT = dirname(fileURLToPath(import.meta.url))

function waitForPort(port, maxMs = 15000) {
  const deadline = Date.now() + maxMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.createConnection(port, '127.0.0.1')
      sock.once('connect', () => { sock.destroy(); resolve() })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() < deadline) setTimeout(attempt, 400)
        else reject(new Error(`Port ${port} not ready after ${maxMs}ms`))
      })
    }
    attempt()
  })
}

function run(cmd, args, label) {
  const p = spawn(cmd, args, { cwd: ROOT, stdio: 'pipe' })
  p.stdout.on('data', d => process.stdout.write(`[${label}] ${d}`))
  p.stderr.on('data', d => process.stderr.write(`[${label}] ${d}`))
  p.on('exit', code => { if (code && code !== 0) console.error(`[${label}] exited ${code}`) })
  return p
}

console.log('[start] Starting Express server...')
const server = run(process.execPath, ['server/index.js'], 'server')

server.on('error', err => {
  console.error('[start] Failed to start server:', err.message)
  process.exit(1)
})

try {
  await waitForPort(3001)
  console.log('[start] Server ready — starting Vite...')
  const vite = run(process.execPath, ['node_modules/.bin/vite'], 'vite')
  process.on('SIGINT', () => { server.kill(); vite.kill(); process.exit(0) })
} catch (e) {
  console.error('[start]', e.message)
  server.kill()
  process.exit(1)
}
