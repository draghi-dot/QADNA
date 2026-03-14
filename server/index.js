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
import crypto from 'crypto'
import simpleGit from 'simple-git'
import OpenAI from 'openai'
import { scanRepository } from './scanner.js'
import { buildDependencyGraph } from './graph.js'

// ---------------------------------------------------------------------------
// AI Client — always Kimi K2.5 via Featherless
// ---------------------------------------------------------------------------

const featherless = new OpenAI({
  baseURL: 'https://api.featherless.ai/v1',
  apiKey: 'rc_22250c67de3c61dd84d6ef100e62e37a37991bae06be0510829b73ac29b903f5',
})

const KIMI = 'moonshotai/Kimi-K2.5'

/**
 * Call Kimi with streaming.
 * @param {{ role: string, content: string }[]} messages
 * @param {(text: string) => void} onDelta
 * @returns {Promise<string>}
 */
async function callAIStream(messages, onDelta) {
  const stream = await featherless.chat.completions.create({
    model: KIMI,
    max_tokens: 4096,
    messages,
    stream: true,
  })
  let full = ''
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content || ''
    if (delta) { onDelta(delta); full += delta }
  }
  return full
}

/**
 * Call Kimi non-streaming.
 * @param {{ role: string, content: string }[]} messages
 * @returns {Promise<string>}
 */
async function callAI(messages) {
  const response = await featherless.chat.completions.create({
    model: KIMI,
    max_tokens: 4096,
    messages,
  })
  return response.choices[0]?.message?.content || ''
}

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

/**
 * Sanitize control characters from a string so it serializes safely to JSON.
 * @param {string} s
 * @returns {string}
 */
