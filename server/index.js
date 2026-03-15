/**
 * CodeAtlas Audit Server
 * Express backend on port 3001 that clones GitHub repositories,
 * runs a static security scanner, and generates AI-powered reports.
 */

import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import simpleGit from 'simple-git'
import OpenAI from 'openai'
import Stripe from 'stripe'
import { scanRepository } from './scanner.js'
import { buildDependencyGraph } from './graph.js'
import * as auditStore from './auditStore.js'
import { db, firebaseReady } from './firebaseAdmin.js'

// ---------------------------------------------------------------------------
// Stripe Client
// ---------------------------------------------------------------------------

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

// ---------------------------------------------------------------------------
// AI Client — Qwen 2.5 72B via Featherless (fast, non-thinking, 1 concurrency unit)
// ---------------------------------------------------------------------------

const featherless = new OpenAI({
  baseURL: 'https://api.featherless.ai/v1',
  apiKey: process.env.FEATHERLESS_API_KEY || '',
})

const MODEL = 'moonshotai/Kimi-K2.5'

// ---------------------------------------------------------------------------
// Light AI Client — Qwen3-0.6B via Featherless (fast, no deep thinking)
// Used only for FAQ generation and file-purpose previews
// ---------------------------------------------------------------------------

const LIGHT_MODEL = 'Qwen/Qwen3-0.6B'

// ---------------------------------------------------------------------------
// AI Concurrency Manager — shared 4-unit pool across ALL models on the API key
// Kimi K2.5 = 4 units (exclusive), Qwen3-0.6B = 1 unit (up to 4 concurrent)
// ---------------------------------------------------------------------------
const AI_UNIT_LIMIT = 4
const KIMI_UNITS = 4
const QWEN_UNITS = 1
let aiUnitsInUse = 0
const aiWaitQueue = [] // { units, resolve }

function aiAcquire(units) {
  return new Promise(resolve => {
    if (aiUnitsInUse + units <= AI_UNIT_LIMIT) {
      aiUnitsInUse += units
      resolve()
    } else {
      aiWaitQueue.push({ units, resolve })
    }
  })
}

function aiRelease(units) {
  aiUnitsInUse -= units
  // Process waiting calls that now fit
  let i = 0
  while (i < aiWaitQueue.length) {
    if (aiUnitsInUse + aiWaitQueue[i].units <= AI_UNIT_LIMIT) {
      const { units: u, resolve } = aiWaitQueue.splice(i, 1)[0]
      aiUnitsInUse += u
      resolve()
    } else {
      i++
    }
  }
}

// ---------------------------------------------------------------------------
// Light AI (Qwen) — 1 unit each, up to 4 concurrent
// ---------------------------------------------------------------------------

async function callLightAI(messages, maxTokens = 2048) {
  await aiAcquire(QWEN_UNITS)
  try {
    const stream = await featherless.chat.completions.create({
      model: LIGHT_MODEL,
      max_tokens: maxTokens,
      messages,
      stream: true,
    })
    let full = ''
    for await (const chunk of stream) {
      full += chunk.choices[0]?.delta?.content || ''
    }
    return full.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  } finally {
    aiRelease(QWEN_UNITS)
  }
}

async function callLightAIStream(messages, onDelta) {
  await aiAcquire(QWEN_UNITS)
  try {
    const stream = await featherless.chat.completions.create({
      model: LIGHT_MODEL,
      max_tokens: 2048,
      messages,
      stream: true,
    })
    let full = ''
    let emitted = ''
    let inThink = false
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || ''
      if (!delta) continue
      full += delta
      if (full.includes('<think>')) inThink = true
      if (inThink) {
        if (full.includes('</think>')) {
          inThink = false
          const after = full.split('</think>').pop().trim()
          if (after) {
            onDelta(after)
            emitted += after
          }
          full = ''
        }
        continue
      }
      onDelta(delta)
      emitted += delta
    }
    if (emitted.trim().length === 0 && full.length > 0) {
      const cleaned = full.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim()
      if (cleaned) {
        onDelta(cleaned)
        emitted = cleaned
      }
    }
    return emitted
  } finally {
    aiRelease(QWEN_UNITS)
  }
}

// ---------------------------------------------------------------------------
// Heavy AI (Kimi K2.5) — 4 units each, exclusive access
// ---------------------------------------------------------------------------

async function callAIStream(messages, onDelta) {
  await aiAcquire(KIMI_UNITS)
  try {
    const stream = await featherless.chat.completions.create({
      model: MODEL,
      max_tokens: 16384,
      messages,
      stream: true,
    })
    let full = ''
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || ''
      if (delta) { onDelta(delta); full += delta }
    }
    return full
  } finally {
    aiRelease(KIMI_UNITS)
  }
}

async function callAI(messages, maxTokens = 16384) {
  await aiAcquire(KIMI_UNITS)
  try {
    const stream = await featherless.chat.completions.create({
      model: MODEL,
      max_tokens: maxTokens,
      messages,
      stream: true,
    })
    let full = ''
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || ''
      if (delta) full += delta
    }
    const stripped = full.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
    if (stripped) return stripped
    const thinkMatch = full.match(/<think>([\s\S]*?)<\/think>/i)
    if (thinkMatch) {
      const inner = thinkMatch[1]
      const jsonStart = inner.indexOf('{')
      const jsonEnd = inner.lastIndexOf('}')
      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        return inner.slice(jsonStart, jsonEnd + 1)
      }
    }
    return full.trim()
  } finally {
    aiRelease(KIMI_UNITS)
  }
}

/**
 * Augment a dependency graph with AI-identified edges when static analysis found none.
 * Reads up to 1.5KB of each file and asks the AI to identify relationships.
 * @param {{ nodes, edges, stats }} graph
 * @param {string} cloneDir
 * @returns {Promise<{ nodes, edges, stats }>}
 */
async function aiAugmentGraph(graph, cloneDir) {
  const nodes = graph.nodes

  // Read file snippets (up to 3 KB each)
  const fileBlocks = []
  for (const node of nodes.slice(0, 50)) {
    const absPath = path.join(cloneDir, node.id)
    let content = ''
    try {
      if (fs.existsSync(absPath)) {
        const stat = fs.statSync(absPath)
        if (stat.isFile() && stat.size > 0) {
          const buf = Buffer.alloc(Math.min(stat.size, 3072))
          const fd = fs.openSync(absPath, 'r')
          fs.readSync(fd, buf, 0, buf.length, 0)
          fs.closeSync(fd)
          content = buf.toString('utf8')
        }
      }
    } catch { /* skip unreadable */ }
    if (content) fileBlocks.push(`--- ${node.id} ---\n${content}`)
  }

  if (fileBlocks.length === 0) return graph

  const fileList = nodes.map(n => n.id).join('\n')

  const prompt = `You are an expert software architect. Analyze this repository and build a COMPLETE dependency graph that shows how the application works as a system.

FILES (use these EXACT paths for all edges):
${fileList}

FILE CONTENTS:
${fileBlocks.join('\n\n')}

YOUR TASK — build the graph in 3 steps:

STEP 1: Understand what each file does by reading its code.

STEP 2: Build the hierarchy. Think about the application's data flow:
- What is the main entry point / UI page? (it goes at the top)
- What API routes or backend endpoints does it call?
- What backend scripts do those routes execute or depend on?
- Which files work together in a pipeline or sequence?
- Which config files support which application files?

STEP 3: Connect EVERY file. For each file, ask:
"What does this file USE?" → add edge: this file → that file
"What USES this file?" → add edge: that file → this file

EDGE TYPES (use the most appropriate one):
- "calls_api" — frontend calls a backend API route (e.g. page.tsx does fetch('/api/X') → route.ts handles it)
- "import" — one file imports or requires code from another
- "executes" — one file runs another as a subprocess (exec, spawn, child_process, subprocess.run)
- "uses_layout" — Next.js page.tsx is wrapped by layout.tsx in same directory
- "renders" — React component renders another component via JSX
- "feeds_data" — one file produces output that another file reads/consumes (even without direct import)
- "configures" — a config file (next.config, postcss.config, etc.) that affects how other files are built/processed

CRITICAL RULES:
- EVERY file MUST appear in at least one edge (as source or target) — no orphan nodes
- The graph must be CONNECTED — you should be able to trace a path between any two files
- Include MANY edges — a rich, well-connected graph is far better than a sparse one
- If files are in the same folder and work on the same domain, they are likely related — connect them
- If scripts are numbered (e.g. script_1.py, script_2.py, script_3.py), they likely form a pipeline — connect them in sequence
- Backend scripts that do similar work (e.g. image processing) likely share data with a capture/collection script — connect them
- Direction: source → target means "source depends on / calls / uses target"
- Both source and target MUST be EXACT strings from the FILES list
- No self-loops (source ≠ target)

Return ONLY valid JSON, no markdown, no explanation:
{"edges":[{"source":"path/to/file.ts","target":"path/to/other.ts","type":"calls_api"}]}`

  try {
    const raw = await callAI([
      { role: 'system', content: 'You are an expert software architect who builds dependency graphs. You understand how full-stack applications work — frontend pages call API routes, API routes execute backend scripts, scripts process data in pipelines, config files affect builds. You always produce richly connected graphs where every file has its place in the hierarchy. Respond with valid JSON only — no markdown, no explanation.' },
      { role: 'user', content: prompt },
    ], 16384)
    logAiResponse('GRAPH-AI-EDGES RESPONSE', raw)

    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    const startIdx = cleaned.indexOf('{')
    const endIdx = cleaned.lastIndexOf('}')
    if (startIdx === -1 || endIdx === -1) throw new Error('No JSON found in AI edges response')

    const parsed = JSON.parse(cleaned.slice(startIdx, endIdx + 1))
    const aiEdges = Array.isArray(parsed.edges) ? parsed.edges : []

    const validIds = new Set(nodes.map(n => n.id))
    const existingEdgeKeys = new Set(graph.edges.map(e => `${e.source}→${e.target}`))
    const inDegree = new Map(nodes.map(n => [n.id, n.size || 0]))

    const newEdges = []
    for (const edge of aiEdges) {
      const key = `${edge.source}→${edge.target}`
      if (
        edge.source && edge.target &&
        validIds.has(edge.source) &&
        validIds.has(edge.target) &&
        edge.source !== edge.target &&
        !existingEdgeKeys.has(key)
      ) {
        newEdges.push({ source: edge.source, target: edge.target, type: edge.type || 'import' })
        existingEdgeKeys.add(key)
        inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1)
      }
    }

    const augmentedEdges = [...graph.edges, ...newEdges]
    const augmentedNodes = nodes.map(n => ({ ...n, size: inDegree.get(n.id) || 0 }))

    let mostImported = ''
    let maxDeg = -1
    for (const [id, deg] of inDegree) {
      if (deg > maxDeg) { maxDeg = deg; mostImported = id }
    }

    console.log(`[GraphAI] AI added ${newEdges.length} edges`)
    return {
      nodes: augmentedNodes,
      edges: augmentedEdges,
      stats: { totalNodes: augmentedNodes.length, totalEdges: augmentedEdges.length, mostImported },
    }
  } catch (err) {
    console.error('[GraphAI] Augmentation failed:', err.message)
    return graph
  }
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')

