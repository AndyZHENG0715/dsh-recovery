import { existsSync, readdirSync, copyFileSync, readFileSync, statSync, renameSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { snapshotsRoot, recoveryDir, resolveProfileDir, PROFILE_FILES, userPresetsDir, settingsPath, credentialsPath, homePatchPath, storagesDir, sessionsDir } from './paths.mjs'
import { ensureDir, atomicWriteFile, sha256Hex, copyTree, appendJournal, writeJsonAtomic, readFileOrNull } from './fsutil.mjs'
import { readState, writeState } from './state.mjs'
import { parseYaml } from './yaml.mjs'
import { redact } from './redact.mjs'
import { dshVersionOf } from './resolve.mjs'

const rand = () => Math.random().toString(36).slice(2, 8)

export function snapshot(home, opts = {}) {
  const profile = opts.profile ?? 'web'
  const reason = opts.reason ?? 'manual'
  const withData = opts.data === true
  const includeSettings = opts.includeSettings === true
  const markGood = opts.markGood === true
  const internal = opts.internal === true // pre-rollback snapshots never become "latest"
  const id = Date.now() + '-' + rand()
  const compDir = join(snapshotsRoot(home), 'composition', id)
  const userDir = join(snapshotsRoot(home), 'usercode', id)
  const dataDir = join(snapshotsRoot(home), 'data', id)
  ensureDir(compDir)
  ensureDir(userDir)
  const profileDir = resolveProfileDir(home, profile)
  const manifest = {
    version: 1, id, time: new Date().toISOString(), reason, profile,
    dshVersion: opts.install ? dshVersionOf(opts.install) : null,
    tiers: { composition: { files: [], absent: [] }, usercode: { files: [], skipped: [] }, data: { files: [], skipped: [] } },
    settings: { present: false }, credentials: { present: false }, presets: []
  }

  // Tier A — profile 5 files
  for (const name of PROFILE_FILES) {
    const src = join(profileDir, name)
    if (!existsSync(src)) { manifest.tiers.composition.absent.push('profile/' + name); continue }
    const rel = 'profile/' + name
    copyAtomic(src, join(compDir, rel))
    manifest.tiers.composition.files.push(recordFile(rel, src))
  }
  // home patch layer (home tier)
  if (existsSync(homePatchPath(home))) {
    copyAtomic(homePatchPath(home), join(compDir, 'home', 'cordis.patch.yml'))
    manifest.tiers.composition.files.push(recordFile('home/cordis.patch.yml', homePatchPath(home)))
  } else manifest.tiers.composition.absent.push('home/cordis.patch.yml')

  // settings: redacted structure always; verbatim only with --include-settings
  const rawSettings = readFileOrNull(settingsPath(home))
  if (rawSettings !== null) {
    manifest.settings = { present: true, sha256: sha256Hex(Buffer.from(rawSettings, 'utf8')), verbatim: includeSettings }
    const parsed = parseYaml(rawSettings)
    manifest.settings.parseOk = parsed.ok
    if (parsed.ok) writeJsonAtomic(join(compDir, 'settings.redacted.json'), redact(parsed.value))
    else writeJsonAtomic(join(compDir, 'settings.parse-error.json'), { error: parsed.error?.message ?? 'unknown', line: parsed.error?.line ?? 0 })
    if (includeSettings) {
      atomicWriteFile(join(compDir, 'settings', 'settings.yaml'), rawSettings, 0o600)
      manifest.tiers.composition.files.push({ rel: 'settings/settings.yaml', sha256: manifest.settings.sha256, size: Buffer.byteLength(rawSettings) })
    }
  }

  // credentials: fingerprint only, never content
  if (existsSync(credentialsPath(home))) {
    const buf = readFileOrNull(credentialsPath(home))
    manifest.credentials = { present: true, sha256: sha256Hex(Buffer.from(buf ?? '', 'utf8')), parseOk: buf === null ? false : parseYaml(buf).ok }
  }

  // storages (small registry files)
  if (existsSync(storagesDir(home))) {
    for (const entry of readdirSync(storagesDir(home))) {
      if (!entry.endsWith('.json')) continue
      const src = join(storagesDir(home), entry)
      copyAtomic(src, join(compDir, 'storages', entry))
      manifest.tiers.composition.files.push(recordFile('storages/' + entry, src))
    }
  }

  // presets: composition + metadata content (Tier A) 
  if (existsSync(userPresetsDir(home))) {
    for (const entry of readdirSync(userPresetsDir(home))) {
      const dir = join(userPresetsDir(home), entry)
      let stat = null
      try { stat = statSync(dir) } catch { stat = null }
      if (stat === null || !stat.isDirectory()) continue
      const files = []
      for (const name of ['agent.cordis.yml', 'preset.yml']) {
        const src = join(dir, name)
        if (!existsSync(src)) continue
        const rel = 'presets/' + entry + '/' + name
        copyAtomic(src, join(compDir, rel))
        files.push({ name, sha256: sha256Hex(readFileSync(src)) })
      }
      manifest.presets.push({ id: entry, files })
    }
  }

  // Tier B — user code/assets (agent presets incl. tool js + skills)
  const b1 = copyTree(userPresetsDir(home), join(userDir, 'agent-presets'), { excludeDirNames: ['node_modules'] })
  manifest.tiers.usercode.files.push(...b1.files.map((f) => ({ ...f, rel: 'agent-presets/' + f.rel })))
  manifest.tiers.usercode.skipped.push(...b1.files.filter((f) => f.skipped).map((f) => f.rel))
  const skillsHome = join(home, 'skills')
  if (existsSync(skillsHome)) {
    const s = copyTree(skillsHome, join(userDir, 'skills-home'))
    manifest.tiers.usercode.files.push(...s.files.map((f) => ({ ...f, rel: 'skills-home/' + f.rel })))
  }
  const agentsHome = process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents')
  const skillsAgents = join(agentsHome, 'skills')
  if (existsSync(skillsAgents)) {
    const s = copyTree(skillsAgents, join(userDir, 'skills-agents'))
    manifest.tiers.usercode.files.push(...s.files.map((f) => ({ ...f, rel: 'skills-agents/' + f.rel })))
  }

  // Tier C — session data (optional)
  if (withData) {
    const c = copyTree(sessionsDir(home), join(dataDir, 'sessions'), { maxFileBytes: 256 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024 })
    manifest.tiers.data.files.push(...c.files.map((f) => ({ ...f, rel: 'sessions/' + f.rel })))
  }

  writeJsonAtomic(join(compDir, 'manifest.json'), manifest)
  if (!internal) {
    const state = readState(home)
    state.lastSnapshot = id
    if (markGood) state.lastGood = id
    writeState(home, state)
  }
  appendJournal(home, { op: 'snapshot', id, reason, profile, internal, tiers: { composition: manifest.tiers.composition.files.length, usercode: manifest.tiers.usercode.files.length, data: manifest.tiers.data.files.length } })
  return { id, dir: compDir, manifest }
}

export function listSnapshots(home) {
  const root = join(snapshotsRoot(home), 'composition')
  const out = []
  if (!existsSync(root)) return out
  for (const entry of readdirSync(root)) {
    const manifestPath = join(root, entry, 'manifest.json')
    let manifest = null
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { manifest = null }
    if (manifest === null) continue
    out.push({ id: entry, time: manifest.time, reason: manifest.reason, profile: manifest.profile, dshVersion: manifest.dshVersion, compositionFiles: manifest.tiers?.composition?.files?.length ?? 0, usercodeFiles: manifest.tiers?.usercode?.files?.length ?? 0, dataFiles: manifest.tiers?.data?.files?.length ?? 0, settingsVerbose: manifest.settings?.verbatim === true })
  }
  out.sort((a, b) => (a.time < b.time ? 1 : -1))
  return out
}

export function snapshotManifest(home, id) {
  const path = join(snapshotsRoot(home), 'composition', id, 'manifest.json')
  try { return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) } } catch (error) { return { ok: false, error: String(error?.message ?? error) } }
}

function copyAtomic(src, dest) {
  ensureDir(join(dest, '..'))
  const tmp = dest + '.tmp-' + process.pid + '-' + rand()
  copyFileSync(src, tmp)
  renameSync(tmp, dest)
}

function recordFile(rel, src) {
  const buf = readFileSync(src)
  return { rel, sha256: sha256Hex(buf), size: buf.length }
}
