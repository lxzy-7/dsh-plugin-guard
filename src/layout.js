// Layout: every path this package touches is anchored at DSH_HOME so the
// plugin (in-process), the CLI and the boot guard scripts (out-of-process)
// share one state directory.
//
//   $DSH_HOME/rollbacks/<profile>/<stamp>/   profile snapshots
//   $DSH_HOME/guard/logs/                    boot/server logs, incident reports
//   $DSH_HOME/guard/pending-incident.json    pending incident marker
//
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function dshHome() {
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '') {
    return resolve(process.env.DSH_HOME.trim())
  }
  return join(homedir(), '.dsh')
}

export function profilesDir() {
  return join(dshHome(), 'profiles')
}

export function profileDir(name) {
  return join(profilesDir(), name)
}

export function rollbacksRoot(profile) {
  return join(dshHome(), 'rollbacks', profile)
}

export function guardDir() {
  return join(dshHome(), 'guard')
}

export function guardLogsDir() {
  return join(guardDir(), 'logs')
}

export function pendingMarkerPath() {
  return join(guardDir(), 'pending-incident.json')
}

export function guardConfigPath() {
  return join(guardDir(), 'config.json')
}

/** Files captured by every snapshot (the complete install-state metadata). */
export const SNAPSHOT_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'cordis.patch.yml',
]
