import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync, lstatSync, renameSync, appendFileSync, rmSync, symlinkSync, readlinkSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'

export const ensureDir = (dir) => { mkdirSync(dir, { recursive: true }) }

export const atomicWriteFile = (path, content, mode) => {
  ensureDir(dirname(path))
  const tmp = path + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  writeFileSync(tmp, content, mode === undefined ? {} : { mode })
  renameSync(tmp, path)
}

export const readFileOrNull = (path) => { try { return readFileSync(path, 'utf8') } catch { return null } }
export const readFileOrUndefined = (path) => { try { return readFileSync(path) } catch { return undefined } }

export const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex')

export const readJsonFile = (path) => {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: path + ' must hold a JSON object' }
    }
    return { ok: true, value: parsed }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

export const writeJsonAtomic = (path, value) => atomicWriteFile(path, JSON.stringify(value, null, 2) + '\n')

export const mode600 = 0o600
export const mode700 = 0o700

/** Copy one tree with exclusions; records every copied file as { rel, size, sha256 }. */
export function copyTree(src, dest, opts = {}) {
  const { excludeDirNames = [], maxFileBytes = 8 * 1024 * 1024, maxTotalBytes = 256 * 1024 * 1024, dereference = true } = opts
  const files = []
  let total = 0
  const walk = (dir, out) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      if (excludeDirNames.includes(entry)) continue
      const from = join(dir, entry)
      let stat
      try { stat = dereference ? statSync(from) : lstatSync(from) } catch { continue }
      const relPath = relative(src, from)
      if (stat.isDirectory()) { walk(from, join(out, entry)); continue }
      if (!stat.isFile()) continue
      if (stat.size > maxFileBytes) { files.push({ rel: relPath, skipped: 'too-large', size: stat.size }); continue }
      if (total + stat.size > maxTotalBytes) { files.push({ rel: relPath, skipped: 'total-cap', size: stat.size }); continue }
      ensureDir(out)
      copyFileSync(from, join(out, entry))
      const buf = readFileSync(join(out, entry))
      files.push({ rel: relPath, size: stat.size, sha256: sha256Hex(buf) })
      total += stat.size
    }
  }
  ensureDir(dest)
  walk(src, dest)
  return { files, totalBytes: total }
}

export const rmrf = (path) => { try { rmSync(path, { recursive: true, force: true }) } catch {} }

export function appendJournal(home, entry) {
  try {
    ensureDir(recoveryDirOf(home))
    appendFileSync(join(home, 'recovery', 'journal.log'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch {}
}
function recoveryDirOf(home) { return join(home, 'recovery') }

export function linkType() { return process.platform === 'win32' ? 'junction' : 'dir' }

export function ensureSymlink(link, target) {
  let stat = null
  try { stat = lstatSync(link) } catch { stat = null }
  if (stat !== null) {
    if (!stat.isSymbolicLink()) return false
    try { if (readlinkSync(link) === target) return true } catch {}
    rmSync(link, { force: true })
  }
  try { symlinkSync(target, link, linkType()); return true } catch { return false }
}
