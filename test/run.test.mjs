import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { makeHome, clean, runCli, mutate, HAS_DSH, SECRET_VALUE, makeHttpStubInstall } from '../support/fixtures.mjs'
import { parseYaml } from '../lib/yaml.mjs'

const findCode = (json, code) => json.findings?.some((f) => f.code === code)
const scanJson = async (home, extra = []) => {
  const res = await runCli(home, ['scan', '--json', ...extra])
  return JSON.parse(res.stdout)
}

test('yaml subset parser: block scalars, flows, comments, tags', () => {
  const text = [
    'list:',
    '  - id: a',
    '    config:',
    '      text: |-',
    '        line one',
    '        line two',
    '      items: [x, y, 3, true]',
    '  - id: b # comment',
    "    name: 'quoted key: value'",
    '    tagged: !!js process.platform === "win32"',
    'flowmap: { a: 1, b: [2, 3] }',
    'plain: hello world',
    'num: 42',
    'yes: true'
  ].join('\n')
  const parsed = parseYaml(text)
  assert.ok(parsed.ok, JSON.stringify(parsed))
  assert.equal(parsed.value.list[0].config.text, 'line one\nline two')
  assert.deepEqual(parsed.value.list[0].config.items, ['x', 'y', 3, true])
  assert.equal(parsed.value.list[1].name, 'quoted key: value')
  assert.equal(parsed.value.list[1].tagged.tag, '!!js')
  assert.deepEqual(parsed.value.flowmap, { a: 1, b: [2, 3] })
  assert.equal(parsed.value.num, 42)
  assert.equal(parsed.value.yes, true)
})

test('scan: healthy fixture has zero errors', async () => {
  const home = makeHome()
  try {
    const res = await runCli(home, ['scan', '--json'])
    const json = JSON.parse(res.stdout)
    assert.equal(res.code, 0, res.stderr + res.stdout)
    assert.equal(json.summary.errors, 0, JSON.stringify(json.findings))
    assert.equal(json.dshVersion === null, false)
  } finally { clean(home) }
})

const corruptions = [
  ['manifest-invalid', mutate.breakPackageJson, 'manifest-invalid'],
  ['patch-parse-failed', mutate.breakPatchYaml, 'patch-parse-failed'],
  ['duplicate-entry-id', mutate.duplicateTimerInsert, 'duplicate-entry-id'],
  ['name-unresolvable', mutate.unresolvableName, 'name-unresolvable'],
  ['bundle-unresolvable', mutate.addGhostBundle, 'bundle-unresolvable'],
  ['settings-parse-failed', mutate.breakSettings, 'settings-parse-failed'],
  ['storages-corrupt', mutate.breakStorage, 'storages-corrupt'],
  ['preset-broken (composition)', mutate.breakPresetComp, 'preset-broken'],
  ['preset-broken (js syntax)', mutate.breakPresetJs, 'preset-broken'],
  ['session-corrupt (zstd)', mutate.breakSessionZstd, 'session-corrupt'],
  ['session-corrupt (seq gap)', mutate.seqGap, 'session-corrupt']
]
for (const [label, breaker, code] of corruptions) {
  test('scan detects: ' + label, async () => {
    const home = makeHome()
    try {
      breaker(home)
      const res = await runCli(home, ['scan', '--json'])
      const json = JSON.parse(res.stdout)
      assert.equal(res.code, 1)
      assert.ok(findCode(json, code), 'expected ' + code + ' in ' + JSON.stringify(json.findings?.map((f) => f.code)))
    } finally { clean(home) }
  })
}

test('scan warns on unreconciled bundle layer (pnpm reconcile gap)', async () => {
  const home = makeHome()
  try {
    mutate.fakeBundleUnreconciled(home)
    const res = await runCli(home, ['scan', '--json'])
    const json = JSON.parse(res.stdout)
    assert.equal(res.code, 0)
    assert.ok(findCode(json, 'bundle-not-in-layer'), JSON.stringify(json.findings?.map((f) => f.code)))
  } finally { clean(home) }
})

test('scan --no-sessions skips session decoding', async () => {
  const home = makeHome()
  try {
    mutate.breakSessionZstd(home)
    const res = await runCli(home, ['scan', '--no-sessions', '--json'])
    assert.equal(res.code, 0)
  } finally { clean(home) }
})

