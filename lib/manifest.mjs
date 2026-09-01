import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { parseYaml } from './yaml.mjs'
import { atomicWriteFile } from './fsutil.mjs'

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

export const readYamlFile = (path) => {
  let text
  try { text = readFileSync(path, 'utf8') } catch (error) { return { ok: false, error: String(error?.message ?? error) } }
  const parsed = parseYaml(text)
  if (!parsed.ok) return { ok: false, error: path + ':' + (parsed.error.line || '?') + ': ' + parsed.error.message }
  return { ok: true, value: parsed.value, text }
}

export const writeJsonAtomic = (path, value) => atomicWriteFile(path, JSON.stringify(value, null, 2) + '\n')
export const writeTextAtomic = (path, text) => atomicWriteFile(path, text)

export const readProfileManifest = (profileDir) => readJsonFile(join(profileDir, 'package.json'))
export const writeProfileManifest = (profileDir, value) => writeJsonAtomic(join(profileDir, 'package.json'), value)
export const readBundleManifest = (pkgDir) => readJsonFile(join(pkgDir, 'package.json'))
export const bundlePatchDecl = (manifest) => manifest?.dsh?.bundle?.patch
