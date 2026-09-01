import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
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
  writeFileSync(join(home, '.credentials.yaml'), CREDENTIALS_GOOD)
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
