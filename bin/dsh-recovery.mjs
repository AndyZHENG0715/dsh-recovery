#!/usr/bin/env node
import { parseArgs } from '../lib/args.mjs'
import { resolveDshHome } from '../lib/paths.mjs'
import { findInstallAnchor } from '../lib/resolve.mjs'
import { scanHome } from '../lib/scan.mjs'
import { snapshot, listSnapshots } from '../lib/snapshot.mjs'
import { rollback } from '../lib/rollback.mjs'
import { safemodeEnter, safemodeExit } from '../lib/safemode.mjs'
import { bootProbe } from '../lib/bootprobe.mjs'
import { doctor } from '../lib/doctor.mjs'
import { readState } from '../lib/state.mjs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version

const HELP = `dsh-recovery ${VERSION} — DeepSeek Harness self-recovery CLI (P0, pure Node)

USAGE
  dsh-recovery <command> [options]

COMMANDS
  scan                 five-gate + F1/F5 diagnostics over one profile and the home tier
  snapshot             capture a tiered snapshot (composition + usercode; --data adds sessions)
  rollback             restore a snapshot (--latest default; --good = last known-good; --id <id>)
  safemode enter|exit  create/exit the whitelist safemode profile (guaranteed-to-boot console)
  boot-probe           static --dump-config gate + optional real boot with an HTTP-200 gate
  doctor               full diagnostic report with fix recommendations
  list                 list snapshots

COMMON OPTIONS
  --home <dir>         DSH_HOME to operate on (default: $DSH_HOME or ~/.dsh)
  --profile <name>     profile to scan/snapshot/rollback (default: web)
  --dsh <dir>          dsh installation dir (default: $DSH_RECOVERY_DSH_DIR, then the npx cache)
  --json               machine-readable JSON output

snapshot options: --reason <text> --data --include-settings --mark-good
rollback options: --id <id> | --latest | --good | --list | --types comp[,usercode,data] | --install | --pnpm <bin>
safemode options: --reset (repair whitelist files on exit)
boot-probe options: --live --port <n> --timeout-ms <n> --mark-good
doctor options:  --json

EXIT CODES
  0 ok (doctor/scan: no errors)   1 errors / probe failed   2 usage error
`

function fail(msg) { process.stderr.write('dsh-recovery: ' + msg + '\n'); process.exit(2) }

function common(argv, spec) {
  const { options, positionals } = parseArgs(argv, spec)
  const home = resolveDshHome(process.env, options.home)
  const profile = options.profile ?? 'web'
  const install = findInstallAnchor(process.env, options)
  return { options, positionals, home, profile, install }
}

function renderFindings(findings) {
  const icons = { error: 'ERROR', warning: 'WARN ', info: 'INFO ' }
  return findings.map((f) => `${icons[f.severity] ?? '     '} [${f.code}] ${f.message}`).join('\n')
}

