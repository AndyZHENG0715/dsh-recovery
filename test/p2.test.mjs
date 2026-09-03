import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { makeHome, clean, installRecoveryPlugin, addRuntimeCrasher, armCrashFlag, disarmCrashFlag, touchCrasherConfig, bootWeb, waitHttp, freePort, HAS_DSH, mutate } from '../support/fixtures.mjs'
import { isInstallCommand, snapshotSync, reconcileBundles, quarantineBrokenPresets, addDisabledRow, listQuarantined } from '../packages/dsh-recovery-plugin/lib/index.js'

// ── unit tests (no boot) ───────────────────────────────────────────────────
test('P2 unit: install-command matcher', () => {
  assert.equal(isInstallCommand('dsh plugin --profile web add dshmarket'), true)
  assert.equal(isInstallCommand('dsh plugin remove foo'), true)
  assert.equal(isInstallCommand('dsh plugin --profile web update x'), true)
  assert.equal(isInstallCommand('dsh web --port 3080'), false)
  assert.equal(isInstallCommand('echo dsh plugin add'), true) // substring semantics are acceptable for a snapshot guard
})

test('P2 unit: guard snapshot is tiered, redacted, and reversible', () => {
  const home = makeHome()
  try {
    const result = snapshotSync(home, 'web', 'pre-install')
    assert.equal(result.ok, true, JSON.stringify(result))
    const snap = join(home, 'recovery', 'snapshots', 'composition', result.id)
    assert.ok(existsSync(join(snap, 'profile', 'package.json')))
    const redacted = JSON.parse(readFileSync(join(snap, 'settings.redacted.json'), 'utf8'))
    const blob = JSON.stringify(redacted)
    assert.ok(blob.includes('***') && !blob.includes('sk-test-secret-123'))
    assert.ok(existsSync(join(home, 'recovery', 'snapshots', 'usercode', result.id, 'agent-presets', 'fixture-preset', 'tool-echo.mjs')))
  } finally { clean(home) }
})

test('P2 unit: bundle reconcile appends a bundle-typed dependency to the layer', () => {
  const home = makeHome()
  try {
    mutate.fakeBundleUnreconciled(home)
    const result = reconcileBundles(home, 'web')
    assert.equal(result.ok, true)
    assert.deepEqual(result.added, ['fake-bundle'])
    const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
    assert.ok(manifest.dsh.profile.bundles.includes('fake-bundle'))
  } finally { clean(home) }
})

test('P2 unit: broken preset is quarantined and the default falls back to standard', () => {
  const home = makeHome()
  try {
    mutate.breakPresetComp(home)
    const quarantined = quarantineBrokenPresets(home)
    assert.equal(quarantined.length, 1)
    assert.equal(quarantined[0].id, 'fixture-preset')
    assert.ok(!existsSync(join(home, '.agent-presets', 'fixture-preset')))
    assert.ok(existsSync(join(home, 'recovery', 'quarantine', 'presets', 'fixture-preset', 'agent.cordis.yml')))
    const settings = readFileSync(join(home, 'settings.yaml'), 'utf8')
    assert.ok(/default:\s*standard/.test(settings))
  } finally { clean(home) }
})

test('P2 unit: plugin-local quarantine row helpers are marker-scoped', () => {
  const home = makeHome()
  try {
    const patch = join(home, 'profiles', 'web', 'cordis.patch.yml')
    const result = addDisabledRow(patch, 'broken-row', 'unit test')
    assert.equal(result.ok, true)
    assert.deepEqual(listQuarantined(patch).map((r) => r.id), ['broken-row'])
  } finally { clean(home) }
})

test('P2 client: module registers the settings section and render probe', async () => {
  const source = await readFile(join(process.cwd(), 'packages', 'dsh-recovery-plugin', 'lib', 'client.js'), 'utf8')
  let captured = null
  const scheduled = []
  const fetches = []
  const listeners = {}
  const fakeReact = {
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    createElement: (...args) => ({ __element: args })
  }
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (def) => { captured = def } },
      addEventListener: (name, cb) => { listeners[name] = cb }
    },
    require: (id) => (id === 'react' ? fakeReact : undefined),
    fetch: (...args) => { fetches.push(args); return Promise.resolve({ json: () => Promise.resolve({ ok: true, profile: 'web' }) }) },
    setTimeout: (cb) => { scheduled.push(cb); return 0 },
    setInterval: () => 0,
    clearInterval: () => {},
    JSON, String, Date, console
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.ok(captured, 'client module must register')
  assert.equal(captured.id, 'dsh-recovery-plugin')
  const plugin = captured.factory(sandbox.require)
  assert.deepEqual(Array.from(plugin.inject), ['slots'])
  let registered = null
  const ctx = { slots: { inject: (_name, cb) => { registered = cb() }, register: (options, component) => ({ options, component }) } }
  plugin.apply(ctx)
  assert.ok(registered)
  assert.equal(registered.options.name, 'settings.section')
  assert.equal(registered.options.id, 'dsh-recovery')
  assert.equal(typeof registered.component, 'function')
  assert.doesNotThrow(() => registered.component(null))
  assert.ok(listeners.error && listeners.unhandledrejection)
  assert.equal(scheduled.length, 1)
  scheduled[0]() // render-ok report fires on the deferred timer
  assert.ok(fetches.some(([path]) => path === '/api/dsh-recovery/report-render'))
})

