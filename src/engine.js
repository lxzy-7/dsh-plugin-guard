// Snapshot/rollback engine. Plain synchronous Node builtins only, so it works
// identically inside the harness process (plugin tools, pre-tool guard) and
// from the standalone CLI.
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  copyFileSync, rmSync, statSync, renameSync, lstatSync, readlinkSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, dirname, resolve, sep } from 'node:path'
import {
  dshHome, profilesDir, profileDir, rollbacksRoot, guardDir, guardLogsDir, guardConfigPath, SNAPSHOT_FILES,
} from './layout.js'

export const DEFAULT_KEEP_SNAPSHOTS = 10
export const MIN_KEEP_SNAPSHOTS = 2
export const MAX_KEEP_SNAPSHOTS = 100
export const DEFAULT_PORT = 3080
/** How many boot/server logs, incident reports and resolved-incident markers
 * to keep per category; the oldest are pruned on every snapshot/incident. */
export const DEFAULT_KEEP_LOGS = 30

/** Read the guard settings file ($DSH_HOME/guard/config.json). Never throws;
 * malformed/missing config falls back to defaults. */
export function readGuardConfig() {
  let cfg = null
  try {
    cfg = JSON.parse(readFileSync(guardConfigPath(), 'utf8'))
  } catch { /* fallthrough */ }
  const out = { keepSnapshots: DEFAULT_KEEP_SNAPSHOTS, port: DEFAULT_PORT }
  if (cfg && typeof cfg === 'object') {
    const n = Math.floor(Number(cfg.keepSnapshots))
    if (Number.isFinite(n) && n >= MIN_KEEP_SNAPSHOTS && n <= MAX_KEEP_SNAPSHOTS) out.keepSnapshots = n
    const p = Math.floor(Number(cfg.port))
    if (Number.isFinite(p) && p >= 1 && p <= 65535) out.port = p
  }
  return out
}

/** Effective per-profile snapshot retention cap. */
export function resolveKeepSnapshots() {
  return readGuardConfig().keepSnapshots
}

/** Effective web port used for health checks (config override, default 3080). */
export function resolveGuardPort() {
  return readGuardConfig().port
}

function writeGuardConfig(cfg) {
  try {
    mkdirSync(dirname(guardConfigPath()), { recursive: true })
  } catch { /* ignore */ }
  writeFileSync(guardConfigPath(), `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
}

/** Persist the retention cap (clamped to [MIN, MAX]). Returns the stored value. */
export function setKeepSnapshots(n) {
  const num = Math.max(
    MIN_KEEP_SNAPSHOTS,
    Math.min(MAX_KEEP_SNAPSHOTS, Math.floor(Number(n) || DEFAULT_KEEP_SNAPSHOTS)),
  )
  writeGuardConfig({ ...readGuardConfig(), keepSnapshots: num })
  return num
}

export function listProfiles() {
  const dir = profilesDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort()
}

function stamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function isWin() {
  return process.platform === 'win32'
}

/** Resolve a usable pnpm launcher. Explicit env override wins; PATH is tried
 * next; finally the harness-local .bin. Returns null when nothing exists. */
export function resolvePnpmCommand() {
  const candidates = [
    process.env.DSH_GUARD_PNPM ?? '',
    'pnpm',
    join(dirname(dshHome()), 'node_modules', '.bin', isWin() ? 'pnpm.cmd' : 'pnpm'),
    join(dshHome(), 'node_modules', '.bin', isWin() ? 'pnpm.cmd' : 'pnpm'),
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    if (candidate === 'pnpm') {
      // PATH probe; on Windows go through cmd.exe to run pnpm.cmd without a shell.
      const probe = isWin()
        ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'pnpm --version'], { encoding: 'utf8' })
        : spawnSync('pnpm', ['--version'], { encoding: 'utf8' })
      if (probe.status === 0) return candidate
      continue
    }
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Windows cmd token: quote only when it contains whitespace/quotes. A bare
 * token stays unquoted so cmd still resolves it via PATH (a quoted bare name
 * like "pnpm" makes cmd skip the PATH lookup). */
function cmdToken(s) {
  return /[\s"]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s)
}

/** Run pnpm. On Windows the launcher is a .cmd, so it is invoked through
 * cmd.exe explicitly (no `shell: true`, no unescaped-argument warning).
 * Tokens are quoted only when they contain whitespace/quotes: quoting a bare
 * command name breaks cmd's PATH lookup, and Node's spawnSync command-line
 * escaping additionally mangles per-arg quotes passed to cmd /c. The probe in
 * resolvePnpmCommand already uses this unquoted shape and works. */
export function runPnpm(args, cwd, pnpmCommand) {
  const command = pnpmCommand ?? resolvePnpmCommand()
  if (!command) return { ok: false, status: null, output: 'pnpm not found (PATH, DSH_GUARD_PNPM, or a local node_modules/.bin)' }
  const result = isWin()
    ? spawnSync(
        'cmd.exe',
        ['/d', '/s', '/c', [cmdToken(command), ...args.map(cmdToken)].join(' ')],
        { cwd, encoding: 'utf8', timeout: 10 * 60 * 1000 },
      )
    : spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 10 * 60 * 1000 })
  return {
    ok: result.status === 0,
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  }
}

function snapshotMatches(aDir, bDir, files) {
  for (const f of files) {
    const a = join(aDir, f)
    const b = join(bDir, f)
    if (existsSync(a) !== existsSync(b)) return false
    if (existsSync(a) && sha256File(a) !== sha256File(b)) return false
  }
  return true
}

function readManifest(dir) {
  try {
    // Strip a UTF-8 BOM: manifests written by PowerShell 5.1 carry one.
    let raw = readFileSync(join(dir, 'manifest.json'), 'utf8')
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function writeManifest(dir, profile, tag, reason, files, pnpm) {
  const m = {
    profile,
    time: new Date().toISOString(),
    tag,
    reason,
    files,
  }
  if (pnpm) m.pnpm = pnpm
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`, 'utf8')
}

