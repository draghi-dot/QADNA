/**
 * Dependency graph builder for CodeAtlas.
 * Walks a cloned repository directory, parses import/require statements,
 * and returns a graph of nodes (files) and edges (dependencies).
 */

import fs from 'fs'
import path from 'path'

const MAX_DEPTH = 10
const MAX_NODES = 300

/** Directories to skip entirely — mirrors scanner.js SKIP_DIRS */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__',
  '.next', '.nuxt', 'coverage', '.cache', 'vendor', 'bower_components',
  '.turbo', '.vercel', 'out', 'tmp', 'temp',
])

/** Extensions we parse for imports */
const SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go',
])

/**
 * Detect the language group for a file extension.
 * @param {string} ext
 * @returns {string}
 */
function extToGroup(ext) {
  const map = {
    '.js': 'js',
    '.mjs': 'js',
    '.cjs': 'js',
    '.jsx': 'jsx',
    '.ts': 'ts',
    '.tsx': 'tsx',
    '.py': 'py',
    '.go': 'go',
  }
  return map[ext] || 'other'
}

/**
 * Recursively collect all source files under a directory.
 * @param {string} dir - Absolute path to repo root
 * @param {string} base - Current directory being walked
 * @param {number} depth
 * @param {string[]} results - Accumulator of absolute paths
 */