// ── E2E (real dsh web, isolated home) ──────────────────────────────────────
async function bootWithPlugin(home, extraEnv = {}) {
  installRecoveryPlugin(home)
  const port = await freePort()
  const child = bootWeb(home, port, extraEnv)
  const ok = await waitHttp(port, 60000)
  return { child, port, ok }
}
const stop = (child) => new Promise((resolvePromise) => { child.kill('SIGTERM'); child.on('close', (code) => resolvePromise(code)) })

test('P2 E2E: watchdog boots — heartbeat, boot marker, status routes, client bundle served', async (t) => {
  if (!HAS_DSH) return t.skip('no dsh installation available')
  const home = makeHome()
  let child = null
  try {
    const booted = await bootWithPlugin(home)
    child = booted.child
    const { port, ok } = booted
    assert.equal(ok, true, 'web must boot with the watchdog bundle')
    // heartbeat
    const heartbeatPath = join(home, 'recovery', 'heartbeat.json')
    const deadline = Date.now() + 15000
    while (!existsSync(heartbeatPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300))
    assert.ok(existsSync(heartbeatPath), 'watchdog must write a heartbeat')
    const heartbeat = JSON.parse(readFileSync(heartbeatPath, 'utf8'))
    assert.ok(Date.now() - new Date(heartbeat.at).getTime() < 15000)
    // in-process boot marker (no launcher involved)
    assert.ok(existsSync(join(home, 'recovery', 'boot-state.json')))
    // status route
    const statusRes = await fetch('http://127.0.0.1:' + port + '/api/dsh-recovery/status')
    assert.equal(statusRes.status, 200)
    const status = await statusRes.json()
    assert.equal(status.ok, true)
    assert.equal(status.installSnapshotGuard, true)
    // render-report route
    const reportRes = await fetch('http://127.0.0.1:' + port + '/api/dsh-recovery/report-render', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'test render failure' })
    })
    assert.equal(reportRes.status, 200)
    const state = JSON.parse(readFileSync(join(home, 'recovery', 'state.json'), 'utf8'))
    assert.equal(state.clientRender.ok, false)
    // client bundle is served and part of the page graph
    const clientRes = await fetch('http://127.0.0.1:' + port + '/plugins/dsh-recovery-plugin/client.js')
    assert.equal(clientRes.status, 200)
    assert.ok((await clientRes.text()).includes('dsh-recovery-plugin'))
    const index = await (await fetch('http://127.0.0.1:' + port + '/')).text()
    assert.ok(index.includes('dsh-recovery-plugin'), 'boot graph must carry the client entry')
    // clean shutdown tears down marker + heartbeat
    const code = await stop(child)
    child = null
    assert.equal(code, 0)
    assert.ok(!existsSync(join(home, 'recovery', 'boot-state.json')), 'in-process marker cleared on dispose')
    assert.ok(!existsSync(heartbeatPath), 'heartbeat cleared on dispose')
  } finally { if (child) { try { child.kill('SIGKILL') } catch {} }; clean(home) }
})

test('P2 E2E: runtime fiber failure → auto-quarantine via HMR, process stays up', async (t) => {
  if (!HAS_DSH) return t.skip('no dsh installation available')
  const home = makeHome()
  let child = null
  try {
    addRuntimeCrasher(home)
    armCrashFlag(home)
    const booted = await bootWithPlugin(home, { CRASH_FLAG: join(home, 'crash-flag') })
    child = booted.child
    const { port, ok } = booted
    assert.equal(ok, true, 'web must boot with crasher armed')
    const patchPath = join(home, 'profiles', 'web', 'cordis.patch.yml')
    // break the crasher; its own 5s self-restart reload throws → fiber FAILED
    disarmCrashFlag(home)
    const deadline = Date.now() + 30000
    let quarantined = false
    while (Date.now() < deadline && !quarantined) {
      await new Promise((r) => setTimeout(r, 500))
      try {
        const patch = readFileSync(patchPath, 'utf8')
        quarantined = patch.includes('quarantined by dsh-recovery') && patch.includes('crasher')
      } catch {}
    }
    assert.equal(quarantined, true, 'watchdog must quarantine the failed fiber row')
    assert.equal(await waitHttp(port, 5000), true, 'process must stay up without restart')
    const status = await (await fetch('http://127.0.0.1:' + port + '/api/dsh-recovery/status')).json()
    assert.ok((status.quarantined ?? []).some((q) => q.id === 'crasher'), JSON.stringify(status))
    const code = await stop(child)
    child = null
    assert.equal(code, 0)
  } finally { if (child) { try { child.kill('SIGKILL') } catch {} }; clean(home) }
})