// In Cloud Functions, use /tmp (the only writable directory)
const IS_CLOUD_FUNCTION = !!process.env.FUNCTION_TARGET || !!process.env.K_SERVICE
const TEMP_DIR = IS_CLOUD_FUNCTION ? '/tmp/qadna' : path.join(PROJECT_ROOT, 'temp')

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true })
  console.log(`[Server] Created temp directory at ${TEMP_DIR}`)
}

// Debug log file — prepends new AI responses on top of existing content
const AI_DEBUG_LOG = path.join(TEMP_DIR, 'ai_responses_debug.txt')

function logAiResponse(label, rawText) {
  try {
    const timestamp = new Date().toISOString()
    const separator = '='.repeat(80)
    const header = `${separator}\n[${timestamp}] ${label}\n${separator}\n`
    const entry = `${header}${rawText}\n\n`
    // Prepend new entry on top of existing content
    const existing = fs.existsSync(AI_DEBUG_LOG) ? fs.readFileSync(AI_DEBUG_LOG, 'utf8') : ''
    fs.writeFileSync(AI_DEBUG_LOG, entry + existing, 'utf8')
    console.log(`[Debug] Logged ${label} response (${rawText.length} chars) to ai_responses_debug.txt`)
  } catch (err) {
    console.warn(`[Debug] Could not write debug log:`, err.message)
  }
}

/**
 * Re-clone a repo if the temp directory was cleaned but the audit exists in Firestore.
 * Uses a per-repo lock to prevent concurrent clone attempts (race condition on cold start).
 * Returns true if the clone dir exists (or was recreated), false otherwise.
 */
const cloneLocks = new Map()

async function ensureCloneDir(repoId) {
  const cloneDir = path.join(TEMP_DIR, repoId)
  if (fs.existsSync(cloneDir)) return true

  // If another request is already cloning this repo, wait for it
  if (cloneLocks.has(repoId)) {
    return cloneLocks.get(repoId)
  }

  const clonePromise = (async () => {
    // Double-check after acquiring "lock"
    if (fs.existsSync(cloneDir)) return true

    // Ensure TEMP_DIR exists (may be cleared between cold starts)
    if (!fs.existsSync(TEMP_DIR)) {
      fs.mkdirSync(TEMP_DIR, { recursive: true })
      console.log(`[Clone] Re-created TEMP_DIR at ${TEMP_DIR}`)
    }

    const audit = await auditStore.getAudit(repoId)
    if (!audit?.repoUrl) {
      console.error(`[Clone] No repoUrl found in database for ${repoId} — cannot re-clone`)
      return false
    }

    const pat = audit.uid ? await getUserGithubToken(audit.uid) : null
    const cloneUrl = buildAuthCloneUrl(audit.repoUrl, pat)
    console.log(`[Clone] Re-cloning ${audit.repoUrl} for cached audit ${repoId}${pat ? ' (with PAT)' : ''}`)
    try {
      const git = simpleGit()
      await git.clone(cloneUrl, cloneDir, ['--depth', '1', '--single-branch'])
      console.log(`[Clone] Re-clone complete for ${repoId}`)
      return true
    } catch (err) {
      // If it failed because dir already exists (race), that's fine
      if (fs.existsSync(cloneDir)) return true
      console.error(`[Clone] Re-clone failed for ${repoId} (${audit.repoUrl}):`, err.message)
      return false
    } finally {
      cloneLocks.delete(repoId)
    }
  })()

  cloneLocks.set(repoId, clonePromise)
  return clonePromise
}