// eslint-disable-next-line no-control-regex
const sanitizeStr = (s) => (typeof s === 'string' ? s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ') : s)

/**
 * Build a fallback AI report from raw scan data when AI is unavailable.
 * @param {string} repoName
 * @param {{ findings: object[], summary: object }} scanResult
 * @returns {object}
 */
function buildFallbackReport(repoName, scanResult) {
  const { summary, findings } = scanResult
  const total = Object.values(summary).reduce((a, b) => a + b, 0)

  let overallRating = 'Secure'
  if (summary.critical > 0) overallRating = 'Critical'
  else if (summary.high > 5) overallRating = 'Vulnerable'
  else if (summary.high > 0 || summary.medium > 3) overallRating = 'Needs Attention'

  const riskScore = Math.min(
    100,
    summary.critical * 25 + summary.high * 10 + summary.medium * 4 + summary.low * 1,
  )

  const categoryMap = {}
  for (const f of findings) {
    if (!categoryMap[f.category]) {
      categoryMap[f.category] = { count: 0, severity: f.severity }
    }
    categoryMap[f.category].count++
  }

  const categories = Object.entries(categoryMap).map(([name, { count, severity }]) => ({
    name,
    severity,
    count,
    explanation: `${count} instance(s) detected.`,
    remediation: 'Review each flagged location and apply appropriate fixes.',
  }))

  return {
    overallRating,
    executiveSummary: `Static analysis of ${repoName} found ${total} issue(s) across ${Object.keys(categoryMap).length} category(ies). Manual review is recommended for all flagged items.`,
    riskScore,
    categories,
    generatedByFallback: true,
  }
}

/**
 * Parse the accumulated AI text into a structured report object.
 * @param {string} rawText
 * @param {string} repoName
 * @param {{ findings: object[], summary: object }} scanResult
 * @returns {object}
 */
function parseAIReport(rawText, repoName, scanResult) {
  try {
    const cleaned = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim()
    const parsed = JSON.parse(cleaned)
    if (!parsed.overallRating || !parsed.executiveSummary || typeof parsed.riskScore !== 'number') {
      throw new Error('Missing required fields in AI response')
    }
    return parsed
  } catch (err) {
    console.error('[AI] Failed to parse AI response, using fallback.', err.message)
    return buildFallbackReport(repoName, scanResult)
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
 * POST /api/repo/clone — fast clone only, returns immediately after git clone.
 * Body: { repoUrl: string }
 * Response: { repoId, repoName, repoUrl }
 */
app.post('/api/repo/clone', async (req, res) => {
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
  const repoId = crypto.randomUUID()
  const cloneDir = path.join(TEMP_DIR, repoId)
  const clonedAt = new Date().toISOString()

  console.log(`[Clone ${repoId}] Cloning ${repoUrl}`)
  audits.set(repoId, { auditId: repoId, repoId, repoUrl, repoName, clonedAt, status: 'cloning' })

  try {
    const git = simpleGit()
    await git.clone(repoUrl, cloneDir, [
      '--depth', '1',
      '--single-branch',
      '--no-tags',
    ])
    console.log(`[Clone ${repoId}] Done`)
  } catch (err) {
    audits.delete(repoId)
    await safeDeleteDir(cloneDir)

    const msg = err.message || ''
    if (msg.includes('not found') || msg.includes('Repository not found') || msg.includes('does not exist')) {
      return res.status(400).json({ error: `Repository not found or is private: ${repoName}` })
    }
    if (msg.includes('Authentication failed') || msg.includes('could not read Username')) {
      return res.status(400).json({ error: `Repository is private or requires authentication: ${repoName}` })
    }
    console.error(`[Clone ${repoId}] Failed:`, msg)
    return res.status(500).json({ error: `Failed to clone repository: ${msg}` })
  }

  audits.get(repoId).status = 'cloned'
  return res.json({ repoId, repoName, repoUrl })
})

/**
 * POST /api/audit/run — scan + AI analysis for a previously cloned repo via SSE.
 * Body: { repoId: string }
 * SSE events:
 *   { type: 'scan_start' }
 *   { type: 'scan_complete', findings, summary, totalFiles, scannedFiles }
 *   { type: 'reasoning', text }
 *   { type: 'complete', report }
 *   { type: 'error', message }
 */
app.post('/api/audit/run', async (req, res) => {
  const { repoId } = req.body

  if (!repoId) {
    return res.status(400).json({ error: 'repoId is required' })
  }

  const auditRecord = audits.get(repoId)
  if (!auditRecord) {
    return res.status(404).json({ error: `No cloned repo found for id ${repoId}. Please clone first.` })
  }

  const cloneDir = path.join(TEMP_DIR, repoId)
  if (!fs.existsSync(cloneDir)) {
    return res.status(404).json({ error: `Clone directory not found for ${repoId}. Please clone again.` })
  }

  const { repoName, repoUrl } = auditRecord

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.flushHeaders()

  const sendEvent = (payload) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch {
      // client disconnected
    }
  }

  console.log(`[Audit ${repoId}] Run starting — ${repoName}`)
  audits.get(repoId).status = 'scanning'

  try {
    // --- Scan ---
    sendEvent({ type: 'scan_start' })
    console.log(`[Audit ${repoId}] Running scanner...`)
    let scanResult
    try {
      scanResult = await scanRepository(cloneDir)
      console.log(`[Audit ${repoId}] Scan complete — ${scanResult.findings.length} findings`)
    } catch (err) {
      audits.get(repoId).status = 'error'
      sendEvent({ type: 'error', message: `Scanner error: ${err.message}` })
      res.end()
      return
    }

    // Sanitize findings
    const safeFindings = scanResult.findings.map((f) => ({
      ...f,
      snippet: sanitizeStr(f.snippet),
      description: sanitizeStr(f.description),
    }))

    // Store findings in audit record
    audits.set(repoId, {
      ...auditRecord,
      status: 'analyzing',
      findings: safeFindings,
      scanResult,
      scanSummary: scanResult.summary,
      totalFiles: scanResult.totalFiles,
      scannedFiles: scanResult.scannedFiles,
    })

    sendEvent({
      type: 'scan_complete',
      findings: safeFindings,
      summary: scanResult.summary,
      totalFiles: scanResult.totalFiles,
      scannedFiles: scanResult.scannedFiles,
    })

    // --- AI Analysis ---
    audits.get(repoId).status = 'analyzing'
    console.log(`[Audit ${repoId}] Running AI analysis...`)

    const { findings, summary } = scanResult

    let aiReport
    if (findings.length === 0) {
      aiReport = {
        overallRating: 'Secure',
        executiveSummary: `No security issues were detected in ${repoName} during static analysis. The codebase appears to follow secure coding practices for the patterns checked.`,
        riskScore: 0,
        categories: [],
      }
      sendEvent({ type: 'complete', report: aiReport })
    } else {
      const condensed = findings.slice(0, 80).map((f) => ({
        category: f.category,
        severity: f.severity,
        file: f.file,
        line: f.line,
        description: f.description,
        snippet: f.snippet?.slice(0, 80),
      }))

      const systemMessage = 'You are a security analysis assistant. Always respond with valid JSON only — no markdown, no explanation, no code fences.'
      const userPrompt = `You are a senior security engineer. Analyze these findings from a static code audit of the GitHub repository "${repoName}" and produce a JSON response with EXACTLY this structure (no extra text, no markdown fences, just the JSON object):

{
  "overallRating": "Critical|Vulnerable|Needs Attention|Secure",
  "executiveSummary": "2-3 sentence plain-English summary of the security posture",
  "riskScore": <integer 0-100>,
  "categories": [
    {
      "name": "<category name>",
      "severity": "critical|high|medium|low",
      "count": <integer>,
      "explanation": "<why this is a risk>",
      "remediation": "<specific steps to fix>"
    }
  ]
}

Summary counts: critical=${summary.critical}, high=${summary.high}, medium=${summary.medium}, low=${summary.low}

Findings (up to 80 shown):
${JSON.stringify(condensed, null, 2)}`

      let accumulatedContent = ''
      try {
        accumulatedContent = await callAIStream(
          [
            { role: 'system', content: systemMessage },
            { role: 'user', content: userPrompt },
          ],
          (text) => {
            sendEvent({ type: 'reasoning', text })
          }
        )
      } catch (err) {
        console.error(`[Audit ${repoId}] AI stream error:`, err.message)
        // Fall through to fallback
      }

      aiReport = parseAIReport(accumulatedContent, repoName, scanResult)
      sendEvent({ type: 'complete', report: aiReport })
    }

    // Store final record
    audits.set(repoId, {
      ...audits.get(repoId),
      aiReport,
      status: 'complete',
      scanResult: undefined, // free memory
    })

    console.log(`[Audit ${repoId}] Complete — rating: ${aiReport.overallRating}`)
    res.write('data: [DONE]\n\n')
  } catch (err) {
    console.error(`[Audit ${repoId}] Unexpected error:`, err.message)
    sendEvent({ type: 'error', message: err.message })
  } finally {
    res.end()
  }
})

/**
 * POST /api/audit/start — legacy Phase 1 endpoint (clone + scan, return immediately).
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

  audits.get(auditId).status = 'scanning'
  let scanResult
  try {
    scanResult = await scanRepository(cloneDir)
    console.log(`[Audit ${auditId}] Scan complete — ${scanResult.findings.length} findings`)
  } catch (err) {
    audits.delete(auditId)
    await safeDeleteDir(cloneDir)
    console.error(`[Audit ${auditId}] Scan failed:`, err.message)
    return res.status(500).json({ error: `Scanner error: ${err.message}` })
  }

  const safeFindings = scanResult.findings.map((f) => ({
    ...f,
    snippet: sanitizeStr(f.snippet),
    description: sanitizeStr(f.description),
  }))

  audits.set(auditId, {
    auditId,
    repoUrl,
    repoName,
    clonedAt,
    status: 'analyzing',
    findings: safeFindings,
    scanResult,
    scanSummary: scanResult.summary,
    totalFiles: scanResult.totalFiles,
    scannedFiles: scanResult.scannedFiles,
  })

  console.log(`[Audit ${auditId}] Phase 1 complete`)
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
 * GET /api/audit/:auditId/analyze — legacy Phase 2 SSE stream.
 */
app.get('/api/audit/:auditId/analyze', async (req, res) => {
  const { auditId } = req.params
  const auditRecord = audits.get(auditId)

  if (!auditRecord) {
    return res.status(404).json({ error: `Audit ${auditId} not found` })
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.flushHeaders()

  const sendEvent = (payload) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch { /* client disconnected */ }
  }

  console.log(`[Audit ${auditId}] Legacy analyze stream starting`)

  try {
    const { repoName, scanResult } = auditRecord
    const { findings, summary } = scanResult || { findings: [], summary: {} }

    if (findings.length === 0) {
      const aiReport = {
        overallRating: 'Secure',
        executiveSummary: `No security issues were detected in ${repoName} during static analysis.`,
        riskScore: 0,
        categories: [],
      }
      audits.set(auditId, { ...auditRecord, aiReport, status: 'complete', scanResult: undefined })
      sendEvent({ type: 'complete', report: aiReport })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    const condensed = findings.slice(0, 80).map((f) => ({
      category: f.category, severity: f.severity, file: f.file,
      line: f.line, description: f.description, snippet: f.snippet?.slice(0, 80),
    }))

    const userPrompt = `You are a senior security engineer. Analyze these findings from a static code audit of the GitHub repository "${repoName}" and produce a JSON response with EXACTLY this structure (no extra text, no markdown fences, just the JSON object):

{
  "overallRating": "Critical|Vulnerable|Needs Attention|Secure",
  "executiveSummary": "2-3 sentence plain-English summary of the security posture",
  "riskScore": <integer 0-100>,
  "categories": [
    {
      "name": "<category name>",
      "severity": "critical|high|medium|low",
      "count": <integer>,
      "explanation": "<why this is a risk>",
      "remediation": "<specific steps to fix>"
    }
  ]
}

Summary counts: critical=${summary.critical}, high=${summary.high}, medium=${summary.medium}, low=${summary.low}

Findings (up to 80 shown):
${JSON.stringify(condensed, null, 2)}`

    let accumulatedContent = ''
    try {
      accumulatedContent = await callAIStream(
        [
          { role: 'system', content: 'You are a security analysis assistant. Always respond with valid JSON only — no markdown, no explanation, no code fences.' },
          { role: 'user', content: userPrompt },
        ],
        (text) => sendEvent({ type: 'reasoning', text })
      )
    } catch (err) {
      console.error(`[Audit ${auditId}] AI stream error:`, err.message)
    }

    const aiReport = parseAIReport(accumulatedContent, repoName, scanResult)
    audits.set(auditId, { ...auditRecord, aiReport, status: 'complete', scanResult: undefined })
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
 * GET /api/audit/:auditId/graph — build and return a dependency graph.
 */
app.get('/api/audit/:auditId/graph', async (req, res) => {
  const { auditId } = req.params
  const cloneDir = path.join(TEMP_DIR, auditId)
  const auditRecord = audits.get(auditId)

  if (auditRecord?.graph) {
    console.log(`[Audit ${auditId}] Returning cached dependency graph`)
    return res.json(auditRecord.graph)
  }

  if (!fs.existsSync(cloneDir)) {
    return res.status(404).json({
      error: `No data found for audit ${auditId}. The server may have restarted — please run a new audit.`,
    })
  }

  console.log(`[Audit ${auditId}] Building dependency graph for ${cloneDir}`)
  try {
    const graph = await buildDependencyGraph(cloneDir)
    if (auditRecord) {
      auditRecord.graph = graph
      audits.set(auditId, auditRecord)
    }
    console.log(`[Audit ${auditId}] Graph built — ${graph.stats.totalNodes} nodes, ${graph.stats.totalEdges} edges`)
    return res.json(graph)
  } catch (err) {
    console.error(`[Audit ${auditId}] Graph build failed:`, err.message)
    return res.status(500).json({ error: `Failed to build dependency graph: ${err.message}` })
  }
})

/**
 * POST /api/chat — streaming AI chat with optional repo context.
 * Body: { messages: [{role, content}], auditId?: string }
 */
app.post('/api/chat', async (req, res) => {
  const { messages, auditId } = req.body

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' })
  }

  let systemPrompt = 'You are CodeAtlas AI, a code intelligence assistant. You help developers understand codebases, security issues, and architecture.'

  if (auditId) {
    const auditRecord = audits.get(auditId)
    if (auditRecord) {
      const findingCount = auditRecord.findings?.length ?? 0
      const topFindings = (auditRecord.findings || [])
        .filter(f => f.severity === 'critical' || f.severity === 'high')
        .slice(0, 8)
        .map(f => `  - [${f.severity}] ${f.file}: ${f.description}`)
        .join('\n')

      systemPrompt += `\n\nYou have analyzed the repository "${auditRecord.repoName}". The static scan found ${findingCount} security issue(s).`

      if (auditRecord.aiReport?.executiveSummary) {
        systemPrompt += ` Summary: ${auditRecord.aiReport.executiveSummary}`
      }

      if (topFindings) {
        systemPrompt += `\n\nTop findings:\n${topFindings}`
      }
    }
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.flushHeaders()

  const sendEvent = (payload) => {
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`) } catch { /* client disconnected */ }
  }

  const fullMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ]

  try {
    await callAIStream(fullMessages, (text) => {
      sendEvent({ type: 'delta', text })
    })
    sendEvent({ type: 'done' })
  } catch (err) {
    console.error('[Chat] Stream error:', err.message)
    sendEvent({ type: 'error', message: `AI error: ${err.message}` })
  } finally {
    res.end()
  }
})

/**
 * POST /api/audit/analyze-visual — AI visual analysis of a repo's file graph.
 * Body: { auditId: string }
 * Response: { summary, workflow, keyFiles, risks }
 */
app.post('/api/audit/analyze-visual', async (req, res) => {
  const { auditId } = req.body

  if (!auditId) {
    return res.status(400).json({ error: 'auditId is required' })
  }

  const auditRecord = audits.get(auditId)
  if (!auditRecord) {
    return res.status(404).json({ error: `Audit ${auditId} not found` })
  }

  const { repoName, findings = [], graph } = auditRecord
  const findingCount = findings.length

  const fileList = graph
    ? graph.nodes.slice(0, 60).map(n => n.id).join('\n')
    : [...new Set(findings.map(f => f.file).filter(Boolean))].slice(0, 60).join('\n')

  const topFindings = findings
    .filter(f => f.severity === 'critical' || f.severity === 'high')
    .slice(0, 12)
    .map(f => `${f.file}: [${f.severity}] ${f.description}`)
    .join('\n')

  const prompt = `You are a code intelligence assistant. Analyze this repository structure and produce a JSON response.

Repository: ${repoName}
Total findings: ${findingCount}

Files in repository:
${fileList || '(no file list available)'}

${topFindings ? `High/critical findings:\n${topFindings}` : ''}

Respond with ONLY valid JSON (no markdown fences) matching this exact structure:
{
  "summary": "1-2 sentence plain-English description of what this project does and its architecture",
  "workflow": [
    { "step": 1, "description": "short step label", "files": ["file1", "file2"] }
  ],
  "keyFiles": [
    { "path": "path/to/file", "role": "role description" }
  ],
  "risks": [
    { "file": "path/to/file", "reason": "why this file is high risk" }
  ]
}

Include 3-5 workflow steps, 4-6 key files, and 2-4 risk entries. Base everything on the actual file names and findings.`

  try {
    const rawText = await callAI([
      { role: 'system', content: 'You are a code intelligence assistant. Always respond with valid JSON only — no markdown, no explanation, no code fences.' },
      { role: 'user', content: prompt },
    ])

    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    let result
    try {
      result = JSON.parse(cleaned)
    } catch {
      result = {
        summary: `${repoName} is a software project with ${findingCount} security findings detected.`,
        workflow: [
          { step: 1, description: 'Entry point', files: [] },
          { step: 2, description: 'Core logic', files: [] },
          { step: 3, description: 'Output', files: [] },
        ],
        keyFiles: [],
        risks: findings.filter(f => f.severity === 'critical').slice(0, 3).map(f => ({
          file: f.file,
          reason: f.description,
        })),
      }
    }

    return res.json(result)
  } catch (err) {
    console.error(`[VisualAnalysis] Error for ${auditId}:`, err.message)
    return res.status(500).json({ error: `AI analysis failed: ${err.message}` })
  }
})

/**
 * POST /api/audit/key-files — ask AI which files are most significant.
 * Body: { auditId: string }
 * Response: { ids: string[] }
 */
app.post('/api/audit/key-files', async (req, res) => {
  const { auditId } = req.body
  if (!auditId) return res.status(400).json({ error: 'auditId is required' })

  // Try audit record first, fall back to rebuilding the graph from disk
  let auditRecord = audits.get(auditId)
  let graph = auditRecord?.graph

  if (!graph) {
    const cloneDir = path.join(TEMP_DIR, auditId)
    if (!fs.existsSync(cloneDir)) {
      return res.status(404).json({ error: 'Audit not found' })
    }
    try {
      graph = await buildDependencyGraph(cloneDir)
      if (auditRecord) { auditRecord.graph = graph; audits.set(auditId, auditRecord) }
    } catch (err) {
      return res.status(500).json({ error: `Graph build failed: ${err.message}` })
    }
  }

  const nodes = graph.nodes || []
  if (nodes.length === 0) return res.json({ ids: [] })

  // Build a ranked file list: sort by inDegree descending, cap at 120 for prompt length
  const fileLines = nodes
    .slice()
    .sort((a, b) => (b.size || 0) - (a.size || 0))
    .slice(0, 120)
    .map(n => `${n.id} [type:${n.group || 'file'}, importedBy:${n.size || 0}]`)
    .join('\n')

  const prompt = `You are a senior software engineer reviewing a repository's dependency graph.

Below is the list of source files with their type and how many other files import them (importedBy count):

${fileLines}

Task: Identify the ${Math.min(30, Math.ceil(nodes.length * 0.4))} most architecturally significant files — the ones that form the core structure, are imported the most, define key abstractions, or are entry points. Exclude trivial files like index re-exports, config files, or test files unless they are truly central.

Respond with ONLY valid JSON (no markdown, no explanation):
{ "ids": ["path/to/file1", "path/to/file2", ...] }

Return between 10 and 30 file paths.`

  try {
    const raw = await callAI([
      { role: 'system', content: 'You are a software architecture assistant. Respond with valid JSON only.' },
      { role: 'user', content: prompt },
    ])
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    let result
    try {
      result = JSON.parse(cleaned)
    } catch {
      // Fallback: return top files by in-degree
      result = { ids: nodes.sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, 25).map(n => n.id) }
    }
    // Ensure returned ids actually exist in the graph
    const validIds = new Set(nodes.map(n => n.id))
    result.ids = (result.ids || []).filter(id => validIds.has(id))
    return res.json(result)
  } catch (err) {
    console.error(`[KeyFiles] Error for ${auditId}:`, err.message)
    // Fallback: top files by in-degree
    const ids = nodes.sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, 25).map(n => n.id)
    return res.json({ ids })
  }
})

/**
 * POST /api/audit/generate-docs — generate comprehensive documentation.
 * Body: { auditId: string }
 * Response: SSE stream of { type: 'delta', text } events then { type: 'done' }
 */
app.post('/api/audit/generate-docs', async (req, res) => {
  const { auditId } = req.body

  if (!auditId) return res.status(400).json({ error: 'auditId is required' })

  const auditRecord = audits.get(auditId)
  if (!auditRecord) {
    return res.status(404).json({ error: `Audit ${auditId} not found` })
  }

  const { repoName, repoUrl, findings = [], graph, totalFiles, scannedFiles } = auditRecord

  const fileList = graph
    ? graph.nodes.slice(0, 120).map(n => n.id).join('\n')
    : [...new Set(findings.map(f => f.file).filter(Boolean))].slice(0, 80).join('\n')

  const criticalFindings = findings
    .filter(f => ['critical', 'high'].includes(f.severity))
    .slice(0, 20)
    .map(f => `- [${f.severity?.toUpperCase()}] ${f.file}: ${f.type} — ${f.description}`)
    .join('\n')

  const allFindingsSummary = ['critical', 'high', 'medium', 'low', 'info'].map(sev => {
    const count = findings.filter(f => f.severity === sev).length
    return count ? `${sev}: ${count}` : null
  }).filter(Boolean).join(', ')

  const prompt = `You are a senior software engineer writing comprehensive documentation for the GitHub repository "${repoName}".

Repository URL: ${repoUrl}
Total files: ${totalFiles ?? 'unknown'}
Scanned files: ${scannedFiles ?? 'unknown'}
Security findings summary: ${allFindingsSummary || 'none'}

File structure (up to 120 files):
${fileList || '(no file list available)'}

${criticalFindings ? `Critical/high security findings:\n${criticalFindings}` : ''}

Write a thorough, professional README-style documentation in Markdown. Include ALL of the following sections:

# [Project Name]

## Overview
What this project does, its purpose, and main use cases (2-3 paragraphs based on file names and structure).

## Tech Stack
List all detected languages, frameworks, and key libraries inferred from the file extensions and names.

## Project Structure
A tree-style breakdown of the main directories and what each contains. Describe every major folder and key files.

## Getting Started
### Prerequisites
What needs to be installed.
### Installation
Step-by-step commands to clone, install, and configure.
### Running the Project
How to start in development mode, production mode, running tests.
### Environment Variables
Any .env or config files detected, and what they likely configure.

## Architecture
How the system is structured — frontend, backend, database, services, etc. Explain the data flow.

## Key Files
A table of the most important files with their roles.

## API Reference (if applicable)
Any API endpoints or routes detected from file names.

## Security Notes
Based on the ${findings.length} security findings detected, summarize the issues and what a developer should be aware of.

## Contributing
Standard contributing guidelines.

Be detailed, professional, and base everything on the actual file names and project structure. Write as if you have read the full codebase.`

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.flushHeaders()

  const send = (payload) => {
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`) } catch { /* client disconnected */ }
  }

  try {
    await callAIStream([
      { role: 'system', content: 'You are a senior software engineer. Write detailed, accurate technical documentation in Markdown. Be thorough and professional.' },
      { role: 'user', content: prompt },
    ], (text) => send({ type: 'delta', text }))

    send({ type: 'done' })
  } catch (err) {
    console.error(`[GenerateDocs] Error for ${auditId}:`, err.message)
    send({ type: 'error', message: err.message })
  } finally {
    res.end()
  }
})

/**
 * POST /api/audit/file-purpose — stream AI explanation for a single file.
 * Body: { auditId: string, filePath: string }
 * Response: SSE stream of { type: 'delta', text } then { type: 'done' }
 */
app.post('/api/audit/file-purpose', async (req, res) => {
  const { auditId, filePath } = req.body
  if (!auditId || !filePath) return res.status(400).json({ error: 'auditId and filePath are required' })

  const cloneDir = path.join(TEMP_DIR, auditId)
  if (!fs.existsSync(cloneDir)) {
    return res.status(404).json({ error: 'Audit not found' })
  }

  // Read up to 8 KB of the file so the prompt stays manageable
  const absPath = path.join(cloneDir, filePath)
  let fileContent = ''
  try {
    const stat = fs.statSync(absPath)
    if (stat.size > 0) {
      const buf = Buffer.alloc(Math.min(stat.size, 8192))
      const fd = fs.openSync(absPath, 'r')
      fs.readSync(fd, buf, 0, buf.length, 0)
      fs.closeSync(fd)
      fileContent = buf.toString('utf8')
    }
  } catch {
    // File unreadable — continue with metadata only
  }

  // Pull findings for this file from the audit record
  const auditRecord = audits.get(auditId)
  const findings = (auditRecord?.findings || []).filter(f => (f.file || '').replace(/^\//, '') === filePath)
  const findingLines = findings.slice(0, 10).map(f => `- [${f.severity}] ${f.type}: ${f.description}`).join('\n')

  const prompt = `You are a senior software engineer. Analyze this file and explain its purpose clearly.

File path: ${filePath}
${findings.length > 0 ? `\nSecurity findings in this file:\n${findingLines}\n` : ''}
${fileContent ? `\nFile content (first 8KB):\n\`\`\`\n${fileContent}\n\`\`\`` : '(file content unavailable)'}

Write a concise but complete explanation covering:
1. What this file does and its role in the project
2. Key functions, classes, or exports it defines
3. How it fits into the broader architecture
4. Any notable patterns, concerns, or security issues if present

Be direct and specific. Use plain text, not markdown headers.`

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.flushHeaders()

  const send = (payload) => {
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`) } catch { /* disconnected */ }
  }

  try {
    await callAIStream([
      { role: 'system', content: 'You are a senior software engineer. Explain code files clearly and concisely.' },
      { role: 'user', content: prompt },
    ], (text) => send({ type: 'delta', text }))
    send({ type: 'done' })
  } catch (err) {
    console.error(`[FilePurpose] Error:`, err.message)
    send({ type: 'error', message: err.message })
  } finally {
    res.end()
  }
})

/**
 * GET /api/repo/:repoId/filetree — return a recursive file tree of the cloned repo.
 * Response: { tree: TreeNode }
 * TreeNode: { name: string, path: string, type: 'file'|'dir', children?: TreeNode[] }
 */
app.get('/api/repo/:repoId/filetree', (req, res) => {
  const { repoId } = req.params
  const cloneDir = path.join(TEMP_DIR, repoId)

  if (!fs.existsSync(cloneDir)) {
    return res.status(404).json({ error: 'Repository not found. Please clone again.' })
  }

  const SKIP = new Set([
    'node_modules', '.git', 'dist', 'build', '__pycache__',
    '.next', '.nuxt', 'coverage', '.cache', 'vendor', 'bower_components',
    '.turbo', '.vercel', 'out', 'tmp', 'temp',
  ])

  /**
   * Recursively build a tree node.
   * @param {string} absPath
   * @param {string} relPath — path relative to cloneDir
   * @param {number} depth
   * @returns {object|null}
   */
  function buildNode(absPath, relPath, depth) {
    if (depth > 8) return null
    let stat
    try { stat = fs.statSync(absPath) } catch { return null }

    const name = path.basename(absPath)
    if (SKIP.has(name)) return null

    if (stat.isDirectory()) {
      let entries
      try { entries = fs.readdirSync(absPath) } catch { return null }

      const children = entries
        .map(e => buildNode(path.join(absPath, e), relPath ? `${relPath}/${e}` : e, depth + 1))
        .filter(Boolean)
        .sort((a, b) => {
          // Directories first, then files, both alphabetically
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
          return a.name.localeCompare(b.name)
        })

      return { name, path: relPath || '.', type: 'dir', children }
    }

    if (stat.isFile()) {
      return { name, path: relPath, type: 'file' }
    }

    return null
  }

  try {
    let entries
    try { entries = fs.readdirSync(cloneDir) } catch (e) {
      return res.status(500).json({ error: `Cannot read repository: ${e.message}` })
    }

    const children = entries
      .map(e => buildNode(path.join(cloneDir, e), e, 0))
      .filter(Boolean)
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name)
      })

    const auditRecord = audits.get(repoId)
    const repoName = auditRecord?.repoName || path.basename(cloneDir)

    return res.json({
      tree: { name: repoName, path: '.', type: 'dir', children },
    })
  } catch (err) {
    console.error(`[FileTree ${repoId}] Error:`, err.message)
    return res.status(500).json({ error: `Failed to build file tree: ${err.message}` })
  }
})

