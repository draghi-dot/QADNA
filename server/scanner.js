/**
 * Static security scanner for cloned repositories.
 * Walks the directory tree up to MAX_DEPTH levels deep,
 * reads text files under MAX_FILE_SIZE bytes, and applies
 * regex-based checks for common vulnerability patterns.
 */

import fs from 'fs'
import path from 'path'

const MAX_DEPTH = 8
const MAX_FILE_SIZE = 500 * 1024 // 500 KB

/** Directories to skip entirely. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__',
  '.next', '.nuxt', 'coverage', '.cache', 'vendor', 'bower_components',
])

/** Extensions treated as likely binary — skip reading content. */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg',
  '.mp4', '.mp3', '.wav', '.ogg', '.zip', '.tar', '.gz',
  '.rar', '.7z', '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.ppt', '.pptx', '.exe', '.dll', '.so', '.dylib', '.class',
  '.jar', '.wasm', '.bin', '.dat', '.db', '.sqlite',
])

/** Source-code / text extensions we want to scan. */
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.py', '.rb', '.php', '.java', '.go', '.rs', '.cs',
  '.c', '.cpp', '.h', '.hpp', '.sh', '.bash', '.zsh',
  '.yaml', '.yml', '.json', '.toml', '.xml', '.html', '.htm',
  '.css', '.scss', '.sass', '.less', '.env', '.config',
  '.conf', '.ini', '.properties', '.tf', '.tfvars',
  '', // no extension — could be Dockerfile, Makefile, etc.
])

/** Known-vulnerable package versions (name → max safe version string for display). */
const KNOWN_VULNERABLE_PACKAGES = {
  'lodash': { below: [4, 17, 21], label: '< 4.17.21 (prototype pollution)' },
  'axios': { below: [0, 21, 2], label: '< 0.21.2 (SSRF via redirects)' },
  'express': { below: [4, 17, 3], label: '< 4.17.3 (ReDoS)' },
  'minimist': { below: [1, 2, 6], label: 'any version (prototype pollution)' },
  'node-serialize': { below: [999, 0, 0], label: 'any version (RCE via deserialization)' },
  'serialize-javascript': { below: [3, 1, 0], label: '< 3.1.0 (XSS via regex)' },
}

/** Sensitive file name patterns (exact or glob-style). */
const SENSITIVE_FILE_PATTERNS = [
  /^id_rsa$/,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.key$/i,
  /\.cert$/i,
  /^credentials\.json$/i,
  /^serviceaccount\.json$/i,
  /^service_account\.json$/i,
]

/** .env file names that signal committed secrets. */
const ENV_FILE_NAMES = new Set(['.env', '.env.local', '.env.production', '.env.staging', '.env.development'])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect all file paths under `dir` up to `maxDepth`.
 * @param {string} dir
 * @param {number} depth
 * @returns {string[]}
 */
function walkDir(dir, depth = 0) {
  if (depth > MAX_DEPTH) return []
  let results = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.isDirectory() && entry.name !== '.git') continue
    if (SKIP_DIRS.has(entry.name)) continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results = results.concat(walkDir(fullPath, depth + 1))
    } else if (entry.isFile()) {
      results.push(fullPath)
    }
  }
  return results
}

/**
 * Return true if the file is a readable text file within size limits.
 * @param {string} filePath
 * @returns {boolean}
 */
function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (BINARY_EXTENSIONS.has(ext)) return false
  // Only scan known text extensions (or no extension)
  if (!TEXT_EXTENSIONS.has(ext)) return false
  try {
    const stat = fs.statSync(filePath)
    return stat.size <= MAX_FILE_SIZE
  } catch {
    return false
  }
}

/**
 * Read file lines safely.
 * @param {string} filePath
 * @returns {string[] | null}
 */
function readLines(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    return content.split('\n')
  } catch {
    return null
  }
}

/**
 * Truncate and sanitize a string for safe JSON transport.
 * Strips control characters and ensures the result is valid UTF-8 text.
 * @param {string} s
 * @param {number} maxLen
 * @returns {string}
 */
