// dsh-plugin-guard — install safety net for DeepSeek Harness.
//
// In-process half (this plugin):
//  1. systemPrompt section (order -50, before the persona): when
//     $DSH_HOME/guard/pending-incident.json exists it injects an instruction
//     that makes the pending incident the session's first task.
//  2. Tools: incident_resolved, dsh_snapshot, dsh_rollback.
//  3. Pre-tool guard: automatically snapshots every profile before
//     plugin_install / plugin_uninstall / plugin_toggle run (never denies).
//  4. HTTP API (via webServer, when present) backing the 设置 > 备份管理
//     panel: state / snapshot / rollback / keep.
//
// Out-of-process halves (scripts/): standalone CLI (`dsh-guard`), boot guard
// scripts for Windows and POSIX, and PATH shims — see README.
import { snapshotAll, snapshotProfile, listProfiles, listSnapshots, resolveSnapshotDir, restoreSnapshot, readGuardConfig, setKeepSnapshots } from './engine.js'
import { incidentSectionText, readPending, resolveIncidentMarker } from './incident.js'
import { createGuardTools } from './tools.js'

export const name = 'guard'

const GUARDED_TOOLS = new Set(['plugin_install', 'plugin_uninstall', 'plugin_toggle'])

// ── tiny HTTP helpers (plain node:http) ──
const errMsg = (e) => (e && e.message) ? e.message : String(e)

function send(res, data, status = 200) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(data))
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

// ── API handlers ──
async function handleState(_req, res) {
  try {
    const profiles = listProfiles().map((p) => ({
      name: p,
      snapshots: listSnapshots(p).map((s) => ({
        stamp: s.stamp,
        tag: s.tag,
        time: s.time,
        reason: s.reason,
      })),
    }))
    send(res, { ok: true, keepSnapshots: readGuardConfig().keepSnapshots, profiles })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

async function handleSnapshot(req, res) {
  try {
    const body = await readBody(req)
    const profile = typeof body.profile === 'string' && body.profile !== '' ? body.profile : undefined
    const results = profile
      ? [snapshotProfile(profile, { tag: 'manual', reason: '手动存档（设置页）' })]
      : snapshotAll('manual', '手动存档（设置页）')
    send(res, { ok: true, results: results.map((r) => r.error ? { profile: r.profile, error: r.error } : r.skipped ? { profile: r.profile, skipped: true } : { profile: r.profile, stamp: r.stamp }) })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

async function handleRollback(req, res) {
  try {
    const body = await readBody(req)
    const profile = typeof body.profile === 'string' && body.profile !== '' ? body.profile : 'web'
    const stamp = typeof body.stamp === 'string' ? body.stamp : ''
    if (!stamp) return send(res, { ok: false, error: '缺少要加载的快照 stamp' })
    const dir = resolveSnapshotDir(profile, { id: stamp })
    if (!dir) return send(res, { ok: false, error: `profile "${profile}" 找不到快照 ${stamp}` })
    const { pnpm } = restoreSnapshot(profile, dir)
    const target = dir.split(/[\\/]/).at(-1)
    if (pnpm !== null && !pnpm.ok) {
      return send(res, { ok: true, restored: true, stamp: target, warning: `配置文件已还原；pnpm install 失败（exit ${pnpm.status}）：${pnpm.output}` })
    }
    send(res, { ok: true, restored: true, stamp: target, note: '请重启应用使更改生效。' })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

async function handleKeep(req, res) {
  try {
    const body = await readBody(req)
    const n = setKeepSnapshots(Number(body.keep))
    send(res, { ok: true, keepSnapshots: n })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export function apply(ctx, config) {
  const apiOnly = !!(config && config.apiOnly)

  if (!apiOnly) {
    const sp = ctx.get('systemPrompt')
    if (sp !== undefined) {
      sp.section({
        name: 'guard:incident-alert',
        order: -50,
        text: () => incidentSectionText(),
      })
    }

    const tools = ctx.get('tools')
    if (tools !== undefined) {
      // Auto-snapshot before mutating install tools. Side-effect only: a guard
      // never denies; snapshot errors are swallowed so the install itself is
      // never blocked by the safety net.
      tools.guard((execution) => {
        if (GUARDED_TOOLS.has(execution.name)) {
          try {
            snapshotAll('auto-before-install', `pre-tool guard for ${execution.name}`)
          } catch {
            // never block the install because the guard failed
          }
        }
        return undefined
      })

      for (const tool of createGuardTools()) {
        tools.register(tool)
      }
    }
  }

  // 设置 > 备份管理 API. Registered only by the apiOnly row; that row declares
  // inject:['webServer'] (per-row, in the bundle patch), so webServer is
  // guaranteed present here. The main guard row never touches routes (no
  // duplicate registration) and stays webServer-free for non-web profiles.
  if (apiOnly) {
    const webServer = ctx.get('webServer')
    const routes = [
      { kind: 'exact', path: '/guard/api/state', handler: handleState },
      { kind: 'exact', path: '/guard/api/snapshot', handler: handleSnapshot },
      { kind: 'exact', path: '/guard/api/rollback', handler: handleRollback },
      { kind: 'exact', path: '/guard/api/keep', handler: handleKeep },
    ]
    for (const route of routes) {
      ctx.effect(() => webServer.register(route), `guard: ${route.path} route`)
    }
  }
}

export { readPending, resolveIncidentMarker }
