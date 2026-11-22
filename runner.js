/**
 * Runtime bridge for dsh-project-memory.
 *
 * The memory engine is a single stdlib-only Python file (`core/memory.py`)
 * exposing a JSON-over-stdout CLI. This module locates a Python interpreter
 * (the DSH built-in runtime first, then plain `python3`), translates the tool
 * arguments into CLI flags, and normalizes the result.
 *
 * Why a subprocess and not an in-process JS store:
 * - one implementation, usable from the plugin, from bash, and from skills;
 * - the file format stays plain Markdown + YAML frontmatter that humans and
 *   git can read;
 * - a crash in the engine cannot take the DSH host down.
 *
 * No external npm dependencies.
 *
 * @module dsh-project-memory/runner
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

function dshHome() {
  const override = process.env.DSH_HOME
  return override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh')
}

function firstExistingFile(candidates) {
  for (const c of candidates) {
    if (c === undefined || c === null || c.length === 0) continue
    try {
      if (existsSync(c) && statSync(c).isFile()) return c
    } catch { /* ignore */ }
  }
  return undefined
}

/**
 * Ordered interpreter candidates.
 *
 * 1. `DSH_PROJECT_MEMORY_PYTHON` — explicit override.
 * 2. DSH built-in Python (ships PyYAML; always present in the desktop build).
 * 3. `python3` from PATH — fallback for headless / dev setups.
 */
export function findPythonCandidates() {
  const runtime = join(dshHome(), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python')
  const list = []
  const explicit = process.env.DSH_PROJECT_MEMORY_PYTHON
  if (explicit && explicit.length > 0) list.push({ python: explicit, source: 'env' })
  const dsh = firstExistingFile([
    join(runtime, 'bin', 'python3'),
    join(runtime, 'bin', 'python'),
    join(runtime, 'python.exe'),
    join(runtime, 'bin', 'python.exe'),
  ])
  if (dsh) list.push({ python: dsh, source: 'dsh-builtin' })
  list.push({ python: 'python3', source: 'path' })
  const seen = new Set()
  return list.filter((c) => {
    if (seen.has(c.python)) return false
    seen.add(c.python)
    return true
  })
}

function exec(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeoutMs = options.timeoutMs ?? 60_000
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolve({ code: -1, stdout, stderr: `${stderr}\n[timeout after ${timeoutMs}ms]`, timedOut: true })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: `${stderr}\n${String(error?.message ?? error)}`, spawnError: error })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** Map the flat tool arguments onto the engine's CLI flags. */
function buildArgs(action, workspace, args = {}) {
  const cli = ['--workspace', workspace]
  const push = (flag, value) => {
    if (value === undefined || value === null || value === '') return
    cli.push(flag, String(value))
  }

  switch (action) {
    case 'recall':
      cli.push('recall')
      push('--query', args.query)
      push('--type', args.type)
      push('--scope', args.scope)
      push('--scene', args.scene)
      push('--as-of', args.asOf)
      push('--known-at', args.knownAt)
      push('--limit', args.limit)
      push('--min-confidence', args.minConfidence)
      if (Array.isArray(args.includeStatus) && args.includeStatus.length > 0) {
        cli.push('--include-status', ...args.includeStatus)
      }
      break
    case 'write':
      cli.push('write')
      push('--type', args.type)
      push('--title', args.title)
      push('--body', args.body)
      push('--as-of', args.asOf)
      push('--source', args.source)
      push('--scope', args.scope)
      push('--scene', args.scene)
      push('--tags', args.tags)
      push('--confidence', args.confidence)
      push('--status', args.status)
      push('--id', args.id)
      if (args.force) cli.push('--force')
      break
    case 'supersede':
      cli.push('supersede')
      push('--id', args.id)
      push('--body', args.body)
      push('--title', args.title)
      push('--type', args.type)
      push('--scope', args.scope)
      push('--scene', args.scene)
      push('--as-of', args.asOf)
      push('--source', args.source)
      push('--tags', args.tags)
      push('--confidence', args.confidence)
      break
    case 'promote':
      cli.push('promote')
      push('--id', args.id)
      if (args.force) cli.push('--force')
      break
    case 'status':
      cli.push('status')
      break
    case 'list':
      cli.push('list')
      push('--type', args.type)
      push('--status', args.status)
      push('--scene', args.scene)
      break
    case 'compact':
      cli.push('compact')
      push('--older-than', args.olderThan)
      break
    case 'leak-check':
      cli.push('leak-check')
      push('--as-of', args.asOf)
      push('--known-at', args.knownAt)
      break
    case 'reindex':
      cli.push('reindex')
      break
    case 'verify':
      cli.push('verify')
      break
    case 'rebuild-core':
      cli.push('rebuild-core')
      break
    case 'doctor':
      cli.push('doctor')
      push('--scope', args.scope)
      break
    case 'migrate':
      cli.push('migrate')
      break
    case 'export':
      cli.push('export')
      push('--to', args.to)
      break
    case 'import':
      cli.push('import')
      push('--from', args.fromFile)
      break
    case 'init':
    default:
      cli.push('init')
      break
  }
  return cli
}

