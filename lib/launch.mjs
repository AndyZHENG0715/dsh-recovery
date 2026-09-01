import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveProfileDir, profilePatchPath, recoveryDir, homePatchPath } from './paths.mjs'
import { ensureDir, appendJournal } from './fsutil.mjs'
import { readState, writeState } from './state.mjs'
import { readConfig } from './config.mjs'
import { dshBinOf, dshVersionOf } from './resolve.mjs'
import { rollback } from './rollback.mjs'
import { listSnapshots } from './snapshot.mjs'
import { safemodeEnter, enforceSafemodeProfile } from './safemode.mjs'
import { addDisabledRow, listQuarantined } from './patch-edit.mjs'

export const bootStatePath = (home) => join(recoveryDir(home), 'boot-state.json')
export const incidentsDir = (home) => join(recoveryDir(home), 'incidents')

export const writeBootMarker = (home, marker) => {
  ensureDir(recoveryDir(home))
  writeFileSync(bootStatePath(home), JSON.stringify({ version: 1, ...marker }, null, 2) + '\n')
}
export const readBootMarker = (home) => {
  try { return JSON.parse(readFileSync(bootStatePath(home), 'utf8')) } catch { return null }
}
export const clearBootMarker = (home) => { try { rmSync(bootStatePath(home), { force: true }) } catch {} }

export const recordIncident = (home, kind, detail) => {
  ensureDir(incidentsDir(home))
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const path = join(incidentsDir(home), ts + '-' + kind + '.json')
  writeFileSync(path, JSON.stringify({ kind, at: new Date().toISOString(), ...detail }, null, 2) + '\n')
  appendJournal(home, { op: 'incident', kind, ...detail })
  return path
}

export const listIncidents = (home) => {
  const dir = incidentsDir(home)
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue
    try { out.push(JSON.parse(readFileSync(join(dir, entry), 'utf8'))) } catch {}
  }
  out.sort((a, b) => (a.at < b.at ? 1 : -1))
  return out
}

const isCorePackage = (pkg) => typeof pkg === 'string' && (pkg.startsWith('@deepseek-ai/') || pkg === 'cordis:include')

/** Attribute a boot failure to a loader entry + package from the captured output. */
export function attributeBootFailure(text) {
  const source = String(text ?? '')
  // Failure stacks nest: 'failed to apply loader entry include (cordis:include)'
  // wraps the real failing row deeper in the text. Take the innermost
  // non-builtin match; a lone core entry (e.g. credentials) stays core.
  const patterns = [/failed to apply loader entry\s+(\S+)\s+\(([^)]+)\)/g, /failed to (load|start) loader entry\s+(\S+)\s+\(([^)]+)\)/g]
  const matches = []
  for (let pi = 0; pi < patterns.length; pi++) {
    const re = patterns[pi]
    let match
    while ((match = re.exec(source)) !== null) {
      matches.push(pi === 0
        ? { entryId: match[1], pkg: match[2].trim() }
        : { entryId: match[2], pkg: match[3].trim() })
    }
  }
  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i].pkg !== 'cordis:include') return matches[i]
  }
  let match = /cannot resolve profile bundle\s+"([^"]+)"/.exec(source)
  if (match) return { bundle: match[1] }
  return null
}

function relayDsh(bin, args, extraEnv) {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    let stdoutTail = ''
    let stderrTail = ''
    let child
    try {
      child = spawn(process.execPath, [bin, ...args], { env: { ...process.env, ...extraEnv }, stdio: ['inherit', 'pipe', 'pipe'] })
    } catch (error) {
      resolvePromise({ code: null, signal: null, error: String(error?.message ?? error), elapsedMs: 0, stdoutTail, stderrTail })
      return
    }
    const tee = (chunk, stream) => {
      stream.write(chunk)
      if (stream === process.stdout) stdoutTail = (stdoutTail + chunk.toString()).slice(-16000)
      else stderrTail = (stderrTail + chunk.toString()).slice(-16000)
    }
    child.stdout.on('data', (c) => tee(c, process.stdout))
    child.stderr.on('data', (c) => tee(c, process.stderr))
    const forward = (signal) => () => { try { child.kill(signal) } catch {} }
    const onInt = forward('SIGINT')
    const onTerm = forward('SIGTERM')
    process.on('SIGINT', onInt)
    process.on('SIGTERM', onTerm)
    child.on('error', (error) => {
      process.removeListener('SIGINT', onInt)
      process.removeListener('SIGTERM', onTerm)
      resolvePromise({ code: null, signal: null, error: String(error?.message ?? error), elapsedMs: Date.now() - started, stdoutTail, stderrTail })
    })
    child.on('close', (code, signal) => {
      process.removeListener('SIGINT', onInt)
      process.removeListener('SIGTERM', onTerm)
      resolvePromise({ code, signal, elapsedMs: Date.now() - started, stdoutTail, stderrTail })
    })
  })
}

const cleanExit = (outcome) => outcome.code === 0 || outcome.signal === 'SIGINT' || outcome.signal === 'SIGTERM'

