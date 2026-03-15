/**
 * Audit Store — Firestore-backed persistence with in-memory cache.
 *
 * Replaces the old in-memory `audits` Map. All data persists across
 * server restarts. The local cache avoids Firestore latency on hot paths.
 *
 * Collection structure:
 *   audits/{auditId}            — core metadata + scanSummary + aiReport
 *   audits/{auditId}/findings   — chunked findings arrays
 *   graphs/{auditId}.json       — graph data in Firebase Storage
 */

import { db, firebaseReady } from './firebaseAdmin.js'

const FINDINGS_CHUNK_SIZE = 150 // max findings per Firestore doc

// ── In-memory cache (write-through) ──────────────────────────────────────────

const cache = new Map()

// ── Core CRUD ────────────────────────────────────────────────────────────────

/**
 * Get an audit record. Checks cache first, then Firestore.
 */
export async function getAudit(auditId) {
  if (cache.has(auditId)) return cache.get(auditId)

  if (!firebaseReady) return null

  try {
    const doc = await db.collection('audits').doc(auditId).get()
    if (!doc.exists) return null

    const data = doc.data()

    // Load findings from subcollection
    const findingsSnap = await db.collection('audits').doc(auditId)
      .collection('findings').orderBy('chunkIndex').get()
    let findings = []
    findingsSnap.forEach(chunk => {
      findings = findings.concat(chunk.data().items || [])
    })
    if (findings.length > 0) data.findings = findings

    // Load graph from Storage
    const graph = await getGraph(auditId)
    if (graph) data.graph = graph

    cache.set(auditId, data)
    return data
  } catch (err) {
    console.error(`[AuditStore] getAudit(${auditId}) error:`, err.message)
    return null
  }
}

/**
 * Set/merge audit data. Updates both cache and Firestore.
 */
export async function setAudit(auditId, data) {
  // Update cache immediately
  const existing = cache.get(auditId) || {}
  const merged = { ...existing, ...data, updatedAt: new Date().toISOString() }
  cache.set(auditId, merged)

  if (!firebaseReady) return

  try {
    // Separate findings and graph from the main doc (stored separately)
    const { findings, graph, scanResult, ...docData } = merged

    // Write main doc (merge to avoid overwriting fields)
    await db.collection('audits').doc(auditId).set(docData, { merge: true })

    // Write findings if provided in this update
    if (data.findings) {
      await setFindings(auditId, data.findings)
    }

    // Write graph if provided in this update
    if (data.graph) {
      await setGraph(auditId, data.graph)
    }
  } catch (err) {
    console.error(`[AuditStore] setAudit(${auditId}) error:`, err.message)
  }
}

/**
 * Check if audit exists (cache or Firestore).
 */
export async function hasAudit(auditId) {
  if (cache.has(auditId)) return true
  if (!firebaseReady) return false

  try {
    const doc = await db.collection('audits').doc(auditId).get()
    return doc.exists
  } catch {
    return false
  }
}

/**
 * Delete an audit completely.
 */
export async function deleteAudit(auditId) {
  cache.delete(auditId)

  if (!firebaseReady) return

  try {
    // Delete findings subcollection
    const findingsSnap = await db.collection('audits').doc(auditId)
      .collection('findings').get()
    const batch = db.batch()
    findingsSnap.forEach(doc => batch.delete(doc.ref))
    await batch.commit()

    // Delete main doc
    await db.collection('audits').doc(auditId).delete()

    // Delete graph subcollection
    try {
      const graphDoc = db.collection('audits').doc(auditId).collection('graphData').doc('graph')
      await graphDoc.delete()
    } catch {}
  } catch (err) {
    console.error(`[AuditStore] deleteAudit(${auditId}) error:`, err.message)
  }
}

/**
 * List all audits (summary only — does not load findings/graph).
 */
export async function listAudits() {
  if (!firebaseReady) {
    return Array.from(cache.values()).map(({ auditId, repoUrl, repoName, clonedAt, status, analyzedBy }) => ({
      auditId, repoUrl, repoName, clonedAt, status, analyzedBy: analyzedBy || '',
    }))
  }

  try {
    const snap = await db.collection('audits').orderBy('updatedAt', 'desc').get()
    const list = []
    snap.forEach(doc => {
      const d = doc.data()
      list.push({
        auditId: d.auditId, repoUrl: d.repoUrl, repoName: d.repoName,
        clonedAt: d.clonedAt, status: d.status, analyzedBy: d.analyzedBy || '',
      })
    })
    return list
  } catch (err) {
    console.error('[AuditStore] listAudits error:', err.message)
    return Array.from(cache.values()).map(({ auditId, repoUrl, repoName, clonedAt, status, analyzedBy }) => ({
      auditId, repoUrl, repoName, clonedAt, status, analyzedBy: analyzedBy || '',
    }))
  }
}

/**
 * Find an existing audit by repo URL or repoName.
 * Prefers 'complete' status, but returns any existing audit with data.
 */
