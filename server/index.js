/**
 * CodeAtlas Audit Server
 * Express backend on port 3001 that clones GitHub repositories,
 * runs a static security scanner, and generates AI-powered reports.
 */

import express from 'express'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import crypto from 'crypto'
import simpleGit from 'simple-git'
import { scanRepository } from './scanner.js'
import { generateAIReport, analyzeWithStream } from './ai.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')
const TEMP_DIR = path.join(PROJECT_ROOT, 'temp')

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true })
  console.log(`[Server] Created temp directory at ${TEMP_DIR}`)
}

const app = express()
const PORT = 3001

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:5174', 'http://127.0.0.1:5173', 'http://127.0.0.1:5174'],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))

app.use(express.json())

// Request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`)
  next()
})

// ---------------------------------------------------------------------------
// In-memory audit store
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} */
const audits = new Map()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a URL is a well-formed github.com repo URL.
 * @param {string} url
 * @returns {{ valid: boolean, owner?: string, repo?: string, error?: string }}
 */
function parseGitHubUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') {
      return { valid: false, error: 'URL must use https://' }
    }
    if (parsed.hostname !== 'github.com') {
      return { valid: false, error: 'Only github.com URLs are supported' }
    }
    const parts = parsed.pathname.replace(/^\/|\/$/g, '').split('/')
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      return { valid: false, error: 'URL must be in the format https://github.com/owner/repo' }
    }
    return { valid: true, owner: parts[0], repo: parts[1] }
  } catch {
    return { valid: false, error: 'Invalid URL format' }
  }
}

/**
 * Recursively delete a directory, ignoring errors.
 * @param {string} dirPath
 */
async function safeDeleteDir(dirPath) {
  try {
    await fs.promises.rm(dirPath, { recursive: true, force: true })
  } catch (err) {
    console.error(`[Server] Failed to delete ${dirPath}:`, err.message)
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/health — liveness check
 */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', audits: audits.size })
})

/**
 * GET /api/audits — list all active audits
 */
app.get('/api/audits', (_req, res) => {
  const list = Array.from(audits.values()).map(({ auditId, repoUrl, repoName, clonedAt, status }) => ({
    auditId,
    repoUrl,
    repoName,
    clonedAt,
    status,
  }))
  res.json(list)
})

/**
 * POST /api/audit — run a full audit on a GitHub repository
 * Body: { repoUrl: string }
 */