/**
 * GET /api/repo/:repoId/languages — return language/extension breakdown.
 * Response: { languages: [{ name, ext, count, bytes, color }], totalFiles: number }
 */
app.get('/api/repo/:repoId/languages', (req, res) => {
  const { repoId } = req.params
  const cloneDir = path.join(TEMP_DIR, repoId)

  if (!fs.existsSync(cloneDir)) {
    return res.status(404).json({ error: 'Repository not found. Please clone again.' })
  }

  const SKIP = new Set([
    'node_modules', '.git', 'dist', 'build', '__pycache__',
    '.next', '.nuxt', 'coverage', '.cache', 'vendor', 'bower_components',
    '.turbo', '.vercel', 'out', 'tmp', 'temp',
  ])

  const LANG_MAP = {
    '.js':   { name: 'JavaScript', color: '#f7df1e' },
    '.mjs':  { name: 'JavaScript', color: '#f7df1e' },
    '.cjs':  { name: 'JavaScript', color: '#f7df1e' },
    '.jsx':  { name: 'JSX',        color: '#61dafb' },
    '.ts':   { name: 'TypeScript', color: '#3178c6' },
    '.tsx':  { name: 'TypeScript', color: '#3178c6' },
    '.py':   { name: 'Python',     color: '#3776ab' },
    '.go':   { name: 'Go',         color: '#00add8' },
    '.rs':   { name: 'Rust',       color: '#dea584' },
    '.java': { name: 'Java',       color: '#b07219' },
    '.rb':   { name: 'Ruby',       color: '#701516' },
    '.php':  { name: 'PHP',        color: '#4f5d95' },
    '.swift':{ name: 'Swift',      color: '#f05138' },
    '.kt':   { name: 'Kotlin',     color: '#a97bff' },
    '.c':    { name: 'C',          color: '#555555' },
    '.cpp':  { name: 'C++',        color: '#f34b7d' },
    '.cs':   { name: 'C#',         color: '#178600' },
    '.css':  { name: 'CSS',        color: '#c084fc' },
    '.scss': { name: 'SCSS',       color: '#c6538c' },
    '.less': { name: 'Less',       color: '#1d365d' },
    '.html': { name: 'HTML',       color: '#f97316' },
    '.htm':  { name: 'HTML',       color: '#f97316' },
    '.json': { name: 'JSON',       color: '#86efac' },
    '.yaml': { name: 'YAML',       color: '#94a3b8' },
    '.yml':  { name: 'YAML',       color: '#94a3b8' },
    '.md':   { name: 'Markdown',   color: '#083fa1' },
    '.mdx':  { name: 'MDX',        color: '#1a86c8' },
    '.sh':   { name: 'Shell',      color: '#89e051' },
    '.bash': { name: 'Shell',      color: '#89e051' },
    '.toml': { name: 'TOML',       color: '#9c4221' },
    '.xml':  { name: 'XML',        color: '#0060ac' },
    '.sql':  { name: 'SQL',        color: '#e38c00' },
    '.graphql': { name: 'GraphQL', color: '#e10098' },
    '.gql':  { name: 'GraphQL',    color: '#e10098' },
    '.vue':  { name: 'Vue',        color: '#41b883' },
    '.svelte': { name: 'Svelte',   color: '#ff3e00' },
  }

  /** @type {Map<string, { name: string, color: string, count: number, bytes: number }>} */
  const langCounts = new Map()
  let totalFiles = 0

  function walk(dir, depth) {
    if (depth > 10) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }

    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else if (entry.isFile()) {
        totalFiles++
        const ext = path.extname(entry.name).toLowerCase()
        if (!ext) continue
        const lang = LANG_MAP[ext]
        if (!lang) continue
        const key = lang.name
        if (!langCounts.has(key)) {
          langCounts.set(key, { name: lang.name, color: lang.color, count: 0, bytes: 0 })
        }
        const rec = langCounts.get(key)
        rec.count++
        try {
          const stat = fs.statSync(full)
          rec.bytes += stat.size
        } catch { /* ignore */ }
      }
    }
  }

  try {
    walk(cloneDir, 0)

    const languages = Array.from(langCounts.values())
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 20)

    return res.json({ languages, totalFiles })
  } catch (err) {
    console.error(`[Languages ${repoId}] Error:`, err.message)
    return res.status(500).json({ error: `Failed to analyze languages: ${err.message}` })
  }
})

