import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { makeHome, clean, runCli, makeStubInstall, addBreakRow, addBrokenPlugin, writeBootFailures, freePort, HAS_DSH, DSH_DIR } from '../support/fixtures.mjs'
import { parseYaml } from '../lib/yaml.mjs'

const stubEnv = (dir) => ({ DSH_RECOVERY_DSH_DIR: dir })

test('P1 launch: transparent relay, clean boot clears marker and resets failures', async () => {
  const home = makeHome()
  try {
    const stub = makeStubInstall(join(home, '..'))
    writeBootFailures(home, [{ at: Date.now(), kind: 'boot-failure' }])
    const res = await runCli(home, ['launch', '--profile', 'web', '--dsh', stub, '--', '--port', '3099', 'extra-arg'], { STUB_MODE: 'ok' })
    assert.equal(res.code, 0, res.stderr + res.stdout)
    const record = JSON.parse(readFileSync(join(home, 'stub-record', 'last.json'), 'utf8'))
    // the launcher owns the profile and injects it ahead of the passthrough args
    assert.deepEqual(record.argv, ['--profile', 'web', '--port', '3099', 'extra-arg'])
    assert.ok(!existsSync(join(home, 'recovery', 'boot-state.json')), 'marker must be cleared on clean exit')
    const state = JSON.parse(readFileSync(join(home, 'recovery', 'state.json'), 'utf8'))
    assert.equal(state.bootFailures.length, 0)
  } finally { clean(home) }
})

test('P1 launch: crash leaves boot marker + incident; next launch records crash evidence', async () => {
  const home = makeHome()
  try {
    const stub = makeStubInstall(join(home, '..'))
    const first = await runCli(home, ['launch', '--no-ladder', '--dsh', stub], { STUB_MODE: 'crash' })
    assert.equal(first.code, 1)
    assert.ok(existsSync(join(home, 'recovery', 'boot-state.json')), 'crash must leave the boot marker')
    assert.ok(existsSync(join(home, 'recovery', 'incidents')))
    const second = await runCli(home, ['launch', '--no-ladder', '--dsh', stub], { STUB_MODE: 'ok' })
    assert.equal(second.code, 0)
    const state = JSON.parse(readFileSync(join(home, 'recovery', 'state.json'), 'utf8'))
    assert.ok(state.previousCrash, 'previous crash marker must be recorded on the next start')
  } finally { clean(home) }
})

test('P1 ladder: attributed boot failure → quarantine row → retry succeeds → unquarantine undoes', async () => {
  const home = makeHome()
  try {
    const stub = makeStubInstall(join(home, '..'))
    addBreakRow(home)
    const res = await runCli(home, ['launch', '--dsh', stub, '--json'], { STUB_MODE: 'fail-attributed' })
    assert.equal(res.code, 0, res.stderr + res.stdout)
    const json = JSON.parse(res.stdout)
    assert.equal(json.recovered, true, JSON.stringify(json))
    assert.ok(json.actions.some((a) => a.step === 'quarantine' && a.entryId === 'break-row'), JSON.stringify(json.actions))
    const patch = readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    assert.ok(patch.includes('quarantined by dsh-recovery') && patch.includes('break-row'))
    assert.ok(parseYaml(patch).ok)
    // backups exist; scan sees the quarantined row
    const scan = JSON.parse((await runCli(home, ['scan', '--json'])).stdout)
    assert.ok(scan.findings.some((f) => f.code === 'quarantined-row'))
    // undo in one command
    const undo = await runCli(home, ['unquarantine', '--id', 'break-row', '--json'])
    assert.equal(undo.code, 0, undo.stderr)
    const after = readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    // unquarantine removes only OUR quarantine block; the original row stays
    assert.ok(!after.includes('quarantined by dsh-recovery'))
    assert.ok(after.includes('break-row'))
    assert.ok(parseYaml(after).ok)
  } finally { clean(home) }
})

test('P1 ladder: unattributed boot failure → rollback to last good → retry succeeds', async () => {
  const home = makeHome()
  try {
    const stub = makeStubInstall(join(home, '..'))
    await runCli(home, ['snapshot', '--reason', 'healthy', '--mark-good'])
    addBreakRow(home)
    const res = await runCli(home, ['launch', '--dsh', stub, '--json'], { STUB_MODE: 'fail-unattributed' })
    assert.equal(res.code, 0, res.stderr + res.stdout)
    const json = JSON.parse(res.stdout)
    assert.equal(json.recovered, true, JSON.stringify(json))
    assert.ok(json.actions.some((a) => a.step === 'rollback'), JSON.stringify(json.actions))
    const patch = readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    assert.ok(!patch.includes('break-row'), 'patch must be back to healthy')
  } finally { clean(home) }
})