app.post('/api/audit', async (req, res) => {
  const { repoUrl } = req.body

  if (!repoUrl) {
    return res.status(400).json({ error: 'repoUrl is required' })
  }

  const parsed = parseGitHubUrl(repoUrl)
  if (!parsed.valid) {
    return res.status(400).json({ error: parsed.error })
  }

  const { owner, repo } = parsed
  const repoName = `${owner}/${repo}`
  const auditId = crypto.randomUUID()
  const cloneDir = path.join(TEMP_DIR, auditId)
  const clonedAt = new Date().toISOString()

  console.log(`[Audit ${auditId}] Starting audit for ${repoName}`)

  // Store audit record immediately so GET /api/audits shows it as in-progress
  audits.set(auditId, { auditId, repoUrl, repoName, clonedAt, status: 'cloning' })

  // --- Step 1: Clone ---
  console.log(`[Audit ${auditId}] Cloning ${repoUrl} into ${cloneDir}`)
  try {
    const git = simpleGit()
    await git.clone(repoUrl, cloneDir, [
      '--depth', '1',         // shallow clone — only latest commit
      '--single-branch',      // no extra branch data
      '--no-tags',            // skip tags
    ])
    console.log(`[Audit ${auditId}] Clone complete`)
  } catch (err) {
    audits.delete(auditId)
    await safeDeleteDir(cloneDir)

    const msg = err.message || ''
    if (msg.includes('not found') || msg.includes('Repository not found') || msg.includes('does not exist')) {
      return res.status(400).json({ error: `Repository not found or is private: ${repoName}` })
    }
    if (msg.includes('Authentication failed') || msg.includes('could not read Username')) {
      return res.status(400).json({ error: `Repository is private or requires authentication: ${repoName}` })
    }
    console.error(`[Audit ${auditId}] Clone failed:`, msg)
    return res.status(500).json({ error: `Failed to clone repository: ${msg}` })
  }

  // --- Step 2: Scan ---
  audits.get(auditId).status = 'scanning'
  console.log(`[Audit ${auditId}] Running security scanner...`)
  let scanResult
  try {
    scanResult = await scanRepository(cloneDir)
    console.log(`[Audit ${auditId}] Scan complete — ${scanResult.findings.length} findings across ${scanResult.scannedFiles} files`)
  } catch (err) {
    audits.delete(auditId)
    await safeDeleteDir(cloneDir)
    console.error(`[Audit ${auditId}] Scan failed:`, err.message)
    return res.status(500).json({ error: `Scanner error: ${err.message}` })
  }

  // --- Step 3: AI Report ---
  audits.get(auditId).status = 'analyzing'
  console.log(`[Audit ${auditId}] Generating AI report...`)
  let aiReport
  try {
    aiReport = await generateAIReport(repoName, scanResult)
    console.log(`[Audit ${auditId}] AI report done — rating: ${aiReport.overallRating}`)
  } catch (err) {
    // AI failure is non-fatal — use fallback inside generateAIReport, but catch any unexpected throws
    console.error(`[Audit ${auditId}] Unexpected AI error:`, err.message)
    aiReport = { overallRating: 'Unknown', executiveSummary: 'AI analysis unavailable.', riskScore: 0, categories: [] }
  }

  // --- Step 4: Store and respond ---
  // Sanitize findings so snippets with unusual characters don't break JSON serialization
  // eslint-disable-next-line no-control-regex
  const sanitizeStr = (s) => (typeof s === 'string' ? s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ') : s)
  const safeFindigns = scanResult.findings.map((f) => ({
    ...f,
    snippet: sanitizeStr(f.snippet),
    description: sanitizeStr(f.description),
  }))

  const auditRecord = {
    auditId,
    repoUrl,
    repoName,
    clonedAt,
    status: 'complete',
    findings: safeFindigns,
    scanSummary: scanResult.summary,
    totalFiles: scanResult.totalFiles,
    scannedFiles: scanResult.scannedFiles,
    aiReport,
  }
  audits.set(auditId, auditRecord)

  console.log(`[Audit ${auditId}] Complete`)
  return res.json(auditRecord)
})

/**
 * POST /api/audit/start — Phase 1: clone + scan, return immediately.
 * Body: { repoUrl: string }
 * Response: { auditId, repoName, findings, summary }
 */
app.post('/api/audit/start', async (req, res) => {
  const { repoUrl } = req.body

  if (!repoUrl) {
    return res.status(400).json({ error: 'repoUrl is required' })
  }

  const parsed = parseGitHubUrl(repoUrl)
  if (!parsed.valid) {
    return res.status(400).json({ error: parsed.error })
  }

  const { owner, repo } = parsed
  const repoName = `${owner}/${repo}`
  const auditId = crypto.randomUUID()
  const cloneDir = path.join(TEMP_DIR, auditId)
  const clonedAt = new Date().toISOString()

  console.log(`[Audit ${auditId}] Phase 1 start — ${repoName}`)
  audits.set(auditId, { auditId, repoUrl, repoName, clonedAt, status: 'cloning' })

  // --- Clone ---
  console.log(`[Audit ${auditId}] Cloning ${repoUrl} into ${cloneDir}`)
  try {
    const git = simpleGit()
    await git.clone(repoUrl, cloneDir, ['--depth', '1', '--single-branch', '--no-tags'])
    console.log(`[Audit ${auditId}] Clone complete`)
  } catch (err) {
    audits.delete(auditId)
    await safeDeleteDir(cloneDir)
    const msg = err.message || ''
    if (msg.includes('not found') || msg.includes('Repository not found') || msg.includes('does not exist')) {
      return res.status(400).json({ error: `Repository not found or is private: ${repoName}` })
    }
    if (msg.includes('Authentication failed') || msg.includes('could not read Username')) {
      return res.status(400).json({ error: `Repository is private or requires authentication: ${repoName}` })
    }
    console.error(`[Audit ${auditId}] Clone failed:`, msg)
    return res.status(500).json({ error: `Failed to clone repository: ${msg}` })
  }

  // --- Scan ---
  audits.get(auditId).status = 'scanning'
  console.log(`[Audit ${auditId}] Running scanner...`)
  let scanResult
  try {
    scanResult = await scanRepository(cloneDir)
    console.log(`[Audit ${auditId}] Scan complete — ${scanResult.findings.length} findings across ${scanResult.scannedFiles} files`)
  } catch (err) {
    audits.delete(auditId)
    await safeDeleteDir(cloneDir)
    console.error(`[Audit ${auditId}] Scan failed:`, err.message)
    return res.status(500).json({ error: `Scanner error: ${err.message}` })
  }

  // Sanitize findings
  // eslint-disable-next-line no-control-regex
  const sanitizeStr = (s) => (typeof s === 'string' ? s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ') : s)
  const safeFindings = scanResult.findings.map((f) => ({
    ...f,
    snippet: sanitizeStr(f.snippet),
    description: sanitizeStr(f.description),
  }))

  // Store intermediate record so Phase 2 SSE endpoint can find it
  audits.set(auditId, {
    auditId,
    repoUrl,
    repoName,
    clonedAt,
    status: 'analyzing',
    findings: safeFindings,
    scanResult,  // keep raw scan for AI call
    scanSummary: scanResult.summary,
    totalFiles: scanResult.totalFiles,
    scannedFiles: scanResult.scannedFiles,
  })

  console.log(`[Audit ${auditId}] Phase 1 complete — returning to client`)
  return res.json({
    auditId,
    repoName,
    findings: safeFindings,
    summary: scanResult.summary,
    totalFiles: scanResult.totalFiles,
    scannedFiles: scanResult.scannedFiles,
  })
})

/**
 * GET /api/audit/:auditId/analyze — Phase 2: stream AI reasoning via SSE.
 * Sends events:
 *   data: {"type":"reasoning","text":"..."}
 *   data: {"type":"complete","report":{...}}
 *   data: [DONE]
 */
app.get('/api/audit/:auditId/analyze', async (req, res) => {
  const { auditId } = req.params

  const auditRecord = audits.get(auditId)
  if (!auditRecord) {
    return res.status(404).json({ error: `Audit ${auditId} not found` })
  }

  // SSE headers — CORS must be explicit here because EventSource ignores preflight
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.flushHeaders()

  /**
   * Write a single SSE event frame.
   * @param {object} payload
   */
  const sendEvent = (payload) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch {
      // Client disconnected — ignore
    }
  }

  console.log(`[Audit ${auditId}] Phase 2 SSE stream starting`)

  try {
    const { repoName, scanResult } = auditRecord

    const aiReport = await analyzeWithStream(repoName, scanResult, (text) => {
      sendEvent({ type: 'reasoning', text })
    })

    // Store final report
    audits.set(auditId, {
      ...auditRecord,
      aiReport,
      status: 'complete',
      scanResult: undefined, // free memory — raw scan no longer needed
    })

    console.log(`[Audit ${auditId}] Phase 2 complete — rating: ${aiReport.overallRating}`)

    sendEvent({ type: 'complete', report: aiReport })
    res.write('data: [DONE]\n\n')
  } catch (err) {
    console.error(`[Audit ${auditId}] SSE stream error:`, err.message)
    sendEvent({ type: 'error', message: err.message })
  } finally {
    res.end()
  }
})

/**
 * DELETE /api/audit/:auditId — clean up a cloned repo from disk
 */
app.delete('/api/audit/:auditId', async (req, res) => {
  const { auditId } = req.params

  if (!audits.has(auditId)) {
    return res.status(404).json({ error: `Audit ${auditId} not found` })
  }

  const cloneDir = path.join(TEMP_DIR, auditId)
  await safeDeleteDir(cloneDir)
  audits.delete(auditId)

  console.log(`[Server] Deleted audit ${auditId}`)
  return res.json({ success: true, auditId })
})

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

app.use((err, _req, res, _next) => {
  console.error('[Server] Unhandled error:', err)
  res.status(500).json({ error: 'Internal server error' })
})

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[Server] CodeAtlas audit server running on http://localhost:${PORT}`)
  console.log(`[Server] Temp directory: ${TEMP_DIR}`)
})