/**
 * Snapshot one profile. Returns { profile, stamp } or { profile, skipped: true }.
 * The dedup check compares against the newest existing snapshot unless
 * `force` pins this state deliberately.
 */
export function snapshotProfile(profile, { tag = '', reason = '', force = false } = {}) {
  const dir = profileDir(profile)
  if (!existsSync(join(dir, 'package.json'))) {
    return { profile, error: `profile "${profile}" has no package.json` }
  }
  const newStamp = stamp()
  const snapDir = join(rollbacksRoot(profile), newStamp)
  mkdirSync(snapDir, { recursive: true })

  const saved = []
  for (const f of SNAPSHOT_FILES) {
    const src = join(dir, f)
    if (existsSync(src)) {
      copyFileSync(src, join(snapDir, f))
      saved.push(f)
    }
  }

  if (!force) {
    const root = rollbacksRoot(profile)
    const entries = existsSync(root) ? readdirSync(root, { withFileTypes: true }) : []
    const prev = entries
      .filter((e) => e.isDirectory() && e.name !== newStamp)
      .sort((a, b) => a.name.localeCompare(b.name))
      .at(-1)
    if (prev && snapshotMatches(snapDir, join(root, prev.name), saved)) {
      rmSync(snapDir, { recursive: true, force: true })
      return { profile, skipped: true }
    }
  }

  writeManifest(snapDir, profile, tag, reason, saved, resolvePnpmCommand())
  pruneSnapshots(profile, resolveKeepSnapshots())
  pruneGuardArtifacts()
  return { profile, stamp: newStamp }
}

export function snapshotAll(tag = '', reason = '') {
  const results = []
  for (const profile of listProfiles()) {
    try {
      results.push(snapshotProfile(profile, { tag, reason }))
    } catch (error) {
      results.push({ profile, error: String(error) })
    }
  }
  return results
}

export function pruneSnapshots(profile, keep) {
  const root = rollbacksRoot(profile)
  if (!existsSync(root)) return
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name))
  for (const d of dirs.slice(keep)) rmSync(join(root, d.name), { recursive: true, force: true })
}

/** Bounded retention for the artifacts that would otherwise grow forever:
 * per-run boot/server logs, incident reports and resolved-incident markers.
 * Keeps the newest `keep` files of each category (stamp names sort
 * chronologically) and deletes the rest. `last-boot.txt` and
 * `pending-incident.json` are intentionally left untouched. Returns how many
 * files were removed. */
export function pruneGuardArtifacts(keep = DEFAULT_KEEP_LOGS) {
  const n = Math.max(1, Math.floor(Number(keep) || DEFAULT_KEEP_LOGS))
  const groups = [
    { dir: guardLogsDir(), re: /^boot-.*\.log$/ },
    { dir: guardLogsDir(), re: /^server-.*\.out\.log$/ },
    { dir: guardLogsDir(), re: /^server-.*\.err\.log$/ },
    { dir: guardLogsDir(), re: /^incident-.*\.md$/ },
    { dir: guardDir(), re: /^resolved-incident-.*\.json$/ },
  ]
  let removed = 0
  for (const { dir, re } of groups) {
    if (!existsSync(dir)) continue
    let files
    try { files = readdirSync(dir) } catch { continue }
    const matched = files.filter((f) => re.test(f)).sort()
    for (const f of matched.slice(0, Math.max(0, matched.length - n))) {
      try { rmSync(join(dir, f), { force: true }); removed++ } catch { /* best effort */ }
    }
  }
  return removed
}