test('P1 circuit breaker: threshold failures → automatic safemode entry', async () => {
  const home = makeHome()
  try {
    const stub = makeStubInstall(join(home, '..'))
    // a snapshot gives the ladder something to roll back to, so each launch
    // burns 2 attempts (retries=1) and records 2 failures
    await runCli(home, ['snapshot', '--reason', 'healthy'])
    const first = await runCli(home, ['launch', '--dsh', stub, '--retries', '1', '--no-auto-safe-boot', '--json'], { STUB_MODE: 'always-fail' })
    assert.equal(first.code, 1)
    const state1 = JSON.parse(readFileSync(join(home, 'recovery', 'state.json'), 'utf8'))
    assert.equal(state1.bootFailures.length, 2)
    // second launch ends with 4 recent failures (still below threshold at start)
    await runCli(home, ['launch', '--dsh', stub, '--retries', '1', '--no-auto-safe-boot', '--json'], { STUB_MODE: 'always-fail' })
    // third launch: recent failures >= threshold 3 → straight to safemode
    const third = await runCli(home, ['launch', '--dsh', stub, '--retries', '1', '--no-auto-safe-boot', '--json'], { STUB_MODE: 'always-fail' })
    assert.equal(third.code, 1)
    const json = JSON.parse(third.stdout)
    assert.equal(json.mode, 'safemode')
    assert.equal(json.circuitBreaker, true, JSON.stringify(json))
    const state2 = JSON.parse(readFileSync(join(home, 'recovery', 'state.json'), 'utf8'))
    assert.equal(state2.safeMode.active, true)
    assert.ok(existsSync(join(home, 'profiles', 'safemode', 'package.json')))
  } finally { clean(home) }
})

test('P1 circuit breaker: pre-seeded failures trip immediately without spawning dsh', async () => {
  const home = makeHome()
  try {
    const stub = makeStubInstall(join(home, '..'))
    const now = Date.now()
    writeBootFailures(home, [{ at: now, kind: 'boot-failure' }, { at: now, kind: 'boot-failure' }, { at: now, kind: 'boot-failure' }])
    const res = await runCli(home, ['launch', '--dsh', stub, '--no-auto-safe-boot', '--json'], { STUB_MODE: 'always-fail' })
    assert.equal(res.code, 1)
    const json = JSON.parse(res.stdout)
    assert.equal(json.mode, 'safemode')
    assert.equal(json.circuitBreaker, true)
  } finally { clean(home) }
})

test('P1 safemode guard: launch enforces the whitelist before booting safemode', async () => {
  const home = makeHome()
  try {
    const stub = makeStubInstall(join(home, '..'))
    await runCli(home, ['safemode', 'enter'])
    writeFileSync(join(home, 'profiles', 'safemode', 'cordis.patch.yml'), '- id: [unclosed\n')
    const res = await runCli(home, ['launch', '--profile', 'safemode', '--dsh', stub, '--no-ladder'], { STUB_MODE: 'check-safemode-patch' })
    assert.equal(res.code, 0, res.stderr + res.stdout)
  } finally { clean(home) }
})

test('P1 safemode guard: watcher restores drift while safe mode is active', async (t) => {
  const home = makeHome()
  try {
    await runCli(home, ['safemode', 'enter'])
    const child = spawn(process.execPath, [join(process.cwd(), 'bin', 'dsh-recovery.mjs'), 'guard', '--poll-ms', '200', '--watch-ms', '200'], {
      env: { ...process.env, DSH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    await wait(400)
    writeFileSync(join(home, 'profiles', 'safemode', 'cordis.patch.yml'), '- id: [unclosed\n')
    await wait(900)
    const patch = readFileSync(join(home, 'profiles', 'safemode', 'cordis.patch.yml'), 'utf8')
    child.kill('SIGTERM')
    assert.ok(patch.trim().endsWith('[]'), 'guard must restore the whitelist patch')
  } finally { clean(home) }
})

test('P1 E2E: real dsh, broken third-party bundle → auto-quarantine → web boots', async (t) => {
  if (!HAS_DSH) return t.skip('no dsh installation available')
  const home = makeHome()
  try {
    await runCli(home, ['snapshot', '--reason', 'healthy-baseline', '--mark-good'])
    addBrokenPlugin(home)
    const port = await freePort()
    const child = spawn(process.execPath, [join(process.cwd(), 'bin', 'dsh-recovery.mjs'), 'launch', '--profile', 'web', '--', '--port', String(port), '--no-open'], {
      env: { ...process.env, DSH_HOME: home, DSH_RECOVERY_DSH_DIR: DSH_DIR },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    child.stdout.on('data', (c) => { out += c.toString() })
    child.stderr.on('data', (c) => { out += c.toString() })
    // wait for HTTP 200 (ladder: fail -> quarantine -> retry boots)
    let httpOk = false
    const deadline = Date.now() + 90000
    while (Date.now() < deadline && !httpOk && child.exitCode === null) {
      try {
        const res = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(2000) })
        httpOk = res.status === 200
      } catch {}
      if (!httpOk) await new Promise((r) => setTimeout(r, 500))
    }
    assert.equal(httpOk, true, 'web must come up after auto-quarantine; output: ' + out.slice(-3000))
    child.kill('SIGTERM')
    const exitCode = await new Promise((resolvePromise) => child.on('close', (code) => resolvePromise(code)))
    assert.equal(exitCode, 0)
    const patch = readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    assert.ok(patch.includes('broken-apply') && patch.includes('quarantined by dsh-recovery'), 'broken row must be quarantined: ' + patch)
    assert.ok(!existsSync(join(home, 'recovery', 'boot-state.json')), 'marker cleared after clean stop')
  } finally { clean(home) }
})