/**
 * Run one memory operation.
 *
 * @param {object} options
 * @param {string} options.action - operation name
 * @param {string} options.workspace - absolute workspace root
 * @param {string} options.engineRoot - plugin root (contains core/memory.py)
 * @param {object} [options.args] - flat tool arguments
 * @returns {Promise<object>} the engine's JSON payload
 */
export async function runMemory(options) {
  const { action, workspace, engineRoot } = options
  const engine = join(engineRoot, 'core', 'memory.py')
  if (!existsSync(engine)) {
    return { ok: false, error: `memory engine missing: ${engine}` }
  }

  const cliArgs = buildArgs(action, workspace, options.args)
  const candidates = findPythonCandidates()
  const tried = []
  let lastError = null

  for (const cand of candidates) {
    const result = await exec(cand.python, [engine, ...cliArgs], {
      cwd: engineRoot,
      timeoutMs: 60_000,
    })
    if (result.code !== 0 && !result.stdout.trim().startsWith('{')) {
      const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-6).join('\n')
      tried.push({ source: cand.source, error: `exit ${result.code}: ${detail.slice(0, 300)}` })
      lastError = detail
      continue
    }
    let payload
    try {
      payload = JSON.parse(result.stdout)
    } catch {
      tried.push({ source: cand.source, error: 'invalid JSON from engine' })
      lastError = 'invalid JSON from engine'
      continue
    }
    payload.interpreter = cand.source
    if (tried.length > 0) payload.fallback_used = tried
    return payload
  }

  return {
    ok: false,
    error: `memory engine failed on every interpreter (tried: ${tried.map((t) => t.source).join(', ') || 'none'})${lastError ? `: ${lastError}` : ''}`,
    tried,
    hint: 'Set DSH_PROJECT_MEMORY_PYTHON to a python3 with PyYAML available, or check core/memory.py.',
  }
}

/* ------------------------------------------------------------------ */
/* active-workspace state (survives plugin restarts)                    */
/* ------------------------------------------------------------------ */

/** Where the "workspace this session is working on" pointer is persisted. */
export function activeStatePath() {
  const home = process.env.DSH_HOME
  const root = home && home.length > 0 ? home : join(homedir(), '.dsh')
  const memHome = process.env.DSH_MEMORY_HOME
  const base = memHome && memHome.length > 0 ? memHome : join(root, 'memory')
  return join(base, '.active.json')
}

/**
 * Read the persisted pointer.
 *
 * The pointer holds **paths only** — never memory content. The old version
 * stored the whole `core.md` text here, which created a second copy of the
 * core memory that could drift from the file it claimed to mirror. Now the
 * host reads the file at `core_path` on every prompt assembly, so there is
 * exactly one copy on disk and it is always current.
 */
export async function readActiveWorkspace() {
  try {
    const raw = await readFile(activeStatePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.core_path === 'string') return parsed
  } catch { /* no state yet */ }
  return null
}
