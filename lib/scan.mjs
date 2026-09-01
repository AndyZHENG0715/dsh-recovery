import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveProfileDir, userPresetsDir, sessionsDir, storagesDir, settingsPath, credentialsPath, homePatchPath, profilePatchPath, SHIPPED_PRESET_IDS, SAFEMODE_BUNDLES } from './paths.mjs'
import { readJsonFile, readYamlFile } from './manifest.mjs'
import { loadPatchFile, bundleLayers, composeRows } from './patch.mjs'
import { resolveRowName, dshVersionOf, packageDirFromAnchor } from './resolve.mjs'
import zlib from 'node:zlib'

const zstd = typeof zlib.zstdDecompressSync === 'function' && typeof zlib.zstdCompressSync === 'function'
  ? { compress: zlib.zstdCompressSync, decompress: zlib.zstdDecompressSync }
  : null

export function scanHome(home, opts = {}) {
  const profile = opts.profile ?? 'web'
  const install = opts.install ?? null
  const findings = []
  const add = (severity, code, message, extra = {}) => findings.push({ severity, code, message, ...extra })
  const profileDir = resolveProfileDir(home, profile)

  // ── profile manifest + bundle layers + patch composition ────────────────
  if (!existsSync(join(profileDir, 'package.json'))) {
    add('error', 'profile-missing', 'profile ' + JSON.stringify(profile) + ' does not exist at ' + profileDir)
  } else {
    const manifest = readJsonFile(join(profileDir, 'package.json'))
    let deps = {}
    if (!manifest.ok) add('error', 'manifest-invalid', manifest.error, { path: join(profileDir, 'package.json') })
    else {
      deps = manifest.value?.dependencies ?? {}
      const bundles = manifest.value?.dsh?.profile?.bundles
      if (!Array.isArray(bundles)) add('error', 'bundles-missing', 'dsh.profile.bundles is not an array', { path: join(profileDir, 'package.json') })
    }
    const { layers, findings: bundleFindings, bundles } = bundleLayers(home, profileDir, install)
    findings.push(...bundleFindings)

    const profileLayer = loadPatchFile(profilePatchPath(home, profile))
    if (!profileLayer.ok) add('error', 'patch-parse-failed', profileLayer.error, { path: profilePatchPath(home, profile) })
    const homeLayer = loadPatchFile(homePatchPath(home))
    if (homeLayer.exists && !homeLayer.ok) add('error', 'patch-parse-failed', homeLayer.error, { path: homePatchPath(home) })

    const composed = composeRows([...layers, { id: 'profile-patch', rows: profileLayer.rows }, { id: 'home-patch', rows: homeLayer.rows }], join(profileDir, 'package.json'), install)
    findings.push(...composed.findings)

    // gate ①③: installed dependencies vs bundles layer + link targets
    for (const dep of Object.keys(deps)) {
      if (dep.startsWith('link:')) {
        const target = join(profileDir, dep.slice(5))
        if (!existsSync(target)) add('error', 'link-target-missing', 'link: dependency ' + dep + ' target does not exist: ' + target)
        continue
      }
      const dir = install === null ? undefined : resolveInstalled(install, profileDir, dep)
      if (dir === undefined) {
        add('error', 'dependency-not-installed', 'dependency ' + dep + ' does not resolve from the profile or the dsh installation')
        continue
      }
      const pm = readJsonFile(join(dir, 'package.json'))
      if (pm.ok && typeof pm.value?.dsh?.bundle?.patch === 'string' && !(bundles ?? []).includes(dep)) {
        add('warning', 'bundle-not-in-layer', 'dependency ' + dep + ' declares a dsh.bundle but is missing from dsh.profile.bundles — the plugin is installed but will not mount (reconcile gap)', { path: join(profileDir, 'package.json') })
      }
    }
    if (!existsSync(join(profileDir, 'node_modules'))) add('warning', 'node-modules-missing', 'profile node_modules does not exist yet', { path: profileDir })

    // intent reconciliation (gate ⑤)
    const intent = readJsonFile(join(home, 'recovery', 'plugins.intent.json'))
    if (intent.ok) {
      const wanted = intent.value?.profiles?.[profile]?.plugins ?? []
      const names = new Set([...(bundles ?? []), ...Object.keys(deps)])
      for (const entry of wanted) {
        const name = typeof entry === 'string' ? entry : entry?.name
        if (typeof name === 'string' && !names.has(name)) add('warning', 'intent-drift', 'plugins.intent.json expects ' + JSON.stringify(name) + ' in profile ' + JSON.stringify(profile) + ' but it is neither a bundle nor a dependency')
      }
    }
  }

  // ── home-level state files ───────────────────────────────────────────────
  const settings = readYamlFile(settingsPath(home))
  if (settings.ok) {
    const s = settings.value ?? {}
    const defaultPreset = s?.['agent-presets']?.default
    const permissionPreset = s?.permission?.defaultPreset
    if (typeof defaultPreset !== 'string') add('warning', 'settings-key-missing', 'settings.yaml has no agent-presets.default')
    // permission.defaultPreset names a permission preset (sandbox mode), not an agent preset
    if (typeof permissionPreset !== 'string') add('warning', 'settings-key-missing', 'settings.yaml has no permission.defaultPreset')
    if (typeof defaultPreset === 'string' && !SHIPPED_PRESET_IDS.includes(defaultPreset) && !existsSync(join(userPresetsDir(home), defaultPreset))) {
      add('warning', 'preset-default-missing', 'settings point at agent preset ' + JSON.stringify(defaultPreset) + ' but no user preset directory exists for it (not a shipped preset id)')
    }
  } else add('error', 'settings-parse-failed', settings.error, { path: settingsPath(home) })

  if (existsSync(credentialsPath(home))) {
    const cred = readYamlFile(credentialsPath(home))
    if (!cred.ok) add('error', 'credentials-corrupt', credentialsPath(home) + ': credential file cannot be parsed (contents not shown)')
  }

  if (existsSync(storagesDir(home))) {
    for (const entry of readdirSync(storagesDir(home))) {
      if (!entry.endsWith('.json')) continue
      const res = readJsonFile(join(storagesDir(home), entry))
      if (!res.ok) add('error', 'storages-corrupt', join(storagesDir(home), entry) + ': ' + res.error)
    }
  }

  // ── user agent presets ───────────────────────────────────────────────────
  if (existsSync(userPresetsDir(home))) {
    for (const entry of readdirSync(userPresetsDir(home))) {
      const presetDir = join(userPresetsDir(home), entry)
      if (!statSyncSafe(presetDir)?.isDirectory()) continue
      const id = basename(presetDir)
      const comp = readYamlFile(join(presetDir, 'agent.cordis.yml'))
      if (!comp.ok) { add('error', 'preset-broken', 'preset ' + JSON.stringify(id) + ': agent.cordis.yml unreadable — ' + comp.error, { path: join(presetDir, 'agent.cordis.yml') }); continue }
      const rows = Array.isArray(comp.value) ? comp.value : null
      if (rows === null) { add('error', 'preset-broken', 'preset ' + JSON.stringify(id) + ': agent.cordis.yml must be a top-level array', { path: join(presetDir, 'agent.cordis.yml') }); continue }
      for (const row of rows) {
        if (row?.disabled === true) continue
        const name = row?.name
        if (typeof name !== 'string') continue
        const resolved = resolveRowName(name, join(presetDir, 'agent.cordis.yml'), install)
        if (resolved === undefined) add('error', 'preset-broken', 'preset ' + JSON.stringify(id) + ': row name ' + JSON.stringify(name) + ' cannot be resolved', { path: join(presetDir, 'agent.cordis.yml') })
      }
      const jsFiles = []
      for (const entry2 of readdirSync(presetDir)) {
        if (/.(mjs|js|cjs)$/.test(entry2)) jsFiles.push(join(presetDir, entry2))
      }
      for (const file of jsFiles) {
        const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 15000 })
        if (checked.status !== 0) {
          const tail = String(checked.stderr ?? '').split('\n').slice(0, 6).join(' | ')
          add('error', 'preset-broken', 'preset ' + JSON.stringify(id) + ': ' + basename(file) + ' fails node --check: ' + tail.slice(0, 400))
        }
      }
      const meta = readYamlFile(join(presetDir, 'preset.yml'))
      if (!meta.ok) add('warning', 'preset-meta-broken', 'preset ' + JSON.stringify(id) + ': preset.yml unreadable — ' + meta.error)
    }
  }

  // ── sessions (F5-lite) ───────────────────────────────────────────────────
  if (opts.sessions !== false) scanSessions(home, add)

  // ── safemode profile drift ───────────────────────────────────────────────
  const safeDir = resolveProfileDir(home, 'safemode')
  if (existsSync(join(safeDir, 'package.json'))) {
    const sm = readJsonFile(join(safeDir, 'package.json'))
    if (sm.ok) {
      const bundles = sm.value?.dsh?.profile?.bundles
      if (JSON.stringify(bundles) !== JSON.stringify(SAFEMODE_BUNDLES)) add('warning', 'safemode-drift', 'profiles/safemode bundles drifted from the whitelist; run dsh-recovery safemode enter to restore')
    }
  }

  const errors = findings.filter((f) => f.severity === 'error').length
  const warnings = findings.filter((f) => f.severity === 'warning').length
  return {
    home,
    profile,
    dshVersion: install === null ? null : dshVersionOf(install),
    findings,
    summary: { errors, warnings, info: findings.filter((f) => f.severity === 'info').length, total: findings.length }
  }
}