function trunc(s, maxLen = 120) {
  // Replace control characters (except tab) with a space so JSON.stringify won't produce bad escapes
  // eslint-disable-next-line no-control-regex
  const safe = (s || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').trim()
  return safe.length > maxLen ? safe.slice(0, maxLen) + '\u2026' : safe
}

// ---------------------------------------------------------------------------
// Individual check functions
// ---------------------------------------------------------------------------

/**
 * Check 1 — Hardcoded secrets in source files.
 * @param {string} filePath
 * @param {string} relPath
 * @param {string[]} lines
 * @returns {object[]}
 */
function checkHardcodedSecrets(filePath, relPath, lines) {
  const findings = []

  const patterns = [
    {
      re: /\b(api_?key|apikey|secret|password|passwd|auth_?token|access_?token|private_?key)\s*[:=]\s*['"`][^'"`\s]{8,}['"`]/i,
      desc: 'Hardcoded credential assigned to variable',
      severity: 'critical',
    },
    {
      re: /AKIA[0-9A-Z]{16}/,
      desc: 'AWS access key ID pattern detected',
      severity: 'critical',
    },
    {
      re: /\b[0-9a-f]{32,64}\b/,
      desc: 'Long hex token (possible secret or key)',
      severity: 'high',
    },
    {
      re: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
      desc: 'Private key material embedded in source file',
      severity: 'critical',
    },
    {
      re: /ghp_[0-9A-Za-z]{36}/,
      desc: 'GitHub personal access token detected',
      severity: 'critical',
    },
    {
      re: /sk-[0-9A-Za-z]{32,}/,
      desc: 'OpenAI API key pattern detected',
      severity: 'critical',
    },
  ]

  lines.forEach((line, i) => {
    // Skip comment lines
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) return
    for (const { re, desc, severity } of patterns) {
      if (re.test(line)) {
        findings.push({
          category: 'Hardcoded Secret',
          severity,
          file: relPath,
          line: i + 1,
          description: desc,
          snippet: trunc(line),
        })
        break // one finding per line per file
      }
    }
  })

  return findings
}

/**
 * Check 2 — Exposed .env files not covered by .gitignore.
 * @param {string} repoRoot
 * @param {string[]} allFiles
 * @returns {object[]}
 */
function checkExposedEnvFiles(repoRoot, allFiles) {
  const findings = []

  // Read .gitignore content if present
  const gitignorePath = path.join(repoRoot, '.gitignore')
  let gitignoreContent = ''
  try {
    gitignoreContent = fs.readFileSync(gitignorePath, 'utf8')
  } catch { /* no .gitignore */ }

  for (const filePath of allFiles) {
    const name = path.basename(filePath)
    if (!ENV_FILE_NAMES.has(name)) continue

    const relPath = path.relative(repoRoot, filePath)
    const isIgnored = gitignoreContent.split('\n').some((line) => {
      const rule = line.trim()
      if (!rule || rule.startsWith('#')) return false
      return rule === name || rule === relPath || rule === `/${name}`
    })

    findings.push({
      category: 'Exposed .env File',
      severity: isIgnored ? 'medium' : 'critical',
      file: relPath,
      line: 0,
      description: isIgnored
        ? `.env file exists and is gitignored, but may expose secrets in dev environments`
        : `.env file committed to repository — not listed in .gitignore`,
      snippet: name,
    })
  }

  return findings
}

/**
 * Check 3 — eval() and dynamic code execution.
 * @param {string} relPath
 * @param {string[]} lines
 * @returns {object[]}
 */
function checkEvalUsage(relPath, lines) {
  const findings = []
  const patterns = [
    { re: /\beval\s*\(/, desc: 'eval() usage — arbitrary code execution risk' },
    { re: /new\s+Function\s*\(/, desc: 'new Function() — dynamic code execution' },
    { re: /setTimeout\s*\(\s*['"`]/, desc: 'setTimeout with string argument — implicit eval' },
    { re: /setInterval\s*\(\s*['"`]/, desc: 'setInterval with string argument — implicit eval' },
  ]
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) return
    for (const { re, desc } of patterns) {
      if (re.test(line)) {
        findings.push({
          category: 'Eval / Dynamic Code Execution',
          severity: 'high',
          file: relPath,
          line: i + 1,
          description: desc,
          snippet: trunc(line),
        })
        break
      }
    }
  })
  return findings
}

/**
 * Check 4 — SQL injection risks.
 * @param {string} relPath
 * @param {string[]} lines
 * @returns {object[]}
 */
function checkSQLInjection(relPath, lines) {
  const findings = []
  const patterns = [
    {
      re: /["'`]\s*(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\b.+["'`]\s*\+/i,
      desc: 'SQL query built with string concatenation',
    },
    {
      re: /\+\s*(req\.(body|query|params)|userInput|input|data)\b/i,
      desc: 'User input concatenated into query string',
    },
    {
      re: /`\s*(SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{/i,
      desc: 'SQL query uses template literal interpolation',
    },
  ]
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) return
    for (const { re, desc } of patterns) {
      if (re.test(line)) {
        findings.push({
          category: 'SQL Injection Risk',
          severity: 'high',
          file: relPath,
          line: i + 1,
          description: desc,
          snippet: trunc(line),
        })
        break
      }
    }
  })
  return findings
}

/**
 * Check 5 — Prototype pollution patterns.
 * @param {string} relPath
 * @param {string[]} lines
 * @returns {object[]}
 */
function checkPrototypePollution(relPath, lines) {
  const findings = []
  const patterns = [
    {
      re: /\[['"`]?__proto__['"`]?\]/,
      desc: 'Direct __proto__ key access — prototype pollution risk',
    },
    {
      re: /\[['"`]?constructor['"`]?\]\s*\[['"`]?prototype['"`]?\]/,
      desc: 'constructor.prototype access via dynamic key',
    },
    {
      re: /Object\.assign\s*\([^,]+,\s*(req\.(body|query|params)|userInput)/i,
      desc: 'Object.assign with unvalidated user input — prototype pollution risk',
    },
  ]
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) return
    for (const { re, desc } of patterns) {
      if (re.test(line)) {
        findings.push({
          category: 'Prototype Pollution',
          severity: 'high',
          file: relPath,
          line: i + 1,
          description: desc,
          snippet: trunc(line),
        })
        break
      }
    }
  })
  return findings
}

