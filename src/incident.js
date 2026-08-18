// Incident marker + report. The plugin reads the marker at prompt-assembly
// time; the CLI and boot guards write it. Everything is JSON lossless.
import {
  existsSync, readFileSync, writeFileSync, renameSync, readdirSync, mkdirSync,
} from 'node:fs'
import http from 'node:http'
import { TextDecoder } from 'node:util'
import { join } from 'node:path'
import { guardDir, guardLogsDir, pendingMarkerPath, profileDir, SNAPSHOT_FILES } from './layout.js'
import {
  listProfiles, listSnapshots, resolveSnapshotDir, sha256File, resolveGuardPort, pruneGuardArtifacts, harnessVersion,
} from './engine.js'

const _decUtf8 = new TextDecoder('utf-8', { fatal: true })
const _decGbk = new TextDecoder('gbk')

/** Decode log/text bytes robustly: strip UTF-8/UTF-16 BOMs, prefer strict
 * UTF-8, then fall back to the system ANSI code page (GBK/CP936) for legacy
 * logs written by PowerShell 5.1's default ANSI encoding. Returns '' only on
 * a read failure. */
function decodeTextRobust(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8')
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le')
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const be = Buffer.from(buf.subarray(2))
    for (let i = 0; i + 1 < be.length; i += 2) {
      const t = be[i]
      be[i] = be[i + 1]
      be[i + 1] = t
    }
    return be.toString('utf16le')
  }
  try {
    return _decUtf8.decode(buf)
  } catch {
    /* not strict UTF-8 — try the ANSI fallback below */
  }
  try {
    return _decGbk.decode(buf)
  } catch {
    /* give up on a clean decode; raw utf8 replacement is the last resort */
  }
  return buf.toString('utf8')
}

function readTextRobust(path) {
  try {
    return decodeTextRobust(readFileSync(path))
  } catch {
    return ''
  }
}

