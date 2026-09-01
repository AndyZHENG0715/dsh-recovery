import { watch } from 'node:fs'
import { resolveProfileDir } from './paths.mjs'
import { readState } from './state.mjs'
import { readConfig } from './config.mjs'
import { enforceSafemodeProfile } from './safemode.mjs'
import { appendJournal } from './fsutil.mjs'

/**
 * Safemode profile guard: force the whitelist at startup, then keep enforcing
 * while safeMode is active (fs.watch + polling fallback), like the jinsiyu
 * safemode-profile design.
 */
export async function runGuard(home, opts = {}) {
  const cfg = readConfig(home, opts)
  const dir = resolveProfileDir(home, 'safemode')
  let watcher = null
  let lastEnforce = 0
  let repairedOnce = []

  const enforce = () => {
    const state = readState(home)
    if (state.safeMode?.active !== true) return
    const now = Date.now()
    if (now - lastEnforce < cfg.guard.debounceMs) return
    lastEnforce = now
    const repaired = enforceSafemodeProfile(home)
    if (repaired.length > 0) appendJournal(home, { op: 'safemode-guard-repair', repaired })
  }

  enforce()
  if (opts.once === true) return { ok: true, once: true }

  try { watcher = watch(dir, () => enforce()) } catch { watcher = null }
  const poll = setInterval(enforce, cfg.guard.pollMs)

  return await new Promise((resolvePromise) => {
    let settle = false
    const stop = (code) => {
      if (settle) return
      settle = true
      if (watcher !== null) { try { watcher.close() } catch {} }
      clearInterval(poll)
      resolvePromise({ ok: true, stoppedBy: code })
    }
    process.on('SIGINT', () => stop('SIGINT'))
    process.on('SIGTERM', () => stop('SIGTERM'))
  })
}
