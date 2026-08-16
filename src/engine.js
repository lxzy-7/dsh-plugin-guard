// Snapshot/rollback engine. Plain synchronous Node builtins only, so it works
// identically inside the harness process (plugin tools, pre-tool guard) and
// from the standalone CLI.
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  copyFileSync, rmSync, statSync, renameSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import {
  dshHome, profilesDir, profileDir, rollbacksRoot, guardLogsDir, guardConfigPath, SNAPSHOT_FILES,
} from './layout.js'

export const DEFAULT_KEEP_SNAPSHOTS = 10
export const MIN_KEEP_SNAPSHOTS = 2
export const MAX_KEEP_SNAPSHOTS = 100
export const DEFAULT_PORT = 3080

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

function quoteCmdArg(a) {
  return `"${String(a).replace(/"/g, '""')}"`
}

/** Run pnpm. On Windows the launcher is a .cmd, so it is invoked through
 * cmd.exe explicitly (no `shell: true`, no unescaped-argument warning). */
export function runPnpm(args, cwd, pnpmCommand) {
  const command = pnpmCommand ?? resolvePnpmCommand()
  if (!command) return { ok: false, status: null, output: 'pnpm not found (PATH, DSH_GUARD_PNPM, or a local node_modules/.bin)' }
  const result = isWin()
    ? spawnSync(
        'cmd.exe',
        ['/d', '/s', '/c', `${quoteCmdArg(command)} ${args.map(quoteCmdArg).join(' ')}`],
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
  return { restored: SNAPSHOT_FILES, pnpm }
}

export { stamp, sha256File }