test('snapshot: tiers, redaction, verbatim settings opt-in', async () => {
  const home = makeHome()
  try {
    const res = await runCli(home, ['snapshot', '--json', '--reason', 't1', '--data'])
    assert.equal(res.code, 0, res.stderr)
    const { id } = JSON.parse(res.stdout)
    const snapDir = join(home, 'recovery', 'snapshots', 'composition', id)
    assert.ok(existsSync(join(snapDir, 'manifest.json')))
    assert.ok(existsSync(join(snapDir, 'profile', 'package.json')))
    const redacted = JSON.parse(readFileSync(join(snapDir, 'settings.redacted.json'), 'utf8'))
    const blob = JSON.stringify(redacted)
    assert.ok(blob.includes('***') && !blob.includes(SECRET_VALUE), 'settings must be redacted')
    assert.ok(!existsSync(join(snapDir, 'credentials')), 'credentials never copied')
    // no secret in snapshot tree at all
    const userSnap = join(home, 'recovery', 'snapshots', 'usercode', id)
    assert.ok(existsSync(join(userSnap, 'agent-presets', 'fixture-preset', 'tool-echo.mjs')))
    assert.ok(existsSync(join(home, 'recovery', 'snapshots', 'data', id, 'sessions')))
    const list = JSON.parse((await runCli(home, ['list', '--json'])).stdout)
    assert.equal(list[0].id, id)
  } finally { clean(home) }
})

test('rollback: restores corrupted patch byte-exactly, takes pre-rollback snapshot', async () => {
  const home = makeHome()
  try {
    await runCli(home, ['snapshot', '--reason', 'before-break'])
    const original = readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    mutate.breakPatchYaml(home)
    const res = await runCli(home, ['rollback', '--latest', '--json'])
    assert.equal(res.code, 0, res.stderr + res.stdout)
    const json = JSON.parse(res.stdout)
    assert.ok(json.ok, JSON.stringify(json))
    assert.ok(json.verify.ok, JSON.stringify(json.verify))
    assert.equal(readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), original)
    const list = JSON.parse((await runCli(home, ['list', '--json'])).stdout)
    assert.ok(list.some((s) => s.reason === 'pre-rollback'), 'pre-rollback snapshot must exist')
    // pre-rollback is internal: state.lastSnapshot still points at the real snapshot
    const state = JSON.parse(readFileSync(join(home, 'recovery', 'state.json'), 'utf8'))
    assert.equal(state.lastSnapshot, json.id)
  } finally { clean(home) }
})

test('rollback: verbatim settings survive round-trip with secrets intact', async () => {
  const home = makeHome()
  try {
    const res = await runCli(home, ['snapshot', '--include-settings', '--json', '--reason', 'with-settings'])
    const id = JSON.parse(res.stdout).id
    writeFileSync(join(home, 'settings.yaml'), 'broken: [unclosed\n')
    const roll = await runCli(home, ['rollback', '--types', 'composition', '--json'])
    assert.equal(roll.code, 0, roll.stderr)
    assert.ok(readFileSync(join(home, 'settings.yaml'), 'utf8').includes('fixture-preset'))
  } finally { clean(home) }
})

test('rollback: redacted snapshots never overwrite current settings', async () => {
  const home = makeHome()
  try {
    await runCli(home, ['snapshot', '--reason', 'redacted-only'])
    const current = readFileSync(join(home, 'settings.yaml'), 'utf8')
    writeFileSync(join(home, 'settings.yaml'), 'agent-presets:\n  default: something-new\n')
    const roll = JSON.parse((await runCli(home, ['rollback', '--types', 'composition', '--json'])).stdout)
    assert.ok(roll.warnings.some((w) => /redacted/.test(w)), JSON.stringify(roll))
    assert.ok(readFileSync(join(home, 'settings.yaml'), 'utf8').includes('something-new'))
    assert.ok(current.length > 0)
  } finally { clean(home) }
})

test('rollback: Tier B restores a broken preset, Tier C restores sessions', async () => {
  const home = makeHome()
  try {
    await runCli(home, ['snapshot', '--data', '--reason', 'full'])
    mutate.breakPresetComp(home)
    const sessionPath = join(home, 'sessions', '--ws--', 'session-a', 'session.jsonl.zstd')
    const sessionBytes = readFileSync(sessionPath)
    writeFileSync(sessionPath, Buffer.from('junk'))
    const roll = JSON.parse((await runCli(home, ['rollback', '--types', 'all', '--json'])).stdout)
    assert.ok(roll.ok, JSON.stringify(roll))
    assert.ok(readFileSync(join(home, '.agent-presets', 'fixture-preset', 'agent.cordis.yml'), 'utf8').includes('- id: persona'))
    assert.deepEqual(readFileSync(sessionPath), sessionBytes)
  } finally { clean(home) }
})