test('P2 E2E: unreconciled dependency joins the layer at boot; broken preset quarantined with default fallback', async (t) => {
  if (!HAS_DSH) return t.skip('no dsh installation available')
  const home = makeHome()
  let child = null
  try {
    mutate.fakeBundleUnreconciled(home)   // dependency present, missing from bundles
    mutate.breakPresetComp(home)          // settings default points at fixture-preset
    const booted = await bootWithPlugin(home)
    child = booted.child
    const { port, ok } = booted
    assert.equal(ok, true)
    const deadline = Date.now() + 15000
    let manifest = null
    while (Date.now() < deadline && manifest === null) {
      await new Promise((r) => setTimeout(r, 300))
      try {
        const m = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
        if (m.dsh.profile.bundles.includes('fake-bundle')) manifest = m
      } catch {}
    }
    assert.ok(manifest, 'reconciler must append the bundle-typed dependency to the layer')
    assert.ok(!existsSync(join(home, '.agent-presets', 'fixture-preset')), 'broken preset must be quarantined')
    assert.ok(existsSync(join(home, 'recovery', 'quarantine', 'presets', 'fixture-preset')))
    const settings = readFileSync(join(home, 'settings.yaml'), 'utf8')
    assert.ok(/default:\s*standard/.test(settings), 'settings default must fall back to standard')
    const journal = readFileSync(join(home, 'recovery', 'journal.log'), 'utf8')
    assert.ok(journal.includes('intent-reconcile'))
    assert.ok(journal.includes('preset-quarantine'))
    await stop(child)
    child = null
  } finally { if (child) { try { child.kill('SIGKILL') } catch {} }; clean(home) }
})

// ── P2 runtime preset verification (standingKeyFor) ────────────────────────
import { addMountBrokenPreset, addRealmViolationPreset, writeWatchdogConfig } from '../support/fixtures.mjs'

test('P2 E2E: runtime standingKeyFor verification catches mount-level preset damage and quarantines', async (t) => {
  if (!HAS_DSH) return t.skip('no dsh installation available')
  const home = makeHome()
  let child = null
  try {
    addMountBrokenPreset(home)     // package resolution failure — static-clean
    addRealmViolationPreset(home)  // realm violation — static-clean
    const before = readFileSync(join(home, 'settings.yaml'), 'utf8')
    writeWatchdogConfig(home, { presetCheckMs: 200, presetVerifyCacheMs: 60000 })
    const booted = await bootWithPlugin(home)
    child = booted.child
    const { port } = booted
    assert.equal(booted.ok, true)

    const deadline = Date.now() + 30000
    let status = null
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300))
      try {
        status = await (await fetch('http://127.0.0.1:' + port + '/api/dsh-recovery/status')).json()
      } catch { continue }
      const cache = status.presetVerification?.cache ?? []
      const ghost = cache.find((v) => v.id === 'ghost-preset')
      const leaky = cache.find((v) => v.id === 'leaky-preset')
      if (ghost?.ok === false && ghost?.quarantined === true && leaky?.ok === false && leaky?.quarantined === true) break
    }
    assert.ok(status, 'status route must answer')
    const cache = status.presetVerification?.cache ?? []
    const ghost = cache.find((v) => v.id === 'ghost-preset')
    const leaky = cache.find((v) => v.id === 'leaky-preset')
    assert.ok(ghost?.ok === false && ghost?.quarantined === true, 'ghost-preset must be quarantined: ' + JSON.stringify(ghost))
    assert.ok(leaky?.ok === false && leaky?.quarantined === true, 'leaky-preset must be quarantined: ' + JSON.stringify(leaky))

    // both directories moved to the quarantine root
    assert.ok(!existsSync(join(home, '.agent-presets', 'ghost-preset')))
    assert.ok(!existsSync(join(home, '.agent-presets', 'leaky-preset')))
    assert.ok(existsSync(join(home, 'recovery', 'quarantine', 'presets', 'ghost-preset')))
    assert.ok(existsSync(join(home, 'recovery', 'quarantine', 'presets', 'leaky-preset')))
    // incidents + journal carry the mount-level reason
    const journal = readFileSync(join(home, 'recovery', 'journal.log'), 'utf8')
    assert.ok(journal.includes('preset-mount-quarantine'), journal.slice(-1000))
    assert.ok(journal.includes('ghost-preset') && journal.includes('leaky-preset'))
    // healthy user preset verified ok and left in place; default untouched
    const status2 = await (await fetch('http://127.0.0.1:' + port + '/api/dsh-recovery/status')).json()
    const healthy = (status2.presetVerification?.cache ?? []).find((v) => v.id === 'fixture-preset')
    assert.ok(healthy?.ok === true, 'fixture-preset must verify ok: ' + JSON.stringify(healthy))
    assert.ok(existsSync(join(home, '.agent-presets', 'fixture-preset')))
    assert.equal(readFileSync(join(home, 'settings.yaml'), 'utf8'), before, 'settings default must be untouched while the default preset is healthy')
    // roster shrinks once the broken presets are gone (next discovery refresh)
    const shrinkDeadline = Date.now() + 10000
    let shrunk = false
    while (Date.now() < shrinkDeadline) {
      await new Promise((r) => setTimeout(r, 300))
      try {
        const s = await (await fetch('http://127.0.0.1:' + port + '/api/dsh-recovery/status')).json()
        if ((s.presetVerification?.total ?? 99) <= 1) { shrunk = true; break }
      } catch {}
    }
    assert.ok(shrunk, 'roster must drop quarantined presets once discovery refreshes: ' + JSON.stringify(status2.presetVerification))
  } finally {
    if (child) { try { child.kill('SIGKILL') } catch {} }
    clean(home)
  }
})

