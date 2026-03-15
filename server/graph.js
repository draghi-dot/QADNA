/**
 * Dependency graph builder for CodeAtlas.
 * Walks a cloned repository directory, parses import/require statements,
 * and returns a graph of nodes (files) and edges (dependencies).
 */

import fs from 'fs'
import path from 'path'

const MAX_DEPTH = 10
const MAX_NODES = 50

// Risk flag thresholds
const RISK_FAN_IN_MEDIUM  = 5
const RISK_FAN_IN_HIGH    = 8
const RISK_FAN_OUT_MEDIUM = 6
const RISK_FAN_OUT_HIGH   = 10
const RISK_LOC_MEDIUM     = 500
const RISK_LOC_HIGH       = 1000

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
 * Extract API route paths from Express-style route definitions.
 * Matches: app.get('/api/...'), router.post('/...'), etc.
 * @param {string} source
 * @returns {string[]} - route paths like '/api/users'
 */
function extractExpressRoutes(source) {
  const routes = []
  const re = /\b(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g
  let m
  while ((m = re.exec(source)) !== null) {
    routes.push({ method: m[1].toUpperCase(), path: m[2] })
  }
  return routes
}

/**
 * Extract fetch/axios API calls from frontend code.
 * Matches: fetch('/api/...'), axios.get('/api/...'), etc.
 * @param {string} source
 * @returns {string[]} - API paths
 */
function extractApiCalls(source) {
  const calls = []
  // fetch('/api/...')  or  fetch(`/api/...`)
  const fetchRe = /\bfetch\s*\(\s*['"`]([^'"`]+)['"`]/g
  let m
  while ((m = fetchRe.exec(source)) !== null) {
    calls.push(m[1])
  }
  // axios.get/post/put/delete('/...')
  const axiosRe = /\baxios\.\w+\s*\(\s*['"`]([^'"`]+)['"`]/g
  while ((m = axiosRe.exec(source)) !== null) {
    calls.push(m[1])
  }
  return calls
}

/**
 * Extract React component names used in JSX.
 * Matches: <ComponentName  (PascalCase only, to avoid HTML tags)
 * @param {string} source
 * @returns {string[]}
 */
function extractJsxComponents(source) {
  const components = new Set()
  const re = /<([A-Z][A-Za-z0-9]+)[\s/>]/g
  let m
  while ((m = re.exec(source)) !== null) {
    components.add(m[1])
  }
  return [...components]
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
 * Extract all import path strings from Go source.
 * Handles both single-line and grouped import blocks.
 * @param {string} source
 * @returns {string[]} raw import paths, e.g. ["fmt", "github.com/owner/repo/internal/handlers"]
 */
function extractGoImports(source) {
  const imports = []

  // Single-line: import "path/to/pkg"  or  import _ "path/to/pkg"  or  import alias "path/to/pkg"
  const singleRe = /^import\s+(?:\w+\s+)?["']([^"']+)["']/gm
  let m
  while ((m = singleRe.exec(source)) !== null) {
    imports.push(m[1])
  }

  // Grouped: import ( ... )
  // Extract the block content first, then pick out each quoted path
  const blockRe = /^import\s*\(/gm
  while ((m = blockRe.exec(source)) !== null) {
    const blockStart = source.indexOf('(', m.index)
    const blockEnd = source.indexOf(')', blockStart)
    if (blockEnd === -1) continue
    const block = source.slice(blockStart + 1, blockEnd)
    const lineRe = /(?:\w+\s+)?["']([^"']+)["']/g
    let lm
    while ((lm = lineRe.exec(block)) !== null) {
      imports.push(lm[1])
    }
  }

  return imports
}

/**
 * Extract HTTP route paths from Go source code.
 * Handles Fiber, Gin, Echo, Chi, net/http, and Gorilla Mux patterns.
 * Also detects .Group() prefixes and prepends them to nested routes.
 * @param {string} source
 * @returns {{method: string, path: string}[]}
 */
function extractGoRoutes(source) {
  const routes = []

  // Detect group prefixes: varName := something.Group("/api/prefix")
  // Maps variable name → prefix path
  const groupPrefixes = new Map()
  const groupRe = /(\w+)\s*(?::=|=)\s*\w+\.Group\(\s*["'`]([^"'`]+)["'`]/g
  let gm
  while ((gm = groupRe.exec(source)) !== null) {
    groupPrefixes.set(gm[1], gm[2].replace(/\/$/, ''))
  }

  // Match route registrations:
  // varOrChain.Get("/path", ...) — Fiber, Gin (.GET), Echo (.GET), Chi (.Get)
  // http.HandleFunc("/path", ...) — net/http
  // varOrChain.HandleFunc("/path", ...) — Gorilla Mux
  const routeRe = /(\w+)\s*\.\s*(?:Get|Post|Put|Delete|Patch|Options|Head|GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD|HandleFunc|Handle)\s*\(\s*["'`]([^"'`]+)["'`]/g
  let rm
  while ((rm = routeRe.exec(source)) !== null) {
    const varName = rm[1]
    const routePath = rm[2]
    // If the variable has a known group prefix, prepend it
    const prefix = groupPrefixes.get(varName) || ''
    const fullPath = prefix + (routePath.startsWith('/') ? routePath : '/' + routePath)
    routes.push({ method: 'any', path: fullPath })
  }

  return routes
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

  // --- Go module resolution: find go.mod to get the module path ---
  // Search repo root and immediate subdirectories for go.mod
  /** @type {string} Go module path, e.g. "github.com/owner/repo" */
  let goModulePath = ''
  /** @type {string} Absolute path of the directory containing go.mod */
  let goModuleRoot = ''

  const goModCandidates = [path.join(repoDir, 'go.mod')]
  try {
    for (const entry of fs.readdirSync(repoDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        goModCandidates.push(path.join(repoDir, entry.name, 'go.mod'))
      }
    }
  } catch { /* ignore read errors */ }

  for (const candidate of goModCandidates) {
    try {
      const modContent = fs.readFileSync(candidate, 'utf8')
      const modMatch = modContent.match(/^module\s+(\S+)/m)
      if (modMatch) {
        goModulePath = modMatch[1]
        goModuleRoot = path.dirname(candidate)
        break
      }
    } catch { /* file doesn't exist or can't be read */ }
  }

  // Build lookup: absolute directory → [repo-relative ids of .go files in that dir]
  // Used to create edges to all files in the target Go package directory
  /** @type {Map<string, string[]>} */
  const goDirToIds = new Map()
  if (goModulePath) {
    for (const [abs, id] of absToId) {
      if (path.extname(abs).toLowerCase() !== '.go') continue
      const dir = path.dirname(abs)
      if (!goDirToIds.has(dir)) goDirToIds.set(dir, [])
      goDirToIds.get(dir).push(id)
    }
  }

  // Phase 2: parse imports and relationships from each file
  /** @type {Map<string, {target: string, type: string}[]>} edges with types */
  const edgeMap = new Map()
  /** @type {Map<string, number>} in-degree count per node id */
  const inDegree = new Map()

  // Initialize
  for (const [, id] of absToId) {
    edgeMap.set(id, [])
    inDegree.set(id, 0)
  }

  // Helper: add an edge if it doesn't exist
  function addEdge(sourceId, targetId, type = 'import') {
    if (!targetId || targetId === sourceId) return
    const edges = edgeMap.get(sourceId) || []
    if (!edges.some(e => e.target === targetId && e.type === type)) {
      edges.push({ target: targetId, type })
      edgeMap.set(sourceId, edges)
      inDegree.set(targetId, (inDegree.get(targetId) || 0) + 1)
    }
  }

  // Build lookup: basename (no ext) → [repo-relative ids] for component matching
  const basenameToIds = new Map()
  for (const [, id] of absToId) {
    const base = path.basename(id, path.extname(id))
    if (!basenameToIds.has(base)) basenameToIds.set(base, [])
    basenameToIds.get(base).push(id)
  }

  // Build lookup: route path → [sourceId] for API call matching
  const routeToFiles = new Map()

  // First pass: collect all source contents and extract imports + routes
  const fileContents = new Map()
  for (const absPath of absolutePaths) {
    try {
      const stat = fs.statSync(absPath)
      if (stat.size > 512 * 1024) continue
      fileContents.set(absPath, fs.readFileSync(absPath, 'utf8'))
    } catch { continue }
  }

  for (const absPath of absolutePaths) {
    const sourceId = absToId.get(absPath)
    const ext = path.extname(absPath).toLowerCase()
    const fromDir = path.dirname(absPath)
    const source = fileContents.get(absPath)
    if (!source) continue

    // --- Standard imports ---
    if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
      const specifiers = extractJsImports(source)
      for (const spec of specifiers) {
        const targetAbs = resolveJsSpecifier(spec, fromDir, fileSet)
        if (!targetAbs) continue
        const targetId = absToId.get(targetAbs)
        addEdge(sourceId, targetId, 'import')
      }

      // --- Express routes: record which files define which routes ---
      const routes = extractExpressRoutes(source)
      for (const { method, path: routePath } of routes) {
        const key = routePath.replace(/:[^/]+/g, ':param')
        if (!routeToFiles.has(key)) routeToFiles.set(key, [])
        routeToFiles.get(key).push(sourceId)
      }

      // --- Next.js App Router: app/api/.../route.[ts|js] ---
      const appRouterMatch = sourceId.match(/(?:^|[/\\])app[/\\]api[/\\](.*?)[/\\]route\.[tj]sx?$/)
      if (appRouterMatch) {
        const routeSegment = appRouterMatch[1].replace(/\[([^\]]+)\]/g, ':param')
        const routePath = '/api/' + routeSegment
        if (!routeToFiles.has(routePath)) routeToFiles.set(routePath, [])
        if (!routeToFiles.get(routePath).includes(sourceId)) routeToFiles.get(routePath).push(sourceId)
      }

      // --- Next.js Pages Router: pages/api/... ---
      const pagesRouterMatch = sourceId.match(/(?:^|[/\\])pages[/\\]api[/\\](.*?)\.[tj]sx?$/)
      if (pagesRouterMatch) {
        const routeSegment = pagesRouterMatch[1].replace(/\[([^\]]+)\]/g, ':param')
        const routePath = '/api/' + routeSegment
        if (!routeToFiles.has(routePath)) routeToFiles.set(routePath, [])
        if (!routeToFiles.get(routePath).includes(sourceId)) routeToFiles.get(routePath).push(sourceId)
      }

      // --- Child process: exec/spawn Python scripts ---
      const pyExecRe = /(?:exec|execSync|spawn|spawnSync)\s*\(\s*['"`](?:python[3]?\s+)([\w./\\-]+\.py)/g
      let m
      while ((m = pyExecRe.exec(source)) !== null) {
        const pyFile = m[1].replace(/\\/g, '/')
        for (const [, targetId] of absToId) {
          if (targetId.endsWith(pyFile) || path.basename(targetId) === path.basename(pyFile)) {
            addEdge(sourceId, targetId, 'executes')
          }
        }
      }

      // --- JSX component usage ---
      if (['.jsx', '.tsx'].includes(ext)) {
        const components = extractJsxComponents(source)
        for (const compName of components) {
          const candidates = basenameToIds.get(compName) || []
          for (const targetId of candidates) {
            addEdge(sourceId, targetId, 'renders')
          }
        }

        // --- Next.js: page.tsx implicitly uses layout.tsx in same dir ---
        const basename = path.basename(absPath)
        if (basename.startsWith('page.')) {
          for (const layoutExt of ['.tsx', '.jsx', '.ts', '.js']) {
            const layoutAbs = path.join(fromDir, 'layout' + layoutExt)
            if (fileSet.has(layoutAbs)) {
              const targetId = absToId.get(layoutAbs)
              if (targetId) addEdge(sourceId, targetId, 'uses_layout')
            }
          }
        }
      }
    } else if (ext === '.py') {
      const absCandidates = extractPyImports(source, fromDir, repoDir)
      for (const candidate of absCandidates) {
        if (!fileSet.has(candidate)) continue
        const targetId = absToId.get(candidate)
        addEdge(sourceId, targetId, 'import')
      }

      // --- Python absolute imports of same-directory local modules ---
      const absImportRe = /^(?:import\s+(\w[\w.]*)|from\s+(\w[\w.]*)\s+import)/gm
      let m2
      while ((m2 = absImportRe.exec(source)) !== null) {
        const modName = (m2[1] || m2[2]).split('.')[0]
        const candidate = path.join(fromDir, modName + '.py')
        if (fileSet.has(candidate)) {
          const targetId = absToId.get(candidate)
          if (targetId) addEdge(sourceId, targetId, 'import')
        }
      }
    } else if (ext === '.go' && goModulePath) {
      // --- Go: resolve local (intra-module) imports to target package files ---
      const rawImports = extractGoImports(source)
      for (const importPath of rawImports) {
        // Only care about imports that belong to this module
        if (!importPath.startsWith(goModulePath)) continue

        // Strip module prefix to get the package's relative directory
        // e.g. "github.com/owner/repo/internal/handlers" → "internal/handlers"
        let pkgRelDir = importPath.slice(goModulePath.length)
        if (pkgRelDir.startsWith('/')) pkgRelDir = pkgRelDir.slice(1)

        // Resolve to an absolute directory under the module root
        const pkgAbsDir = pkgRelDir
          ? path.join(goModuleRoot, pkgRelDir)
          : goModuleRoot

        // Add edges from this file to every .go file in the target package directory
        // (In Go a package == directory, so all files there are part of that package)
        const targetIds = goDirToIds.get(pkgAbsDir)
        if (!targetIds) continue
        for (const targetId of targetIds) {
          addEdge(sourceId, targetId, 'import')
        }
      }

      // --- Go HTTP routes: record which files define which routes ---
      const goRoutes = extractGoRoutes(source)
      for (const { path: routePath } of goRoutes) {
        const key = routePath.replace(/:[^/]+/g, ':param')
        if (!routeToFiles.has(key)) routeToFiles.set(key, [])
        if (!routeToFiles.get(key).includes(sourceId)) routeToFiles.get(key).push(sourceId)
      }
    }
  }

  // Second pass: link fetch/axios calls to the files that define those routes
  for (const absPath of absolutePaths) {
    const sourceId = absToId.get(absPath)
    const source = fileContents.get(absPath)
    if (!source) continue

    const ext = path.extname(absPath).toLowerCase()
    if (!['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) continue

    const apiCalls = extractApiCalls(source)
    for (const callPath of apiCalls) {
      if (!callPath.startsWith('/')) continue
      const normalized = callPath.replace(/:[^/]+/g, ':param').split('?')[0]

      // Try exact match first, then prefix match
      for (const [routeKey, routeFileIds] of routeToFiles) {
        if (normalized === routeKey || normalized.startsWith(routeKey)) {
          for (const targetId of routeFileIds) {
            addEdge(sourceId, targetId, 'calls_api')
          }
        }
      }
    }
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

  // Build reverse lookup: id → absolute path (for line counts)
  const idToAbs = new Map()
  for (const [abs, id] of absToId) { idToAbs.set(id, abs) }

  // Phase 4: build final nodes array with risk flags
  let riskFlagCount = 0
  const nodes = nodeIds.map((id) => {
    const ext = path.extname(id).toLowerCase()
    const fanIn = inDegree.get(id) || 0
    const fanOut = edgeMap.get(id)?.filter(e => {
      const t = typeof e === 'string' ? e : e.target
      return nodeSet.has(t)
    }).length || 0

    // Count lines from file contents
    const absPath = idToAbs.get(id)
    const content = absPath ? fileContents.get(absPath) : null
    const loc = content ? content.split('\n').length : 0

    // Compute risk flags
    const riskFlags = []

    if (fanIn >= RISK_FAN_IN_HIGH) {
      riskFlags.push({ type: 'high-fan-in', label: `Imported by ${fanIn} files`, severity: 'high' })
    } else if (fanIn >= RISK_FAN_IN_MEDIUM) {
      riskFlags.push({ type: 'high-fan-in', label: `Imported by ${fanIn} files`, severity: 'medium' })
    }

    if (fanOut >= RISK_FAN_OUT_HIGH) {
      riskFlags.push({ type: 'high-fan-out', label: `Depends on ${fanOut} files`, severity: 'high' })
    } else if (fanOut >= RISK_FAN_OUT_MEDIUM) {
      riskFlags.push({ type: 'high-fan-out', label: `Depends on ${fanOut} files`, severity: 'medium' })
    }

    if (loc >= RISK_LOC_HIGH) {
      riskFlags.push({ type: 'large-file', label: `${loc} lines`, severity: 'high' })
    } else if (loc >= RISK_LOC_MEDIUM) {
      riskFlags.push({ type: 'large-file', label: `${loc} lines`, severity: 'medium' })
    }

    if (riskFlags.length > 0) riskFlagCount++

    return {
      id,
      label: path.basename(id),
      group: extToGroup(ext),
      size: fanIn,
      loc,
      fanIn,
      fanOut,
      riskFlags,
    }
  })

  // Phase 5: build final edges array with type labels
  const edges = []
  for (const [sourceId, targets] of edgeMap) {
    if (!nodeSet.has(sourceId)) continue
    for (const edgeInfo of targets) {
      const targetId = typeof edgeInfo === 'string' ? edgeInfo : edgeInfo.target
      const type = typeof edgeInfo === 'string' ? 'import' : (edgeInfo.type || 'import')
      if (!nodeSet.has(targetId)) continue
      edges.push({ source: sourceId, target: targetId, type })
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
      riskFlagCount,
    },
  }
}
