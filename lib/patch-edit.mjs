import { readFileSync, writeFileSync, copyFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { parseYaml } from './yaml.mjs'
import { ensureDir } from './fsutil.mjs'
import { PATCH_TEMPLATE } from './paths.mjs'

export const QUARANTINE_MARK = '# quarantined by dsh-recovery'

/** Copy the current patch aside; keep the newest 10 backups. */
export function backupPatch(patchPath) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = patchPath + '.dsh-recovery.bak.' + ts
  if (existsSync(patchPath)) copyFileSync(patchPath, backup)
  const dir = dirname(patchPath)
  const all = readdirSync(dir).filter((name) => name.includes('.dsh-recovery.bak.')).sort().reverse()
  for (const stale of all.slice(10)) { try { unlinkSync(join(dir, stale)) } catch {} }
  return backup
}

const parseCheck = (text, path) => {
  const parsed = parseYaml(text)
  if (!parsed.ok) return { ok: false, error: path + ':' + (parsed.error.line || '?') + ': ' + parsed.error.message }
  if (parsed.value !== undefined && !Array.isArray(parsed.value)) return { ok: false, error: path + ': patch layer must be a top-level YAML array' }
  return { ok: true }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Append (or materialize) one quarantined row: - id: X + disabled: true + our marker. */
export function addDisabledRow(patchPath, id, reason) {
  ensureDir(dirname(patchPath))
  let text = null
  try { text = readFileSync(patchPath, 'utf8') } catch { text = null }
  const row = '- id: ' + id + '\n  disabled: true  ' + QUARANTINE_MARK + ' ' + new Date().toISOString() + ' — ' + String(reason ?? '').slice(0, 120) + '\n'
  let next
  if (text === null) next = PATCH_TEMPLATE.replace(/\[\]\s*$/, '') + row
  else {
    // Empty-array template: replace the [] placeholder line with the row.
    const placeholder = /^(\s*)\[\]\s*$/m.exec(text)
    if (placeholder) next = text.replace(placeholder[0], row.trimEnd())
    else {
      const already = new RegExp('^\\s*- id:\\s*[\'"]?' + escapeRe(id) + '[\'"]?\\s*$', 'm').test(text)
      if (already) return { ok: true, already: true, path: patchPath }
      next = text.replace(/\s*$/, '\n') + '\n' + row
    }
  }
  const check = parseCheck(next, patchPath)
  if (!check.ok) return { ok: false, error: 'refusing to write invalid patch: ' + check.error, path: patchPath }
  backupPatch(patchPath)
  writeFileSync(patchPath, next)
  return { ok: true, already: false, path: patchPath }
}

/** Remove only rows this tool quarantined (marker required — never touch user rows). */
export function removeMarkedRow(patchPath, id) {
  let text = null
  try { text = readFileSync(patchPath, 'utf8') } catch { text = null }
  if (text === null) return { ok: true, removed: 0, path: patchPath }
  const lines = text.split('\n')
  const rowRe = /^(\s*)- id:\s*(['"]?)([A-Za-z0-9_.:-]+)\2\s*$/
  const boundaryRe = /^(\s*)- (id|insert):/
  const out = []
  let removed = 0
  let i = 0
  while (i < lines.length) {
    const match = rowRe.exec(lines[i])
    if (match !== null && match[3] === id) {
      let j = i + 1
      let hasMarker = false
      while (j < lines.length) {
        if (lines[j].includes(QUARANTINE_MARK)) { hasMarker = true; break }
        if (boundaryRe.test(lines[j])) break
        j++
      }
      if (hasMarker) {
        removed++
        let end = i
        while (end < lines.length) {
          if (boundaryRe.test(lines[end]) && end > i) break
          if (end > i && lines[end].trim() === '') { end++; break }
          end++
        }
        i = end
        continue
      }
    }
    out.push(lines[i])
    i++
  }
  let next = out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
  // A comment-only remainder is not a valid array; normalize to the empty template.
  const nonComment = out.filter((line) => line.trim() !== '' && !line.trim().startsWith('#') && line.trim() !== '[]')
  if (nonComment.length === 0) next = PATCH_TEMPLATE
  const check = parseCheck(next, patchPath)
  if (!check.ok) return { ok: false, error: 'refusing to write invalid patch: ' + check.error, path: patchPath }
  if (removed === 0) return { ok: true, removed: 0, path: patchPath }
  backupPatch(patchPath)
  writeFileSync(patchPath, next)
  return { ok: true, removed, path: patchPath }
}

/** Ids of rows carrying our quarantine marker. */
export function listQuarantined(patchPath) {
  let text = null
  try { text = readFileSync(patchPath, 'utf8') } catch { return [] }
  const lines = text.split('\n')
  const rowRe = /^(\s*)- id:\s*(['"]?)([A-Za-z0-9_.:-]+)\2\s*$/
  const boundaryRe = /^(\s*)- (id|insert):/
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const match = rowRe.exec(lines[i])
    if (match === null) continue
    let j = i + 1
    while (j < lines.length && !boundaryRe.test(lines[j])) {
      if (lines[j].includes(QUARANTINE_MARK)) { out.push({ id: match[3], line: i + 1 }); break }
      j++
    }
  }
  return out
}