const app = express()
const PORT = 3001

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(cors({
  origin: true, // Allow all origins — Firebase Hosting rewrites handle routing
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
// Audit store — Firestore-backed with in-memory cache (see auditStore.js)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// GitHub PAT helpers — retrieve stored tokens for private repo access
// ---------------------------------------------------------------------------

async function getUserGithubToken(uid) {
  if (!uid || !firebaseReady) return null
  try {
    const userDoc = await db.collection('users').doc(uid).get()
    if (!userDoc.exists) return null
    return userDoc.data()?.githubPat || null
  } catch (err) {
    console.error(`[Auth] Failed to get GitHub PAT for ${uid}:`, err.message)
    return null
  }
}

function buildAuthCloneUrl(repoUrl, pat) {
  if (!pat) return repoUrl
  try {
    const u = new URL(repoUrl)
    u.username = 'x-access-token'
    u.password = pat
    return u.toString()
  } catch {
    return repoUrl
  }
}

function buildGhHeaders(pat) {
  const headers = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'QADNA-CodeAtlas' }
  if (pat) headers['Authorization'] = `Bearer ${pat}`
  return headers
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
  res.json({ status: 'ok', audits: auditStore.cacheSize() })
})

/**
 * GET /api/audits — list all active audits
 */
app.get('/api/audits', async (_req, res) => {
  const list = await auditStore.listAudits()
  res.json(list)
})

/**
 * GET /api/session/last — get the most recent completed audit for session restoration.
 * The frontend calls this on page load to restore state after reload.
 */
app.get('/api/session/last', async (_req, res) => {
  try {
    const lastAudit = await auditStore.getLastAudit()
    if (!lastAudit) return res.json({ audit: null })
    return res.json({
      audit: {
        auditId: lastAudit.auditId,
        repoUrl: lastAudit.repoUrl,
        repoName: lastAudit.repoName,
        status: lastAudit.status,
      }
    })
  } catch (err) {
    console.error('[Session] Error:', err.message)
    return res.json({ audit: null })
  }
})

/**
 * POST /api/repo/clone — fast clone only, returns immediately after git clone.
 * Body: { repoUrl: string }
 * Response: { repoId, repoName, repoUrl }
 */
app.post('/api/repo/clone', async (req, res) => {
  const { repoUrl, userEmail, uid } = req.body

  if (!repoUrl) {
    return res.status(400).json({ error: 'repoUrl is required' })
  }

  const parsed = parseGitHubUrl(repoUrl)
  if (!parsed.valid) {
    return res.status(400).json({ error: parsed.error })
  }

  const { owner, repo } = parsed
  const repoName = `${owner}/${repo}`

  // Check if this repo was already audited — return cached audit instantly
  const existingAudit = await auditStore.findByRepoUrl(repoUrl, repoName)
  if (existingAudit) {
    console.log(`[Clone] Repo ${repoName} already exists (${existingAudit.auditId}, status: ${existingAudit.status}), returning cached`)
    // Backfill analyzedBy if it was missing
    if (userEmail && !existingAudit.analyzedBy) {
      await auditStore.setAudit(existingAudit.auditId, { analyzedBy: userEmail })
    }
    return res.json({
      repoId: existingAudit.auditId,
      repoName: existingAudit.repoName,
      repoUrl: existingAudit.repoUrl,
      cached: true,
    })
  }

  const repoId = crypto.randomUUID()
  const cloneDir = path.join(TEMP_DIR, repoId)
  const clonedAt = new Date().toISOString()

  const pat = await getUserGithubToken(uid)
  const cloneUrl = buildAuthCloneUrl(repoUrl, pat)
  console.log(`[Clone ${repoId}] Cloning ${repoUrl}${pat ? ' (with PAT)' : ''}`)
  await auditStore.setAudit(repoId, { auditId: repoId, repoId, repoUrl, repoName, clonedAt, status: 'cloning', analyzedBy: userEmail || '', uid: uid || '' })

  try {
    const git = simpleGit()
    await git.clone(cloneUrl, cloneDir, [
      '--depth', '1',
      '--single-branch',
      '--no-tags',
    ])
    console.log(`[Clone ${repoId}] Done`)
  } catch (err) {
    await auditStore.deleteAudit(repoId)
    await safeDeleteDir(cloneDir)

    const msg = err.message || ''
    if (msg.includes('not found') || msg.includes('Repository not found') || msg.includes('does not exist')) {
      return res.status(400).json({ error: pat
        ? `Repository not found: ${repoName}. Check the URL or your token permissions.`
        : `Repository not found or is private: ${repoName}. For private repos, add a GitHub token in your profile.` })
    }
    if (msg.includes('Authentication failed') || msg.includes('could not read Username')) {
      return res.status(400).json({ error: `Authentication failed for ${repoName}. Check your GitHub token in your profile.` })
    }
    console.error(`[Clone ${repoId}] Failed:`, msg)
    return res.status(500).json({ error: `Failed to clone repository: ${msg}` })
  }

  await auditStore.setAuditStatus(repoId, 'cloned')
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

  const auditRecord = await auditStore.getAudit(repoId)
  if (!auditRecord) {
    return res.status(404).json({ error: `No cloned repo found for id ${repoId}. Please clone first.` })
  }

  const { repoName, repoUrl } = auditRecord

  // If this audit was already completed, return cached results instantly via SSE
  if (auditRecord.status === 'complete' && auditRecord.scanSummary && auditRecord.aiReport) {
    console.log(`[Audit ${repoId}] Returning cached audit results for ${repoName}`)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.flushHeaders()
    const sendCached = (payload) => { try { res.write(`data: ${JSON.stringify(payload)}\n\n`) } catch {} }
    sendCached({ type: 'scan_start' })
    sendCached({
      type: 'scan_complete',
      findings: auditRecord.findings || [],
      summary: auditRecord.scanSummary,
      totalFiles: auditRecord.scanSummary?.totalFiles || 0,
      scannedFiles: auditRecord.scanSummary?.scannedFiles || 0,
    })
    sendCached({ type: 'reasoning', text: 'Loaded from cache — this repo was already analyzed.' })
    sendCached({ type: 'complete', report: auditRecord.aiReport, cached: true })
    res.end()
    return
  }

  // Check if we have cached scan results but no AI report (e.g., AI analysis was interrupted).
  // In this case we can skip the scan phase and re-run just the AI analysis — no clone dir needed.
  const hasCachedScan = auditRecord.scanSummary && auditRecord.findings
  let useCachedScan = false

  if (!hasCachedScan) {
    // Need clone dir for a fresh scan
    const cloneDir = path.join(TEMP_DIR, repoId)
    if (!fs.existsSync(cloneDir)) {
      const restored = await ensureCloneDir(repoId)
      if (!restored) {
        return res.status(404).json({ error: `Clone directory not found for ${repoId}. Please re-clone the repository.` })
      }
    }
  } else {
    useCachedScan = true
    console.log(`[Audit ${repoId}] Using cached scan results, re-running AI analysis only`)
  }

  // SSE headers — include anti-buffering headers for reverse proxies
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-store')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.flushHeaders()

  const sendEvent = (payload) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch {
      // client disconnected
    }
  }

  // Keepalive pings every 8s to prevent proxy timeouts during long operations
  const keepalivePing = setInterval(() => {
    sendEvent({ type: 'ping' })
  }, 8000)

  console.log(`[Audit ${repoId}] Run starting — ${repoName}`)
  await auditStore.setAuditStatus(repoId, 'scanning')

  try {
    let safeFindings
    let scanResult

    if (useCachedScan) {
      // Use cached scan data — no clone dir needed
      safeFindings = auditRecord.findings
      scanResult = {
        findings: safeFindings,
        summary: auditRecord.scanSummary,
        totalFiles: auditRecord.scanSummary?.totalFiles || 0,
        scannedFiles: auditRecord.scanSummary?.scannedFiles || 0,
      }
      sendEvent({ type: 'scan_start' })
      sendEvent({
        type: 'scan_complete',
        findings: safeFindings,
        summary: scanResult.summary,
        totalFiles: scanResult.totalFiles,
        scannedFiles: scanResult.scannedFiles,
      })
      sendEvent({ type: 'reasoning', text: 'Scan results loaded from cache — running AI analysis...' })
    } else {
      // --- Fresh Scan ---
      const cloneDir = path.join(TEMP_DIR, repoId)
      sendEvent({ type: 'scan_start' })
      console.log(`[Audit ${repoId}] Running scanner...`)
      try {
        scanResult = await scanRepository(cloneDir)
        console.log(`[Audit ${repoId}] Scan complete — ${scanResult.findings.length} findings`)
      } catch (err) {
        await auditStore.setAuditStatus(repoId, 'error')
        clearInterval(keepalivePing)
        sendEvent({ type: 'error', message: `Scanner error: ${err.message}` })
        res.end()
        return
      }

      // Sanitize findings
      safeFindings = scanResult.findings.map((f) => ({
        ...f,
        snippet: sanitizeStr(f.snippet),
        description: sanitizeStr(f.description),
      }))

      // Store findings in audit record
      await auditStore.setAudit(repoId, {
        status: 'analyzing',
        findings: safeFindings,
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
    }

    // --- AI Analysis ---
    await auditStore.setAuditStatus(repoId, 'analyzing')
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
    await auditStore.setAudit(repoId, {
      aiReport,
      status: 'complete',
    })

    console.log(`[Audit ${repoId}] Complete — rating: ${aiReport.overallRating}`)
    res.write('data: [DONE]\n\n')
  } catch (err) {
    console.error(`[Audit ${repoId}] Unexpected error:`, err.message)
    sendEvent({ type: 'error', message: err.message })
  } finally {
    clearInterval(keepalivePing)
    res.end()
  }
})

/**
 * POST /api/audit/start — legacy Phase 1 endpoint (clone + scan, return immediately).
 * Body: { repoUrl: string }
 * Response: { auditId, repoName, findings, summary }
 */
app.post('/api/audit/start', async (req, res) => {
  const { repoUrl, uid } = req.body

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

  const pat = await getUserGithubToken(uid)
  const cloneUrl = buildAuthCloneUrl(repoUrl, pat)
  console.log(`[Audit ${auditId}] Phase 1 start — ${repoName}${pat ? ' (with PAT)' : ''}`)
  await auditStore.setAudit(auditId, { auditId, repoUrl, repoName, clonedAt, status: 'cloning', uid: uid || '' })

  try {
    const git = simpleGit()
    await git.clone(cloneUrl, cloneDir, ['--depth', '1', '--single-branch', '--no-tags'])
    console.log(`[Audit ${auditId}] Clone complete`)
  } catch (err) {
    await auditStore.deleteAudit(auditId)
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

  await auditStore.setAuditStatus(auditId, 'scanning')
  let scanResult
  try {
    scanResult = await scanRepository(cloneDir)
    console.log(`[Audit ${auditId}] Scan complete — ${scanResult.findings.length} findings`)
  } catch (err) {
    await auditStore.deleteAudit(auditId)
    await safeDeleteDir(cloneDir)
    console.error(`[Audit ${auditId}] Scan failed:`, err.message)
    return res.status(500).json({ error: `Scanner error: ${err.message}` })
  }

  const safeFindings = scanResult.findings.map((f) => ({
    ...f,
    snippet: sanitizeStr(f.snippet),
    description: sanitizeStr(f.description),
  }))

  await auditStore.setAudit(auditId, {
    auditId,
    repoUrl,
    repoName,
    clonedAt,
    status: 'analyzing',
    findings: safeFindings,
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
  const auditRecord = await auditStore.getAudit(auditId)

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
      await auditStore.setAudit(auditId, { aiReport, status: 'complete' })
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
    await auditStore.setAudit(auditId, { aiReport, status: 'complete' })
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
 * Uses a per-audit lock to prevent duplicate builds when multiple requests arrive.
 */
const graphBuildLocks = new Map() // auditId → Promise
app.get('/api/audit/:auditId/graph', async (req, res) => {
  const { auditId } = req.params
  const cloneDir = path.join(TEMP_DIR, auditId)
  const auditRecord = await auditStore.getAudit(auditId)

  // Return cached graph only if it has enough edges (sparse graphs get rebuilt with AI)
  const cachedGraph = auditRecord?.graph
  if (cachedGraph && cachedGraph.stats?.totalEdges >= (cachedGraph.stats?.totalNodes || 1)) {
    console.log(`[Audit ${auditId}] Returning cached dependency graph (${cachedGraph.stats.totalEdges} edges)`)
    return res.json(cachedGraph)
  }

  if (!fs.existsSync(cloneDir)) {
    // Try to re-clone from the stored repoUrl
    const restored = await ensureCloneDir(auditId)
    if (!restored) {
      // If we have a sparse cached graph and no clone dir, return it rather than 404
      if (cachedGraph) {
        return res.json(cachedGraph)
      }
      return res.status(404).json({
        error: `No data found for audit ${auditId}. The server may have restarted — please run a new audit.`,
      })
    }
  }

  // Flush headers + send keepalive whitespace to prevent gateway timeout during long builds
  res.setHeader('Content-Type', 'application/json')
  res.flushHeaders()
  res.write(' ')
  const keepalive = setInterval(() => {
    try { res.write(' ') } catch { clearInterval(keepalive) }
  }, 5000)

  // Deduplicate: if a build is already in flight for this audit, wait for it
  if (graphBuildLocks.has(auditId)) {
    console.log(`[Audit ${auditId}] Graph build already in progress — waiting`)
    try {
      const graph = await graphBuildLocks.get(auditId)
      clearInterval(keepalive)
      return res.end(JSON.stringify(graph))
    } catch (err) {
      clearInterval(keepalive)
      return res.end(JSON.stringify({ error: `Graph build failed: ${err.message}` }))
    }
  }

  console.log(`[Audit ${auditId}] Building dependency graph for ${cloneDir}`)
  const buildPromise = (async () => {
    let graph = await buildDependencyGraph(cloneDir)
    console.log(`[Audit ${auditId}] Static graph — ${graph.stats.totalNodes} nodes, ${graph.stats.totalEdges} edges`)

    // Save static graph immediately so it persists even if augmentation fails/hangs
    if (auditRecord) {
      await auditStore.setAudit(auditId, { graph })
    }

    // If static analysis found sparse edges (fewer edges than nodes), ask AI to enrich the graph
    if (graph.stats.totalEdges < graph.nodes.length && graph.nodes.length > 1) {
      console.log(`[Audit ${auditId}] Sparse graph (${graph.stats.totalEdges} edges for ${graph.stats.totalNodes} nodes) — running AI graph augmentation`)
      graph = await aiAugmentGraph(graph, cloneDir)
      console.log(`[Audit ${auditId}] After AI augmentation — ${graph.stats.totalEdges} edges`)
      // Save augmented graph
      if (auditRecord) {
        await auditStore.setAudit(auditId, { graph })
      }
    }
    logAiResponse('GRAPH JSON', JSON.stringify(graph, null, 2))
    return graph
  })()

  graphBuildLocks.set(auditId, buildPromise)

  try {
    const graph = await buildPromise
    clearInterval(keepalive)
    res.end(JSON.stringify(graph))
  } catch (err) {
    clearInterval(keepalive)
    console.error(`[Audit ${auditId}] Graph build failed:`, err.message)
    res.end(JSON.stringify({ error: `Failed to build dependency graph: ${err.message}` }))
  } finally {
    graphBuildLocks.delete(auditId)
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
    const auditRecord = await auditStore.getAudit(auditId)
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

  const auditRecord = await auditStore.getAudit(auditId)
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
    const rawText = await callLightAI([
      { role: 'system', content: '/no_think\nYou are a code intelligence assistant. Always respond with valid JSON only — no markdown, no explanation, no code fences, no thinking.' },
      { role: 'user', content: prompt },
    ], 4096)
    logAiResponse('ANALYZE-VISUAL RESPONSE', rawText)

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

  let auditRecord = await auditStore.getAudit(auditId)

  // Return cached key-files if available
  if (auditRecord?.cachedKeyFiles) {
    console.log(`[KeyFiles] Returning cached for ${auditId}`)
    return res.json({ ids: auditRecord.cachedKeyFiles })
  }

  let graph = auditRecord?.graph

  if (!graph) {
    const cloneDir = path.join(TEMP_DIR, auditId)
    if (!fs.existsSync(cloneDir)) {
      return res.status(404).json({ error: 'Audit not found' })
    }
    try {
      graph = await buildDependencyGraph(cloneDir)
      if (auditRecord) { await auditStore.setAudit(auditId, { graph }) }
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
    const raw = await callLightAI([
      { role: 'system', content: 'You are a software architecture assistant. Respond with valid JSON only.' },
      { role: 'user', content: prompt },
    ])
    logAiResponse('KEY-FILES RESPONSE', raw)
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    let result
    try {
      result = JSON.parse(cleaned)
    } catch {
      result = { ids: nodes.sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, 25).map(n => n.id) }
    }
    const validIds = new Set(nodes.map(n => n.id))
    result.ids = (result.ids || []).filter(id => validIds.has(id))
    await auditStore.setAudit(auditId, { cachedKeyFiles: result.ids })
    return res.json(result)
  } catch (err) {
    console.error(`[KeyFiles] Error for ${auditId}:`, err.message)
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

  const auditRecord = await auditStore.getAudit(auditId)
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

  // Check for cached purpose
  const auditRecord = await auditStore.getAudit(auditId)
  const cachedPurposes = auditRecord?.cachedFilePurposes || {}
  if (cachedPurposes[filePath]) {
    console.log(`[FilePurpose] Returning cached for ${filePath}`)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.flushHeaders()
    res.write(`data: ${JSON.stringify({ type: 'delta', text: cachedPurposes[filePath] })}\n\n`)
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
    res.end()
    return
  }

  const cloneDir = path.join(TEMP_DIR, auditId)
  if (!fs.existsSync(cloneDir)) {
    await ensureCloneDir(auditId)
    // Continue even if clone fails — AI can still explain based on file path + findings
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

  let fullText = ''
  const aiMessages = [
    { role: 'system', content: '/no_think\nYou are a senior software engineer. Explain code files clearly and concisely. Respond directly without using thinking tags.' },
    { role: 'user', content: prompt },
  ]

  try {
    await callLightAIStream(aiMessages, (text) => {
      fullText += text
      send({ type: 'delta', text })
    })

    // If AI returned empty (thinking mode swallowed output), retry with non-streaming fallback
    if (fullText.trim().length === 0) {
      console.log(`[FilePurpose] Empty response for ${filePath}, retrying with non-streaming call`)
      const retryText = await callLightAI(aiMessages, 2048)
      if (retryText.trim().length > 0) {
        fullText = retryText.trim()
        send({ type: 'delta', text: fullText })
      } else {
        fullText = `This is ${filePath.split('/').pop()}, located at ${filePath}. The AI model was unable to generate a detailed explanation for this file at this time. Please try again.`
        send({ type: 'delta', text: fullText })
      }
    }

    send({ type: 'done' })

    // Cache the generated purpose for instant reuse
    if (fullText.length > 0) {
      const updated = { ...cachedPurposes, [filePath]: fullText }
      await auditStore.setAudit(auditId, { cachedFilePurposes: updated })
      console.log(`[FilePurpose] Cached explanation for ${filePath} (${fullText.length} chars)`)
    }
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
app.get('/api/repo/:repoId/filetree', async (req, res) => {
  const { repoId } = req.params
  const cloneDir = path.join(TEMP_DIR, repoId)

  if (!fs.existsSync(cloneDir)) {
    const restored = await ensureCloneDir(repoId)
    if (!restored) return res.status(404).json({ error: 'Repository not found. Please clone again.' })
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

    const auditRecord = await auditStore.getAudit(repoId)
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
app.get('/api/repo/:repoId/languages', async (req, res) => {
  const { repoId } = req.params
  const cloneDir = path.join(TEMP_DIR, repoId)

  if (!fs.existsSync(cloneDir)) {
    const restored = await ensureCloneDir(repoId)
    if (!restored) return res.status(404).json({ error: 'Repository not found. Please clone again.' })
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
 * GET /api/repo/:repoId/contributors — return contributor list & commit count.
 *
 * Strategy (GitHub repos):
 *   1. Fetch repo metadata (gives us total commit count via default branch)
 *   2. Fetch contributors list (handles 202 retry, 204 empty)
 *   3. Fallback: git log from clone dir (shallow — limited data but better than 0)
 *
 * Response: { contributors: [...], total, totalCommits }
 */
app.get('/api/repo/:repoId/contributors', async (req, res) => {
  const { repoId } = req.params

  const auditRecord = await auditStore.getAudit(repoId)
  const pat = auditRecord?.uid ? await getUserGithubToken(auditRecord.uid) : null
  const ghHeaders = buildGhHeaders(pat)
  const repoUrl = auditRecord?.repoUrl || ''
  const ghMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/)

  // Track commit count from the GitHub commits API (survives fallback to git log)
  let ghTotalCommits = 0

  if (ghMatch) {
    const owner = ghMatch[1]
    const repo = ghMatch[2]

    try {
      // ── Step 1: Get total commit count from the repo's default branch ──
      try {
        const commitsRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`,
          { headers: ghHeaders }
        )
        if (commitsRes.ok) {
          const linkHeader = commitsRes.headers.get('link') || ''
          const lastMatch = linkHeader.match(/page=(\d+)>;\s*rel="last"/)
          ghTotalCommits = lastMatch ? parseInt(lastMatch[1], 10) : 1
        }
      } catch (e) {
        console.warn(`[Contributors ${repoId}] Commit count fetch failed: ${e.message}`)
      }

      // ── Step 2: Get contributors (with 202 retry) ─────────────────────
      let ghContributors = []
      for (let attempt = 0; attempt < 3; attempt++) {
        const ghRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contributors?per_page=30&anon=false`,
          { headers: ghHeaders }
        )

        if (ghRes.status === 204) {
          console.log(`[Contributors ${repoId}] GitHub returned 204 (no content)`)
          break
        }

        if (ghRes.status === 202) {
          console.log(`[Contributors ${repoId}] GitHub returned 202 (computing), retry ${attempt + 1}/3`)
          await new Promise(r => setTimeout(r, 1500))
          continue
        }

        if (!ghRes.ok) {
          const errBody = await ghRes.text()
          console.error(`[Contributors ${repoId}] GitHub API ${ghRes.status}: ${errBody}`)
          throw new Error(`GitHub API returned ${ghRes.status}`)
        }

        const data = await ghRes.json()
        if (Array.isArray(data) && data.length > 0) {
          ghContributors = data
        }
        break
      }

      // If GitHub returned actual contributors, use them
      if (ghContributors.length > 0) {
        const contributors = ghContributors.map((c) => ({
          name: c.login,
          email: '',
          commits: c.contributions || 0,
          avatarUrl: c.avatar_url || `https://github.com/${c.login}.png?size=80`,
          profileUrl: c.html_url || `https://github.com/${c.login}`,
          githubUser: c.login,
        }))

        const contribSum = contributors.reduce((sum, c) => sum + c.commits, 0)
        const totalCommits = Math.max(contribSum, ghTotalCommits)

        return res.json({ contributors, total: contributors.length, totalCommits })
      }

      // GitHub returned empty contributors — fall through to git log
      console.log(`[Contributors ${repoId}] GitHub Contributors API returned empty, falling through to git log (ghTotalCommits=${ghTotalCommits})`)
    } catch (err) {
      console.warn(`[Contributors ${repoId}] GitHub API failed (${err.message}), falling back to git log`)
    }
  }

  // ── Fallback: git log from clone directory ────────────────────────────
  const cloneDir = path.join(TEMP_DIR, repoId)
  if (!fs.existsSync(cloneDir)) {
    const restored = await ensureCloneDir(repoId)
    if (!restored) {
      return res.status(404).json({ error: 'Repository data not available. Please re-analyze the repo.' })
    }
  }

  try {
    const git = simpleGit(cloneDir)

    // Unshallow if possible to get full commit history
    try {
      const isShallow = fs.existsSync(path.join(cloneDir, '.git', 'shallow'))
      if (isShallow) {
        console.log(`[Contributors ${repoId}] Unshallowing clone for full git log`)
        await git.raw(['fetch', '--unshallow']).catch(() => {})
      }
    } catch {}

    const raw = await git.raw(['log', '--all', '--format=%aN||%aE'])
    const contribMap = new Map()
    for (const line of raw.split('\n')) {
      const parts = line.split('||')
      if (parts.length < 2) continue
      const name = parts[0].trim()
      const email = parts[1].trim()
      if (!name) continue
      const key = email || name
      if (contribMap.has(key)) {
        contribMap.get(key).commits++
      } else {
        contribMap.set(key, { name, email, commits: 1 })
      }
    }

    // Try to resolve GitHub profiles via the commits API (if it's a GitHub repo)
    let ghAuthorMap = new Map()
    if (ghMatch) {
      try {
        const owner = ghMatch[1], repo = ghMatch[2]
        const commitsRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/commits?per_page=100`,
          { headers: ghHeaders }
        )
        if (commitsRes.ok) {
          const commits = await commitsRes.json()
          for (const c of commits) {
            const email = c.commit?.author?.email || ''
            const name = c.commit?.author?.name || ''
            const ghUser = c.author // linked GitHub account (can be null)
            if (ghUser?.login) {
              if (email) ghAuthorMap.set(email, ghUser)
              if (name) ghAuthorMap.set(name, ghUser)
            }
          }
        }
      } catch {}
    }

    const contributors = Array.from(contribMap.values())
      .sort((a, b) => b.commits - a.commits)
      .slice(0, 30)
      .map(c => {
        // Try to match by email first, then by name
        const ghUser = ghAuthorMap.get(c.email) || ghAuthorMap.get(c.name)
        // Also check noreply email pattern: 12345+username@users.noreply.github.com
        const noreplyMatch = c.email.match(/(\d+\+)?([^@]+)@users\.noreply\.github\.com/)
        const ghLogin = ghUser?.login || (noreplyMatch ? noreplyMatch[2] : '')

        return {
          name: ghLogin || c.name,
          email: c.email,
          commits: c.commits,
          avatarUrl: ghUser?.avatar_url || (ghLogin ? `https://github.com/${ghLogin}.png?size=80` : `https://ui-avatars.com/api/?name=${encodeURIComponent(c.name)}&size=56&background=f0f0f5&color=4a4a5a&bold=true&format=svg`),
          profileUrl: ghUser?.html_url || (ghLogin ? `https://github.com/${ghLogin}` : ''),
          githubUser: ghLogin,
        }
      })

    const gitTotal = contributors.reduce((sum, c) => sum + c.commits, 0)
    // Prefer the GitHub commit count (from commits API) if available and larger
    const totalCommits = Math.max(gitTotal, ghTotalCommits || 0)
    return res.json({ contributors, total: contributors.length, totalCommits })
  } catch (err) {
    console.error(`[Contributors ${repoId}] git log fallback failed:`, err.message)
    return res.status(500).json({ error: `Failed to get contributors: ${err.message}` })
  }
})

/**
 * GET /api/repo/:repoId/github-languages — return language breakdown from GitHub API.
 * Response: { languages: [{ name, bytes, percentage, color }], totalBytes }
 */
const GITHUB_LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', Java: '#b07219',
  'C++': '#f34b7d', C: '#555555', 'C#': '#178600', Go: '#00ADD8', Rust: '#dea584',
  Ruby: '#701516', PHP: '#4F5D95', Swift: '#F05138', Kotlin: '#A97BFF', Dart: '#00B4AB',
  HTML: '#e34c26', CSS: '#563d7c', SCSS: '#c6538c', Shell: '#89e051', Lua: '#000080',
  Perl: '#0298c3', R: '#198CE7', Scala: '#c22d40', Haskell: '#5e5086',
  Elixir: '#6e4a7e', Clojure: '#db5855', Vue: '#41b883', Svelte: '#ff3e00',
  Dockerfile: '#384d54', Makefile: '#427819', Nix: '#7e7eff', Zig: '#ec915c',
  OCaml: '#3be133', Jupyter: '#DA5B0B', MDX: '#fcb32c',
}

app.get('/api/repo/:repoId/github-languages', async (req, res) => {
  const { repoId } = req.params
  const auditRecord = await auditStore.getAudit(repoId)
  const pat = auditRecord?.uid ? await getUserGithubToken(auditRecord.uid) : null
  const repoUrl = auditRecord?.repoUrl || ''
  const ghMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/)

  if (!ghMatch) {
    // Fall back to the local languages endpoint
    return res.redirect(`/api/repo/${repoId}/languages`)
  }

  const owner = ghMatch[1]
  const repo = ghMatch[2]

  try {
    const ghRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/languages`,
      { headers: buildGhHeaders(pat) }
    )

    if (!ghRes.ok) {
      throw new Error(`GitHub API returned ${ghRes.status}`)
    }

    const data = await ghRes.json() // { "JavaScript": 12345, "CSS": 6789, ... }
    const totalBytes = Object.values(data).reduce((s, v) => s + v, 0)

    const languages = Object.entries(data)
      .sort((a, b) => b[1] - a[1])
      .map(([name, bytes]) => ({
        name,
        bytes,
        percentage: totalBytes > 0 ? Math.round((bytes / totalBytes) * 1000) / 10 : 0,
        color: GITHUB_LANG_COLORS[name] || '#8b8b8b',
      }))

    return res.json({ languages, totalBytes })
  } catch (err) {
    console.error(`[Languages ${repoId}] GitHub API failed:`, err.message)
    // Fall back to local analysis
    return res.redirect(`/api/repo/${repoId}/languages`)
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
app.get('/api/repo/:repoId/file', async (req, res) => {
  const { repoId } = req.params
  const relPath = req.query.path

  if (!relPath) {
    return res.status(400).json({ error: 'path query parameter is required' })
  }

  const cloneDir = path.join(TEMP_DIR, repoId)
  if (!fs.existsSync(cloneDir)) {
    const restored = await ensureCloneDir(repoId)
    if (!restored) return res.status(404).json({ error: 'Repository not found. Please clone again.' })
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
 * POST /api/audit/entry-point — AI identifies the single best entry point and reading path.
 * Body: { auditId: string }
 * Response: { entryPoint: string, readingPath: string[], reasoning: string }
 */
app.post('/api/audit/entry-point', async (req, res) => {
  const { auditId } = req.body
  if (!auditId) return res.status(400).json({ error: 'auditId is required' })

  let auditRecord = await auditStore.getAudit(auditId)

  // Return cached entry-point if available
  if (auditRecord?.cachedEntryPoint) {
    console.log(`[EntryPoint] Returning cached for ${auditId}`)
    return res.json(auditRecord.cachedEntryPoint)
  }

  let graph = auditRecord?.graph

  if (!graph) {
    const cloneDir = path.join(TEMP_DIR, auditId)
    if (!fs.existsSync(cloneDir)) {
      return res.status(404).json({ error: 'Audit not found' })
    }
    try {
      graph = await buildDependencyGraph(cloneDir)
      if (auditRecord) { await auditStore.setAudit(auditId, { graph }) }
    } catch (err) {
      return res.status(500).json({ error: `Graph build failed: ${err.message}` })
    }
  }

  const nodes = graph.nodes || []
  if (nodes.length === 0) {
    return res.json({ entryPoint: null, readingPath: [], reasoning: 'No files found in graph.' })
  }

  // For small repos (≤ 20 files), pick entry point heuristically — skip AI
  if (nodes.length <= 20) {
    const entryPatterns = [/page\.[tj]sx?$/, /index\.[tj]sx?$/, /app\.[tj]sx?$/, /main\.[tj]sx?$/, /server\.[tj]sx?$/]
    const sorted = nodes.slice().sort((a, b) => (b.size || 0) - (a.size || 0))
    const entryNode = sorted.find(n => entryPatterns.some(p => p.test(n.id))) || sorted[0]
    const readingPath = sorted.slice(0, Math.min(4, sorted.length)).map(n => n.id)
    if (!readingPath.includes(entryNode.id)) readingPath.unshift(entryNode.id)
    const result = {
      entryPoint: entryNode.id,
      readingPath,
      reasoning: `Selected ${entryNode.label} as the most central file based on dependency count and naming.`,
    }
    console.log(`[EntryPoint] Small repo (${nodes.length} files) — heuristic pick: ${entryNode.id}`)
    await auditStore.setAudit(auditId, { cachedEntryPoint: result })
    return res.json(result)
  }

  const fileLines = nodes
    .slice(0, 80)
    .map(n => `${n.id} [importedBy:${n.size || 0}, type:${n.group || 'file'}]`)
    .join('\n')

  const prompt = `You are a senior software engineer helping a new developer onboard to a codebase.

Below is the file list from a repository's dependency graph. Each file shows how many other files import it.

${fileLines}

Your task:
1. Identify the single most logical ENTRY POINT file — this is where a developer should start reading. Typically: main.js, index.ts, app.py, server.js, or the file with the most imports from other files. Not a config file, not a test file.
2. Identify the 3-4 most important NEXT files to read after the entry point, in logical reading order.
3. Write 1-2 sentences explaining why you chose this entry point.

Respond with ONLY valid JSON (no markdown, no code fences):
{
  "entryPoint": "path/to/entry/file",
  "readingPath": ["path/to/entry/file", "path/to/file2", "path/to/file3", "path/to/file4"],
  "reasoning": "one or two sentence explanation"
}`

  try {
    const raw = await callLightAI([
      { role: 'system', content: 'You are a software architecture assistant. Respond with valid JSON only.' },
      { role: 'user', content: prompt },
    ])
    logAiResponse('ENTRY-POINT RESPONSE', raw)
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    let result
    try {
      result = JSON.parse(cleaned)
    } catch {
      // Fallback: pick file with highest importedBy count
      const top = nodes.sort((a, b) => (b.size || 0) - (a.size || 0))[0]
      result = {
        entryPoint: top?.id || null,
        readingPath: nodes.slice(0, 4).map(n => n.id),
        reasoning: 'Chosen as the most-imported file in the dependency graph.',
      }
    }
    // Validate ids exist in graph
    const validIds = new Set(nodes.map(n => n.id))
    if (result.entryPoint && !validIds.has(result.entryPoint)) {
      result.entryPoint = nodes.sort((a, b) => (b.size || 0) - (a.size || 0))[0]?.id || null
    }
    result.readingPath = (result.readingPath || []).filter(id => validIds.has(id))
    await auditStore.setAudit(auditId, { cachedEntryPoint: result })
    return res.json(result)
  } catch (err) {
    console.error(`[EntryPoint] Error for ${auditId}:`, err.message)
    const top = nodes.sort((a, b) => (b.size || 0) - (a.size || 0))[0]
    return res.json({
      entryPoint: top?.id || null,
      readingPath: nodes.slice(0, 4).map(n => n.id),
      reasoning: 'Automatically selected based on dependency count.',
    })
  }
})

/**
 * POST /api/audit/card-summaries — batch one-line AI summaries for each key file.
 * Body: { auditId: string }
 * Response: { summaries: { [fileId]: string } }
 */
app.post('/api/audit/card-summaries', async (req, res) => {
  const { auditId } = req.body
  if (!auditId) return res.status(400).json({ error: 'auditId is required' })

  const cached = await auditStore.getAudit(auditId)
  if (cached?.cachedCardSummaries) {
    console.log(`[CardSummaries] Returning cached for ${auditId}`)
    return res.json({ summaries: cached.cachedCardSummaries })
  }

  let auditRecord = await auditStore.getAudit(auditId)
  let graph = auditRecord?.graph

  const cloneDir = path.join(TEMP_DIR, auditId)
  if (!fs.existsSync(cloneDir)) {
    return res.status(404).json({ error: 'Audit not found' })
  }

  if (!graph) {
    try {
      graph = await buildDependencyGraph(cloneDir)
      if (auditRecord) { await auditStore.setAudit(auditId, { graph }) }
    } catch (err) {
      return res.status(500).json({ error: `Graph build failed: ${err.message}` })
    }
  }

  const nodes = (graph.nodes || [])
    .sort((a, b) => (b.size || 0) - (a.size || 0))
    .slice(0, 30) // cap at 30 files to keep prompt manageable

  if (nodes.length === 0) return res.json({ summaries: {} })

  // Read up to 2KB of each file
  const fileBlocks = []
  for (const node of nodes) {
    const absPath = path.join(cloneDir, node.id)
    let content = ''
    try {
      if (fs.existsSync(absPath)) {
        const stat = fs.statSync(absPath)
        if (stat.isFile() && stat.size > 0) {
          const buf = Buffer.alloc(Math.min(stat.size, 2048))
          const fd = fs.openSync(absPath, 'r')
          fs.readSync(fd, buf, 0, buf.length, 0)
          fs.closeSync(fd)
          content = buf.toString('utf8')
        }
      }
    } catch {
      // skip unreadable files
    }
    if (content) {
      fileBlocks.push(`--- ${node.id} ---\n${content}`)
    }
  }

  if (fileBlocks.length === 0) return res.json({ summaries: {} })

  const prompt = `You are analyzing a codebase. For each file below, write ONE sentence (max 15 words) explaining WHY this file exists — the problem it solves, not what the code does line by line.

Files and their content:
${fileBlocks.join('\n\n')}

Respond with ONLY valid JSON (no markdown, no code fences):
{ "summaries": { "path/to/file": "one sentence here", ... } }`

  try {
    const raw = await callLightAI([
      { role: 'system', content: 'You are a software architecture assistant. Respond with valid JSON only.' },
      { role: 'user', content: prompt },
    ])
    logAiResponse('CARD-SUMMARIES RESPONSE', raw)
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    let result
    try {
      result = JSON.parse(cleaned)
    } catch {
      result = { summaries: {} }
    }
    const summaries = result.summaries || {}
    await auditStore.setAudit(auditId, { cachedCardSummaries: summaries })
    return res.json({ summaries })
  } catch (err) {
    console.error(`[CardSummaries] Error for ${auditId}:`, err.message)
    return res.json({ summaries: {} })
  }
})

/**
 * POST /api/audit/flow-query — AI answers a codebase navigation question with a file path.
 * Body: { auditId: string, query: string }
 * Response: { path: string[], explanation: string }
 */
app.post('/api/audit/flow-query', async (req, res) => {
  const { auditId, query } = req.body
  if (!auditId || !query) return res.status(400).json({ error: 'auditId and query are required' })

  let auditRecord = await auditStore.getAudit(auditId)
  let graph = auditRecord?.graph

  if (!graph) {
    const cloneDir = path.join(TEMP_DIR, auditId)
    if (!fs.existsSync(cloneDir)) {
      return res.status(404).json({ error: 'Audit not found' })
    }
    try {
      graph = await buildDependencyGraph(cloneDir)
      if (auditRecord) { await auditStore.setAudit(auditId, { graph }) }
    } catch (err) {
      return res.status(500).json({ error: `Graph build failed: ${err.message}` })
    }
  }

  const nodes = graph.nodes || []
  const fileList = nodes.slice(0, 100).map(n => n.id).join('\n')

  // Add any relevant findings context
  const findings = auditRecord?.findings || []
  const findingsSummary = findings.length > 0
    ? `\n\nRepository has ${findings.length} security findings. Top issues: ` +
      findings.filter(f => f.severity === 'critical' || f.severity === 'high').slice(0, 5).map(f => `${f.file}: ${f.description}`).join('; ')
    : ''

  const prompt = `You are a codebase navigation assistant. Given this repository's file list and the user's question, identify the ordered sequence of files that answer the question.

Files in repository:
${fileList}${findingsSummary}

User question: "${query}"

Return ONLY valid JSON (no markdown, no code fences):
{
  "path": ["file1.js", "file2.js", ...],
  "explanation": "one paragraph explaining the flow"
}

Rules:
- Return 3-8 files maximum that form a logical flow path relevant to the question
- Only include files from the list above
- Order them in the sequence a developer would follow to understand the flow
- If you cannot find relevant files, return an empty path with an explanation`

  try {
    const raw = await callLightAI([
      { role: 'system', content: 'You are a codebase navigation assistant. Respond with valid JSON only.' },
      { role: 'user', content: prompt },
    ])
    logAiResponse('FLOW-QUERY RESPONSE', raw)
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    let result
    try {
      result = JSON.parse(cleaned)
    } catch {
      result = { path: [], explanation: 'Could not parse the AI response. Please try rephrasing your question.' }
    }
    // Validate that returned file ids exist in graph
    const validIds = new Set(nodes.map(n => n.id))
    result.path = (result.path || []).filter(id => validIds.has(id))
    return res.json(result)
  } catch (err) {
    console.error(`[FlowQuery] Error for ${auditId}:`, err.message)
    return res.status(500).json({ error: `Flow query failed: ${err.message}` })
  }
})

/**
 * POST /api/audit/what-to-fix — generate improvement recommendations from visual map analysis.
 * Reuses cached analyze-visual data if available.
 * Body: { auditId: string }
 * Response: { recommendations: [{ file, title, description }] }
 */
app.post('/api/audit/what-to-fix', async (req, res) => {
  const { auditId } = req.body
  if (!auditId) return res.status(400).json({ error: 'auditId is required' })

  // Check Firestore-backed cache first
  const cached = await auditStore.getAudit(auditId)
  if (cached?.cachedWhatToFix) {
    return res.json({ recommendations: cached.cachedWhatToFix })
  }

  // Use JSON with whitespace keepalive (SSE gets buffered by Firebase Hosting proxy)
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-cache, no-store')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
  res.write(' ')
  const keepalive = setInterval(() => {
    try { res.write(' ') } catch { clearInterval(keepalive) }
  }, 5000)

  let auditRecord = cached
  if (!auditRecord) {
    clearInterval(keepalive)
    return res.end(JSON.stringify({ error: 'Audit not found' }))
  }

  let { repoName, graph } = auditRecord

  if (!graph || !graph.nodes || graph.nodes.length === 0) {
    const cloneDir = path.join(TEMP_DIR, auditId)
    if (fs.existsSync(cloneDir)) {
      try {
        graph = await buildDependencyGraph(cloneDir)
        await auditStore.setAudit(auditId, { graph })
      } catch (err) {
        console.error(`[WhatToFix] Graph build failed for ${auditId}:`, err.message)
      }
    }
  }

  const nodes = graph?.nodes || []
  if (nodes.length === 0) {
    clearInterval(keepalive)
    return res.end(JSON.stringify({ error: 'No graph data available — try opening the Visual Map first' }))
  }

  const fileList = nodes.slice(0, 80).map(n => n.id).join('\n')
  const extensions = [...new Set(nodes.map(n => n.id.split('.').pop()))].join(', ')

  const prompt = `You are a senior software engineer reviewing the repository "${repoName}".

Files in the project:
${fileList || '(no file list)'}

Technologies detected: ${extensions}

Based on the project structure and file names, identify specific improvement recommendations — things that could be refactored, simplified, better organised, or added to improve the codebase quality.

Focus on:
- Architecture improvements (missing abstractions, poor separation of concerns)
- Files that are likely too large or doing too much based on their name
- Missing things that this type of project typically needs (tests, config, documentation)
- Code organisation improvements

Do NOT mention security vulnerabilities (those are in the security report).

If the project looks clean and well-structured with nothing obvious to improve, return an empty array.

Return ONLY valid JSON, no markdown:
[
  { "file": "path/to/file or area", "title": "short title", "description": "1-2 sentence actionable suggestion" }
]

Return 0-6 items. Return [] if nothing meaningful to suggest.`

  try {
    const aiMessages = [
      { role: 'system', content: 'You are a senior software engineer. Respond with a JSON array only. No markdown, no explanation.' },
      { role: 'user', content: prompt },
    ]

    let raw = await callLightAI(aiMessages, 2048)
    logAiResponse('WHAT-TO-FIX RESPONSE', raw)

    if (!raw || raw.trim().length === 0) {
      console.warn(`[WhatToFix] Empty AI response for ${auditId}, retrying...`)
      raw = await callLightAI(aiMessages, 2048)
      logAiResponse('WHAT-TO-FIX RETRY RESPONSE', raw)
    }

    clearInterval(keepalive)

    if (!raw || raw.trim().length === 0) {
      return res.end(JSON.stringify({ recommendations: [], error: 'AI returned an empty response' }))
    }

    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    let recommendations
    try {
      recommendations = JSON.parse(cleaned)
      if (!Array.isArray(recommendations)) recommendations = []
    } catch {
      const arrMatch = cleaned.match(/\[[\s\S]*\]/)
      if (arrMatch) {
        try { recommendations = JSON.parse(arrMatch[0]) } catch { recommendations = [] }
      } else {
        recommendations = []
      }
    }
    // Persist to Firestore so it survives restarts/redeployments
    await auditStore.setAudit(auditId, { cachedWhatToFix: recommendations })
    res.end(JSON.stringify({ recommendations }))
  } catch (err) {
    clearInterval(keepalive)
    console.error(`[WhatToFix] Error for ${auditId}:`, err.message)
    res.end(JSON.stringify({ error: err.message }))
  }
})

/**
 * POST /api/audit/generate-faq — generate project-specific suggested questions.
 * Body: { auditId: string }
 * Response: { questions: string[] }
 */
const faqCache = new Map()

app.post('/api/audit/generate-faq', async (req, res) => {
  const { auditId } = req.body
  if (!auditId) return res.status(400).json({ error: 'auditId is required' })

  // Return cached if available
  if (faqCache.has(auditId)) {
    return res.json({ questions: faqCache.get(auditId) })
  }

  let auditRecord = await auditStore.getAudit(auditId)
  let graph = auditRecord?.graph

  if (!graph) {
    const cloneDir = path.join(TEMP_DIR, auditId)
    if (!fs.existsSync(cloneDir)) await ensureCloneDir(auditId)
    if (fs.existsSync(path.join(TEMP_DIR, auditId))) {
      try {
        graph = await buildDependencyGraph(path.join(TEMP_DIR, auditId))
        if (auditRecord) await auditStore.setAudit(auditId, { graph })
      } catch { /* continue without graph */ }
    }
  }

  const nodes = (graph?.nodes) || []
  const fileList = nodes.slice(0, 80).map(n => n.id).join('\n')
  const repoName = auditRecord?.repoName || auditId

  // Gather some context about the project
  const edges = (graph?.edges) || []
  const extensions = [...new Set(nodes.map(n => n.id.split('.').pop()))].join(', ')
  const findingsSummary = (auditRecord?.findings || []).length > 0
    ? `The project has ${auditRecord.findings.length} security findings.`
    : ''

  const prompt = `You are analyzing a repository called "${repoName}".

Files in the project:
${fileList}

Technologies/extensions used: ${extensions}
${findingsSummary}
Number of files: ${nodes.length}, Number of dependency connections: ${edges.length}

Generate exactly 5 suggested questions that a developer exploring this specific project for the first time would find most useful. The questions should:
- Be specific to THIS project's actual files, structure, and technology stack
- Cover different aspects: architecture, data flow, entry points, key logic, and patterns
- Be natural questions a developer would ask, not generic
- Reference actual patterns you can see in the file names (e.g. if you see auth files, ask about auth flow; if you see API routes, ask about the API layer)

Return ONLY a JSON array of 5 strings, no markdown, no code fences:
["question 1", "question 2", "question 3", "question 4", "question 5"]`

  try {
    const raw = await callLightAI([
      { role: 'system', content: '/no_think\nYou generate project-specific FAQ questions. Respond with a JSON array only. No thinking, no explanation.' },
      { role: 'user', content: prompt },
    ], 1024)
    logAiResponse('GENERATE-FAQ RESPONSE', raw)
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    let questions
    try {
      questions = JSON.parse(cleaned)
      if (!Array.isArray(questions)) throw new Error('not an array')
      questions = questions.filter(q => typeof q === 'string').slice(0, 5)
    } catch {
      questions = [
        'What is the main entry point of this project?',
        'How is the project structured?',
        'Where is the core business logic?',
        'How does data flow through the application?',
        'What external services does this project depend on?',
      ]
    }
    faqCache.set(auditId, questions)
    return res.json({ questions })
  } catch (err) {
    console.error(`[GenerateFAQ] Error for ${auditId}:`, err.message)
    return res.status(500).json({ error: `FAQ generation failed: ${err.message}` })
  }
})

/**
 * POST /api/audit/tour — generate a step-by-step tour of the repository.
 * Body: { auditId: string }
 * Response: { steps: [{ target, description, action, type }] }
 */
app.post('/api/audit/tour', async (req, res) => {
  try {
    const { auditId } = req.body
    if (!auditId) return res.status(400).json({ error: 'auditId is required' })

    const auditRecord = await auditStore.getAudit(auditId)
    if (!auditRecord) return res.status(404).json({ error: 'Audit not found' })

    // Check for cached tour steps
    if (auditRecord.tourSteps && auditRecord.tourSteps.length > 0) {
      console.log(`[Tour] Returning ${auditRecord.tourSteps.length} cached tour steps`)
      return res.json({ steps: auditRecord.tourSteps, cached: true })
    }

    const { repoName = 'Repository', findings = [], graph } = auditRecord

    // 1. Get nodes and sort by importance (size = in-degree) to help AI find the "heart" of the app
    let nodes = (graph?.nodes || [])
      .sort((a, b) => (b.size || 0) - (a.size || 0))
    
    if (nodes.length === 0) {
      const uniqueFiles = [...new Set(findings.map(f => f.file).filter(Boolean))]
      if (uniqueFiles.length > 0) {
        nodes = uniqueFiles.map(f => ({ id: f }))
      }
    }

    if (nodes.length === 0) {
      return res.json({ 
        steps: [{ target: '.', type: 'folder', description: 'Welcome! Start by exploring the root directory.', action: 'zoom_to' }],
        isFallback: true 
      })
    }

    // 2. Build compact context: top 40 files + edges (smaller prompt = faster response)
    const topNodes = nodes.slice(0, 40)
    const topNodeIds = new Set(topNodes.map(n => n.id))

    const fileList = topNodes
      .map(n => `${n.id} (${n.size || 0})`)
      .join('\n')

    const edges = (graph?.edges || [])
      .filter(e => topNodeIds.has(e.source) && topNodeIds.has(e.target))
      .slice(0, 100)
      .map(e => `${e.source} → ${e.target}`)
      .join('\n')

    const prompt = `Create a 9-step guided tour of "${repoName}" codebase. Tell the story of how the app works end-to-end.

FILES (name, import count):
${fileList}

EDGES (source imports target):
${edges || 'none'}

RULES:
- Pick 9 files for complete story: entry→config→middleware→routes→data→frontend
- Use EXACT paths from list. 2-3 sentence descriptions. Be concise.
- relatesTo = other tour files this one connects to
- Output raw JSON only

{"steps":[{"target":"path.js","type":"file","title":"3-5 words","description":"2-3 sentences","action":"zoom_to","relatesTo":["path.js"]}]}`

    try {
      console.log('[Tour] Calling AI for tour generation...')
      const rawText = await callLightAI([
        { role: 'system', content: '/no_think\nRespond with raw valid JSON only. No markdown, no fences, no explanation, no thinking.' },
        { role: 'user', content: prompt },
      ], 4096)

      console.log('[Tour] Raw response length:', rawText.length)
      logAiResponse('TOUR RESPONSE', rawText)

      // Save raw response for debugging (in temp dir so Vite doesn't HMR reload)
      try {
        fs.writeFileSync(path.join(TEMP_DIR, 'ai_tour_response.txt'), rawText, 'utf8')
        console.log('[Tour] Saved raw response to temp/ai_tour_response.txt')
      } catch (writeErr) {
        console.warn('[Tour] Could not save response file:', writeErr.message)
      }

      if (!rawText || rawText.length < 10) {
        throw new Error(`Empty or too short response (${rawText.length} chars)`)
      }

      // Strip thinking tags (Qwen3), markdown fences, and any non-JSON text
      const cleaned = rawText
        .replace(/<think>[\s\S]*?<\/think>/gi, '')  // Qwen3 thinking tags
        .replace(/```(?:json)?\s*/gi, '')             // markdown fences
        .trim()

      // Try to find a JSON object { ... } or array [ ... ]
      let jsonStr
      const objStart = cleaned.indexOf('{')
      const arrStart = cleaned.indexOf('[')

      if (arrStart !== -1 && (objStart === -1 || arrStart < objStart)) {
        // AI returned a bare array — wrap it as { steps: [...] }
        const endIdx = cleaned.lastIndexOf(']')
        if (endIdx === -1) throw new Error('No JSON found in response')
        jsonStr = `{"steps":${cleaned.slice(arrStart, endIdx + 1)}}`
      } else if (objStart !== -1) {
        const endIdx = cleaned.lastIndexOf('}')
        if (endIdx === -1) throw new Error('No JSON found in response')
        jsonStr = cleaned.slice(objStart, endIdx + 1)
      } else {
        throw new Error('No JSON found in response')
      }

      const result = JSON.parse(jsonStr)

      if (!result.steps || !Array.isArray(result.steps)) throw new Error('Invalid steps array')

      console.log(`[Tour] Successfully parsed ${result.steps.length} tour steps`)

      // Cache tour steps in Firestore for instant reload
      await auditStore.setAudit(auditId, { tourSteps: result.steps })

      return res.json(result)
    } catch (aiErr) {
      console.error('[Tour] AI/Parse Error:', aiErr.message)
      // AI fallback
      const fallbackSteps = [
        {
          target: nodes[0]?.id || '.',
          type: nodes[0]?.id?.includes('.') ? 'file' : 'folder',
          title: 'Entry Point',
          description: `Welcome to ${repoName}. This is the main entry point of the codebase.`,
          action: 'zoom_to',
          relatesTo: nodes.length > 1 ? [nodes[1].id] : []
        },
        {
          target: nodes.find(n => n.id.includes('package.json') || n.id.includes('requirements.txt'))?.id || nodes[Math.min(1, nodes.length-1)].id,
          type: 'file',
          title: 'Dependencies',
          description: 'This file defines the project dependencies and configuration.',
          action: 'zoom_to',
          relatesTo: [nodes[0]?.id || '.']
        }
      ]
      return res.json({ steps: fallbackSteps, isFallback: true })
    }
  } catch (globalErr) {
    console.error('[Tour] Global Error:', globalErr)
    return res.status(500).json({ error: 'Internal server error during tour generation' })
  }
})

/**
 * DELETE /api/audit/:auditId — clean up a cloned repo from disk
 */
app.delete('/api/audit/:auditId', async (req, res) => {
  const { auditId } = req.params

  if (!(await auditStore.hasAudit(auditId))) {
    return res.status(404).json({ error: `Audit ${auditId} not found` })
  }

  const cloneDir = path.join(TEMP_DIR, auditId)
  await safeDeleteDir(cloneDir)
  await auditStore.deleteAudit(auditId)

  console.log(`[Server] Deleted audit ${auditId}`)
  return res.json({ success: true, auditId })
})

// ---------------------------------------------------------------------------
// Stripe endpoints
// ---------------------------------------------------------------------------

/**
 * POST /api/stripe/create-checkout-session
 * Creates a Stripe Checkout session for one-time $9.99 payment.
 * Body: { userId, returnUrl }
 */
app.post('/api/stripe/create-checkout-session', async (req, res) => {
  const { userId, returnUrl } = req.body
  if (!userId) return res.status(400).json({ error: 'userId required' })

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'QADNA Repo Analysis — Full Access',
            description: 'Unlimited repository analysis, visual maps, and AI insights.',
          },
          unit_amount: 999, // $9.99
        },
        quantity: 1,
      }],
      metadata: { userId },
      success_url: `${returnUrl}?payment_success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${returnUrl}?payment_cancelled=true`,
    })
    res.json({ url: session.url })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/stripe/verify-session
 * Called after Stripe redirects back on success. Marks user as paid in Firestore.
 * Body: { sessionId, userId }
 */
app.post('/api/stripe/verify-session', async (req, res) => {
  const { sessionId, userId } = req.body
  if (!sessionId || !userId) return res.status(400).json({ error: 'sessionId and userId required' })

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId)
    // Payment links use client_reference_id; checkout sessions use metadata.userId
    const sessionUserId = session.client_reference_id || session.metadata?.userId
    if (session.payment_status === 'paid' && sessionUserId === userId) {
      if (firebaseReady) {
        await db.collection('users').doc(userId).set(
          { hasPaid: true, paidAt: new Date().toISOString() },
          { merge: true }
        )
      }
      return res.json({ success: true })
    }
    res.status(400).json({ error: 'Payment not confirmed' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/stripe/check-payment
 * Searches recent Stripe sessions for a paid session matching this userId.
 * Used as fallback when webhook hasn't fired (e.g. local dev).
 * Body: { userId }
 */
app.post('/api/stripe/check-payment', async (req, res) => {
  const { userId } = req.body
  if (!userId) return res.status(400).json({ error: 'userId required' })

  try {
    // List recent sessions and filter manually (Stripe doesn't support client_reference_id as a list filter)
    const sessions = await stripe.checkout.sessions.list({ limit: 50 })

    console.log(`[Stripe] check-payment for ${userId}: scanning ${sessions.data.length} sessions`)
    sessions.data.forEach(s => console.log(`  ${s.id} status=${s.payment_status} ref=${s.client_reference_id} meta=${JSON.stringify(s.metadata)}`))

    const paid = sessions.data.find(s =>
      s.payment_status === 'paid' &&
      (s.client_reference_id === userId || s.metadata?.userId === userId)
    )

    if (paid) {
      if (firebaseReady) {
        await db.collection('users').doc(userId).set(
          { hasPaid: true, paidAt: new Date().toISOString(), stripeSessionId: paid.id },
          { merge: true }
        )
        console.log(`[Stripe] Marked ${userId} as paid via session ${paid.id}`)
      }
      return res.json({ success: true, found: true })
    }

    console.log(`[Stripe] No paid session found for ${userId}`)
    res.json({ success: false, found: false })
  } catch (err) {
    console.error(`[Stripe] check-payment error:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/stripe/webhook
 * Stripe webhook for production payment confirmation.
 */
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature']
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

  let event
  try {
    event = webhookSecret
      ? stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
      : JSON.parse(req.body)
  } catch (err) {
    return res.status(400).json({ error: `Webhook error: ${err.message}` })
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    // Support both checkout sessions (metadata.userId) and payment links (client_reference_id)
    const userId = session.metadata?.userId || session.client_reference_id
    if (session.payment_status === 'paid' && userId) {
      if (firebaseReady) {
        await db.collection('users').doc(userId).set(
          { hasPaid: true, paidAt: new Date().toISOString() },
          { merge: true }
        )
        console.log(`[Stripe] Marked user ${userId} as paid`)
      }
    }
  }

  res.json({ received: true })
})

// ---------------------------------------------------------------------------
// User endpoints
// ---------------------------------------------------------------------------
// Dev utilities (only active in non-production)
// ---------------------------------------------------------------------------

/**
 * POST /api/dev/set-paid — manually set a user's paid status for testing.
 * Body: { userId, paid: true|false }
 * Disabled in production (NODE_ENV=production).
 */
if (process.env.NODE_ENV !== 'production') {
  app.post('/api/dev/set-paid', async (req, res) => {
    const { userId, paid } = req.body
    if (!userId) return res.status(400).json({ error: 'userId required' })

    if (!firebaseReady) return res.status(503).json({ error: 'Firebase not ready' })

    const hasPaid = paid === true || paid === 'true'
    try {
      await db.collection('users').doc(userId).set({
        hasPaid,
        updatedAt: new Date().toISOString(),
        ...(hasPaid ? { paidAt: new Date().toISOString() } : { paidAt: null }),
      }, { merge: true })

      console.log(`[Dev] User ${userId} → hasPaid: ${hasPaid}`)
      res.json({ success: true, userId, hasPaid })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  console.log('[Dev] /api/dev/set-paid endpoint enabled (non-production mode)')
}

// ---------------------------------------------------------------------------

/**
 * GET /api/user/repos
 * Returns the list of analyzed repos for a paid user.
 * Query: ?uid=xxx
 */
app.get('/api/user/repos', async (req, res) => {
  const { uid } = req.query
  if (!uid) return res.status(400).json({ error: 'uid required' })

  const repos = await auditStore.listAudits()
  res.json({ repos })
})

// ---------------------------------------------------------------------------
// GitHub PAT management
// ---------------------------------------------------------------------------

/**
 * POST /api/user/github-token — save or clear a GitHub PAT for a user.
 * Body: { uid, githubPat }
 */
app.post('/api/user/github-token', async (req, res) => {
  const { uid, githubPat } = req.body
  if (!uid) return res.status(400).json({ error: 'uid required' })
  if (!firebaseReady) return res.status(503).json({ error: 'Database not ready' })

  try {
    const updateData = githubPat
      ? { githubPat, githubPatUpdatedAt: new Date().toISOString() }
      : { githubPat: '', githubPatUpdatedAt: new Date().toISOString() }
    await db.collection('users').doc(uid).set(updateData, { merge: true })
    console.log(`[Auth] GitHub PAT ${githubPat ? 'saved' : 'cleared'} for user ${uid}`)
    res.json({ success: true })
  } catch (err) {
    console.error(`[Auth] Failed to save GitHub PAT:`, err.message)
    res.status(500).json({ error: 'Failed to save token' })
  }
})

/**
 * POST /api/user/github-token/status — check if user has a valid GitHub PAT.
 * Body: { uid }
 * Response: { connected, login?, scopes? }
 */
app.post('/api/user/github-token/status', async (req, res) => {
  const { uid } = req.body
  if (!uid) return res.status(400).json({ error: 'uid required' })

  const pat = await getUserGithubToken(uid)
  if (!pat) return res.json({ connected: false })

  try {
    const ghRes = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `Bearer ${pat}`, 'User-Agent': 'QADNA-CodeAtlas' },
    })
    if (!ghRes.ok) return res.json({ connected: false, error: 'Token invalid or expired' })
    const data = await ghRes.json()
    res.json({ connected: true, login: data.login, avatarUrl: data.avatar_url })
  } catch {
    res.json({ connected: false, error: 'Failed to verify token' })
  }
})

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

app.use((err, _req, res, _next) => {
  console.error('[Server] Unhandled error:', err)
  res.status(500).json({ error: 'Internal server error' })
})

// ---------------------------------------------------------------------------
// File git info
// ---------------------------------------------------------------------------

/**
 * POST /api/audit/file-git-info
 * Returns last commit info for a file in the cloned repo.
 * Body: { auditId, filePath }
 */
app.post('/api/audit/file-git-info', async (req, res) => {
  const { auditId, filePath } = req.body
  if (!auditId || !filePath) return res.status(400).json({ error: 'auditId and filePath required' })

  const cloneDir = path.join(TEMP_DIR, auditId)
  if (!fs.existsSync(cloneDir)) {
    const restored = await ensureCloneDir(auditId)
    if (!restored) return res.status(404).json({ error: 'Repo not found. Please re-analyze.' })
  }

  try {
    const git = simpleGit(cloneDir)
    const log = await git.log({ file: filePath, maxCount: 1 })
    const latest = log.latest
    if (!latest) return res.json({ lastChanged: null, message: null })

    const date = new Date(latest.date)
    const lastChanged = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

    return res.json({ lastChanged, message: latest.message?.trim() || '' })
  } catch (err) {
    console.error('[file-git-info]', err.message)
    return res.json({ lastChanged: null, message: null })
  }
})

// ---------------------------------------------------------------------------
// Serve built frontend in production (after all API routes)
// ---------------------------------------------------------------------------

const DIST_DIR = path.join(__dirname, '..', 'dist')
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR))
  // SPA fallback — serve index.html for any non-API route
  app.get('{*path}', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(DIST_DIR, 'index.html'))
    }
  })
  console.log('[Server] Serving built frontend from dist/')
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Only listen when run directly (not when imported by Cloud Functions)
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isDirectRun) {
  app.listen(PORT, () => {
    console.log(`[Server] CodeAtlas audit server running on http://localhost:${PORT}`)
    console.log(`[Server] Temp directory: ${TEMP_DIR}`)
  })
}

export { app }