export async function runLaunch(home, opts = {}) {
  const profile = opts.profile ?? 'web'
  const install = opts.install ?? null
  const args = opts.args ?? []
  const cfg = readConfig(home, opts)
  if (install === null) return { ok: false, error: 'dsh installation not found — pass --dsh <dir> or set DSH_RECOVERY_DSH_DIR' }
  const bin = dshBinOf(install)
  if (!existsSync(bin)) return { ok: false, error: 'dsh bin not found at ' + bin }
  const state = readState(home)
  const actions = []
  // The launcher owns the profile: inject it into the child argv unless the
  // caller already passed it, and enforce the whitelist before booting safemode.
  const childArgs = args.some((a) => a === '--profile' || a.startsWith('--profile=')) ? [...args] : ['--profile', profile, ...args]
  if (profile === 'safemode') enforceSafemodeProfile(home)

  // Crash-marker handoff: a marker left by a previous run is crash evidence.
  const previous = readBootMarker(home)
  if (previous !== null) {
    state.previousCrash = { at: previous.startedAt ?? null, pid: previous.pid ?? null, argv: previous.argv ?? [], profile: previous.profile ?? null }
    writeState(home, state)
    recordIncident(home, 'crash-marker', { profile: previous.profile ?? null, startedAt: previous.startedAt ?? null, dshVersion: previous.dshVersion ?? null })
  }

  // Circuit breaker: enough recent failures → straight to safe mode.
  const windowStart = Date.now() - cfg.boot.failureWindowMs
  const recent = (state.bootFailures ?? []).filter((f) => f.at >= windowStart)
  if (cfg.boot.autoLadder && recent.length >= cfg.boot.failureThreshold) {
    const safe = safemodeEnter(home, { profile, install, skipSnapshotIfActive: true })
    actions.push({ step: 'safemode', why: 'circuit-breaker (' + recent.length + ' failures in window)' })
    appendJournal(home, { op: 'launch', profile, outcome: 'safemode', why: 'circuit-breaker', failures: recent.length })
    let spawned = null
    if (cfg.boot.autoSafeBoot) {
      enforceSafemodeProfile(home)
      const safeArgs = ['--profile', 'safemode', '--port', String(cfg.boot.safemodePort)]
      spawned = await relayDsh(bin, safeArgs, { DSH_HOME: home })
    }
    return { ok: false, mode: 'safemode', circuitBreaker: true, failures: recent.length, snapshot: safe.snapshot, next: safe.next, autoSafeBoot: spawned, actions }
  }

  let lastOutcome = null
  let attempts = 0
  for (let attempt = 0; attempt <= cfg.boot.maxLadderRetries; attempt++) {
    attempts = attempt + 1
    writeBootMarker(home, { pid: process.pid, profile, startedAt: new Date().toISOString(), argv: args, dshVersion: dshVersionOf(install), attempt })
    const outcome = await relayDsh(bin, childArgs, { DSH_HOME: home })
    lastOutcome = outcome

    if (cleanExit(outcome)) {
      clearBootMarker(home)
      const recovered = attempt > 0
      if (recovered) recordIncident(home, 'recovery-succeeded', { profile, attempt, actions })
      state.bootFailures = []
      writeState(home, state)
      appendJournal(home, { op: 'launch', profile, outcome: 'ok', attempts, recovered })
      return { ok: true, attempts, code: outcome.code ?? 0, signal: outcome.signal ?? null, recovered, actions }
    }

    const kind = outcome.elapsedMs < cfg.boot.readyMs ? 'boot-failure' : 'runtime-crash'
    const failure = { at: Date.now(), kind, profile, code: outcome.code ?? null, signal: outcome.signal ?? null, tail: outcome.stderrTail.slice(0, 2000) }
    state.bootFailures = [...(state.bootFailures ?? []), failure]
    writeState(home, state)
    recordIncident(home, kind, { profile, code: outcome.code ?? null, signal: outcome.signal ?? null, elapsedMs: outcome.elapsedMs, attempt, tail: outcome.stderrTail.slice(0, 4000) })

    if (kind === 'runtime-crash' || !cfg.boot.autoLadder) {
      const report = kind === 'runtime-crash'
        ? 'runtime failure after the ready window — automatic ladder not applied'
        : 'boot failure — automatic ladder disabled by --no-ladder'
      return { ok: false, kind, attempts, code: outcome.code ?? null, signal: outcome.signal ?? null, report, actions }
    }

    // L2: attribute → quarantine the third-party row, retry.
    const attribution = attributeBootFailure(outcome.stderrTail + '\n' + outcome.stdoutTail)
    if (attribution?.entryId !== undefined && attribution.pkg !== undefined && !isCorePackage(attribution.pkg)) {
      const quarantined = addDisabledRow(profilePatchPath(home, profile), attribution.entryId, attribution.pkg)
      if (quarantined.ok && !quarantined.already) {
        actions.push({ step: 'quarantine', entryId: attribution.entryId, pkg: attribution.pkg })
        recordIncident(home, 'quarantine', { profile, entryId: attribution.entryId, pkg: attribution.pkg })
        continue
      }
    }

    // L4: unattributed or core failure → roll back to the last good snapshot, retry.
    if (listSnapshots(home).length > 0) {
      const rolled = rollback(home, { profile, target: 'good', types: 'composition', install: false })
      actions.push({ step: 'rollback', ok: rolled.ok, id: rolled.id })
      recordIncident(home, 'rollback', { profile, ok: rolled.ok, id: rolled.id ?? null, warnings: rolled.warnings ?? [] })
      continue
    }

    // Nothing to roll back to → safe mode.
    const safe = safemodeEnter(home, { profile, install, skipSnapshotIfActive: true })
    actions.push({ step: 'safemode', why: 'boot failure, no recovery action left' })
    return { ok: false, mode: 'safemode', attempts, kind, actions, snapshot: safe.snapshot, next: safe.next }
  }

  // Retries exhausted → safe mode.
  const safe = safemodeEnter(home, { profile, install, skipSnapshotIfActive: true })
  actions.push({ step: 'safemode', why: 'ladder retries exhausted' })
  return { ok: false, mode: 'safemode', attempts, kind: 'boot-failure', actions, snapshot: safe.snapshot, next: safe.next, tail: lastOutcome?.stderrTail?.slice(-3000) ?? '' }
}