const jsonOut = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n')

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') { process.stdout.write(HELP); return }
  if (argv[0] === 'version' || argv[0] === '--version' || argv[0] === '-V') { process.stdout.write(VERSION + '\n'); return }
  const command = argv[0]
  const rest = argv.slice(1)

  if (command === 'scan') {
    const { options, positionals, home, profile, install } = common(rest, { home: 'string', profile: 'string', dsh: 'string', json: 'boolean', sessions: 'boolean', 'no-sessions': 'boolean' })
    if (positionals.length > 0) fail('scan takes no positional arguments')
    const result = scanHome(home, { profile, install, sessions: options['no-sessions'] === true ? false : options.sessions })
    if (options.json) jsonOut(result)
    else {
      process.stdout.write(`dsh-recovery scan — home=${home} profile=${profile} dsh=${result.dshVersion ?? 'not-found'}\n`)
      if (result.findings.length === 0) process.stdout.write('OK — no findings\n')
      else process.stdout.write(renderFindings(result.findings) + '\n')
      process.stdout.write(`summary: ${result.summary.errors} errors, ${result.summary.warnings} warnings\n`)
    }
    process.exitCode = result.summary.errors > 0 ? 1 : 0
    return
  }

  if (command === 'snapshot') {
    const { options, positionals, home, profile, install } = common(rest, { home: 'string', profile: 'string', dsh: 'string', json: 'boolean', reason: 'string', data: 'boolean', 'include-settings': 'boolean', 'mark-good': 'boolean' })
    if (positionals.length > 0) fail('snapshot takes no positional arguments')
    process.stderr.write('dsh-recovery: operating on DSH_HOME=' + home + '\n')
    const result = snapshot(home, { profile, reason: options.reason, data: options.data, includeSettings: options['include-settings'], markGood: options['mark-good'], install })
    if (options.json) jsonOut(result)
    else {
      const m = result.manifest
      process.stdout.write(`snapshot ${result.id}\n`)
      process.stdout.write(`  composition files: ${m.tiers.composition.files.length} (settings ${m.settings.present ? (m.settings.verbatim ? 'verbatim' : 'redacted') : 'absent'})\n`)
      process.stdout.write(`  usercode files: ${m.tiers.usercode.files.length}   data files: ${m.tiers.data.files.length}\n`)
    }
    return
  }

  if (command === 'rollback') {
    const { options, positionals, home, profile, install } = common(rest, { home: 'string', profile: 'string', dsh: 'string', json: 'boolean', id: 'string', latest: 'boolean', good: 'boolean', list: 'boolean', types: 'string', install: 'boolean', pnpm: 'string', yes: 'boolean' })
    if (positionals.length > 0) fail('rollback takes no positional arguments')
    if (options.list === true) {
      const snaps = listSnapshots(home)
      if (options.json) jsonOut(snaps)
      else for (const s of snaps) process.stdout.write(`${s.id}  ${s.time}  ${s.reason}  comp=${s.compositionFiles} user=${s.usercodeFiles} data=${s.dataFiles}${s.settingsVerbose ? '  [verbatim settings]' : ''}\n`)
      return
    }
    const target = options.id ?? (options.good === true ? 'good' : options.latest === true ? 'latest' : 'latest')
    process.stderr.write('dsh-recovery: operating on DSH_HOME=' + home + '\n')
    const result = rollback(home, { profile, target, types: options.types, install: options.install, pnpm: options.pnpm, install })
    if (options.json) jsonOut(result)
    else {
      if (!result.ok) process.stderr.write('rollback failed: ' + result.error + '\n')
      else {
        process.stdout.write(`rollback ${result.id} — restored ${result.restored.length} file(s)\n`)
        for (const w of result.warnings) process.stdout.write('WARN ' + w + '\n')
        process.stdout.write('verify: ' + (result.verify.ok ? result.verify.detail : result.verify.error) + '\n')
      }
    }
    process.exitCode = result.ok ? 0 : 1
    return
  }

  if (command === 'safemode') {
    const { options, positionals, home, profile, install } = common(rest, { home: 'string', profile: 'string', dsh: 'string', json: 'boolean', reset: 'boolean', rollback: 'boolean' })
    const action = positionals[0]
    if (action !== 'enter' && action !== 'exit') fail('safemode needs enter|exit')
    process.stderr.write('dsh-recovery: operating on DSH_HOME=' + home + '\n')
    const result = action === 'enter' ? safemodeEnter(home, { profile, install }) : safemodeExit(home, { reset: options.reset, rollback: options.rollback, profile })
    if (options.json) jsonOut(result)
    else {
      if (!result.ok) process.stderr.write('safemode failed: ' + result.error + '\n')
      else {
        process.stdout.write(`safemode ${action} ok (snapshot ${result.snapshot})\n`)
        if (result.repaired?.length) process.stdout.write('repaired: ' + result.repaired.join(', ') + '\n')
        process.stdout.write('next: ' + result.next + '\n')
      }
    }
    process.exitCode = result.ok ? 0 : 1
    return
  }

  if (command === 'boot-probe') {
    const { options, positionals, home, profile, install } = common(rest, { home: 'string', profile: 'string', dsh: 'string', json: 'boolean', live: 'boolean', port: 'string', 'timeout-ms': 'string', 'mark-good': 'boolean' })
    if (positionals.length > 0) fail('boot-probe takes no positional arguments')
    process.stderr.write('dsh-recovery: probe stages a throwaway DSH_HOME copy (no writes to the real home)\n')
    const result = await bootProbe(home, { profile, install, live: options.live, timeoutMs: options['timeout-ms'], markGood: options['mark-good'] })
    if (options.json) jsonOut(result)
    else {
      if (result.error) process.stderr.write('boot-probe: ' + result.error + '\n')
      else {
        process.stdout.write(`boot-probe static=${result.static.ok ? 'PASS' : 'FAIL'} (exit ${result.static.exitCode}, ${result.static.ms}ms)\n`)
        if (result.static.tail && !result.static.ok) process.stdout.write(result.static.tail + '\n')
        if (result.live?.ran) process.stdout.write(`boot-probe live=${result.live.ok ? 'PASS' : 'FAIL'} (port ${result.live.port}, http ${result.live.httpStatus}, ${result.live.ms}ms)\n`)
        for (const f of result.findings ?? []) process.stdout.write(`ERROR [${f.code}] ${f.message}\n`)
        if (result.markedGood) process.stdout.write('marked good snapshot: ' + result.markedGood + '\n')
      }
    }
    process.exitCode = result.ok ? 0 : 1
    return
  }

  if (command === 'doctor') {
    const { options, positionals, home, profile, install } = common(rest, { home: 'string', profile: 'string', dsh: 'string', json: 'boolean' })
    if (positionals.length > 0) fail('doctor takes no positional arguments')
    const result = doctor(home, { profile, install })
    if (options.json) jsonOut(result.report)
    else {
      const r = result.report
      process.stdout.write(`dsh-recovery doctor — home=${home} profile=${profile} dsh=${r.dshVersion ?? 'not-found'} mode=${r.state.mode} safeMode=${r.state.safeModeActive}\n`)
      process.stdout.write(`findings: ${r.summary.errors} errors, ${r.summary.warnings} warnings\n`)
      if (r.findings.length > 0) process.stdout.write(renderFindings(r.findings) + '\n')
      if (r.recommendations.length > 0) {
        process.stdout.write('recommendations:\n')
        for (const rec of r.recommendations) process.stdout.write(`  [${rec.code}] ${rec.hint}\n`)
      }
      if (r.snapshots.length > 0) process.stdout.write(`snapshots: ${r.snapshots.length} (last-good ${r.state.lastGood ?? 'unset'})\n`)
    }
    process.exitCode = result.ok ? 0 : 1
    return
  }

  if (command === 'list') {
    const { options, positionals, home } = common(rest, { home: 'string', json: 'boolean' })
    if (positionals.length > 0) fail('list takes no positional arguments')
    const snaps = listSnapshots(home)
    if (options.json) jsonOut(snaps)
    else for (const s of snaps) process.stdout.write(`${s.id}  ${s.time}  ${s.reason}  comp=${s.compositionFiles} user=${s.usercodeFiles} data=${s.dataFiles}${s.settingsVerbose ? '  [verbatim settings]' : ''}\n`)
    return
  }

  fail('unknown command ' + JSON.stringify(command) + ' — run dsh-recovery help')
}

main().catch((error) => {
  process.stderr.write('dsh-recovery: ' + String(error?.stack ?? error) + '\n')
  process.exit(1)
})