export async function findByRepoUrl(repoUrl, repoName) {
  // Check cache first — only trust entries that have been fully loaded (have graph or aiReport)
  let bestCache = null
  for (const audit of cache.values()) {
    if (audit.repoUrl === repoUrl || audit.repoName === repoName) {
      const isFullyLoaded = audit.graph || audit.aiReport || audit.status !== 'complete'
      if (audit.status === 'complete' && isFullyLoaded) return audit
      if (!bestCache) bestCache = audit
    }
  }
  if (bestCache && bestCache.status !== 'complete') return bestCache

  if (!firebaseReady) return null

  try {
    // Try by repoUrl first
    let snap = await db.collection('audits')
      .where('repoUrl', '==', repoUrl)
      .limit(5)
      .get()

    // If nothing by URL, try by repoName
    if (snap.empty && repoName) {
      snap = await db.collection('audits')
        .where('repoName', '==', repoName)
        .limit(5)
        .get()
    }

    if (snap.empty) return null

    // Prefer complete, otherwise return the most recent one
    let bestId = null
    let bestUpdated = ''
    for (const doc of snap.docs) {
      const data = doc.data()
      if (data.status === 'complete') {
        bestId = data.auditId
        break
      }
      if (!bestId || (data.updatedAt && data.updatedAt > bestUpdated)) {
        bestId = data.auditId
        bestUpdated = data.updatedAt || ''
      }
    }

    if (!bestId) return null

    // Do a full load (graph + findings) so the cache is properly populated
    return await getAudit(bestId)
  } catch (err) {
    console.error(`[AuditStore] findByRepoUrl error:`, err.message)
    return null
  }
}

// ── Specialized operations ───────────────────────────────────────────────────

/**
 * Quick status update — fastest path for status changes.
 */
export async function setAuditStatus(auditId, status) {
  const existing = cache.get(auditId)
  if (existing) existing.status = status

  if (!firebaseReady) return

  try {
    await db.collection('audits').doc(auditId).update({
      status,
      updatedAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error(`[AuditStore] setAuditStatus(${auditId}, ${status}) error:`, err.message)
  }
}

/**
 * Write findings (chunked to avoid Firestore 1MB doc limit).
 */
async function setFindings(auditId, findings) {
  if (!firebaseReady || !findings?.length) return

  try {
    // Delete old chunks first
    const oldSnap = await db.collection('audits').doc(auditId)
      .collection('findings').get()
    const delBatch = db.batch()
    oldSnap.forEach(doc => delBatch.delete(doc.ref))
    await delBatch.commit()

    // Write new chunks
    for (let i = 0; i < findings.length; i += FINDINGS_CHUNK_SIZE) {
      const chunk = findings.slice(i, i + FINDINGS_CHUNK_SIZE)
      await db.collection('audits').doc(auditId)
        .collection('findings').doc(`chunk_${Math.floor(i / FINDINGS_CHUNK_SIZE)}`)
        .set({ chunkIndex: Math.floor(i / FINDINGS_CHUNK_SIZE), items: chunk })
    }
  } catch (err) {
    console.error(`[AuditStore] setFindings(${auditId}) error:`, err.message)
  }
}

/**
 * Write graph data to Firestore (as a subcollection doc to avoid main doc size limits).
 */
export async function setGraph(auditId, graph) {
  const existing = cache.get(auditId)
  if (existing) existing.graph = graph

  if (!firebaseReady) return

  try {
    await db.collection('audits').doc(auditId)
      .collection('graphData').doc('graph')
      .set({ data: JSON.stringify(graph) })
  } catch (err) {
    console.error(`[AuditStore] setGraph(${auditId}) error:`, err.message)
  }
}

/**
 * Read graph data from Firestore subcollection.
 */
async function getGraph(auditId) {
  if (!firebaseReady) return null

  try {
    const doc = await db.collection('audits').doc(auditId)
      .collection('graphData').doc('graph').get()
    if (!doc.exists) return null
    return JSON.parse(doc.data().data)
  } catch (err) {
    console.error(`[AuditStore] getGraph(${auditId}) error:`, err.message)
    return null
  }
}

/**
 * Get the most recently completed audit (for session restoration).
 */
export async function getLastAudit() {
  if (!firebaseReady) {
    // Fallback to cache
    let latest = null
    for (const audit of cache.values()) {
      if (audit.status === 'complete') {
        if (!latest || (audit.updatedAt && audit.updatedAt > latest.updatedAt)) {
          latest = audit
        }
      }
    }
    return latest
  }

  try {
    // Simple query — no composite index needed
    const snap = await db.collection('audits')
      .orderBy('updatedAt', 'desc')
      .limit(10)
      .get()

    if (snap.empty) return null

    // Find the most recent completed one
    for (const doc of snap.docs) {
      const data = doc.data()
      if (data.status === 'complete') return data
    }
    return null
  } catch (err) {
    console.error('[AuditStore] getLastAudit error:', err.message)
    return null
  }
}

/**
 * Get cached audit synchronously (for hot paths during streaming).
 */
export function getCached(auditId) {
  return cache.get(auditId) || null
}

/**
 * Cache size (for health endpoint).
 */
export function cacheSize() {
  return cache.size
}