/**
 * Check 6 — Path traversal risks.
 * @param {string} relPath
 * @param {string[]} lines
 * @returns {object[]}
 */
function checkPathTraversal(relPath, lines) {
  const findings = []
  const patterns = [
    {
      re: /\.\.\//,
      desc: 'Relative path traversal sequence "../" found',
      severity: 'medium',
    },
    {
      re: /fs\.(readFile|readFileSync|createReadStream)\s*\([^)]*req\.(params|query|body)/i,
      desc: 'File read with request parameter — path traversal risk',
      severity: 'high',
    },
    {
      re: /path\.join\s*\([^)]*req\.(params|query|body)/i,
      desc: 'path.join with unsanitized request parameter',
      severity: 'high',
    },
  ]
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) return
    for (const { re, desc, severity } of patterns) {
      if (re.test(line)) {
        findings.push({
          category: 'Path Traversal',
          severity,
          file: relPath,
          line: i + 1,
          description: desc,
          snippet: trunc(line),
        })
        break
      }
    }
  })
  return findings
}

/**
 * Check 7 — Insecure HTTP URLs.
 * @param {string} relPath
 * @param {string[]} lines
 * @returns {object[]}
 */
function checkInsecureHTTP(relPath, lines) {
  const findings = []
  const re = /http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|::1)[a-zA-Z0-9]/
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) return
    if (re.test(line)) {
      findings.push({
        category: 'Insecure HTTP',
        severity: 'low',
        file: relPath,
        line: i + 1,
        description: 'Non-HTTPS URL used — data transmitted in plaintext',
        snippet: trunc(line),
      })
    }
  })
  return findings
}

/**
 * Check 8 — Missing input validation.
 * @param {string} relPath
 * @param {string[]} lines
 * @returns {object[]}
 */
