// Smoke test: exercises the engine end-to-end against a throwaway DSH_HOME.
// Run: node scripts/smoke-test.js
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'dsh-guard-test-'))
process.env.DSH_HOME = join(tmp, '.dsh-home')

const {
  snapshotProfile, listSnapshots, restoreSnapshot, resolveSnapshotDir, listProfiles,
} = await import('../src/engine.js')
const { readPending, writePending, incidentSectionText, resolveIncidentMarker } = await import('../src/incident.js')
const { pendingMarkerPath } = await import('../src/layout.js')

let failures = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures++
}

// --- fixture profile
const web = join(tmp, '.dsh-home', 'profiles', 'web')
mkdirSync(web, { recursive: true })
const originalPkg = JSON.stringify({ name: 'test-profile', dependencies: {} }, null, 2)
writeFileSync(join(web, 'package.json'), originalPkg)
writeFileSync(join(web, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
writeFileSync(join(web, 'cordis.patch.yml'), '- insert: []\n')

check('listProfiles sees the fixture', listProfiles().includes('web'), listProfiles().join(','))

// --- snapshot -> mutate -> restore
const snap = snapshotProfile('web', { tag: 'smoke', reason: 'smoke test' })
check('snapshot creates a stamp', Boolean(snap.stamp) && !snap.error, JSON.stringify(snap))
writeFileSync(join(web, 'package.json'), JSON.stringify({ name: 'test-profile', broken: true }))
const restored = restoreSnapshot('web', resolveSnapshotDir('web', { id: snap.stamp }), { skipInstall: true })
check('restore returns files list', Array.isArray(restored.restored) && restored.restored.includes('package.json'))
check('restore brings back the original content', readFileSync(join(web, 'package.json'), 'utf8') === originalPkg)
const snap2 = snapshotProfile('web', { tag: 'smoke' })
check('post-restore snapshot creates a new stamp (pre-rollback differs)', Boolean(snap2.stamp))
const snap3 = snapshotProfile('web', { tag: 'smoke' })
check('identical re-snapshot is skipped', snap3.skipped === true)
const forced = snapshotProfile('web', { tag: 'smoke', force: true })
check('forced snapshot pins a new stamp', Boolean(forced.stamp))
check('snapshot list is populated', listSnapshots('web').length >= 2, `count=${listSnapshots('web').length}`)

// --- pending marker round trip (with a UTF-8 BOM, as PowerShell 5.1 writes it)
writePending('smoke-test', 'C:/fake/report.md')
const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(pendingMarkerPath())])
writeFileSync(pendingMarkerPath(), bom)
const pending = readPending()
check('marker parses despite BOM', pending !== null && pending.kind === 'smoke-test')
const text = incidentSectionText()
check('section text names the report', text.includes('C:/fake/report.md'))
check('section text is empty without marker', (() => {
  resolveIncidentMarker()
  return incidentSectionText() === ''
})())

// --- cleanup
rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
