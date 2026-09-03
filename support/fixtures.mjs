import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync, statSync, utimesSync, chmodSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import net from 'node:net'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const BIN = join(ROOT, 'bin', 'dsh-recovery.mjs')
export const DSH_DIR = process.env.DSH_RECOVERY_DSH_DIR ?? '/home/andy/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh'
export const HAS_DSH = existsSync(join(DSH_DIR, 'package.json'))

const rand = () => Math.random().toString(36).slice(2, 8)

export const SETTINGS_GOOD = `agent-presets:
  default: fixture-preset
permission:
  defaultPreset: fixture-preset
llm-fixture:
  providers:
    opencode-go:
      apiKeyEnv: OPENCODE_GO_KEY
      baseURL: https://example.com/v1
`
export const SECRET_VALUE = 'sk-test-secret-123'

const CREDENTIALS_GOOD = `version: 1
refs:
  opencode_go: ${SECRET_VALUE}
`

const PATCH_TEMPLATE = '# Your patch layer for this dsh profile, applied after every bundle layer:\n[]\n'

export function makeHome(opts = {}) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-recovery-fixture-'))
  const home = join(base, 'home')
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  mkdirSync(join(home, 'storages'), { recursive: true })
  mkdirSync(join(home, 'sessions', '--ws--', 'session-a'), { recursive: true })
  mkdirSync(join(home, 'sessions', '--ws--', 'session-b'), { recursive: true })
  mkdirSync(join(home, '.agent-presets', 'fixture-preset'), { recursive: true })

  writeFileSync(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
  }, null, 2) + '\n')
  writeFileSync(join(home, 'profiles', 'web', 'cordis.yml'), '[]\n')
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), PATCH_TEMPLATE)
  writeFileSync(join(home, 'profiles', 'web', 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  writeFileSync(join(home, 'profiles', 'web', 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')

  writeFileSync(join(home, 'settings.yaml'), SETTINGS_GOOD)
  const credPath = join(home, '.credentials.yaml')
  writeFileSync(credPath, CREDENTIALS_GOOD)
  chmodSync(credPath, 0o600) // dsh-credentials-local refuses 644
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: [], archivedSessionIds: [] }, tables: {} }))

  writeFileSync(join(home, '.agent-presets', 'fixture-preset', 'preset.yml'), 'name: Fixture Preset\ndescription: test preset\n')
  writeFileSync(join(home, '.agent-presets', 'fixture-preset', 'agent.cordis.yml'), [
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    text: |-',
    '      You are a helpful software engineer assistant.',
    '- id: tool-echo',
    '  name: ./tool-echo.mjs'
  ].join('\n') + '\n')
  writeFileSync(join(home, '.agent-presets', 'fixture-preset', 'tool-echo.mjs'), 'export const name = "tool-echo"\nexport function apply(ctx) {}\n')

  const rows = [{ seq: 0, type: 'session/start' }, { seq: 1, type: 'agent/message' }, { seq: 2, type: 'session/end-seed' }].map((r) => JSON.stringify(r)).join('\n') + '\n'
  const sessionA = join(home, 'sessions', '--ws--', 'session-a', 'session.jsonl.zstd')
  const sessionB = join(home, 'sessions', '--ws--', 'session-b', 'session.jsonl')
  writeFileSync(sessionA, zlib.zstdCompressSync(Buffer.from(rows)))
  writeFileSync(sessionB, rows)
  // scan treats files written in the last 10s as "live" and skips them;
  // fixtures are historical sessions.
  const old = new Date(Date.now() - 120000)
  utimesSync(sessionA, old, old)
  utimesSync(sessionB, old, old)

  return home
}

export const clean = (home) => rmSync(join(home, '..'), { recursive: true, force: true })