test('P2 E2E: preset verification cache is stamp-keyed — edits re-verify, idle passes do not', async (t) => {
  if (!HAS_DSH) return t.skip('no dsh installation available')
  const home = makeHome()
  let child = null
  try {
    writeWatchdogConfig(home, { presetCheckMs: 200, presetVerifyCacheMs: 60000 })
    const booted = await bootWithPlugin(home)
    child = booted.child
    const { port } = booted
    assert.equal(booted.ok, true)

    // wait for the healthy preset to be verified at least once
    let entry = null
    const waitDeadline = Date.now() + 15000
    while (Date.now() < waitDeadline) {
      await new Promise((r) => setTimeout(r, 300))
      try {
        const status = await (await fetch('http://127.0.0.1:' + port + '/api/dsh-recovery/status')).json()
        entry = (status.presetVerification?.cache ?? []).find((v) => v.id === 'fixture-preset')
        if (entry?.ok === true) break
      } catch {}
    }
    assert.ok(entry && entry.ok === true, 'fixture-preset must be runtime-verified: ' + JSON.stringify(entry))
    const firstAt = entry.at

    // idle ticks within the cache TTL must NOT re-verify (single standing mount)
    await new Promise((r) => setTimeout(r, 1200))
    const idleStatus = await (await fetch('http://127.0.0.1:' + port + '/api/dsh-recovery/status')).json()
    const idleEntry = (idleStatus.presetVerification?.cache ?? []).find((v) => v.id === 'fixture-preset')
    assert.equal(idleEntry.at, firstAt, 'cached entry must be reused while the stamp is unchanged')

    // touching the composition changes the stamp → the next rotation re-verifies
    const comp = join(home, '.agent-presets', 'fixture-preset', 'agent.cordis.yml')
    const text = readFileSync(comp, 'utf8') + '# touched\n'
    writeFileSync(comp, text)
    const revertDeadline = Date.now() + 15000
    let editedEntry = null
    while (Date.now() < revertDeadline) {
      await new Promise((r) => setTimeout(r, 300))
      try {
        const status = await (await fetch('http://127.0.0.1:' + port + '/api/dsh-recovery/status')).json()
        editedEntry = (status.presetVerification?.cache ?? []).find((v) => v.id === 'fixture-preset')
        if (editedEntry && editedEntry.at !== firstAt) break
      } catch {}
    }
    assert.ok(editedEntry && editedEntry.at !== firstAt, 'stamp change must trigger a re-verify: ' + JSON.stringify(editedEntry))
    assert.equal(editedEntry.ok, true)
    assert.ok(existsSync(join(home, '.agent-presets', 'fixture-preset')), 'healthy preset must survive the edit')
  } finally {
    if (child) { try { child.kill('SIGKILL') } catch {} }
    clean(home)
  }
})
