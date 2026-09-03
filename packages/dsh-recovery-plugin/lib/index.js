// dsh-recovery in-process watchdog (P2).
//
// Plane: this is a profile bundle row that CONSUMES host services (tools,
// loader, agentPresets, webServer) and provides nothing, so it needs no
// isolate realm. Every byte of state it owns lives in the recovery state
// layer under $DSH_HOME/recovery (design §4), never in the profile.
//
// Self-containment: only node: builtins are imported, so the bundle survives
// a dsh upgrade that moves the installation (the P0 CLI stays independent).
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, copyFileSync, statSync, rmSync, lstatSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { parseYaml } from './yaml-subset.mjs'

export const name = 'dsh-recovery-plugin'
export const inject = ['tools', 'loader', 'agentPresets']

const WATCHDOG_ID = 'dsh-recovery-watchdog'
const QUARANTINE_MARK = '# quarantined by dsh-recovery'
const SECRET_KEY = /(key|token|secret|password|credential|authorization|api[-_]?key)/i

const DEFAULT_CONFIG = {
  watchdog: {
    heartbeatMs: 5000,
    presetCheckMs: 30000,
    reconcileMs: 30000,
    quarantinePresets: true,
    reconcileBundles: true,
    installSnapshot: true,
    renderReport: true,
    fiberQuarantine: true,
    // Runtime preset verification (agentPresets.standingKeyFor) is rotated one
    // preset per tick; this is the per-preset cache TTL while its composition
    // stamp is unchanged. Costs one real standing mount per verify — never a
    // full compose of every preset each interval.
    presetVerifyCacheMs: 5 * 60 * 1000
  }
}

const nowIso = () => new Date().toISOString()
const rand = () => Math.random().toString(36).slice(2, 8)

function recoveryDir(home) { return join(home, 'recovery') }
function ensureDir(dir) { try { mkdirSync(dir, { recursive: true }) } catch {} }
function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
function writeJsonAtomic(path, value) {
  try {
    ensureDir(dirname(path))
    const tmp = path + '.tmp-' + process.pid + '-' + rand()
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
    renameSync(tmp, path)
    return true
  } catch { return false }
}
function appendJournal(home, entry) {
  try {
    ensureDir(recoveryDir(home))
    const line = JSON.stringify({ ts: nowIso(), ...entry }) + '\n'
    appendFileSync(join(recoveryDir(home), 'journal.log'), line)
  } catch {}
}
function recordIncident(home, kind, detail) {
  try {
    const dir = join(recoveryDir(home), 'incidents')
    ensureDir(dir)
    const path = join(dir, nowIso().replace(/[:.]/g, '-') + '-' + kind + '.json')
    writeFileSync(path, JSON.stringify({ kind, at: nowIso(), ...detail }, null, 2) + '\n')
    appendJournal(home, { op: 'incident', kind, ...detail })
  } catch {}
}
function readConfig(home) {
  const file = readJson(join(recoveryDir(home), 'config.json')) ?? {}
  return {
    watchdog: { ...DEFAULT_CONFIG.watchdog, ...(file?.watchdog ?? {}) }
  }
}
function readState(home) {
  const raw = readJson(join(recoveryDir(home), 'state.json'))
  return { mode: 'normal', safeMode: { active: false }, bootFailures: [], ...(raw ?? {}) }
}
function writeState(home, state) { writeJsonAtomic(join(recoveryDir(home), 'state.json'), state) }

function redact(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(redact)
  const out = {}
  for (const [key, val] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? '***' : redact(val)
  }
  return out
}

