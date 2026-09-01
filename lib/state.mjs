import { readFileSync } from 'node:fs'
import { statePath, recoveryDir } from './paths.mjs'
import { ensureDir, writeJsonAtomic } from './fsutil.mjs'

export function readState(home) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(home), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return defaultState()
    return { ...defaultState(), ...parsed }
  } catch { return defaultState() }
}
export const defaultState = () => ({
  version: 1,
  mode: 'normal',
  safeMode: { active: false, enteredAt: null },
  lastSnapshot: null,
  lastGood: null,
  lastRollback: null,
  lastDoctor: null,
  bootFailures: [],
  previousCrash: null
})
export function writeState(home, state) {
  ensureDir(recoveryDir(home))
  writeJsonAtomic(statePath(home), state)
}
