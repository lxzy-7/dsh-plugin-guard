// Model tools registered by the guard plugin.
//
// Fully self-contained: the tool descriptors are plain objects (name /
// description / parameters / output.schema / output.render / execute) — the
// exact shape @deepseek-ai/dsh-tools#defineTool produces for these simple
// JSON-Schema definitions (the harness's LLM adapters and tool registry read
// those fields directly). We build them inline so this plugin has ZERO
// runtime dependencies and loads on any dsh install regardless of how pnpm
// lays out node_modules (no @deepseek-ai/dsh-tools, no its peer chain).
import {
  listProfiles, snapshotProfile, snapshotAll, listSnapshots,
  resolveSnapshotDir, restoreSnapshot, resolveGuardPort,
} from './engine.js'
import {
  readPending, resolveIncidentMarker, buildIncidentReport, health,
} from './incident.js'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { guardLogsDir } from './layout.js'

const renderText = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]

// ── tiny self-contained `defineTool` (dsh-tools subset) ─────────────────────
// The plugin's schemas use dsh-tools' DSL conventions: `required: true` lives
// on a property and is hoisted into the parent object's `required` array when
// compiled to raw JSON Schema. `hoistRequired` reproduces exactly that for the
// shapes used here, so the compiled `parameters` / `output.schema` match what
// defineTool would have produced.
function hoistRequired(schema) {
  if (!schema || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) {
    for (const item of schema) hoistRequired(item)
    return schema
  }
  if (schema.type === 'object' && schema.properties && typeof schema.properties === 'object') {
    const required = []
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (prop && prop.required === true) {
        delete prop.required
        required.push(key)
      }
    }
    if (required.length > 0) schema.required = required
    for (const prop of Object.values(schema.properties)) hoistRequired(prop)
  }
  if (schema.items) hoistRequired(schema.items)
  return schema
}

function compileParameters(spec) {
  const schema = { type: 'object', properties: { ...spec } }
  return hoistRequired(schema)
}

function validateArgs(parameters, args) {
  const violations = []
  const walk = (schema, value, path) => {
    if (schema.type === 'object') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        violations.push(`${path || 'value'} must be an object`)
        return
      }
      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (value[key] === undefined) violations.push(`${path ? `${path}.` : ''}${key} is required`)
        }
      }
      for (const [key, prop] of Object.entries(schema.properties || {})) {
        if (value[key] !== undefined) walk(prop, value[key], `${path ? `${path}.` : ''}${key}`)
      }
    } else if (schema.type === 'string') {
      if (typeof value !== 'string') violations.push(`${path} must be a string`)
      else if (Array.isArray(schema.enum) && !schema.enum.includes(value)) violations.push(`${path} must be one of: ${schema.enum.join(', ')}`)
    } else if (schema.type === 'boolean') {
      if (typeof value !== 'boolean') violations.push(`${path} must be a boolean`)
    } else if (schema.type === 'array') {
      if (!Array.isArray(value)) violations.push(`${path} must be an array`)
    }
  }
  walk(parameters, args, '')
  return violations
}