// ── patch row editing (marker-scoped, same semantics as the P0 CLI) ────────
function parseCheck(text, path) {
  const parsed = parseYaml(text)
  if (!parsed.ok) return { ok: false, error: path + ':' + (parsed.error.line || '?') + ': ' + parsed.error.message }
  if (parsed.value !== undefined && !Array.isArray(parsed.value)) return { ok: false, error: path + ': patch layer must be a top-level YAML array' }
  return { ok: true }
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function backupPatch(patchPath) {
  try {
    const backup = patchPath + '.dsh-recovery.bak.' + nowIso().replace(/[:.]/g, '-')
    if (existsSync(patchPath)) copyFileSync(patchPath, backup)
  } catch {}
}
export function addDisabledRow(patchPath, id, reason) {
  try {
    let text = null
    try { text = readFileSync(patchPath, 'utf8') } catch { text = null }
    const row = '- id: ' + id + '\n  disabled: true  ' + QUARANTINE_MARK + ' ' + nowIso() + ' — ' + String(reason ?? '').slice(0, 120) + '\n'
    let next
    if (text === null) next = row
    else {
      const placeholder = /^(\s*)\[\]\s*$/m.exec(text)
      if (placeholder) next = text.replace(placeholder[0], row.trimEnd())
      else {
        if (new RegExp('^\\s*- id:\\s*[\'"]?' + escapeRe(id) + '[\'"]?\\s*$', 'm').test(text)) return { ok: true, already: true }
        next = text.replace(/\s*$/, '\n') + '\n' + row
      }
    }
    const check = parseCheck(next, patchPath)
    if (!check.ok) return { ok: false, error: check.error }
    backupPatch(patchPath)
    writeFileSync(patchPath, next)
    return { ok: true, already: false }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}
export function listQuarantined(patchPath) {
  try {
    const text = readFileSync(patchPath, 'utf8')
    const lines = text.split('\n')
    const rowRe = /^(\s*)- id:\s*(['"]?)([A-Za-z0-9_.:-]+)\2\s*$/
    const boundaryRe = /^(\s*)- (id|insert):/
    const out = []
    for (let i = 0; i < lines.length; i++) {
      const match = rowRe.exec(lines[i])
      if (match === null) continue
      let j = i + 1
      while (j < lines.length && !boundaryRe.test(lines[j])) {
        if (lines[j].includes(QUARANTINE_MARK)) { out.push({ id: match[3], line: i + 1 }); break }
        j++
      }
    }
    return out
  } catch { return [] }
}

// ── sync Tier A(+B) snapshot for the pre-install guard ─────────────────────
const PROFILE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml']
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}
function copyAtomic(src, dest) {
  try {
    ensureDir(dirname(dest))
    const tmp = dest + '.tmp-' + process.pid + '-' + rand()
    copyFileSync(src, tmp)
    renameSync(tmp, dest)
    return true
  } catch { return false }
}
function syncCopyTree(src, dest, excludeDirNames, maxFileBytes) {
  const files = []
  try {
    if (!existsSync(src)) return files
    for (const entry of readdirSync(src)) {
      if (excludeDirNames.includes(entry)) continue
      const from = join(src, entry)
      let stat = null
      try { stat = lstatSync(from) } catch { stat = null }
      if (stat === null) continue
      if (stat.isDirectory()) files.push(...syncCopyTree(from, join(dest, entry), excludeDirNames, maxFileBytes))
      else if (stat.isFile() && stat.size <= maxFileBytes) {
        if (copyAtomic(from, join(dest, entry))) {
          const buf = readFileSync(join(dest, entry))
          files.push({ rel: entry, sha256: sha256(buf), size: buf.length })
        }
      }
    }
  } catch {}
  return files
}
export function snapshotSync(home, profile, reason) {
  try {
    const id = Date.now() + '-' + rand()
    const compDir = join(recoveryDir(home), 'snapshots', 'composition', id)
    const userDir = join(recoveryDir(home), 'snapshots', 'usercode', id)
    const profileDir = join(home, 'profiles', profile)
    const manifest = {
      version: 1, id, time: nowIso(), reason, profile, source: 'in-process-guard',
      tiers: { composition: { files: [], absent: [] }, usercode: { files: [], skipped: [] }, data: { files: [], skipped: [] } },
      settings: { present: false }, credentials: { present: false }, presets: []
    }
    for (const file of PROFILE_FILES) {
      const src = join(profileDir, file)
      if (!existsSync(src)) { manifest.tiers.composition.absent.push('profile/' + file); continue }
      if (copyAtomic(src, join(compDir, 'profile', file))) {
        const buf = readFileSync(src)
        manifest.tiers.composition.files.push({ rel: 'profile/' + file, sha256: sha256(buf), size: buf.length })
      }
    }
    const homePatch = join(home, 'cordis.patch.yml')
    if (existsSync(homePatch) && copyAtomic(homePatch, join(compDir, 'home', 'cordis.patch.yml'))) {
      const buf = readFileSync(homePatch)
      manifest.tiers.composition.files.push({ rel: 'home/cordis.patch.yml', sha256: sha256(buf), size: buf.length })
    }
    const settings = join(home, 'settings.yaml')
    if (existsSync(settings)) {
      const raw = readFileSync(settings, 'utf8')
      const parsed = parseYaml(raw)
      manifest.settings = { present: true, sha256: sha256(Buffer.from(raw)), verbatim: false, parseOk: parsed.ok }
      if (parsed.ok) writeJsonAtomic(join(compDir, 'settings.redacted.json'), redact(parsed.value))
    }
    const storages = join(home, 'storages')
    if (existsSync(storages)) {
      for (const entry of readdirSync(storages)) {
        if (!entry.endsWith('.json')) continue
        const src = join(storages, entry)
        if (copyAtomic(src, join(compDir, 'storages', entry))) {
          const buf = readFileSync(src)
          manifest.tiers.composition.files.push({ rel: 'storages/' + entry, sha256: sha256(buf), size: buf.length })
        }
      }
    }
    const presetsDir = join(home, '.agent-presets')
    if (existsSync(presetsDir)) {
      for (const entry of readdirSync(presetsDir)) {
        const dir = join(presetsDir, entry)
        let stat = null
        try { stat = statSync(dir) } catch { stat = null }
        if (stat === null || !stat.isDirectory()) continue
        const files = []
        for (const file of ['agent.cordis.yml', 'preset.yml']) {
          const src = join(dir, file)
          if (!existsSync(src)) continue
          if (copyAtomic(src, join(compDir, 'presets', entry, file))) {
            const buf = readFileSync(src)
            files.push({ name: file, sha256: sha256(buf) })
          }
        }
        manifest.presets.push({ id: entry, files })
      }
    }
    const tierB = syncCopyTree(presetsDir, join(userDir, 'agent-presets'), ['node_modules'], 8 * 1024 * 1024)
    manifest.tiers.usercode.files = tierB.map((f) => ({ ...f, rel: 'agent-presets/' + f.rel }))
    writeJsonAtomic(join(compDir, 'manifest.json'), manifest)
    const state = readState(home)
    state.lastSnapshot = id
    writeState(home, state)
    appendJournal(home, { op: 'snapshot', id, reason, source: 'in-process-guard' })
    return { ok: true, id }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

// ── bundle reconciliation (deps that declare dsh.bundle join the layer) ────
function packageDirFromProfile(profileDir, packageName) {
  try {
    const paths = createRequire(join(profileDir, 'package.json')).resolve.paths(packageName) ?? []
    for (const searchPath of paths) {
      const candidate = join(searchPath, packageName)
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
  } catch {}
  return null
}
export function reconcileBundles(home, profile) {
  const profileDir = join(home, 'profiles', profile)
  const manifestPath = join(profileDir, 'package.json')
  const manifest = readJson(manifestPath)
  if (manifest === null) return { ok: false, error: 'profile manifest unreadable' }
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const deps = manifest?.dependencies ?? {}
  const added = []
  for (const dep of Object.keys(deps)) {
    if (bundles.includes(dep)) continue
    const dir = packageDirFromProfile(profileDir, dep)
    if (dir === null) continue
    const pkg = readJson(join(dir, 'package.json'))
    if (typeof pkg?.dsh?.bundle?.patch === 'string') {
      bundles.push(dep)
      added.push(dep)
    }
  }
  if (added.length > 0) {
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
    const tmp = manifestPath + '.dsh-recovery.tmp-' + process.pid + '-' + rand()
    writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n')
    renameSync(tmp, manifestPath)
    for (const dep of added) {
      appendJournal(home, { op: 'intent-reconcile', profile, bundle: dep })
    }
    recordIncident(home, 'intent-reconcile', { profile, added })
  }
  // intent drift reporting (no auto-install, per design)
  const intent = readJson(join(recoveryDir(home), 'plugins.intent.json'))
  if (intent !== null) {
    const wanted = intent?.profiles?.[profile]?.plugins ?? []
    for (const entry of wanted) {
      const wantedName = typeof entry === 'string' ? entry : entry?.name
      if (typeof wantedName === 'string' && !Object.keys(deps).includes(wantedName) && !bundles.includes(wantedName)) {
        appendJournal(home, { op: 'intent-drift', profile, plugin: wantedName, hint: 'run: dsh plugin --profile ' + profile + ' add ' + wantedName })
      }
    }
  }
  return { ok: true, added }
}

// ── preset quarantine + default fallback ───────────────────────────────────
function checkPresetDir(dir) {
  const compPath = join(dir, 'agent.cordis.yml')
  if (!existsSync(compPath)) return { broken: true, reason: 'agent.cordis.yml missing' }
  const parsed = parseYaml(readFileSync(compPath, 'utf8'))
  if (!parsed.ok) return { broken: true, reason: 'agent.cordis.yml: ' + parsed.error?.message }
  if (parsed.value !== undefined && !Array.isArray(parsed.value)) return { broken: true, reason: 'agent.cordis.yml must be a top-level array' }
  for (const entry of readdirSync(dir)) {
    if (!/\.(mjs|js|cjs)$/.test(entry)) continue
    const checked = spawnSync(process.execPath, ['--check', join(dir, entry)], { encoding: 'utf8', timeout: 15000 })
    if (checked.status !== 0) return { broken: true, reason: entry + ' fails node --check' }
  }
  return { broken: false }
}
function setSettingsDefault(home, presetId, fallback) {
  const settingsPath = join(home, 'settings.yaml')
  try {
    const text = readFileSync(settingsPath, 'utf8')
    const lines = text.split('\n')
    let inBlock = -1
    let replaced = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/^agent-presets:\s*$/.test(line)) { inBlock = i; continue }
      if (inBlock !== -1) {
        if (line.trim() !== '' && !/^\s/.test(line) && !/^#/.test(line)) inBlock = -1
        else if (inBlock !== -1) {
          const match = /^(\s*)default:\s*['"]?([A-Za-z0-9_.:-]+)['"]?\s*$/.exec(line)
          if (match && match[2] === presetId) {
            lines[i] = match[1] + 'default: ' + fallback
            replaced = true
            break
          }
        }
      }
    }
    if (!replaced) return false
    const backup = settingsPath + '.dsh-recovery.bak.' + nowIso().replace(/[:.]/g, '-')
    copyFileSync(settingsPath, backup)
    const next = lines.join('\n')
    const check = parseYaml(next)
    if (!check.ok) return false
    writeFileSync(settingsPath, next)
    return true
  } catch { return false }
}
/** Move one user preset directory into recovery/quarantine/presets and, when
 * it is the configured agent-presets default, fall the default back to
 * standard (settings backed up first). Shared by the static check and the
 * runtime standing-mount verification. */
function quarantinePresetDir(home, entry, dir, reason) {
  try {
    const targetRoot = join(recoveryDir(home), 'quarantine', 'presets')
    ensureDir(targetRoot)
    let target = join(targetRoot, entry)
    if (existsSync(target)) target = join(targetRoot, entry + '-' + Date.now())
    renameSync(dir, target)
    recordIncident(home, 'preset-quarantined', { id: entry, reason, target })
    let fellBack = false
    try {
      const settings = parseYaml(readFileSync(join(home, 'settings.yaml'), 'utf8'))
      if (settings.ok && settings.value?.['agent-presets']?.default === entry) {
        fellBack = setSettingsDefault(home, entry, 'standard')
        appendJournal(home, { op: 'preset-default-fallback', id: entry, fallback: 'standard', applied: fellBack })
      }
    } catch {}
    return { id: entry, target, reason, fellBack }
  } catch (error) {
    recordIncident(home, 'preset-quarantine-failed', { id: entry, error: String(error?.message ?? error) })
    return null
  }
}

export function quarantineBrokenPresets(home) {
  const presetsDir = join(home, '.agent-presets')
  if (!existsSync(presetsDir)) return []
  const quarantined = []
  for (const entry of readdirSync(presetsDir)) {
    const dir = join(presetsDir, entry)
    let stat = null
    try { stat = lstatSync(dir) } catch { stat = null }
    if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) continue
    const check = checkPresetDir(dir)
    if (!check.broken) continue
    const result = quarantinePresetDir(home, entry, dir, check.reason)
    if (result !== null) quarantined.push(result)
  }
  return quarantined
}

// ── watchdog ───────────────────────────────────────────────────────────────
class Watchdog {
  constructor(ctx, home, profile) {
    this.ctx = ctx
    this.home = home
    this.profile = profile
    this.profileDir = join(home, 'profiles', profile)
    this.patchPath = join(this.profileDir, 'cordis.patch.yml')
    this.cfg = readConfig(home).watchdog
    this.failedOnce = new Set()
    this.bootMarkerPath = join(recoveryDir(home), 'boot-state.json')
    this.heartbeatPath = join(recoveryDir(home), 'heartbeat.json')
    this.markerOwned = !existsSync(this.bootMarkerPath)
    this.lastQuarantined = []
    this.lastReconcile = { added: [] }
    this.clientRender = null
    this.timers = []
    // runtime preset verification state (standingKeyFor, rotated one per tick)
    this.presetRoster = new Map()   // id -> { path, stamp }
    this.presetQueue = []           // ids pending (re)verification
    this.presetCache = new Map()    // id -> { ok, at, stamp, error, quarantined }
    this.presetVerifyBusy = false
  }
  journal(entry) { appendJournal(this.home, entry) }
  heartbeat() {
    try {
      writeJsonAtomic(this.heartbeatPath, { at: nowIso(), pid: process.pid, profile: this.profile, source: 'in-process' })
    } catch {}
  }
  interval(fn, ms) {
    const timer = setInterval(() => { try { fn() } catch {} }, ms)
    this.timers.push(timer)
    return timer
  }
  onFiberFailed(fiber) {
    if (this.cfg.fiberQuarantine !== true) return
    const entry = fiber?.entry?.options
    const id = entry?.id
    const pkgName = entry?.name
    if (typeof id !== 'string' || id === '') return
    if (id === WATCHDOG_ID) return
    if (typeof pkgName === 'string' && (pkgName.startsWith('@deepseek-ai/') || pkgName === 'dsh-recovery-plugin')) return
    if (this.failedOnce.has(id)) return
    this.failedOnce.add(id)
    let message = ''
    try {
      const awaited = fiber.await()
      if (awaited instanceof Promise) awaited.catch((error) => { message = String(error?.message ?? error).slice(0, 200) })
    } catch (error) {
      message = String(error?.message ?? error).slice(0, 200)
    }
    const result = addDisabledRow(this.patchPath, id, 'fiber FAILED: ' + message)
    this.lastQuarantined.push({ id, pkgName, at: nowIso(), ok: result.ok, error: result.error ?? null })
    recordIncident(this.home, 'fiber-quarantined', { profile: this.profile, id, pkgName: pkgName ?? null, message, ok: result.ok })
    this.journal({ op: 'fiber-quarantine', profile: this.profile, id, pkgName: pkgName ?? null, ok: result.ok })
    // Push the recomposition ourselves instead of waiting for the profile-patch
    // file watcher: append the id-targeted disable row to the root include's
    // patch list and update the include entry, unloading the failed row in
    // place (same entry.update call dsh's own patch watcher makes).
    try {
      // ctx.loader is caller-scoped; the ROOT context's loader owns the whole
      // tree, which is where the include entry lives.
      const loader = this.ctx.root?.get?.('loader')
      if (loader !== undefined) {
        const include = loader.resolve('include')
        const config = include.options?.config ?? {}
        const patches = Array.isArray(config.patches) ? config.patches : []
        include.update({ config: { ...config, patches: [...patches, { id, disabled: true }] } }).catch(() => {})
      }
    } catch {}
    this.heartbeat()
  }
  registerRoutes(webServer) {
    const loopback = (req) => {
      const addr = req.socket?.remoteAddress ?? ''
      return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
    }
    const json = (res, code, value) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    const status = () => {
      const state = readState(this.home)
      return {
        ok: true,
        profile: this.profile,
        mode: state.mode,
        safeModeActive: state.safeMode?.active === true,
        lastSnapshot: state.lastSnapshot ?? null,
        lastGood: state.lastGood ?? null,
        bootFailures: (state.bootFailures ?? []).length,
        quarantined: listQuarantined(this.patchPath),
        quarantineEvents: this.lastQuarantined.slice(-5),
        reconcile: this.lastReconcile,
        clientRender: this.clientRender,
        presetVerification: {
          total: this.presetRoster.size,
          queue: this.presetQueue.length,
          checked: this.presetCache.size,
          cache: [...this.presetCache.entries()].map(([id, v]) => ({
            id, ok: v.ok, at: v.at, quarantined: v.quarantined === true,
            error: v.ok ? undefined : String(v.error ?? '').slice(0, 200)
          })).slice(-20)
        },
        heartbeat: readJson(this.heartbeatPath),
        config: this.cfg,
        installSnapshotGuard: this.cfg.installSnapshot === true,
        at: nowIso()
      }
    }
    const disposers = []
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/dsh-recovery/status',
      handler: (req, res) => {
        if (!loopback(req)) return json(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        json(res, 200, status())
      }
    }))
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/dsh-recovery/report-render',
      handler: (req, res) => {
        if (!loopback(req)) return json(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        const chunks = []
        req.on('data', (chunk) => {
          if (chunks.length < 64) chunks.push(chunk)
        })
        req.on('end', () => {
          let payload = null
          try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { payload = null }
          if (payload === null || typeof payload !== 'object') return json(res, 400, { ok: false, error: 'expected a JSON object' })
          const ok = payload.ok === true
          this.clientRender = { ok, at: nowIso(), error: typeof payload.error === 'string' ? payload.error.slice(0, 400) : null }
          // design §4: single state layer — persist, don't keep it memory-only
          writeState(this.home, { ...readState(this.home), clientRender: this.clientRender })
          if (!ok) {
            recordIncident(this.home, 'client-render-failure', { error: this.clientRender.error, profile: this.profile })
          }
          json(res, 200, { ok: true, recorded: this.clientRender })
        })
      }
    }))
    return disposers
  }
  // preset.path from the roster is the COMPOSITION FILE (agent.cordis.yml);
  // the preset directory is its parent.
  stampOf(presetPath) {
    try {
      const comp = statSync(presetPath)
      const metaFile = join(dirname(presetPath), 'preset.yml')
      let meta = { mtimeMs: 0, size: 0 }
      try { meta = statSync(metaFile) } catch {}
      return [comp.mtimeMs, comp.size, meta.mtimeMs, meta.size].join(':')
    } catch { return null }
  }
  async refreshPresetRoster() {
    try {
      const presets = await this.ctx.agentPresets.list()
      const userRoot = join(this.home, '.agent-presets')
      for (const preset of presets) {
        const id = preset?.id
        const path = preset?.path
        if (typeof id !== 'string' || typeof path !== 'string') continue
        // only USER-trusted presets: standing-verifying shipped presets would
        // force-compose standard/code/minimal/cordis standing trees for nothing
        const underUserRoot = path.startsWith(userRoot)
        const isUserTrusted = preset?.trust === 'user'
        if (!underUserRoot && !isUserTrusted) continue
        if (!existsSync(path)) continue
        this.presetRoster.set(id, { path, dir: dirname(path), stamp: this.stampOf(path) })
      }
      for (const id of [...this.presetRoster.keys()]) {
        if (!presets.some((item) => item.id === id)) this.presetRoster.delete(id)
      }
      for (const id of this.presetRoster.keys()) {
        if (!this.presetQueue.includes(id)) this.presetQueue.push(id)
      }
    } catch {}
  }
  async verifyOnePreset() {
    if (this.presetVerifyBusy) return
    this.presetVerifyBusy = true
    try {
      this.presetQueue = this.presetQueue.filter((id) => this.presetRoster.has(id))
      if (this.presetQueue.length === 0) return
      const id = this.presetQueue.shift()
      const roster = this.presetRoster.get(id)
      if (roster === undefined) return
      const stamp = this.stampOf(roster.path)
      const cached = this.presetCache.get(id)
      if (cached !== undefined && cached.stamp === stamp && (Date.now() - new Date(cached.at).getTime() < this.cfg.presetVerifyCacheMs)) return
      if (cached !== undefined && cached.ok === false && cached.error === 'quarantined') return
      let key
      let error = null
      try {
        key = await this.ctx.agentPresets.standingKeyFor(id)
      } catch (mountError) {
        error = String(mountError?.message ?? mountError).slice(0, 400)
      }
      const ok = key !== undefined && key !== null && error === null
      const entry = { ok, at: nowIso(), stamp, error: error ?? null }
      if (ok) {
        this.presetCache.set(id, { ...entry, quarantined: false })
        if (cached !== undefined && cached.ok === false) {
          appendJournal(this.home, { op: 'preset-verified', id, recovered: true })
        }
        return
      }
      // mount-level failure (package resolution, realm violation, inject
      // missing, apply throw): quarantine the user preset + default fallback
      this.presetCache.set(id, { ...entry, quarantined: true })
      const dir = roster.dir
      if (dir !== undefined && existsSync(dir)) {
        const result = quarantinePresetDir(this.home, id, dir, 'mount-level: ' + error)
        if (result !== null) {
          appendJournal(this.home, { op: 'preset-mount-quarantine', id, error, target: result.target, fellBack: result.fellBack })
        }
      }
    } finally {
      this.presetVerifyBusy = false
    }
  }
  async tickPresetVerification() {
    await this.refreshPresetRoster()
    await this.verifyOnePreset()
  }
  start() {
    const ctx = this.ctx
    if (this.markerOwned) {
      writeJsonAtomic(this.bootMarkerPath, { version: 1, pid: process.pid, profile: this.profile, startedAt: nowIso(), source: 'in-process' })
    }
    this.heartbeat()
    this.interval(() => this.heartbeat(), this.cfg.heartbeatMs)
    // fiber failure → quarantine → HMR (no process restart)
    const offStatus = ctx.on('internal/status', (fiber, oldState) => {
      if (fiber?.state === 3 && oldState !== 3) this.onFiberFailed(fiber)
    }, { global: true })
    // pre-install snapshot guard: sync Tier A+B snapshot before dsh plugin mutations
    const offGuard = ctx.tools.guard((execution) => {
      if (this.cfg.installSnapshot !== true) return undefined
      try {
        const toolName = execution?.tool?.name ?? execution?.name ?? ''
        if (toolName !== 'bash' && toolName !== 'pwsh') return undefined
        const args = execution?.args ?? execution?.input ?? {}
        const command = String(args?.command ?? args?.cmd ?? '')
        if (/\bdsh plugin\b/.test(command) && /\b(add|remove|update)\b/.test(command)) {
          const result = snapshotSync(this.home, this.profile, 'pre-install')
          this.journal({ op: 'pre-install-snapshot', ok: result.ok, id: result.id ?? null, command: command.slice(0, 200) })
        }
      } catch {}
      return undefined
    })
    // intent / bundle-layer reconcile
    const reconcile = () => {
      const result = reconcileBundles(this.home, this.profile)
      this.lastReconcile = result
    }
    reconcile()
    this.interval(reconcile, this.cfg.reconcileMs)
    // preset watchdog: quarantine broken user presets, fall back the default
    const checkPresets = () => {
      if (this.cfg.quarantinePresets !== true) return
      const quarantined = quarantineBrokenPresets(this.home)
      if (quarantined.length > 0) this.journal({ op: 'preset-quarantine', quarantined: quarantined.map((q) => q.id) })
    }
    checkPresets()
    this.interval(checkPresets, this.cfg.presetCheckMs)
    // runtime preset verification: one standingKeyFor per tick, stamped and
    // cached (never a full recompose of every preset per interval)
    this.tickPresetVerification().catch(() => {})
    this.interval(() => { this.tickPresetVerification().catch(() => {}) }, this.cfg.presetCheckMs)
    // status + render-report routes (web profile only)
    try { ctx.inject(['webServer'], (wsCtx) => { this.routeDisposers = this.registerRoutes(wsCtx.webServer) }) } catch {}
    ctx.effect(() => () => {
      for (const timer of this.timers) clearInterval(timer)
      this.timers = []
      try { offStatus() } catch {}
      try { offGuard() } catch {}
      for (const dispose of this.routeDisposers ?? []) { try { dispose() } catch {} }
      if (this.markerOwned) { try { rmSync(this.bootMarkerPath, { force: true }) } catch {} }
      try { rmSync(this.heartbeatPath, { force: true }) } catch {}
    }, 'dsh-recovery-watchdog teardown')
  }
}

export function apply(ctx) {
  let home = process.env.DSH_HOME
  let profile = 'web'
  try {
    // ctx.baseUrl points AT the profile directory (trailing slash included);
    // strip it before dirname so basename/dirname math stays correct.
    if (typeof ctx.baseUrl === 'string' && ctx.baseUrl.startsWith('file:')) {
      const profileDir = fileURLToPath(ctx.baseUrl).replace(/[/\\]+$/, '')
      const derivedProfile = basename(profileDir)
      const derivedHome = dirname(dirname(profileDir))
      if (derivedProfile !== 'profiles' && existsSync(join(derivedHome, 'profiles', derivedProfile, 'package.json'))) {
        profile = derivedProfile
        home = derivedHome
      }
    }
  } catch {}
  const watchdog = new Watchdog(ctx, home, profile)
  watchdog.start()
}

// exported for tests / reuse
export function isInstallCommand(text) {
  return /\bdsh plugin\b/.test(String(text ?? '')) && /\b(add|remove|update)\b/.test(String(text ?? ''))
}
export { Watchdog }