const statSyncSafe = (path) => { try { return statSync(path) } catch { return null } }

function resolveInstalled(install, profileDir, name) {
  return packageDirFromAnchor(install.anchor, name) ?? packageDirFromAnchor(join(profileDir, 'package.json'), name)
}

function scanSessions(home, add) {
  const root = sessionsDir(home)
  if (!existsSync(root)) return
  const walk = (dir) => {
    let entries = []
    try { entries = readdirSync(dir) } catch { return }
    for (const entry of entries) {
      const path = join(dir, entry)
      const stat = statSyncSafe(path)
      if (stat === null) continue
      if (stat.isDirectory()) { walk(path); continue }
      if (!/^session\.jsonl(\.zstd)?$/.test(entry)) continue
      const sessionId = basename(dir)
      const mtimeAge = Date.now() - stat.mtimeMs
      if (mtimeAge < 10000) { add('info', 'session-live', 'session ' + sessionId + ' is being written (skipped)'); continue }
      let buf = null
      try { buf = readFileSync(path) } catch { buf = null }
      if (buf === null) { add('warning', 'session-unreadable', 'session ' + sessionId + ' cannot be read', { path }); continue }
      if (entry.endsWith('.zstd')) {
        if (zstd === null) { add('info', 'session-zstd-unsupported', 'session ' + sessionId + ': zstd support unavailable in this Node, decoding skipped'); continue }
        let decoded
        try { decoded = zstd.decompress(buf) } catch (error) {
          add('error', 'session-corrupt', 'session ' + sessionId + ': zstd decode failed — ' + String(error?.message ?? error).slice(0, 160), { path, detail: 'zstd-decode' })
          continue
        }
        checkRows(decoded.toString('utf8'), sessionId, path, add)
      } else checkRows(buf.toString('utf8'), sessionId, path, add)
    }
  }
  walk(root)
}

function checkRows(text, sessionId, path, add) {
  if (text.length > 64 * 1024 * 1024) { add('info', 'session-skipped-large', 'session ' + sessionId + ' too large for row scan'); return }
  const lines = text.split('\n')
  let previous = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '') continue
    let row
    try { row = JSON.parse(line) } catch {
      add('error', 'session-corrupt', 'session ' + sessionId + ': line ' + (i + 1) + ' is not valid JSON', { path, code: 'row-invalid' })
      return
    }
    if (typeof row?.seq === 'number') {
      if (previous !== null && row.seq !== previous + 1) {
        add('error', 'session-corrupt', 'session ' + sessionId + ': seq ' + row.seq + ' after ' + previous + ' (gap/overlap)', { path, detail: 'seq-gap' })
        return
      }
      previous = row.seq
    }
  }
}