/** Read the pending marker, tolerating a UTF-8 BOM (PowerShell 5.1 writes one). */
export function readPending() {
  try {
    const path = pendingMarkerPath()
    if (!existsSync(path)) return null
    let raw = readFileSync(path, 'utf8')
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function writePending(kind, report) {
  mkdirSync(guardDir(), { recursive: true })
  const marker = { kind, time: new Date().toISOString(), report }
  writeFileSync(pendingMarkerPath(), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
  return marker
}

/** Write a pending "plugin quarantined" notice so the next session clearly
 * shows which plugin was pulled out, that rollback could not fix it, and how to
 * restore it. */
export function writeQuarantineMarker(pluginId, pluginName) {
  mkdirSync(guardDir(), { recursive: true })
  const marker = { kind: 'quarantine', time: new Date().toISOString(), pluginId, pluginName }
  writeFileSync(pendingMarkerPath(), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
  return marker
}

export function resolveIncidentMarker() {
  if (!existsSync(pendingMarkerPath())) return { result: '没有待处理的事故' }
  const inc = readPending()
  const resolved = join(guardDir(), `resolved-incident-${Date.now()}.json`)
  renameSync(pendingMarkerPath(), resolved)
  return { result: '事故已标记为已处理', report: inc?.report ?? resolved }
}

/** Prompt text injected when a pending incident exists; '' otherwise. */
export function incidentSectionText() {
  const inc = readPending()
  if (inc === null) return ''
  const kind = typeof inc.kind === 'string' ? inc.kind : 'unknown'
  const time = typeof inc.time === 'string' ? inc.time : 'unknown'
  if (kind === 'quarantine') {
    const id = typeof inc.pluginId === 'string' ? inc.pluginId : '(未知)'
    const name = typeof inc.pluginName === 'string' ? inc.pluginName : id
    return [
      '【需要留意 · 插件已被隔离(disabled)】',
      `插件 ${name} (id: ${id}) 与当前 DSH 不兼容：回滚无法解决，guard 已自动禁用它并正常启动。`,
      `处理方式: ①升级该插件到与当前 DSH 兼容的版本后再恢复; ②或确认不需要它(保持禁用)。`,
      `恢复命令: dsh-guard quarantine --undo ${id}`,
      '若已处理完毕，调用 incident_resolved 工具清除本提示。',
    ].join('\n')
  }
  const report = typeof inc.report === 'string' ? inc.report : '(path missing)'
  return [
    '【高优先级 · 待处理的 DSH 事故】',
    `检测到一次 ${kind} 事故(发生时间:${time})。`,
    `事故定位报告已生成:${report}`,
    '本会话的首要任务:先读取该报告文件,定位根因;能修复的直接修复(修复前先做快照),',
    '修复完成后调用 incident_resolved 工具标记事故已处理。',
    '若根因不可修复(例如上游缺陷),也要给出结论与规避建议后再标记已处理。',
  ].join('\n')
}

function latestLogTail(dir, pattern, tail) {
  try {
    const files = readdirSync(dir).filter((f) => f.includes(pattern)).sort()
    if (files.length === 0) return ''
    const lines = readTextRobust(join(dir, files.at(-1))).split(/\r?\n/)
    return lines.slice(-tail).join('\n')
  } catch {
    return ''
  }
}

function readLastBoot() {
  try {
    return readTextRobust(join(guardLogsDir(), 'last-boot.txt')).trim() || '(unknown)'
  } catch {
    return '(unknown)'
  }
}

export function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3000 }, (res) => {
      res.resume()
      resolve(res.statusCode >= 200 && res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

/** Build a self-contained problem-localization report; returns the path. */
export async function buildIncidentReport(kind, { port = resolveGuardPort(), noMarker = false } = {}) {
  const logsDir = guardLogsDir()
  mkdirSync(logsDir, { recursive: true })
  const healthy = await health(port)
  const reportPath = join(logsDir, `incident-${Date.now()}.md`)

  const lines = []
  lines.push('# DSH 事故报告', '')
  lines.push(`- 类型: ${kind}`)
  lines.push(`- 时间: ${new Date().toISOString()}`)
  lines.push(`- node: ${process.version}`)
  lines.push(`- dsh 版本: ${harnessVersion() || '(未知)'}`)
  lines.push(`- DSH 根目录: ${process.env.DSH_HOME ?? '(默认 ~/.dsh)'}`)
  lines.push(`- 健康状态: http://127.0.0.1:${port}/ -> ${healthy ? '正常' : '异常'}`)
  lines.push(`- 上次启动: ${readLastBoot()}`, '')

  lines.push('## 启动日志(最近)')
  const boot = latestLogTail(logsDir, 'boot-', 40)
  lines.push(boot ? `\`\`\`\n${boot}\n\`\`\`` : '_(无)_', '')

  lines.push('## 服务端 stderr(最近)')
  const err = latestLogTail(logsDir, 'server-', 80)
  lines.push(err ? `\`\`\`\n${err}\n\`\`\`` : '_(无)_', '')

  lines.push('## profiles 与最近良好快照的对比')
  for (const profile of listProfiles()) {
    const snap = resolveSnapshotDir(profile, { good: true })
    if (!snap) {
      lines.push(`- ${profile}: 没有可对比的良好快照`, '')
      continue
    }
    lines.push(`### ${profile} (对照快照 ${snap.split(/[\\/]/).at(-1)})`)
    let changed = false
    for (const f of SNAPSHOT_FILES) {
      const cur = join(profileDir(profile), f)
      const old = join(snap, f)
      if (!existsSync(cur)) continue
      if (!existsSync(old)) {
        lines.push(`- ${f}: 新增(快照中没有)`)
        changed = true
        continue
      }
      if (sha256File(cur) !== sha256File(old)) {
        lines.push(`- ${f}: 已变更`)
        changed = true
      }
    }
    if (!changed) lines.push('- 无差异')
    lines.push('')
  }

  lines.push('## 快照')
  for (const s of listSnapshots('web').slice(0, 6)) {
    lines.push(`- ${s.stamp} [${s.tag}] ${s.reason}`)
  }
  lines.push('')

  // DSH 版本变化检测：profile 回滚无法撤销 DSH 根目录(node_modules)的更新，
  // 若启动失败由 DSH 更新引起，明确提示用户恢复之前的 DSH 版本。
  const curHarness = harnessVersion()
  const goodDir = resolveSnapshotDir('web', { good: true })
  let snapHarness = ''
  if (goodDir) {
    try {
      const m = JSON.parse(readFileSync(join(goodDir, 'manifest.json'), 'utf8'))
      if (typeof m.harness === 'string') snapHarness = m.harness
    } catch { /* ignore */ }
  }
  if (curHarness && snapHarness && curHarness !== snapHarness) {
    lines.push('## ⚠️ DSH 版本变化（可能与本故障有关）', '')
    lines.push(`- 最近良好快照时的 dsh: ${snapHarness}`)
    lines.push(`- 当前 dsh: ${curHarness}`)
    lines.push('- **profile 回滚无法撤销 DSH 根目录(node_modules)的更新**。若启动失败由 DSH 更新引起，请恢复之前的 DSH 版本后再试。', '')
  }

  writeFileSync(reportPath, lines.join('\n'), 'utf8')
  if (!noMarker) writePending(kind, reportPath)
  pruneGuardArtifacts() // the just-written report is the newest, so it survives
  return reportPath
}
