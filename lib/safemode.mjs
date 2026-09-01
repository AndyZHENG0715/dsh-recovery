import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveProfileDir, SAFEMODE_BUNDLES, PATCH_TEMPLATE, PNPM_WORKSPACE, PROFILE_ROOT_CONFIG } from './paths.mjs'
import { ensureDir, writeJsonAtomic, appendJournal } from './fsutil.mjs'
import { readState, writeState } from './state.mjs'
import { snapshot } from './snapshot.mjs'
import { parseYaml } from './yaml.mjs'

export function safemodeEnter(home, opts = {}) {
  const profile = opts.profile ?? 'web'
  const alreadyActive = readState(home).safeMode?.active === true
  const snap = opts.skipSnapshotIfActive === true && alreadyActive
    ? { id: null }
    : snapshot(home, { profile, reason: 'safemode-enter', install: opts.install, internal: false })
  const repaired = enforceSafemodeProfile(home)
  const state = readState(home)
  state.mode = 'safe'
  state.safeMode = { active: true, enteredAt: new Date().toISOString() }
  writeState(home, state)
  appendJournal(home, { op: 'safemode-enter', snapshot: snap.id })
  return {
    ok: true,
    snapshot: snap.id ?? null,
    repaired,
    next: 'DSH_HOME=' + home + ' dsh --profile safemode --port 3081',
    note: 'safemode mounts only the whitelist core bundles and no user presets or skills; it is the guaranteed-to-boot console.'
  }
}

export function safemodeExit(home, opts = {}) {
  let repaired = []
  if (opts.reset === true) repaired = enforceSafemodeProfile(home)
  const state = readState(home)
  state.mode = 'normal'
  state.safeMode = { active: false, enteredAt: state.safeMode?.enteredAt ?? null }
  writeState(home, state)
  appendJournal(home, { op: 'safemode-exit', reset: opts.reset === true })
  return {
    ok: true,
    repaired,
    next: opts.rollback === true
      ? 'dsh-recovery rollback --profile ' + (opts.profile ?? 'web') + ' --good'
      : 'safemode exited; boot your normal profile. Optionally: dsh-recovery rollback --good to restore the last known-good snapshot.'
  }
}

export function enforceSafemodeProfile(home) {
  const dir = resolveProfileDir(home, 'safemode')
  ensureDir(dir)
  const repaired = []
  const manifestPath = join(dir, 'package.json')
  const desired = {
    name: 'dsh-profile-safemode',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...SAFEMODE_BUNDLES] } }
  }
  let current = null
  try { current = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { current = null }
  if (current === null || JSON.stringify(current?.dsh?.profile?.bundles) !== JSON.stringify(SAFEMODE_BUNDLES)) {
    writeJsonAtomic(manifestPath, { ...(current ?? {}), name: desired.name, private: true, dsh: { profile: { bundles: [...SAFEMODE_BUNDLES] } }, dependencies: current?.dependencies ?? {} })
    repaired.push('package.json (bundles whitelist)')
  }
  const patchPath = join(dir, 'cordis.patch.yml')
  let patchEmpty = false
  try {
    const parsed = parseYaml(readFileSync(patchPath, 'utf8'))
    patchEmpty = parsed.ok && Array.isArray(parsed.value) && parsed.value.length === 0
  } catch { patchEmpty = false }
  if (!existsSync(patchPath) || !patchEmpty) {
    ensureDir(dir)
    writeFileSync(patchPath, PATCH_TEMPLATE)
    repaired.push('cordis.patch.yml (empty whitelist patch)')
  }
  const workspacePath = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) {
    writeFileSync(workspacePath, PNPM_WORKSPACE)
    repaired.push('pnpm-workspace.yaml')
  }
  const rootPath = join(dir, 'cordis.yml')
  writeFileSync(rootPath, PROFILE_ROOT_CONFIG)
  return repaired
}
