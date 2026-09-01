import { readState } from './state.mjs'
import { scanHome } from './scan.mjs'
import { listSnapshots } from './snapshot.mjs'
import { listIncidents } from './launch.mjs'

const HINTS = {
  'manifest-invalid': 'restore the profile manifest: dsh-recovery rollback --profile {p} --latest',
  'bundles-missing': 'restore the profile manifest: dsh-recovery rollback --profile {p} --latest',
  'bundle-unresolvable': 'reinstall the bundle: dsh plugin --profile {p} install, or roll back: dsh-recovery rollback --profile {p} --latest',
  'bundle-manifest-invalid': 'the bundle package manifest is corrupt — reinstall it: dsh plugin --profile {p} install',
  'bundle-no-manifest': 'the bundle dropped its dsh.bundle declaration — update or roll back the package',
  'patch-parse-failed': 'restore the patch layer: dsh-recovery rollback --profile {p} --latest',
  'duplicate-entry-id': 'remove the duplicate insert row (or roll back the patch layer)',
  'insert-unnamed': 'give the insert row an id',
  'patch-target-missing': 'the patch addresses a row that does not exist — harmless unless a disable/config was intended',
  'name-unresolvable': 'fix the row name or restore the plugin it references',
  'dependency-not-installed': 'dsh plugin --profile {p} install',
  'bundle-not-in-layer': 'the bundle layer was not reconciled: rerun dsh plugin --profile {p} add <package>',
  'link-target-missing': 're-link or reinstall the local plugin',
  'node-modules-missing': 'dsh plugin --profile {p} install',
  'settings-parse-failed': 'restore settings.yaml from a verbatim snapshot or your own backup (redacted snapshots never overwrite secrets)',
  'settings-key-missing': 'add agent-presets.default / permission.defaultPreset to settings.yaml',
  'preset-default-missing': 'settings point at a missing preset — pick an existing one or restore the preset',
  'credentials-corrupt': 'restore .credentials.yaml from your own backup (never stored in snapshots)',
  'storages-corrupt': 'restore the storage registry: dsh-recovery rollback --profile {p} --latest',
  'preset-broken': 'restore the preset from a Tier B snapshot or move the directory aside and reset the default preset',
  'preset-meta-broken': 'repair preset.yml (display metadata)',
  'session-corrupt': 'restore sessions from a --data snapshot, or quarantine the file',
  'session-unreadable': 'check permissions on the session file',
  'safemode-drift': 'dsh-recovery safemode enter --reset',
  'intent-drift': 'reconcile plugins.intent.json or run dsh plugin add for the missing plugin'
}

export function doctor(home, opts = {}) {
  const scanned = scanHome(home, opts)
  const state = readState(home)
  const snapshots = listSnapshots(home)
  const recommendations = []
  const seen = new Set()
  for (const finding of scanned.findings) {
    if (finding.severity !== 'error' && finding.severity !== 'warning') continue
    const hint = HINTS[finding.code]
    if (hint === undefined || seen.has(finding.code)) continue
    seen.add(finding.code)
    recommendations.push({ code: finding.code, hint: hint.replaceAll('{p}', scanned.profile) })
  }
  const report = {
    home,
    profile: scanned.profile,
    dshVersion: scanned.dshVersion,
    checkedAt: new Date().toISOString(),
    state: {
      mode: state.mode,
      safeModeActive: state.safeMode?.active === true,
      lastSnapshot: state.lastSnapshot,
      lastGood: state.lastGood,
      lastRollback: state.lastRollback,
      bootFailures: (state.bootFailures ?? []).length,
      previousCrash: state.previousCrash ?? null,
      recentIncidents: listIncidents(home).slice(0, 5)
    },
    snapshots: snapshots.map((s) => ({ id: s.id, time: s.time, reason: s.reason, compositionFiles: s.compositionFiles, usercodeFiles: s.usercodeFiles, dataFiles: s.dataFiles })),
    findings: scanned.findings,
    recommendations,
    summary: scanned.summary
  }
  return { ok: scanned.summary.errors === 0, report }
}