function defineTool(options) {
  const parameters = compileParameters(options.parameters || {})
  const outputSchema = hoistRequired(JSON.parse(JSON.stringify(options.output.schema)))
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: options.output.render,
    },
    async execute(args, exec) {
      const violations = validateArgs(parameters, args === undefined ? {} : args)
      if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`)
      return options.execute(args, exec)
    },
  }
}

export function createGuardTools() {
  return [
    defineTool({
      name: 'incident_resolved',
      description: '在事故报告已被分析、且(尽可能)修复完成后，把待处理的 DSH 事故标记为已处理。该工具会改名为"已解决"标记，让后续会话不再收到事故警报。\nMark the pending DSH incident as resolved after the incident report has been analyzed and (when possible) fixed. Renames the pending marker so future sessions stop receiving the incident alert.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            result: { type: 'string', required: true },
            report: { type: 'string' },
          },
        },
        render: (_a, v) => [{ type: 'text', text: `${v.result}${v.report ? ` (报告/report: ${v.report})` : ''}` }],
      },
      async execute() {
        return resolveIncidentMarker()
      },
    }),

    defineTool({
      name: 'dsh_snapshot',
      description: '对某个(或所有) profile 的安装状态做一次快照备份(备份 package.json、锁文件、pnpm-workspace.yaml、cordis.patch.yml 四个文件)，之后可用 dsh_rollback 还原到该快照。\nSnapshot the install state (package.json, lockfile, pnpm-workspace.yaml, cordis.patch.yml) of one profile or every profile, so a later dsh_rollback can restore it.',
      parameters: {
        profile: { type: 'string', description: 'profile 名称；不填则对所有 profile 备份。/ Profile name; omit to snapshot every profile.' },
        tag: { type: 'string', description: '记录到清单里的可选标签(如 manual/安装前/回退前)。/ Optional label recorded in the snapshot manifest.' },
        reason: { type: 'string', description: '记录到清单里的可选原因说明。/ Optional reason text recorded in the manifest.' },
        force: { type: 'boolean', description: '即使与最新快照内容完全一致也强制生成一份(默认会去重跳过)。/ Pin this state even when identical to the newest snapshot.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            snapshots: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          },
        },
        render: renderText,
      },
      async execute(args) {
        const tag = typeof args.tag === 'string' ? args.tag : ''
        const reason = typeof args.reason === 'string' ? args.reason : ''
        const force = args.force === true
        if (typeof args.profile === 'string' && args.profile !== '') {
          return { snapshots: [snapshotProfile(args.profile, { tag, reason, force })] }
        }
        return { snapshots: snapshotAll(tag, reason) }
      },
    }),

    defineTool({
      name: 'dsh_rollback',
      description: '查看或还原 DSH profile 的快照：列出快照、把 profile 回滚到某个快照(或最近的"良好"快照)、报告运行环境健康状况、或生成事故定位报告。\nInspect or restore DSH profile snapshots: list snapshots, roll back a profile to a snapshot (or to the last good one), report harness health, or build an incident report.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'rollback', 'status', 'incident'],
          description: 'list = 列出快照；rollback = 还原文件并重跑 pnpm install --frozen-lockfile；status = 运行环境健康状态 + 待处理事故；incident = 生成事故定位报告(并设置待处理标记)。\nlist = show snapshots; rollback = restore files and run pnpm install --frozen-lockfile; status = harness health + pending incident; incident = write a problem-localization report (and set the pending marker).',
        },
        profile: { type: 'string', description: 'list/rollback 作用的 profile 名称(默认 web)。/ Profile name for list/rollback (default: web).' },
        snapshotId: { type: 'string', description: '快照 stamp 或前缀；不填且 good=true 时用最近一份"良好"快照。/ Snapshot stamp or prefix; omit with good=true for the last good snapshot.' },
        good: { type: 'boolean', description: '回滚到未标记 pre-boot/pre-rollback 的最新快照(未给 snapshotId 时的默认行为)。/ Roll back to the newest snapshot not tagged pre-boot/pre-rollback (default when no snapshotId).' },
        skipInstall: { type: 'boolean', description: '只还原配置文件，不运行 pnpm install。/ Restore config files without running pnpm install.' },
        kind: { type: 'string', description: 'action=incident 时的事故类型(默认 manual)。/ Incident kind for action=incident (default: manual).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            result: { type: 'string', required: true },
            detail: { type: 'string' },
          },
        },
        render: (_a, v) => [{ type: 'text', text: `${v.result}${v.detail ? `\n${v.detail}` : ''}` }],
      },
      async execute(args) {
        const profile = typeof args.profile === 'string' && args.profile !== '' ? args.profile : 'web'
        switch (args.action) {
          case 'list': {
            const snaps = listSnapshots(profile)
            const detail = snaps.length === 0
              ? '(没有快照 / no snapshots)'
              : snaps.map((s) => `${s.stamp} [${s.tag}] ${s.time} ${s.reason}`).join('\n')
            return { result: `profile ${profile} 的快照列表 / snapshots:`, detail }
          }
          case 'rollback': {
            const good = args.snapshotId === undefined && args.good !== false
            const dir = resolveSnapshotDir(profile, { id: args.snapshotId ?? '', good })
            if (!dir) return { result: `profile ${profile} 没有可用快照 / no snapshot available`, detail: '请先运行 dsh_snapshot 备份 / run dsh_snapshot first' }
            const { pnpm } = restoreSnapshot(profile, dir, { skipInstall: args.skipInstall === true })
            const detail = pnpm === null
              ? '文件已还原(pnpm install 已跳过) / files restored (pnpm skipped)'
              : pnpm.ok ? `文件已还原; pnpm: ${pnpm.output} / files restored; pnpm: ${pnpm.output}` : `文件已还原; pnpm 失败(${pnpm.status}): ${pnpm.output} / files restored; PNPM FAILED (${pnpm.status}): ${pnpm.output}`
            return {
              result: `profile ${profile} 已回滚到 / rolled back to ${dir.split(/[\\/]/).at(-1)}`,
              detail: `${detail}\n重启 dsh web 使 bundle 插件的改动生效 / Restart dsh web for bundle changes to take effect.`,
            }
          }
          case 'status': {
            const healthy = await health(resolveGuardPort())
            const pending = readPending()
            let lastBoot = '(未知/unknown)'
            try {
              const p = join(guardLogsDir(), 'last-boot.txt')
              if (existsSync(p)) lastBoot = readFileSync(p, 'utf8').trim()
            } catch {}
            return {
              result: `运行环境健康状态 / harness health: ${healthy ? '健康/healthy' : '异常/UNHEALTHY'}`,
              detail: `profiles: ${listProfiles().join(', ') || '(无/none)'}\nlast boot: ${lastBoot}\n待处理事故 / pending incident: ${pending ? `${pending.kind} @ ${pending.time}` : '无/none'}`,
            }
          }
          case 'incident': {
            const kind = typeof args.kind === 'string' && args.kind !== '' ? args.kind : 'manual'
            const report = await buildIncidentReport(kind)
            return { result: '事故报告已生成 / incident report written', detail: `${report}\n已设置待处理标记:下一个会话将自动触发分析 / Pending marker set: the next session will auto-trigger analysis.` }
          }
          default:
            return { result: `未知 action / unknown action: ${args.action}` }
        }
      },
    }),
  ]
}
