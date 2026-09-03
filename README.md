# dsh-recovery

中文版本请见 [README-ZH.md](./README-ZH.md)

DeepSeek Harness recovery system: a **pure Node, zero-runtime-dependency** CLI plus an in-process watchdog bundle that helps DSH recover from broken configuration, plugins, presets, sessions, or upgrade regressions using a staged flow of **diagnose → snapshot → rollback → safe mode → boot verification**.

## Current status

- **P0**: CLI recovery flow — implemented
- **P1**: launcher and automatic recovery ladder — implemented
- **P2**: in-process watchdog bundle — implemented
- **P3**: rescue capsule / DSH runtime rollback / session repair — planned

## Commands

| Command | Purpose |
|---|---|
| `scan` | Scan profile, settings, storages, user presets, and sessions for common corruption |
| `snapshot` | Create recovery snapshots; supports composition, user assets, and optional data tier |
| `rollback` | Roll back to `--latest`, `--good`, or `--id <id>` |
| `safemode enter/exit` | Enter or exit the safemode profile |
| `boot-probe` | Run static and real boot verification in a temporary `DSH_HOME` |
| `doctor` | Aggregate scan results, state, snapshot inventory, and recovery hints |
| `list` | List snapshots |
| `launch` | Launch wrapper with transparent argv forwarding, boot markers, and the recovery ladder |
| `quarantine` | Manage quarantined rows |
| `unquarantine` | Restore a quarantined row |
| `guard` | Safemode profile guard |

Common flags:

- `--home <dir>`: defaults to `$DSH_HOME` / `~/.dsh`
- `--profile web`: default profile
- `--dsh <dir>`: defaults to `$DSH_RECOVERY_DSH_DIR`
- `--json`: machine-readable output

Exit codes:

- `0`: success
- `1`: error / probe failure
- `2`: usage error

## Run

```sh
node bin/dsh-recovery.mjs scan --json
node bin/dsh-recovery.mjs snapshot --reason before-upgrade
node bin/dsh-recovery.mjs boot-probe --live --mark-good
node bin/dsh-recovery.mjs rollback --good
DSH_HOME=~/.dsh node bin/dsh-recovery.mjs safemode enter
node bin/dsh-recovery.mjs launch --profile web -- --port 3080
```

If `pnpm` is unavailable, `--install` will emit a clear warning. You can point to a binary with `--pnpm <bin>` or `DSH_RECOVERY_PNPM`.

## Safety model

- Snapshot contents **never** include secrets:
  - `settings.yaml` is stored as a redacted structure by default (`secret` keys → `***`) plus the original SHA-256
  - `.credentials.yaml` is fingerprinted only; its contents are never copied
  - `--include-settings` is required to store the raw `settings.yaml`
- A pre-rollback snapshot is created automatically before rollback
- `boot-probe` writes only to a temporary home under `$TMPDIR`; the real home is never modified
- The live phase of `boot-probe` passes `--no-open`, so it will not open a browser
- Snapshot manifests record the DSH version and file SHA-256 hashes for upgrade attribution
- Diagnostic and incident output should be redacted before export

## P1 launcher and recovery ladder

```sh
# Replace direct dsh startup: transparent forwarding + boot marker + automatic recovery
node bin/dsh-recovery.mjs launch --profile web -- --port 3080

# Quarantine management and one-step restore
node bin/dsh-recovery.mjs quarantine list
node bin/dsh-recovery.mjs unquarantine --id <row-id>

# Safemode profile guard
node bin/dsh-recovery.mjs guard --once
node bin/dsh-recovery.mjs guard --poll-ms 30000
```

The launcher records recovery state in `recovery/journal.log` and `recovery/incidents/`:

1. Crash evidence: the boot marker is cleared on clean exit; if it remains, the next launch treats it as crash evidence
2. Attribution quarantine: if a non-core third-party row fails, a marked `disabled` row is written and the process is restarted
3. Rollback: if the failure cannot be attributed, or a core row fails, the last good snapshot is restored
4. Circuit breaker: repeated failures within a time window trigger `safemode`

Thresholds live in `recovery/config.json` under `boot.*` and `guard.*`, and can be overridden. `launch` also accepts:

- `--retries`
- `--ready-ms`
- `--threshold`
- `--window-ms`
- `--no-ladder`
- `--no-auto-safe-boot`

## P2 in-process watchdog bundle

`packages/dsh-recovery-watchdog` is an installable dsh bundle:

```sh
dsh plugin --profile web add link:/abs/path/dsh-recovery/packages/dsh-recovery-watchdog
```

It is responsible for:

- quarantining non-core rows after fiber failure
- writing and clearing the boot marker and heartbeat
- taking Tier A+B snapshots before plugin installation changes
- reconciling dependencies that are installed but missing from the bundles layer
- quarantining broken user presets and falling back the default preset to `standard`
- verifying user preset mount health at runtime
- exposing loopback-only status and render report routes
- registering a recovery status card in Settings

## Tests

```sh
npm test        # node --test; runs in isolated DSH_HOME copies and never touches real ~/.dsh
```

Current test coverage includes:

- YAML subset parser unit tests
- corruption detection
- three-tier snapshots and redaction
- rollback restoration and validation gates
- safemode enter/exit
- boot-probe static gate + HTTP 200 gate
- doctor aggregation
- P2 watchdog unit and E2E paths

## Notes

- Verified on `@deepseek-ai/dsh@0.1.1-rc.2` and Node 24
- zstd session decoding requires Node >= 22.15
- `boot-probe` and `launch` depend on a usable DSH installation
- Full acceptance steps are documented in `docs/ACCEPTANCE.md`

## Roadmap

### P3
- Rescue capsule
- DSH runtime rollback
- Session repair

## Project docs

- `docs/dsh-recovery-design.md`
- `docs/dsh-recovery-research.md`
- `docs/ACCEPTANCE.md`