function collectFiles(dir, base, depth, results) {
  if (depth > MAX_DEPTH) return
  let entries
  try {
    entries = fs.readdirSync(base, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const fullPath = path.join(base, entry.name)

    if (entry.isDirectory()) {
      collectFiles(dir, fullPath, depth + 1, results)
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (SOURCE_EXTENSIONS.has(ext)) {
        results.push(fullPath)
      }
    }
  }
}

/**
 * Extract local import paths from JS/TS source.
 * Only resolves relative imports starting with ./ or ../
 * @param {string} source
 * @returns {string[]}
 */
function extractJsImports(source) {
  const imports = []

  // ES module: import ... from './path' or import './path'
  const esModuleRe = /\bimport\s+(?:[^'"]*\s+from\s+)?['"](\.[^'"]+)['"]/g
  let m
  while ((m = esModuleRe.exec(source)) !== null) {
    imports.push(m[1])
  }

  // CommonJS: require('./path')
  const requireRe = /\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g
  while ((m = requireRe.exec(source)) !== null) {
    imports.push(m[1])
  }

  // Dynamic import: import('./path')
  const dynamicRe = /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g
  while ((m = dynamicRe.exec(source)) !== null) {
    imports.push(m[1])
  }

  return imports
}

/**
 * Extract relative imports from Python source.
 * Matches: from .module import x  and  from ..module import x
 * @param {string} source
 * @param {string} fileDir - Directory of the .py file
 * @param {string} repoRoot - Repo root for path resolution
 * @returns {string[]} relative paths from repo root
 */
function extractPyImports(source, fileDir, repoRoot) {
  const imports = []

  // Explicit relative: from .foo import bar  or  from ..foo import bar
  const relRe = /^from\s+(\.+)(\w[\w.]*)??\s+import\s+/gm
  let m
  while ((m = relRe.exec(source)) !== null) {
    const dots = m[1].length       // number of dots = how many levels up
    const module = m[2] || ''      // might be empty for 'from . import x'

    let resolvedDir = fileDir
    for (let i = 1; i < dots; i++) {
      resolvedDir = path.dirname(resolvedDir)
    }

    const parts = module.split('.').filter(Boolean)
    const candidate = parts.length
      ? path.join(resolvedDir, ...parts) + '.py'
      : path.join(resolvedDir, '__init__.py')

    imports.push(candidate)
  }

  return imports
}

/**
 * Resolve a JS/TS import specifier to an absolute file path.
 * Tries various extensions and index files.
 * @param {string} specifier - e.g. './utils' or '../api/router'
 * @param {string} fromDir - Directory of the importing file
 * @param {Set<string>} fileSet - All known absolute paths in the repo
 * @returns {string|null}
 */
function resolveJsSpecifier(specifier, fromDir, fileSet) {
  const resolved = path.resolve(fromDir, specifier)
  const JS_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']

  // Exact match
  if (fileSet.has(resolved)) return resolved

  // Try adding extensions
  for (const ext of JS_EXTS) {
    const candidate = resolved + ext
    if (fileSet.has(candidate)) return candidate
  }

  // Try as directory with index
  for (const ext of JS_EXTS) {
    const candidate = path.join(resolved, `index${ext}`)
    if (fileSet.has(candidate)) return candidate
  }

  return null
}

/**
 * Build a dependency graph for the given repository directory.
 *
 * @param {string} repoDir - Absolute path to the cloned repository root
 * @returns {{
 *   nodes: Array<{id: string, label: string, group: string, size: number}>,
 *   edges: Array<{source: string, target: string}>,
 *   stats: {totalNodes: number, totalEdges: number, mostImported: string}
 * }}
 */
export async function buildDependencyGraph(repoDir) {
  // Phase 1: collect all source files
  const absolutePaths = []
  collectFiles(repoDir, repoDir, 0, absolutePaths)

  // Build set for O(1) lookup
  const fileSet = new Set(absolutePaths)

  // Map absolute path -> repo-relative id (e.g. "src/App.jsx")
  /** @type {Map<string, string>} */
  const absToId = new Map()
  for (const abs of absolutePaths) {
    const rel = path.relative(repoDir, abs)
    absToId.set(abs, rel)
  }

  // Phase 2: parse imports from each file
  /** @type {Map<string, string[]>} edges: sourceId -> [targetId] */
  const edgeMap = new Map()
  /** @type {Map<string, number>} in-degree count per node id */
  const inDegree = new Map()

  // Initialize
  for (const [, id] of absToId) {
    edgeMap.set(id, [])
    inDegree.set(id, 0)
  }

  for (const absPath of absolutePaths) {
    const sourceId = absToId.get(absPath)
    const ext = path.extname(absPath).toLowerCase()
    const fromDir = path.dirname(absPath)

    let source
    try {
      const stat = fs.statSync(absPath)
      if (stat.size > 512 * 1024) continue // skip very large files
      source = fs.readFileSync(absPath, 'utf8')
    } catch {
      continue
    }

    let specifiers = []

    if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
      specifiers = extractJsImports(source)
      for (const spec of specifiers) {
        const targetAbs = resolveJsSpecifier(spec, fromDir, fileSet)
        if (!targetAbs) continue
        const targetId = absToId.get(targetAbs)
        if (!targetId || targetId === sourceId) continue

        const edges = edgeMap.get(sourceId) || []
        if (!edges.includes(targetId)) {
          edges.push(targetId)
          edgeMap.set(sourceId, edges)
          inDegree.set(targetId, (inDegree.get(targetId) || 0) + 1)
        }
      }
    } else if (ext === '.py') {
      const absCandidates = extractPyImports(source, fromDir, repoDir)
      for (const candidate of absCandidates) {
        if (!fileSet.has(candidate)) continue
        const targetId = absToId.get(candidate)
        if (!targetId || targetId === sourceId) continue

        const edges = edgeMap.get(sourceId) || []
        if (!edges.includes(targetId)) {
          edges.push(targetId)
          edgeMap.set(sourceId, edges)
          inDegree.set(targetId, (inDegree.get(targetId) || 0) + 1)
        }
      }
    }
    // Go: skip for now — Go import paths are package paths not file-relative
    // and resolving them requires module path mapping which is out of scope
  }

  // Phase 3: trim to MAX_NODES by keeping most-connected nodes
  let nodeIds = Array.from(absToId.values())

  if (nodeIds.length > MAX_NODES) {
    // Score = inDegree * 2 + outDegree (prefer highly imported nodes)
    const scored = nodeIds.map((id) => ({
      id,
      score: (inDegree.get(id) || 0) * 2 + (edgeMap.get(id)?.length || 0),
    }))
    scored.sort((a, b) => b.score - a.score)
    const kept = new Set(scored.slice(0, MAX_NODES).map((x) => x.id))
    nodeIds = nodeIds.filter((id) => kept.has(id))
  }

  const nodeSet = new Set(nodeIds)

  // Phase 4: build final nodes array
  const nodes = nodeIds.map((id) => {
    const abs = path.join(repoDir, id)
    const ext = path.extname(id).toLowerCase()
    return {
      id,
      label: path.basename(id),
      group: extToGroup(ext),
      size: inDegree.get(id) || 0,
    }
  })

  // Phase 5: build final edges array (filter out nodes not in nodeSet)
  const edges = []
  for (const [sourceId, targets] of edgeMap) {
    if (!nodeSet.has(sourceId)) continue
    for (const targetId of targets) {
      if (!nodeSet.has(targetId)) continue
      edges.push({ source: sourceId, target: targetId })
    }
  }

  // Compute most-imported node
  let mostImported = ''
  let maxDegree = -1
  for (const [id, deg] of inDegree) {
    if (nodeSet.has(id) && deg > maxDegree) {
      maxDegree = deg
      mostImported = id
    }
  }

  return {
    nodes,
    edges,
    stats: {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      mostImported,
    },
  }
}