/**
 * GET /api/repo/:repoId/contributors — return contributor list from git log.
 * Response: { contributors: [{ name, email, commits, avatar }] }
 */
app.get('/api/repo/:repoId/contributors', async (req, res) => {
  const { repoId } = req.params
  const cloneDir = path.join(TEMP_DIR, repoId)

  if (!fs.existsSync(cloneDir)) {
    return res.status(404).json({ error: 'Repository not found. Please clone again.' })
  }

  try {
    const git = simpleGit(cloneDir)

    // Get commit log with author name and email
    const log = await git.log(['--format=%an|%ae', '--no-merges'])

    /** @type {Map<string, { name: string, email: string, commits: number }>} */
    const authorMap = new Map()

    for (const commit of (log.all || [])) {
      // simple-git returns hash in commit.hash but we used custom format
      // The message field holds our pipe-delimited string
      const raw = commit.message || commit.hash || ''
      // Handle both formats: simple-git might parse differently
      const parts = raw.split('|')
      if (parts.length < 2) continue
      const name = parts[0].trim()
      const email = parts[1].trim()
      if (!name || !email) continue

      const key = email.toLowerCase()
      if (!authorMap.has(key)) {
        authorMap.set(key, { name, email, commits: 0 })
      }
      authorMap.get(key).commits++
    }

    // If simple-git didn't parse our custom format, fall back to raw git command
    let contributors = Array.from(authorMap.values())

    if (contributors.length === 0) {
      // Fallback: use simple-git's built-in log and extract from it
      const fullLog = await git.log(['--no-merges', '--max-count=500'])
      const fallbackMap = new Map()
      for (const commit of (fullLog.all || [])) {
        const name = commit.author_name || 'Unknown'
        const email = commit.author_email || ''
        const key = email.toLowerCase() || name.toLowerCase()
        if (!fallbackMap.has(key)) {
          fallbackMap.set(key, { name, email, commits: 0 })
        }
        fallbackMap.get(key).commits++
      }
      contributors = Array.from(fallbackMap.values())
    }

    contributors.sort((a, b) => b.commits - a.commits)

    // Build avatar URL (GitHub-style — uses gravatar MD5 hash as fallback)
    const auditRecord = audits.get(repoId)
    const repoUrl = auditRecord?.repoUrl || ''
    const githubMatch = repoUrl.match(/github\.com\/([^/]+)\//)
    const orgOwner = githubMatch?.[1] || ''

    // Attach github profile URL guesses and avatar urls
    const withAvatars = contributors.slice(0, 30).map((c, idx) => {
      // Try to derive a GitHub username from the email
      // e.g. "user@users.noreply.github.com" -> username
      let githubUser = null
      const noReplyMatch = c.email.match(/^(\d+\+)?([^@]+)@users\.noreply\.github\.com$/)
      if (noReplyMatch) githubUser = noReplyMatch[2]

      const avatarUrl = githubUser
        ? `https://github.com/${githubUser}.png?size=80`
        : `https://www.gravatar.com/avatar/${hashEmail(c.email)}?d=identicon&s=80`

      const profileUrl = githubUser
        ? `https://github.com/${githubUser}`
        : `mailto:${c.email}`

      return {
        ...c,
        avatarUrl,
        profileUrl,
        githubUser,
      }
    })

    return res.json({ contributors: withAvatars, total: contributors.length })
  } catch (err) {
    console.error(`[Contributors ${repoId}] Error:`, err.message)
    return res.status(500).json({ error: `Failed to get contributors: ${err.message}` })
  }
})

/**
 * Simple MD5-like hash for gravatar (uses crypto).
 * @param {string} email
 * @returns {string}
 */
function hashEmail(email) {
  return crypto.createHash('md5').update((email || '').trim().toLowerCase()).digest('hex')
}

/**
 * GET /api/repo/:repoId/file — return the content of a single file.
 * Query: ?path=relative/path/to/file
 * Response: { content: string, language: string, lines: number }
 * Caps at 500 lines. Returns 400 for binary files.
 */
app.get('/api/repo/:repoId/file', (req, res) => {
  const { repoId } = req.params
  const relPath = req.query.path

  if (!relPath) {
    return res.status(400).json({ error: 'path query parameter is required' })
  }

  const cloneDir = path.join(TEMP_DIR, repoId)
  if (!fs.existsSync(cloneDir)) {
    return res.status(404).json({ error: 'Repository not found. Please clone again.' })
  }

  // Prevent directory traversal
  const absPath = path.resolve(cloneDir, relPath)
  if (!absPath.startsWith(cloneDir + path.sep) && absPath !== cloneDir) {
    return res.status(400).json({ error: 'Invalid file path' })
  }

  if (!fs.existsSync(absPath)) {
    return res.status(404).json({ error: `File not found: ${relPath}` })
  }

  let stat
  try { stat = fs.statSync(absPath) } catch (e) {
    return res.status(500).json({ error: `Cannot stat file: ${e.message}` })
  }

  if (!stat.isFile()) {
    return res.status(400).json({ error: 'Path is not a file' })
  }

  // Reject files larger than 1 MB
  if (stat.size > 1_000_000) {
    return res.status(400).json({ error: 'File is too large to display (>1 MB)' })
  }

  let raw
  try {
    raw = fs.readFileSync(absPath)
  } catch (e) {
    return res.status(500).json({ error: `Cannot read file: ${e.message}` })
  }

  // Detect binary: if >5% of the first 8 KB are non-printable bytes, skip
  const sample = raw.slice(0, 8192)
  let nonPrintable = 0
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i]
    if (b === 0 || (b < 9) || (b > 13 && b < 32 && b !== 27)) nonPrintable++
  }
  if (sample.length > 0 && nonPrintable / sample.length > 0.05) {
    return res.status(400).json({ error: 'Binary file — cannot display as text' })
  }

  const text = raw.toString('utf8')
  const allLines = text.split('\n')
  const MAX_LINES = 500
  const lines = allLines.slice(0, MAX_LINES)
  const content = lines.join('\n')

  // Derive language from extension
  const ext = path.extname(relPath).toLowerCase().slice(1)
  const EXT_LANG = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    jsx: 'jsx', ts: 'typescript', tsx: 'tsx',
    py: 'python', go: 'go', rs: 'rust', rb: 'ruby',
    java: 'java', php: 'php', cs: 'csharp', cpp: 'cpp', c: 'c',
    css: 'css', scss: 'scss', less: 'less',
    html: 'html', htm: 'html',
    json: 'json', yaml: 'yaml', yml: 'yaml',
    md: 'markdown', mdx: 'markdown',
    sh: 'shell', bash: 'shell',
    toml: 'toml', xml: 'xml', sql: 'sql',
    vue: 'vue', svelte: 'svelte',
    graphql: 'graphql', gql: 'graphql',
  }

  return res.json({
    content,
    language: EXT_LANG[ext] || 'text',
    lines: allLines.length,
    truncated: allLines.length > MAX_LINES,
  })
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