export function runCli(home, args, extraEnv = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, DSH_HOME: home, DSH_RECOVERY_DSH_DIR: DSH_DIR, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', (c) => { stdout += c.toString() })
    child.stderr.on('data', (c) => { stderr += c.toString() })
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

export const mutate = {
  breakPackageJson(home) { writeFileSync(join(home, 'profiles', 'web', 'package.json'), '{ not json') },
  breakPatchYaml(home) { writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), '- id: [unclosed\n') },
  duplicateTimerInsert(home) { writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), "- insert:\n    - id: timer\n      name: '@deepseek-ai/cordis-plugin-timer'\n") },
  unresolvableName(home) { writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), "- insert:\n    - id: ghost\n      name: ./no-such-plugin.mjs\n") },
  addGhostBundle(home) {
    const p = join(home, 'profiles', 'web', 'package.json')
    const m = JSON.parse(readFileSync(p, 'utf8'))
    m.dsh.profile.bundles.push('@deepseek-ai/does-not-exist-xyz')
    writeFileSync(p, JSON.stringify(m, null, 2) + '\n')
  },
  breakSettings(home) { writeFileSync(join(home, 'settings.yaml'), 'agent-presets: [unclosed\n') },
  breakStorage(home) { writeFileSync(join(home, 'storages', 'workspace.json'), '{ not json') },
  breakPresetComp(home) { writeFileSync(join(home, '.agent-presets', 'fixture-preset', 'agent.cordis.yml'), '- id: [unclosed\n') },
  breakPresetJs(home) { writeFileSync(join(home, '.agent-presets', 'fixture-preset', 'tool-echo.mjs'), 'export const broken = (\n') },
  breakSessionZstd(home) {
    const p = join(home, 'sessions', '--ws--', 'session-a', 'session.jsonl.zstd')
    writeFileSync(p, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3, 4, 5, 6]))
    const old = new Date(Date.now() - 120000); utimesSync(p, old, old)
  },
  seqGap(home) {
    const p = join(home, 'sessions', '--ws--', 'session-b', 'session.jsonl')
    writeFileSync(p, '{"seq":0}\n{"seq":5}\n')
    const old = new Date(Date.now() - 120000); utimesSync(p, old, old)
  },
  fakeBundleUnreconciled(home) {
    const dir = join(home, 'profiles', 'web', 'node_modules', 'fake-bundle')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fake-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    writeFileSync(join(dir, 'cordis.patch.yml'), "- insert:\n    - id: fake-row\n      name: '@deepseek-ai/dsh-persona'\n")
    const p = join(home, 'profiles', 'web', 'package.json')
    const m = JSON.parse(readFileSync(p, 'utf8'))
    m.dependencies = { 'fake-bundle': '1.0.0' }
    writeFileSync(p, JSON.stringify(m, null, 2) + '\n')
  },
  breakSafemodePatch(home) {
    const dir = join(home, 'profiles', 'safemode')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: [unclosed\n')
  }
}

// ── P1 helpers ──────────────────────────────────────────────────────────────
const STUB_BIN = `import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
const home = process.env.DSH_HOME
const argv = process.argv.slice(2)
const mode = process.env.STUB_MODE ?? 'ok'
const read = (p) => { try { return readFileSync(join(home, p), 'utf8') } catch { return '' } }
mkdirSync(join(home, 'stub-record'), { recursive: true })
writeFileSync(join(home, 'stub-record', 'last.json'), JSON.stringify({ argv, mode, home, patch: read('profiles/web/cordis.patch.yml'), safemodePatch: read('profiles/safemode/cordis.patch.yml') }))
if (mode === 'ok') process.exit(0)
if (mode === 'fail-attributed') {
  const patch = read('profiles/web/cordis.patch.yml')
  if (patch.includes('break-row') && !patch.includes('quarantined by dsh-recovery')) {
    process.stderr.write('Error: failed to apply loader entry break-row (broken-plugin): boom\\n')
    process.exit(1)
  }
  process.exit(0)
}
if (mode === 'fail-unattributed') {
  const patch = read('profiles/web/cordis.patch.yml')
  if (patch.includes('break-row') && !patch.includes('quarantined by dsh-recovery')) {
    process.stderr.write('some opaque crash during composition\\n')
    process.exit(1)
  }
  process.exit(0)
}
if (mode === 'always-fail') { process.stderr.write('opaque boom\\n'); process.exit(1) }
if (mode === 'crash') process.kill(process.pid, 'SIGKILL')
if (mode === 'check-safemode-patch') process.exit(read('profiles/safemode/cordis.patch.yml').trim().endsWith('[]') ? 0 : 1)
process.exit(0)
`
export function makeStubInstall(base) {
  const dir = join(base, 'stub-dsh')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0-test' }))
  writeFileSync(join(dir, 'lib', 'bin.js'), STUB_BIN)
  return dir
}
export const addBreakRow = (home) => {
  const p = join(home, 'profiles', 'web', 'cordis.patch.yml')
  writeFileSync(p, "- insert:\\n    - id: break-row\\n      name: ./never-resolved.mjs\\n")
}
export const addBrokenPlugin = (home) => {
  const dir = join(home, 'profiles', 'web', 'node_modules', 'broken-plugin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'broken-plugin', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(dir, 'cordis.patch.yml'), "- insert:\n    - id: broken-apply\n      name: ./node_modules/broken-plugin/boom.mjs\n")
  writeFileSync(join(dir, 'boom.mjs'), "export const name = 'broken-plugin'\nexport function apply() { throw new Error('boom at apply') }\n")
  const p = join(home, 'profiles', 'web', 'package.json')
  const m = JSON.parse(readFileSync(p, 'utf8'))
  m.dependencies = { 'broken-plugin': '1.0.0' }
  m.dsh.profile.bundles = [...m.dsh.profile.bundles, 'broken-plugin']
  writeFileSync(p, JSON.stringify(m, null, 2) + '\n')
}
export const writeBootFailures = (home, entries) => {
  const p = join(home, 'recovery', 'state.json')
  let state = {}
  try { state = JSON.parse(readFileSync(p, 'utf8')) } catch { state = {} }
  state.bootFailures = entries
  mkdirSync(join(home, 'recovery'), { recursive: true })
  writeFileSync(p, JSON.stringify(state, null, 2) + '\n')
}
export const freePort = () => new Promise((resolvePromise) => {
  const server = net.createServer()
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolvePromise(port)) })
})