function checkMissingValidation(relPath, lines) {
  const findings = []
  // Only scan JS/TS/route files
  const ext = path.extname(relPath).toLowerCase()
  if (!['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx'].includes(ext)) return findings

  const re = /\b(req\.body\.|req\.query\.|req\.params\.)\w+/g
  // Track lines with usage but no preceding validation on the same or previous line
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//')) return
    const matches = line.match(re)
    if (!matches) return

    // Heuristic: flag if the req value is used in a direct assignment or passed as an arg
    // without any of the typical validation patterns on the same or nearby line
    const hasValidation = /\b(validate|sanitize|escape|parseInt|parseFloat|trim\(\)|toString\(\)|isNaN|isFinite|typeof|instanceof|\.match\(|\.test\(|joi\.|yup\.|zod\.)/.test(line)
    if (!hasValidation) {
      findings.push({
        category: 'Missing Input Validation',
        severity: 'medium',
        file: relPath,
        line: i + 1,
        description: `Request parameter used without apparent validation: ${matches[0]}`,
        snippet: trunc(line),
      })
    }
  })

  return findings
}

/**
 * Check 9 — Dependency audit from package.json.
 * @param {string} repoRoot
 * @returns {object[]}
 */
function checkDependencies(repoRoot) {
  const findings = []
  const pkgPath = path.join(repoRoot, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  } catch {
    return findings
  }

  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
  }

  for (const [name, versionRange] of Object.entries(allDeps)) {
    const vuln = KNOWN_VULNERABLE_PACKAGES[name]
    if (!vuln) continue

    // Strip leading ^, ~, =, >= etc.
    const cleanVersion = versionRange.replace(/^[\^~>=<]+/, '').split('-')[0].trim()
    const parts = cleanVersion.split('.').map(Number)
    const [major, minor, patch] = parts

    const [bMajor, bMinor, bPatch] = vuln.below
    const isVulnerable =
      major < bMajor ||
      (major === bMajor && minor < bMinor) ||
      (major === bMajor && minor === bMinor && patch < bPatch)

    if (isVulnerable || name === 'node-serialize' || name === 'minimist') {
      findings.push({
        category: 'Vulnerable Dependency',
        severity: name === 'node-serialize' ? 'critical' : 'high',
        file: 'package.json',
        line: 0,
        description: `${name} ${vuln.label}`,
        snippet: `"${name}": "${versionRange}"`,
      })
    }
  }

  return findings
}

/**
 * Check 10 — Sensitive files committed to the repo.
 * @param {string} repoRoot
 * @param {string[]} allFiles
 * @returns {object[]}
 */
function checkSensitiveFiles(repoRoot, allFiles) {
  const findings = []
  for (const filePath of allFiles) {
    const name = path.basename(filePath)
    for (const pattern of SENSITIVE_FILE_PATTERNS) {
      if (pattern.test(name)) {
        findings.push({
          category: 'Sensitive File Committed',
          severity: 'critical',
          file: path.relative(repoRoot, filePath),
          line: 0,
          description: `Sensitive file found in repository: ${name}`,
          snippet: name,
        })
        break
      }
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Scan a cloned repository directory for security issues.
 * @param {string} repoRoot  Absolute path to the cloned repo.
 * @returns {{ totalFiles: number, scannedFiles: number, findings: object[], summary: object }}
 */
export async function scanRepository(repoRoot) {
  const allFiles = walkDir(repoRoot)
  const textFiles = allFiles.filter(isTextFile)

  let findings = []

  // File-level checks
  for (const filePath of textFiles) {
    const relPath = path.relative(repoRoot, filePath)
    const lines = readLines(filePath)
    if (!lines) continue

    findings = findings.concat(
      checkHardcodedSecrets(filePath, relPath, lines),
      checkEvalUsage(relPath, lines),
      checkSQLInjection(relPath, lines),
      checkPrototypePollution(relPath, lines),
      checkPathTraversal(relPath, lines),
      checkInsecureHTTP(relPath, lines),
      checkMissingValidation(relPath, lines),
    )
  }

  // Repo-level checks
  findings = findings.concat(
    checkExposedEnvFiles(repoRoot, allFiles),
    checkDependencies(repoRoot),
    checkSensitiveFiles(repoRoot, allFiles),
  )

  // Deduplicate by (file, line, category)
  const seen = new Set()
  findings = findings.filter((f) => {
    const key = `${f.file}:${f.line}:${f.category}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // Cap at 200 findings to avoid overwhelming the AI
  findings = findings.slice(0, 200)

  const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
  for (const f of findings) {
    if (summary[f.severity] !== undefined) summary[f.severity]++
  }

  return {
    totalFiles: allFiles.length,
    scannedFiles: textFiles.length,
    findings,
    summary,
  }
}
