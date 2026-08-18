// dsh-plugin-guard — 设置 > 备份管理 client 半。
// 数据通过 fetch 调 host 的 /guard/api/* HTTP 路由：
//   state    列出各 profile 的快照 + 当前保留数量
//   snapshot 手动存档（可选指定 profile）
//   rollback 加载（还原）指定快照
//   keep     设置每个 profile 最多保留的快照数量（最少 2）
// 渲染模式与 dsh-skill-center 一致：__ModuleLoader__ + React.createElement。

window.__ModuleLoader__.load({
  id: 'dsh-plugin-guard',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const CSS = `
.gdb-wrap{display:flex;flex-direction:column;gap:14px;min-height:420px}
.gdb-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.gdb-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.gdb-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.gdb-hint.gdb-err{color:var(--dsw-alias-state-error-primary)}
.gdb-btn{font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 12px;cursor:pointer}
.gdb-btn:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
.gdb-btn[disabled]{opacity:.5;cursor:not-allowed}
.gdb-btn.gdb-primary{background:var(--dsw-alias-state-business-primary);color:#fff;border:none}
.gdb-btn.gdb-danger{color:var(--dsw-alias-state-error-primary)}
.gdb-input{font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;box-sizing:border-box;width:72px}
.gdb-select{font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;box-sizing:border-box}
.gdb-profiles{display:flex;flex-direction:column;gap:12px}
.gdb-prof{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px}
.gdb-prof-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.gdb-prof-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.gdb-prof-desc{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.gdb-prof-count{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.gdb-list{display:flex;flex-direction:column;gap:4px}
.gdb-snap{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;border:1px solid transparent}
.gdb-snap:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.gdb-stamp{font-family:ui-monospace,Consolas,'Courier New',monospace;font-size:11px;color:var(--dsw-alias-label-primary);min-width:150px}
.gdb-tag{font-size:10px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);border-radius:6px;padding:2px 6px;white-space:nowrap}
.gdb-time{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.gdb-reason{font-size:11px;color:var(--dsw-alias-label-tertiary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gdb-load{font-family:inherit;font-size:11px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 8px;cursor:pointer;white-space:nowrap}
.gdb-load:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
.gdb-load.gdb-confirm{color:#fff;background:var(--dsw-alias-state-error-primary);border-color:transparent}
.gdb-load[disabled]{opacity:.5;cursor:not-allowed}
.gdb-status{font-size:12px;color:var(--dsw-alias-label-tertiary);min-height:16px}
.gdb-status.gdb-err{color:var(--dsw-alias-state-error-primary)}
.gdb-status.gdb-ok{color:var(--dsw-alias-state-success-primary)}
.gdb-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:10px;text-align:center}
.gdb-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.gdb-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.gdb-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.gdb-card-head{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.gdb-card-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4;flex:1}
.gdb-card-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.gdb-card-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.gdb-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.gdb-field-head{align-items:center;gap:8px;display:flex}
.gdb-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.gdb-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.gdb-input-invalid{border-color:var(--dsw-alias-state-error-primary)}
.gdb-invalid{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:1.5}
.gdb-card-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.gdb-card-footer .gdb-hint{flex:1}
`

    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-guard'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    async function api(method, args) {
      const base = '/guard/api/' + method
      if (method === 'snapshot' || method === 'rollback' || method === 'keep') {
        const r = await fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args || {}),
        })
        return r.json()
      }
      const q = new URLSearchParams()
      if (args) for (const k in args) { const v = args[k]; if (v !== undefined && v !== null && v !== '') q.set(k, String(v)) }
      const r = await fetch(base + (q.toString() ? '?' + q.toString() : ''))
      return r.json()
    }

    const fmtTime = (iso) => {
      if (!iso) return ''
      const d = new Date(iso)
      return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
    }

    const TAG_LABEL = { 'pre-boot': '启动前', 'pre-rollback': '回退前', 'auto-before-install': '安装前', manual: '手动', 'known-good': '良好基线' }
    // 环境 = 一套独立的运行配置（D 上的安装清单）。web 是网页版主环境，headless 是无界面模式。
    const ENV_DESC = { web: '网页版主环境（你现在用的界面）', headless: '无界面模式（命令行/后台启动）' }

    function BackupsSection() {
      const [phase, setPhase] = React.useState('loading')
      const [profiles, setProfiles] = React.useState([])
      const [keep, setKeep] = React.useState(10)
      const [keepInput, setKeepInput] = React.useState('10')
      const [selProfile, setSelProfile] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [confirm, setConfirm] = React.useState(null) // { profile, stamp }
      const [status, setStatus] = React.useState({ text: '', kind: '' })

      const refresh = async () => {
        try {
          const r = await api('state')
          if (r && r.ok) { setProfiles(r.profiles || []); setKeep(r.keepSnapshots); setKeepInput(String(r.keepSnapshots)) }
          else setStatus({ text: (r && r.error) || '加载失败', kind: 'err' })
        } catch (e) { setStatus({ text: String((e && e.message) || e), kind: 'err' }) }
        setPhase('ready')
      }
      React.useEffect(() => { refresh() }, [])

      const doSnapshot = async () => {
        setBusy(true); setStatus({ text: '', kind: '' })
        try {
          const r = await api('snapshot', selProfile ? { profile: selProfile } : {})
          if (r && r.ok) {
            const made = (r.results || []).filter((x) => x.stamp)
            const skipped = (r.results || []).filter((x) => x.skipped)
            setStatus({ text: made.length ? `已存档 ${made.map((x) => `${x.profile}:${x.stamp}`).join('，')}` : '状态无变化（与最近备份相同，已跳过）', kind: 'ok' })
            await refresh()
          } else setStatus({ text: (r && r.error) || '存档失败', kind: 'err' })
        } catch (e) { setStatus({ text: String((e && e.message) || e), kind: 'err' }) }
        setBusy(false)
      }

      const doRollback = async (profile, stamp) => {
        setBusy(true); setStatus({ text: '', kind: '' }); setConfirm(null)
        try {
          const r = await api('rollback', { profile, stamp })
          if (r && r.ok) {
            const note = r.warning ? `已还原 ${r.stamp}；${r.warning}` : `已加载备份 ${r.stamp}`
            setStatus({ text: note + (r.note ? ` ${r.note}` : ''), kind: r.warning ? 'err' : 'ok' })
            await refresh()
          } else setStatus({ text: (r && r.error) || '加载失败', kind: 'err' })
        } catch (e) { setStatus({ text: String((e && e.message) || e), kind: 'err' }) }
        setBusy(false)
      }

      const doSaveKeep = async () => {
        const n = Math.floor(Number(keepInput))
        if (!Number.isFinite(n) || n < 2) { setStatus({ text: '保留数量至少为 2', kind: 'err' }); return }
        setBusy(true); setStatus({ text: '', kind: '' })
        try {
          const r = await api('keep', { keep: n })
          if (r && r.ok) { setKeep(r.keepSnapshots); setKeepInput(String(r.keepSnapshots)); setStatus({ text: `已保存：每个环境最多保留 ${r.keepSnapshots} 份快照`, kind: 'ok' }) }
          else setStatus({ text: (r && r.error) || '保存失败', kind: 'err' })
        } catch (e) { setStatus({ text: String((e && e.message) || e), kind: 'err' }) }
        setBusy(false)
      }

      const profileOptions = ['', ...profiles.map((p) => p.name)]

      const profilePanels = profiles.length === 0
        ? React.createElement('div', { className: 'gdb-empty' }, phase === 'loading' ? '加载中…' : '暂无快照。点「＋ 手动存档」创建第一份备份。')
        : React.createElement(React.Fragment, null,
            profiles.map((p) => React.createElement('div', { key: p.name, className: 'gdb-prof' },
              React.createElement('div', { className: 'gdb-prof-head' },
                React.createElement('h4', { className: 'gdb-prof-name' }, `环境 ${p.name}`),
                React.createElement('span', { className: 'gdb-prof-desc' }, ENV_DESC[p.name] || '独立配置环境'),
                React.createElement('span', { className: 'gdb-prof-count' }, `${p.snapshots.length} 份`),
              ),
              p.snapshots.length === 0
                ? React.createElement('div', { className: 'gdb-empty' }, '暂无快照')
                : React.createElement('div', { className: 'gdb-list' },
                    p.snapshots.map((s) => {
                      const isConfirm = confirm && confirm.profile === p.name && confirm.stamp === s.stamp
                      return React.createElement('div', { key: s.stamp, className: 'gdb-snap' },
                        React.createElement('span', { className: 'gdb-stamp' }, s.stamp),
                        React.createElement('span', { className: 'gdb-tag' }, TAG_LABEL[s.tag] || s.tag || '—'),
                        React.createElement('span', { className: 'gdb-time' }, fmtTime(s.time)),
                        React.createElement('span', { className: 'gdb-reason', title: s.reason }, s.reason || ''),
                        React.createElement('button', {
                          className: 'gdb-load' + (isConfirm ? ' gdb-confirm' : ''),
                          disabled: busy,
                          onClick: () => isConfirm ? doRollback(p.name, s.stamp) : setConfirm({ profile: p.name, stamp: s.stamp }),
                        }, isConfirm ? '确认加载？' : '加载此备份'),
                      )
                    }),
                  ),
            )))

      return React.createElement('div', { className: 'gdb-wrap' },
        React.createElement('div', { className: 'gdb-toolbar' },
          React.createElement('h3', { className: 'gdb-title' }, '备份管理'),
          React.createElement('span', { className: 'gdb-hint' }, '每个环境最多保留'),
          React.createElement('input', {
            className: 'gdb-input', type: 'number', min: 2, value: keepInput,
            onChange: (e) => setKeepInput(e.target.value),
          }),
          React.createElement('span', { className: 'gdb-hint' }, '份（最少 2）'),
          React.createElement('button', { className: 'gdb-btn', disabled: busy || String(keepInput) === String(keep), onClick: doSaveKeep }, '保存'),
          React.createElement('div', { style: { flex: 1 } }),
          React.createElement('select', { className: 'gdb-select', value: selProfile, onChange: (e) => setSelProfile(e.target.value) },
            React.createElement('option', { value: '' }, '全部环境'),
            profiles.map((p) => React.createElement('option', { key: p.name, value: p.name }, p.name)),
          ),
          React.createElement('button', { className: 'gdb-btn gdb-primary', disabled: busy, onClick: doSnapshot }, busy ? '处理中…' : '＋ 手动存档'),
        ),
        React.createElement('div', { className: 'gdb-hint' }, '说明：「环境」指一套独立的运行配置——web 是网页版主环境（你现在用的界面），headless 是无界面模式（命令行/后台启动）。「加载此备份」会还原该环境的 4 个配置文件并重跑 pnpm install --frozen-lockfile；加载前会自动存一份「回退前」快照（可逆），完成后请重启应用使更改生效。'),
        React.createElement('div', { className: 'gdb-profiles' }, profilePanels),
        React.createElement('div', { className: 'gdb-status' + (status.kind ? ' gdb-' + status.kind : ''), style: { minHeight: '16px' } }, status.text || ''),
      )
    }

    // ── 设置 > 插件 > 插件配置 card（rc.7 插件自有设置表面）──
    // Binds the `guard` settings namespace (registered by the host half) and
    // edits the keepSnapshots field with the settingsScope's revision fencing.
    // Mirrors the dsh-vision-router plugin card pattern.
    function GuardCard(props) {
      const scope = props.scope
      const subscribe = React.useMemo(() => scope.subscribe.bind(scope), [scope])
      const getSnapshot = React.useMemo(() => scope.getSnapshot.bind(scope), [scope])
      const [drafts, setDrafts] = React.useState({})
      const [saving, setSaving] = React.useState(false)
      const [failed, setFailed] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      let snapshot = null
      try {
        snapshot = React.useSyncExternalStore(subscribe, getSnapshot)
      } catch { snapshot = null }
      if (!snapshot || snapshot.status !== 'ready') return null // namespace unavailable: render nothing
      const writable = snapshot.writable
      const current = snapshot.value && Number.isFinite(snapshot.value.keepSnapshots) ? snapshot.value.keepSnapshots : 10
      const draft = 'keepSnapshots' in drafts ? drafts.keepSnapshots : String(current)
      const dirty = Object.keys(drafts).length > 0
      const n = Number(draft)
      const invalid = !Number.isFinite(n) || n < 2 || n > 100
      const blocked = !dirty || invalid || saving || !writable

      const save = async () => {
        if (blocked) return
        setSaving(true); setFailed(false)
        const ok = await scope.set('keepSnapshots', Math.floor(n)).then(() => true, () => false)
        if (ok) setDrafts({})
        setSaving(false)
        setFailed(!ok)
      }

      const h = React.createElement
      return h('li', { className: 'gdb-card' + (open ? ' gdb-card-open' : '') },
        h('button', {
          type: 'button', className: 'gdb-card-head', 'aria-expanded': open,
          onClick: () => setOpen(!open),
        },
          h('span', { className: 'gdb-card-title' }, '备份管理（dsh-plugin-guard）'),
          h('span', { className: 'gdb-card-desc' }, dirty ? '（有未保存的修改）' : '安装安全网：快照 / 回滚 / 保留数量'),
        ),
        open
          ? h('div', { className: 'gdb-card-body' },
              h('div', { className: 'gdb-field' },
                h('div', { className: 'gdb-field-head' },
                  h('span', { className: 'gdb-label' }, '每个环境保留的快照数量（最少 2）'),
                  h('span', { className: 'gdb-badge' }, writable ? '可编辑' : '只读'),
                ),
                h('input', {
                  className: 'gdb-input' + (invalid ? ' gdb-input-invalid' : ''), type: 'number', min: 2,
                  value: draft, disabled: !writable,
                  onChange: (e) => { setFailed(false); setDrafts({ keepSnapshots: e.target.value }) },
                }),
                invalid ? h('p', { className: 'gdb-invalid' }, '保留数量必须在 2–100 之间') : null,
                failed ? h('p', { className: 'gdb-invalid' }, '保存失败：宿主拒绝了本次写入，请重试。') : null,
              ),
              h('div', { className: 'gdb-card-footer' },
                h('button', { type: 'button', className: 'gdb-btn', disabled: !dirty || saving, onClick: () => { setFailed(false); setDrafts({}) } }, '放弃修改'),
                h('button', { type: 'button', className: 'gdb-btn gdb-primary', disabled: blocked, onClick: save }, saving ? '保存中…' : '保存'),
              ),
              h('p', { className: 'gdb-hint' }, '完整管理（列出快照 / 加载备份 / 手动存档）在 设置 → 备份管理 页面。'),
            )
          : null,
      )
    }

    // ── 启动心跳（黑屏检测）──
    // Renders nothing; on mount it proves the render tree actually mounted and
    // tells the host, which the boot-guard waits for after HTTP is up. If the
    // root entry crashes (rc.7 黑屏), nothing mounts -> the host never sees the
    // heartbeat -> the boot-guard rolls back. Rendered from an always-mounted
    // root-scope slot (shell.overlay).
    function BootHeartbeat() {
      React.useEffect(() => {
        try { fetch('/guard/api/booted', { method: 'POST' }).catch(() => {}) } catch { /* best effort */ }
      }, [])
      return null
    }

    function apply(ctx) {
      // Every contribution below is defensive: if a DSH build changes an API we
      // use, the guard degrades gracefully instead of throwing during the
      // client boot and black-screening the whole web app.
      const slots = ctx.slots

      // 0. Render-crash supervision, registered FIRST so a root crash reports
      //    to the host even if a later registration fails.
      try {
        const disposeErr = slots.onEntryError((key, _entry, error) => {
          if (key !== 'root') return
          try {
            const message = error && error.message ? String(error.message) : String(error)
            fetch('/guard/api/render-error', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message }),
            }).catch(() => {})
          } catch { /* best effort */ }
        })
        if (typeof disposeErr === 'function') {
          ctx.effect(() => disposeErr, 'guard: entry error supervision')
        }
      } catch { /* older DSH without onEntryError: black-screen detection is best-effort */ }

      // 0b. Boot heartbeat (null-rendering occupant in an always-mounted slot).
      try {
        slots.inject('shell.overlay', () => slots.register(
          { name: 'shell.overlay', id: 'guard-boot-heartbeat' },
          BootHeartbeat,
        ))
      } catch { /* best effort */ }

      try { ctx.effect(installStyles) } catch { /* best effort */ }

      try {
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'guard-backups', order: 50, label: '备份管理' },
          BackupsSection,
        ))
      } catch { /* best effort */ }

      // 设置 > 插件 > 插件配置 card (rc.7), keyed on the `guard` namespace.
      try {
        const guardScope = ctx.settingsScope.bind({ namespace: 'guard' })
        ctx.effect(() =>
          slots.inject('settings.plugin.item', function* () {
            yield slots.register(
              {
                name: 'settings.plugin.item',
                key: 'guard',
                id: 'guard',
                order: 50,
                label: '备份管理（dsh-plugin-guard）',
                inject: () => ({ scope: guardScope }),
              },
              GuardCard,
            )
          }),
          'guard: plugin settings card',
        )
      } catch { /* best effort */ }
    }

    exports.apply = apply
    exports.inject = ['slots', 'settingsScope']
    return module.exports
  },
})