export function listSnapshots(profile) {
  const root = rollbacksRoot(profile)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name))
    .map((e) => {
      const manifest = readManifest(join(root, e.name))
      return {
        stamp: e.name,
        tag: manifest?.tag ?? '',
        time: manifest?.time ?? '',
        reason: manifest?.reason ?? '',
        pnpm: manifest?.pnpm ?? '',
      }
    })
}

/**
 * Resolve one snapshot directory. `good` = newest not tagged pre-boot or
 * pre-rollback; otherwise the newest snapshot (or exact/prefixed `id`).
 */
export function resolveSnapshotDir(profile, { id = '', good = false } = {}) {
  const root = rollbacksRoot(profile)
  if (!existsSync(root)) return null
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name))
  if (dirs.length === 0) return null
  if (id) {
    const hit = dirs.find((e) => e.name === id || e.name.startsWith(id))
    return hit ? join(root, hit.name) : null
  }
  if (good) {
    for (const e of dirs) {
      const manifest = readManifest(join(root, e.name))
      const tag = manifest?.tag ?? ''
      if (tag !== 'pre-boot' && tag !== 'pre-rollback') return join(root, e.name)
    }
  }
  return join(root, dirs[0].name)
}

/**
 * Restore one snapshot for one profile. Always snapshots the current state
 * first (tag pre-rollback), so every rollback is itself reversible.
 */
export function restoreSnapshot(profile, snapshotDir, { skipInstall = false } = {}) {
  snapshotProfile(profile, { tag: 'pre-rollback', reason: `rollback to ${snapshotDir}` })
  const dir = profileDir(profile)
  for (const f of SNAPSHOT_FILES) {
    const src = join(snapshotDir, f)
    const dst = join(dir, f)
    if (existsSync(src)) copyFileSync(src, dst)
    else if (existsSync(dst)) rmSync(dst, { force: true })
  }
  let pnpm = null
  if (!skipInstall) {
    const manifest = readManifest(snapshotDir)
    const command = manifest?.pnpm && existsSync(manifest.pnpm) ? manifest.pnpm : null
    pnpm = runPnpm(['install', '--frozen-lockfile'], dir, command)
  }
  // pnpm install --frozen-lockfile / pnpm prune both report "Already up to
  // date" and never remove a stale link: bundle entry whose target lives
  // outside node_modules, so clean those symlinks directly.
  const removedLinks = cleanupStaleBundleLinks(profile)
  return { restored: SNAPSHOT_FILES, pnpm, removedLinks }
}

/** Names that must keep a node_modules link for this profile: every `link:`
 * dependency in package.json (bundle plugins are installed this way) plus the
 * dsh.profile.bundles list (harmless extra safety). */
function validLinkNames(pkg) {
  const names = new Set()
  const deps = pkg?.dependencies ?? {}
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec === 'string' && spec.trim().toLowerCase().startsWith('link:')) names.add(name)
  }
  const bundles = pkg?.dsh?.profile?.bundles
  if (Array.isArray(bundles)) for (const b of bundles) names.add(b)
  return names
}

/**
 * Remove orphaned bundle-plugin symlinks left in node_modules after a rollback
 * (or any bundle-stack change). Scans node_modules for symlinks/junctions whose
 * resolved target is OUTSIDE node_modules (bundle `link:` deps point at the
 * plugins dir) and whose name is no longer a `link:` dependency / bundle in the
 * restored package.json, and deletes exactly those links — never their targets
 * and never normal pnpm deps (which link inside node_modules/.pnpm). Returns
 * the removed names.
 */
export function cleanupStaleBundleLinks(profile) {
  const dir = profileDir(profile)
  const nm = join(dir, 'node_modules')
  if (!existsSync(nm)) return []
  let pkg = null
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch { /* broken package.json -> no valid set -> treat stale links as stale */ }
  const valid = validLinkNames(pkg)
  const removed = []
  const scan = (base, prefix) => {
    let entries = []
    try { entries = readdirSync(base, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(base, e.name)
      let st
      try { st = lstatSync(p) } catch { continue }
      // real directory that is a scoped namespace -> descend into it
      if (st.isDirectory() && !st.isSymbolicLink() && e.name.startsWith('@')) {
        scan(p, e.name)
        continue
      }
      if (!st.isSymbolicLink()) continue
      let target = ''
      try { target = readlinkSync(p) } catch { continue }
      const abs = resolve(dirname(p), target)
      // normal pnpm deps link inside node_modules (.pnpm/...) -> keep
      if (abs === nm || abs.startsWith(nm + sep)) continue
      const name = prefix ? `${prefix}/${e.name}` : e.name
      if (valid.has(name)) continue
      try { rmSync(p, { recursive: true, force: true }); removed.push(name) } catch { /* best effort */ }
    }
  }
  scan(nm, '')
  return removed
}

export { stamp, sha256File }
