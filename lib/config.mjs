import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { recoveryDir } from './paths.mjs'

export const DEFAULT_CONFIG = {
  boot: {
    failureWindowMs: 10 * 60 * 1000, // 10 min
    failureThreshold: 3,
    readyMs: 30000,                  // exit before this is a boot failure
    maxLadderRetries: 2,
    autoLadder: true,
    autoSafeBoot: true,
    safemodePort: 3081
  },
  guard: {
    pollMs: 30000,
    debounceMs: 300
  }
}

const num = (v, dflt) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dflt)

export function readConfig(home, overrides = {}) {
  let file = {}
  try { file = JSON.parse(readFileSync(join(recoveryDir(home), 'config.json'), 'utf8')) } catch { file = {} }
  const base = {
    ...DEFAULT_CONFIG,
    ...(file ?? {}),
    boot: { ...DEFAULT_CONFIG.boot, ...(file?.boot ?? {}) },
    guard: { ...DEFAULT_CONFIG.guard, ...(file?.guard ?? {}) }
  }
  const boot = base.boot
  if (overrides.retries !== undefined) boot.maxLadderRetries = num(overrides.retries, boot.maxLadderRetries)
  if (overrides.readyMs !== undefined) boot.readyMs = num(overrides.readyMs, boot.readyMs)
  if (overrides.threshold !== undefined) boot.failureThreshold = num(overrides.threshold, boot.failureThreshold)
  if (overrides.windowMs !== undefined) boot.failureWindowMs = num(overrides.windowMs, boot.failureWindowMs)
  if (overrides.autoLadder !== undefined) boot.autoLadder = overrides.autoLadder === true
  if (overrides.autoSafeBoot !== undefined) boot.autoSafeBoot = overrides.autoSafeBoot === true
  if (overrides.safemodePort !== undefined) boot.safemodePort = num(overrides.safemodePort, boot.safemodePort)
  if (overrides.pollMs !== undefined) base.guard.pollMs = num(overrides.pollMs, base.guard.pollMs)
  if (overrides.watchMs !== undefined) base.guard.watchMs = num(overrides.watchMs, base.guard.watchMs)
  return base
}
