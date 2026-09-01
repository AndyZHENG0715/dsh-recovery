import { existsSync, copyFileSync, mkdtempSync, rmSync, readdirSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import { resolveProfileDir, PROFILE_FILES, homePatchPath, settingsPath, credentialsPath, storagesDir } from './paths.mjs'
import { ensureDir, ensureSymlink, appendJournal } from './fsutil.mjs'
import { dshBinOf } from './resolve.mjs'
import { snapshot } from './snapshot.mjs'

const SIGNATURES = [
  [/duplicate loader entry id|already registered/i, 'duplicate-entry-id'],
  [/cannot resolve profile bundle/i, 'bundle-unresolvable'],
  [/declares no dsh\.bundle/i, 'bundle-no-manifest'],
  [/ERR_MODULE_NOT_FOUND|Cannot find (package|module)/i, 'module-missing'],
  [/YAML|Unexpected token|bad indentation|expected.*mapping/i, 'yaml-syntax'],
  [/seq gap|synthetic-closer|invalid persisted inbox/i, 'session-corrupt'],
  [/EADDRINUSE/i, 'port-in-use'],
  [/failed to apply loader entry include/i, 'patch-composition-failed']
]

export async function bootProbe(home, opts = {}) {
  const profile = opts.profile ?? 'web'
  const install = opts.install
  const live = opts.live === true
  const timeoutMs = Number(opts.timeoutMs ?? 60000)
  const findings = []
  if (install === null) return { ok: false, error: 'dsh installation not found — pass --dsh <dir> or set DSH_RECOVERY_DSH_DIR', findings }
  const profileDir = resolveProfileDir(home, profile)
  if (!existsSync(join(profileDir, 'package.json'))) return { ok: false, error: 'profile does not exist: ' + profileDir, findings }

  const stage = stageTempHome(home, profile)
  const env = { ...process.env, DSH_HOME: stage.tmp, NO_COLOR: '1', DSH_WEB_MODE: process.env.DSH_WEB_MODE ?? '' }
  const startedAt = Date.now()

  // Phase A: official static compose gate
  const dump = spawnSync(process.execPath, [dshBinOf(install), '--profile', profile, '--dump-config'], { env, encoding: 'utf8', timeout: timeoutMs })
  const staticFindings = classify(String(dump.stderr ?? '') + '\n' + String(dump.stdout ?? ''))
  for (const f of staticFindings) findings.push(f)
  const staticOk = dump.status === 0 && staticFindings.length === 0
  const result = {
    ok: staticOk && !live ? true : false,
    static: { ok: staticOk, exitCode: dump.status ?? null, ms: Date.now() - startedAt, findings: staticFindings, tail: String(dump.stderr ?? dump.stdout ?? '').split('\n').slice(-8).join('\n').slice(0, 1200) }
  }

  if (!staticOk || !live) {
    rmSync(stage.tmp, { recursive: true, force: true })
    result.ok = staticOk
    result.live = { ran: false, reason: staticOk ? 'live probe disabled (--live)' : 'skipped: static gate failed' }
    return result
  }

  // Phase B: real boot on a free port, HTTP 200 gate
  const liveResult = await runLiveProbe(stage.tmp, profile, install, timeoutMs)
  result.live = liveResult
  result.ok = liveResult.ok
  rmSync(stage.tmp, { recursive: true, force: true })

  if (result.ok && opts.markGood === true) {
    const snap = snapshot(home, { profile, reason: 'boot-probe-good', install, markGood: true })
    result.markedGood = snap.id
  }
  appendJournal(home, { op: 'boot-probe', profile, ok: result.ok, staticOk, liveOk: liveResult.ok })
  return result
}

function stageTempHome(home, profile) {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-recovery-probe-'))
  const profileDir = resolveProfileDir(home, profile)
  const dest = join(tmp, 'profiles', profile)
  ensureDir(dest)
  for (const name of PROFILE_FILES) {
    const src = join(profileDir, name)
    if (existsSync(src)) copyFileSync(src, join(dest, name))
  }
  if (existsSync(join(profileDir, 'node_modules'))) ensureSymlink(join(dest, 'node_modules'), join(profileDir, 'node_modules'))
  for (const [src, out] of [[homePatchPath(home), join(tmp, 'cordis.patch.yml')], [settingsPath(home), join(tmp, 'settings.yaml')], [credentialsPath(home), join(tmp, '.credentials.yaml')]]) {
    if (existsSync(src)) {
      copyFileSync(src, out)
      // dsh-credentials-local refuses credential files readable beyond the owner
      if (out.endsWith('.credentials.yaml')) chmodSync(out, 0o600)
    }
  }
  if (existsSync(storagesDir(home))) {
    ensureDir(join(tmp, 'storages'))
    for (const entry of readdirSync(storagesDir(home))) {
      if (entry.endsWith('.json')) copyFileSync(join(storagesDir(home), entry), join(tmp, 'storages', entry))
    }
  }
  // User presets are deliberately NOT staged: presets mount at session
  // creation, not at boot; the probe gates the boot-level composition.
  return { tmp, profileDir: dest }
}

function classify(output) {
  const out = []
  for (const [regex, code] of SIGNATURES) {
    if (regex.test(output)) out.push({ severity: 'error', code, message: 'boot output matched ' + regex.source })
  }
  return out
}

function runLiveProbe(tmpHome, profile, install, timeoutMs) {
  return new Promise((resolvePromise) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => {
        const child = spawn(process.execPath, [dshBinOf(install), '--profile', profile, '--port', String(port)], {
          env: { ...process.env, DSH_HOME: tmpHome, NO_COLOR: '1' },
          stdio: ['ignore', 'pipe', 'pipe']
        })
        let stderrTail = ''
        const collect = (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-4000) }
        child.stderr.on('data', collect)
        child.stdout.on('data', collect)
        const deadline = Date.now() + timeoutMs
        const startedAt = Date.now()
        let settled = false
        const finish = (value) => { if (!settled) { settled = true; clearInterval(timer); try { child.kill('SIGKILL') } catch {} resolvePromise(value) } }
        const timer = setInterval(() => {
          if (Date.now() > deadline) {
            finish({ ok: false, reason: 'timeout waiting for boot', port, tail: stderrTail, ms: Date.now() - startedAt })
            return
          }
          net.connect({ host: '127.0.0.1', port }, () => {
            clearInterval(timer)
            probeHttp(port, startedAt, stderrTail).then((res) => {
              try { child.kill('SIGTERM') } catch {}
              setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 3000).unref?.()
              finish({ ok: res.ok, reason: res.ok ? 'http-200' : 'http-' + res.status, port, httpStatus: res.status, bytes: res.bytes, error: res.error ?? undefined, tail: stderrTail, ms: Date.now() - startedAt })
            })
          }).on('error', () => {})
        }, 250)
        child.on('exit', (code) => {
          if (!settled) finish({ ok: false, reason: 'process exited before probe: code ' + code, port, tail: stderrTail, ms: Date.now() - startedAt })
        })
      })
    })
  })
}

async function probeHttp(port, startedAt, tailRef) {
  // The web app may still be finishing its own wiring when the port opens.
  // Three attempts with a short settle delay, then give up.
  let last = { ok: false, status: 0, bytes: 0, error: 'no attempt' }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1200))
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/', { signal: controller.signal, headers: { accept: 'text/html' } })
      const text = await res.text()
      last = { ok: res.status === 200 && text.length > 0, status: res.status, bytes: text.length }
      if (last.ok) return last
    } catch (error) {
      last = { ok: false, status: 0, bytes: 0, error: String(error?.message ?? error) }
    } finally { clearTimeout(timeout) }
  }
  return last
}
