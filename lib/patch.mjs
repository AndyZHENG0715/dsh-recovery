import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseYaml } from './yaml.mjs'
import { readJsonFile } from './manifest.mjs'
import { resolveBundleDir, resolveRowName } from './resolve.mjs'

export const loadPatchFile = (path) => {
  let text
  try { text = readFileSync(path, 'utf8') } catch { return { ok: true, exists: false, rows: [], text: '' } }
  const parsed = parseYaml(text)
  if (!parsed.ok) return { ok: false, exists: true, error: path + ':' + (parsed.error.line || '?') + ': ' + parsed.error.message, rows: [], text }
  if (parsed.value !== undefined && !Array.isArray(parsed.value)) return { ok: false, exists: true, error: path + ': patch layer must be a top-level YAML array', rows: [], text }
  return { ok: true, exists: true, rows: parsed.value ?? [], text }
}

export function bundleLayers(home, profileDir, install) {
  const manifest = readJsonFile(join(profileDir, 'package.json'))
  if (!manifest.ok) return { layers: [], findings: [{ severity: 'error', code: 'manifest-invalid', message: manifest.error, path: join(profileDir, 'package.json') }], bundles: [] }
  const bundles = Array.isArray(manifest.value?.dsh?.profile?.bundles) ? manifest.value.dsh.profile.bundles : []
  const layers = []
  const findings = []
  for (const name of bundles) {
    const dir = resolveBundleDir(install, profileDir, name)
    if (dir === undefined) {
      findings.push({ severity: 'error', code: 'bundle-unresolvable', message: 'cannot resolve profile bundle ' + JSON.stringify(name), path: join(profileDir, 'package.json') })
      continue
    }
    const bm = readJsonFile(join(dir, 'package.json'))
    if (!bm.ok) { findings.push({ severity: 'error', code: 'bundle-manifest-invalid', message: name + ': ' + bm.error, path: join(dir, 'package.json') }); continue }
    const declared = bm.value?.dsh?.bundle?.patch
    if (typeof declared !== 'string') {
      findings.push({ severity: 'error', code: 'bundle-no-manifest', message: 'profile bundle ' + JSON.stringify(name) + ' declares no dsh.bundle in its package.json', path: join(dir, 'package.json') })
      continue
    }
    const patchPath = join(dir, declared)
    const layer = loadPatchFile(patchPath)
    if (!layer.ok) { findings.push({ severity: 'error', code: 'patch-parse-failed', message: layer.error, path: patchPath }); continue }
    layers.push({ id: name, path: patchPath, baseUrl: join(dir, 'package.json'), rows: layer.rows })
  }
  return { layers, findings, bundles }
}

/** Approximate the loader's entry composition to surface duplicate ids and dead rows. */
export function composeRows(layers, baseUrlFile, install) {
  const findings = []
  const rows = new Map()
  const insertOrder = new Map()
  const addInserted = (row, layerId) => {
    const id = row?.id
    if (typeof id !== 'string' || id === '') {
      findings.push({ severity: 'error', code: 'insert-unnamed', message: 'insert row without an id in layer ' + layerId })
      return
    }
    if (insertOrder.has(id)) {
      findings.push({ severity: 'error', code: 'duplicate-entry-id', message: 'duplicate loader entry id ' + JSON.stringify(id) + ' (first inserted by ' + insertOrder.get(id) + ', again by ' + layerId + ')' })
      return
    }
    insertOrder.set(id, layerId)
    rows.set(id, { ...row })
  }
  for (const layer of layers) {
    for (const entry of layer.rows) {
      if (entry === null || typeof entry !== 'object') { findings.push({ severity: 'error', code: 'patch-entry-invalid', message: 'non-object patch entry in ' + layer.id }); continue }
      if (Array.isArray(entry.insert)) {
        for (const child of entry.insert) addInserted(child, layer.id)
        continue
      }
      const id = entry.id
      if (typeof id === 'string') {
        if (!rows.has(id)) {
          if (entry.disabled !== true) findings.push({ severity: 'warning', code: 'patch-target-missing', message: 'patch targets unknown entry id ' + JSON.stringify(id) + ' (loader warns, does not throw)' })
          continue
        }
        const merged = { ...rows.get(id) }
        if (entry.name !== undefined) merged.name = entry.name
        if (entry.disabled !== undefined) merged.disabled = entry.disabled
        if (entry.config !== undefined) merged.config = entry.config
        rows.set(id, merged)
      }
    }
  }
  for (const [id, row] of rows) {
    if (row.disabled === true) continue
    if (row.group === true && Array.isArray(row.config)) {
      const seen = new Set()
      for (const child of row.config) {
        const cid = child?.id
        if (typeof cid !== 'string') { findings.push({ severity: 'error', code: 'group-insert-unnamed', message: 'group ' + id + ' has a child without an id' }); continue }
        if (seen.has(cid)) findings.push({ severity: 'error', code: 'duplicate-entry-id', message: 'duplicate loader entry id ' + JSON.stringify(cid) + ' inside group ' + id })
        seen.add(cid)
      }
      continue
    }
    if (row.name === undefined) { findings.push({ severity: 'warning', code: 'row-unnamed', message: 'entry ' + id + ' has no name' }); continue }
    if (resolveRowName(row.name, baseUrlFile, install) === undefined) {
      findings.push({ severity: 'error', code: 'name-unresolvable', message: 'entry ' + id + ' name ' + JSON.stringify(row.name) + ' cannot be resolved', path: baseUrlFile })
    }
  }
  return { rows, findings }
}