const HTTP_STUB_BIN = `import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'
const home = process.env.DSH_HOME
const argv = process.argv.slice(2)
const pickedEnv = () => {
  const out = {}
  for (const k of ['DSH_WEB_URL', 'DSH_WEB_MODE', 'DSH_SESSION_ID', 'DSH_SESSION_JSONL', 'DSH_SHELL']) out[k] = process.env[k] ?? null
  return out
}
// boot-probe stages a throwaway home; tests point the record dir at the fixture home
const recordDir = process.env.STUB_RECORD_DIR ?? join(home, 'stub-record')
mkdirSync(recordDir, { recursive: true })
if (argv.includes('--dump-config')) {
  writeFileSync(join(recordDir, 'static-argv.json'), JSON.stringify({ argv, env: pickedEnv() }))
  process.exit(0)
}
const portIndex = argv.indexOf('--port')
const port = portIndex >= 0 ? Number(argv[portIndex + 1]) : 0
writeFileSync(join(recordDir, 'live-argv.json'), JSON.stringify({ argv, env: pickedEnv() }))
const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>ok</html>') })
server.listen(port, '127.0.0.1')
const stop = () => server.close(() => process.exit(0))
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
`
export function makeHttpStubInstall(base) {
  const dir = join(base, 'http-stub-dsh')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0-test', type: 'module' }))
  writeFileSync(join(dir, 'lib', 'bin.js'), HTTP_STUB_BIN)
  return dir
}

