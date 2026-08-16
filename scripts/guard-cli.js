#!/usr/bin/env node
// dsh-guard — standalone CLI for the guard engine. Works without the harness
// (this is the tool you use when the app cannot start).
//
//   dsh-guard snapshot [--profile X] [--tag T] [--reason R] [--force]
//   dsh-guard list     [--profile X]
//   dsh-guard rollback [--profile X] [--id I | --good] [--skip-install]
//   dsh-guard keep     [N]            (show, or set the per-profile cap, min 2)
//   dsh-guard health   [--port N]
//   dsh-guard incident [--kind K] [--no-marker]
//   dsh-guard resolve
//   dsh-guard profiles
import {
  listProfiles, snapshotProfile, snapshotAll, listSnapshots,
  resolveSnapshotDir, restoreSnapshot, readGuardConfig, setKeepSnapshots, resolveGuardPort,
} from '../src/engine.js'
import {
  readPending, resolveIncidentMarker, buildIncidentReport, health,
} from '../src/incident.js'

function parseArgs(argv) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--profile') opts.profile = argv[++i]
    else if (a === '--tag') opts.tag = argv[++i]
    else if (a === '--reason') opts.reason = argv[++i]
    else if (a === '--id') opts.id = argv[++i]
    else if (a === '--kind') opts.kind = argv[++i]
    else if (a === '--port') opts.port = Number(argv[++i])
    else if (a === '--force') opts.force = true
    else if (a === '--good') opts.good = true
    else if (a === '--skip-install') opts.skipInstall = true
    else if (a === '--no-marker') opts.noMarker = true
    else if (a === '-h' || a === '--help') opts.help = true
    else opts._.push(a)
  }
  return opts
}

const USAGE = `dsh-guard: DeepSeek Harness 安装/回滚安全网
  命令(可用 --profile / --tag / --reason / --force / --id / --good / --skip-install / --kind / --port 等参数):
  snapshot [--profile X] [--tag T] [--reason R] [--force]   手动快照
  list     [--profile X]                                     列出快照
  rollback [--profile X] [--id I | --good] [--skip-install]  回滚到指定/最近良好快照
  keep     [N]                                               查看或设置保留快照数(最少 2)
  health   [--port N]                                        检查后端健康状态
  incident [--kind K] [--no-marker]                          生成事故定位报告
  resolve                                                   标记待处理事故为已解决
  profiles                                                  列出所有 profile`

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0] ?? 'help'
  const opts = parseArgs(argv.slice(1))
  if (opts.help || cmd === 'help') {
    console.log(USAGE)
    return 0
  }

  switch (cmd) {
    case 'profiles': {
      console.log(`当前 profile 列表: ${listProfiles().join(', ') || '(无)'}`)
      return 0
    }
    case 'snapshot': {
      const tag = opts.tag ?? ''
      const reason = opts.reason ?? ''
      const results = opts.profile
        ? [snapshotProfile(opts.profile, { tag, reason, force: opts.force === true })]
        : snapshotAll(tag, reason)
      for (const r of results) {
        if (r.error) console.log(`快照 ${r.profile} 失败: ${r.error}`)
        else if (r.skipped) console.log(`快照 ${r.profile} -> 跳过(与上一份内容完全相同)`)
        else console.log(`快照 ${r.profile} -> ${r.stamp}`)
      }
      return 0
    }
    case 'list': {
      const profiles = opts.profile ? [opts.profile] : listProfiles()
      for (const p of profiles) {
        console.log(`profile '${p}' 的快照:`)
        const snaps = listSnapshots(p)
        if (snaps.length === 0) console.log('  (无)')
        for (const s of snaps) {
          console.log(`  ${s.stamp}  [${s.tag}]  ${s.time}`)
          if (s.reason) console.log(`      原因: ${s.reason}`)
        }
      }
      return 0
    }
    case 'rollback': {
      const profiles = opts.profile ? [opts.profile] : listProfiles()
      let failed = false
      for (const p of profiles) {
        const good = opts.id === undefined && opts.good !== false
        const dir = resolveSnapshotDir(p, { id: opts.id ?? '', good })
        if (!dir) {
          console.error(`profile '${p}' 没有可用快照`)
          failed = true
          continue
        }
        console.log(`回滚 ${p} -> 快照 ${dir.split(/[\\/]/).at(-1)}`)
        try {
          const { pnpm } = restoreSnapshot(p, dir, { skipInstall: opts.skipInstall === true })
          if (pnpm !== null && !pnpm.ok) {
            console.error(`pnpm 失败(退出码 ${pnpm.status}): ${pnpm.output}`)
            console.error('配置文件已还原; 待 pnpm/网络可用后请手动运行 pnpm install --frozen-lockfile。')
            failed = true
          } else {
            console.log('回滚完成。重启 dsh web 使 bundle 插件的改动生效。')
          }
        } catch (error) {
          console.error(`回滚 ${p} 失败: ${error.message}`)
          failed = true
        }
      }
      return failed ? 1 : 0
    }
    case 'keep': {
      const arg = opts._[0]
      if (arg === undefined) {
        console.log(`每个 profile 保留快照数: ${readGuardConfig().keepSnapshots} (最少 2)`)
        return 0
      }
      const n = Number(arg)
      if (!Number.isFinite(n)) {
        console.error('用法: dsh-guard keep <N>')
        return 2
      }
      const v = setKeepSnapshots(n)
      console.log(`每个 profile 保留快照数: ${v}`)
      return 0
    }
    case 'health': {
      const port = opts.port ?? resolveGuardPort()
      const healthy = await health(port)
      console.log(`http://127.0.0.1:${port}/ -> ${healthy ? '正常' : '异常'}`)
      return healthy ? 0 : 1
    }
    case 'incident': {
      const kind = opts.kind ?? 'manual'
      const report = await buildIncidentReport(kind, { port: opts.port ?? resolveGuardPort(), noMarker: opts.noMarker === true })
      console.log(`事故报告: ${report}`)
      if (!opts.noMarker) console.log('已设置待处理标记; 下一个会话将自动触发分析')
      return 0
    }
    case 'resolve': {
      const out = resolveIncidentMarker()
      console.log(out.result)
      return out.report ? 0 : 1
    }
    case 'status': {
      const port = opts.port ?? resolveGuardPort()
      const healthy = await health(port)
      console.log(`健康状态: ${healthy ? '正常' : '异常'}`)
      console.log(`待处理事故: ${readPending() ? '有' : '无'}`)
      return 0
    }
    default: {
      console.log(USAGE)
      return 2
    }
  }
}

main().then((code) => {
  process.exitCode = code
}).catch((error) => {
  console.error(`dsh-guard 执行失败: ${error.message}`)
  process.exitCode = 1
})