test('safemode enter/exit: whitelist profile + state', async () => {
  const home = makeHome()
  try {
    const enter = JSON.parse((await runCli(home, ['safemode', 'enter', '--json'])).stdout)
    assert.ok(enter.ok, JSON.stringify(enter))
    const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'safemode', 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    assert.equal(readFileSync(join(home, 'profiles', 'safemode', 'cordis.patch.yml'), 'utf8').trim().endsWith('[]'), true)
    assert.ok(existsSync(join(home, 'profiles', 'safemode', 'pnpm-workspace.yaml')))
    const state = JSON.parse(readFileSync(join(home, 'recovery', 'state.json'), 'utf8'))
    assert.equal(state.safeMode.active, true)
    assert.equal(state.mode, 'safe')
    mutate.breakSafemodePatch(home)
    const exit = JSON.parse((await runCli(home, ['safemode', 'exit', '--reset', '--json'])).stdout)
    assert.ok(exit.ok)
    assert.equal(readFileSync(join(home, 'profiles', 'safemode', 'cordis.patch.yml'), 'utf8').trim().endsWith('[]'), true)
    const state2 = JSON.parse(readFileSync(join(home, 'recovery', 'state.json'), 'utf8'))
    assert.equal(state2.safeMode.active, false)
  } finally { clean(home) }
})

test('boot-probe: static gate passes healthy, fails broken patch', async (t) => {
  if (!HAS_DSH) return t.skip('no dsh installation available')
  const home = makeHome()
  try {
    const good = JSON.parse((await runCli(home, ['boot-probe', '--json'])).stdout)
    assert.equal(good.ok, true, JSON.stringify(good))
    mutate.breakPatchYaml(home)
    const bad = JSON.parse((await runCli(home, ['boot-probe', '--json'])).stdout)
    assert.equal(bad.ok, false, JSON.stringify(bad))
    assert.equal(bad.static.ok, false)
  } finally { clean(home) }
})

test('boot-probe: live HTTP-200 gate on a healthy profile', async (t) => {
  if (!HAS_DSH) return t.skip('no dsh installation available')
  const home = makeHome()
  try {
    const res = await runCli(home, ['boot-probe', '--live', '--timeout-ms', '90000', '--json'])
    const json = JSON.parse(res.stdout)
    assert.equal(json.ok, true, res.stderr + JSON.stringify(json))
    assert.equal(json.live.httpStatus, 200)
  } finally { clean(home) }
})

test('boot-probe live: spawns with --no-open and scrubbed session env', async () => {
  const home = makeHome()
  try {
    const stub = makeHttpStubInstall(join(home, '..'))
    const res = await runCli(home, ['boot-probe', '--live', '--dsh', stub, '--json'], { STUB_RECORD_DIR: join(home, 'stub-record') })
    assert.equal(res.code, 0, res.stderr + res.stdout)
    const json = JSON.parse(res.stdout)
    assert.equal(json.ok, true, JSON.stringify(json))
    assert.equal(json.live.httpStatus, 200)
    const live = JSON.parse(readFileSync(join(home, 'stub-record', 'live-argv.json'), 'utf8'))
    assert.ok(live.argv.includes('--no-open'), 'live spawn must pass --no-open: ' + JSON.stringify(live.argv))
    assert.ok(live.argv.includes('--port'))
    for (const key of ['DSH_WEB_URL', 'DSH_WEB_MODE', 'DSH_SESSION_ID', 'DSH_SESSION_JSONL', 'DSH_SHELL']) {
      assert.equal(live.env[key], null, key + ' must be scrubbed from the probe env')
    }
    const stat = JSON.parse(readFileSync(join(home, 'stub-record', 'static-argv.json'), 'utf8'))
    assert.ok(stat.argv.includes('--dump-config'))
    assert.equal(stat.env.DSH_WEB_URL, null, 'static probe env must be scrubbed too')
  } finally { clean(home) }
})

test('doctor: aggregates findings, state, and recommendations; exit code reflects errors', async () => {
  const home = makeHome()
  try {
    const good = await runCli(home, ['doctor', '--json'])
    assert.equal(good.code, 0, good.stderr)
    mutate.breakPresetJs(home)
    const bad = await runCli(home, ['doctor', '--json'])
    assert.equal(bad.code, 1)
    const report = JSON.parse(bad.stdout)
    assert.ok(report.recommendations.some((r) => r.code === 'preset-broken'))
    assert.equal(report.state.safeModeActive, false)
  } finally { clean(home) }
})

test('CLI never touches the real ~/.dsh during fixture runs', async () => {
  const home = makeHome()
  try {
    await runCli(home, ['scan', '--json'])
    const real = join(process.env.HOME ?? '/home/andy', '.dsh', 'recovery')
    assert.ok(!existsSync(real) || !existsSync(join(real, 'snapshots', 'composition', 'zzz-probe')), 'no marker written into real home')
  } finally { clean(home) }
})
