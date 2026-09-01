import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { resolveProfileDir, homePatchPath, storagesDir, settingsPath, userPresetsDir, sessionsDir, recoveryDir } from './paths.mjs'
import { ensureDir, atomicWriteFile, copyTree, appendJournal, readFileOrNull } from './fsutil.mjs'
import { readState, writeState } from './state.mjs'
import { listSnapshots, snapshotManifest, snapshot } from './snapshot.mjs'
import { scanHome } from './scan.mjs'
import { dshBinOf } from './resolve.mjs'

export function rollback(home, opts = {}) {
  const profile = opts.profile ?? 'web'
  const target = opts.target ?? 'latest'
  const types = parseTypes(opts.types)
  const warnings = []
  const restored = []

  const state = readState(home)
  const resolved = resolveTarget(home, target, state)
  if (!resolved.ok) return { ok: false, error: resolved.error, warnings }
  const { id, dir, manifest } = resolved
  const profileDir = resolveProfileDir(home, profile)

  // pre-rollback snapshot (reversible rollback)
  snapshot(home, { profile, reason: 'pre-rollback', data: types.has('data'), internal: true, install: opts.install })
  appendJournal(home, { op: 'rollback', id, target, types: [...types] })

  if (types.has('composition')) {
    for (const file of manifest.tiers?.composition?.files ?? []) {
      const src = join(dir, file.rel)
      if (!existsSync(src)) { warnings.push('snapshot file missing: ' + file.rel); continue }
      const dest = compositionDest(home, profileDir, file.rel)
      const buf = readFileSync(src)
      atomicWriteFile(dest, buf, dest === settingsPath(home) ? 0o600 : undefined)
      restored.push(file.rel)
    }
    for (const absent of manifest.tiers?.composition?.absent ?? []) {
      const dest = compositionDest(home, profileDir, absent)
      if (existsSync(dest)) warnings.push('file was absent in snapshot, left in place: ' + absent)
    }
    if (manifest.settings?.present === true && manifest.settings?.verbatim !== true) {
      warnings.push('settings.yaml snapshot is redacted (no --include-settings); current settings kept — secrets are never restored from redacted copies')
    }
    if (manifest.credentials?.present === true) {
      warnings.push('.credentials.yaml is never stored in snapshots; current credentials kept')
    }
  }

  if (types.has('usercode')) {
    const agentsHome = process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents')
    const roots = [
      ['agent-presets', userPresetsDir(home)],
      ['skills-home', join(home, 'skills')],
      ['skills-agents', join(agentsHome, 'skills')]
    ]
    for (const [rel, destRoot] of roots) {
      const src = join(dir, '..', '..', 'usercode', id, rel)
      if (!existsSync(src)) continue
      const result = copyTree(src, destRoot, { excludeDirNames: [] })
      for (const f of result.files) if (f.skipped === undefined) restored.push('usercode:' + rel + '/' + f.rel)
    }
    warnings.push('usercode restore is an overlay: files created after the snapshot are kept')
  }

  if (types.has('data')) {
    const src = join(dir, '..', '..', 'data', id, 'sessions')
    if (existsSync(src)) {
      const result = copyTree(src, sessionsDir(home), { excludeDirNames: [], maxFileBytes: 256 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024 })
      for (const f of result.files) if (f.skipped === undefined) restored.push('data:' + f.rel)
    } else warnings.push('snapshot has no data tier (taken without --data)')
  }

  if (opts.install === true) {
    const result = reinstall(profileDir, opts)
    if (result.ok) restored.push('pnpm install --frozen-lockfile')
    else warnings.push(result.error)
  }

  // verification gate: structural scan + official dump-config
  const verify = verifyRollback(home, profile, opts.install)
  if (!verify.ok) warnings.push('verification failed: ' + verify.error)

  const entry = { ok: true, id, restored, warnings, verify }
  const st = readState(home)
  st.lastRollback = { id, at: new Date().toISOString(), restored: restored.length }
  writeState(home, st)
  return entry
}

function resolveTarget(home, target, state) {
  if (target === 'latest' || target === 'good') {
    const all = listSnapshots(home)
    const id = target === 'latest' ? all[0]?.id : (state.lastGood ?? all[0]?.id)
    if (id === undefined) return { ok: false, error: 'no snapshots found — run dsh-recovery snapshot first' }
    const m = snapshotManifest(home, id)
    if (!m.ok) return { ok: false, error: 'snapshot ' + id + ' manifest unreadable: ' + m.error }
    return { ok: true, id, dir: join(home, recoveryDirHome(home), 'snapshots', 'composition', id), manifest: m.value }
  }
  const m = snapshotManifest(home, target)
  if (!m.ok) return { ok: false, error: 'snapshot ' + target + ' not found: ' + m.error }
  return { ok: true, id: target, dir: join(home, recoveryDirHome(home), 'snapshots', 'composition', target), manifest: m.value }
}
const recoveryDirHome = (home) => 'recovery'

function parseTypes(value) {
  const set = new Set()
  for (const part of String(value ?? 'composition,usercode').split(',')) {
    const t = part.trim()
    if (t === 'all') { set.add('composition'); set.add('usercode'); set.add('data') }
    else if (t === 'composition' || t === 'usercode' || t === 'data') set.add(t)
  }
  return set
}

function compositionDest(home, profileDir, rel) {
  if (rel.startsWith('profile/')) return join(profileDir, rel.slice('profile/'.length))
  if (rel === 'home/cordis.patch.yml') return homePatchPath(home)
  if (rel.startsWith('storages/')) return join(storagesDir(home), rel.slice('storages/'.length))
  if (rel === 'settings/settings.yaml') return settingsPath(home)
  if (rel.startsWith('presets/')) return join(userPresetsDir(home), rel.slice('presets/'.length))
  return join(home, rel)
}

function reinstall(profileDir, opts) {
  const cmd = opts.pnpm ?? process.env.DSH_RECOVERY_PNPM ?? 'pnpm'
  const result = spawnSync(cmd, ['install', '--frozen-lockfile'], { cwd: profileDir, encoding: 'utf8', timeout: 10 * 60 * 1000 })
  if (result.error) return { ok: false, error: 'pnpm unavailable (' + String(result.error.message) + '); run install manually: pnpm install --frozen-lockfile in ' + profileDir }
  if (result.status !== 0) return { ok: false, error: 'pnpm install failed: ' + String(result.stderr ?? result.stdout ?? '').split('\n').slice(-6).join(' | ').slice(0, 600) }
  return { ok: true }
}

function verifyRollback(home, profile, install) {
  const scanned = scanHome(home, { profile, install, sessions: false })
  if (scanned.summary.errors > 0) return { ok: false, error: scanned.summary.errors + ' structural errors remain: ' + scanned.findings.filter((f) => f.severity === 'error').slice(0, 3).map((f) => f.code).join(', ') }
  if (install === null) return { ok: true, detail: 'structural scan passed; boot gate skipped (no dsh installation found — pass --dsh)' }
  const bin = dshBinOf(install)
  const result = spawnSync(process.execPath, [bin, '--profile', profile, '--dump-config'], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 60000 })
  if (result.status !== 0) return { ok: false, error: 'dsh --dump-config gate failed: ' + String(result.stderr ?? result.stdout ?? '').split('\n').slice(-4).join(' | ').slice(0, 600) }
  return { ok: true, detail: 'structural scan and dsh --dump-config gate passed' }
}