// ── P2 helpers ──────────────────────────────────────────────────────────────
export const PLUGIN_DIR = fileURLToPath(new URL('../packages/dsh-recovery-watchdog/', import.meta.url))
export function installRecoveryPlugin(home) {
  const nm = join(home, 'profiles', 'web', 'node_modules')
  mkdirSync(nm, { recursive: true })
  const link = join(nm, 'dsh-recovery-watchdog')
  try { rmSync(link, { force: true, recursive: true }) } catch {}
  symlinkSync(PLUGIN_DIR, link, process.platform === 'win32' ? 'junction' : 'dir')
  const p = join(home, 'profiles', 'web', 'package.json')
  const m = JSON.parse(readFileSync(p, 'utf8'))
  m.dependencies = { ...(m.dependencies ?? {}), 'dsh-recovery-watchdog': 'link:dsh-recovery-watchdog' }
  m.dsh.profile.bundles = [...m.dsh.profile.bundles, 'dsh-recovery-watchdog']
  writeFileSync(p, JSON.stringify(m, null, 2) + '\n')
  return link
}
export function addRuntimeCrasher(home) {
  const dir = join(home, 'profiles', 'web', 'node_modules', 'runtime-crasher')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'runtime-crasher', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  // bundle patch rows resolve relative names against the PROFILE dir (the
  // loader's root baseUrl), so the fixture must use a profile-relative path.
  writeFileSync(join(dir, 'cordis.patch.yml'), "- insert:\n    - id: crasher\n      name: ./node_modules/runtime-crasher/index.mjs\n")
  // The crasher self-restarts through the loader API after a delay: if the
  // flag file is gone by then, the reload throws and the fiber transitions to
  // FAILED — the exact in-process runtime failure the watchdog quarantines.
  writeFileSync(join(dir, 'index.mjs'), "import { existsSync } from 'node:fs'\nexport const name = 'runtime-crasher'\nexport function apply(ctx) {\n  if (!existsSync(process.env.CRASH_FLAG ?? '')) throw new Error('crash: flag missing')\n  setTimeout(() => {\n    try { ctx.fiber.restart().catch(() => {}) } catch {}\n  }, Number(process.env.CRASH_RESTART_MS ?? 5000))\n}\n")
  const p = join(home, 'profiles', 'web', 'package.json')
  const m = JSON.parse(readFileSync(p, 'utf8'))
  m.dependencies = { ...(m.dependencies ?? {}), 'runtime-crasher': '1.0.0' }
  m.dsh.profile.bundles = [...m.dsh.profile.bundles, 'runtime-crasher']
  writeFileSync(p, JSON.stringify(m, null, 2) + '\n')
}
export const crashFlagPath = (home) => join(home, 'crash-flag')
export function armCrashFlag(home) { writeFileSync(crashFlagPath(home), 'armed\n') }
export function disarmCrashFlag(home) { try { rmSync(crashFlagPath(home), { force: true }) } catch {} }
export function touchCrasherConfig(home) {
  const p = join(home, 'profiles', 'web', 'cordis.patch.yml')
  let text = ''
  try { text = readFileSync(p, 'utf8') } catch {}
  writeFileSync(p, text + '\n- id: crasher\n  config:\n    nudge: 1\n')
}
export const bootWeb = (home, port, extraEnv = {}) => spawn(process.execPath, [join(DSH_DIR, 'lib', 'bin.js'), '--profile', 'web', '--port', String(port), '--no-open'], {
  env: { ...process.env, DSH_HOME: home, DSH_RECOVERY_DSH_DIR: DSH_DIR, ...extraEnv },
  stdio: ['ignore', 'pipe', 'pipe']
})
export const waitHttp = async (port, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(2000) })
      if (res.status === 200) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

// ── P2 runtime preset verification helpers ─────────────────────────────────
/** Mount-level broken preset: YAML and JS are fine, but the package name in a
 * row cannot resolve — static checks pass, standingKeyFor fails. */
export function addMountBrokenPreset(home) {
  const dir = join(home, '.agent-presets', 'ghost-preset')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'preset.yml'), 'name: Ghost Preset\ndescription: unresolvable package row\n')
  writeFileSync(join(dir, 'agent.cordis.yml'), "- id: ghost\n  name: '@deepseek-ai/definitely-not-installed-xyz'\n")
}
/** Realm-violating preset: row publishes a service into the root realm — the
 * mountPreset leakedServices check rejects it. Static checks cannot see it. */
export function addRealmViolationPreset(home) {
  const dir = join(home, '.agent-presets', 'leaky-preset')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'preset.yml'), 'name: Leaky Preset\ndescription: leaks a service into the root realm\n')
  writeFileSync(join(dir, 'agent.cordis.yml'), "- id: leaky\n  name: ./leaky.mjs\n")
  writeFileSync(join(dir, 'leaky.mjs'), "export const name = 'leaky'\nexport function apply(ctx) { ctx.provide('leakyService', {}) }\n")
}
export function writeWatchdogConfig(home, watchdogOverrides) {
  const dir = join(home, 'recovery')
  mkdirSync(dir, { recursive: true })
  const existing = (() => { try { return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) } catch { return {} } })()
  existing.watchdog = { ...(existing.watchdog ?? {}), ...watchdogOverrides }
  writeFileSync(join(dir, 'config.json'), JSON.stringify(existing, null, 2) + '\n')
}
