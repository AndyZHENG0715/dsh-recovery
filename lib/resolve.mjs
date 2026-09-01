import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'

/** Node's own node_modules lookup for a package name from one anchor file. */
export function packageDirFromAnchor(anchorFile, packageName) {
  try {
    const paths = createRequire(anchorFile).resolve.paths(packageName) ?? []
    for (const searchPath of paths) {
      const candidate = join(searchPath, packageName)
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
  } catch { /* fallthrough */ }
  return undefined
}

export function isDshPackageDir(dir) {
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return false
  try { return JSON.parse(readFileSync(manifestPath, 'utf8')).name === '@deepseek-ai/dsh' } catch { return false }
}

/** Locate the dsh install anchor (its package.json). Order: --dsh, env, npx cache, require.resolve. */
export function findInstallAnchor(env, opts = {}) {
  const candidates = [opts.dsh, env.DSH_RECOVERY_DSH_DIR].filter(Boolean)
  for (const raw of candidates) {
    const dir = resolve(raw)
    if (isDshPackageDir(dir)) return { anchor: join(dir, 'package.json'), dir }
    const nested = join(dir, '@deepseek-ai', 'dsh')
    if (isDshPackageDir(nested)) return { anchor: join(nested, 'package.json'), dir: nested }
    const direct = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    if (isDshPackageDir(direct)) return { anchor: join(direct, 'package.json'), dir: direct }
  }
  const npxRoots = []
  for (const base of [join(homedir(), '.npm', '_npx')]) {
    let entries = []
    try { entries = readdirSync(base) } catch { entries = [] }
    for (const entry of entries) npxRoots.push(join(base, entry, 'node_modules', '@deepseek-ai', 'dsh'))
  }
  let best = null
  for (const dir of npxRoots) {
    if (!isDshPackageDir(dir)) continue
    let version = '0.0.0'
    try { version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? version } catch {}
    if (best === null || compareVersions(version, best.version) > 0) best = { anchor: join(dir, 'package.json'), dir, version }
  }
  if (best !== null) return best
  try {
    const url = createRequire(resolve('package.json')).resolve('@deepseek-ai/dsh/package.json')
    const dir = dirname(url.replace(/^file:\/\//, ''))
    if (isDshPackageDir(dir)) return { anchor: join(dir, 'package.json'), dir }
  } catch { /* fallthrough */ }
  return null
}

export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

export function dshVersionOf(install) {
  try { return JSON.parse(readFileSync(install.anchor, 'utf8')).version ?? null } catch { return null }
}

export function dshBinOf(install) {
  return join(install.dir, 'lib', 'bin.js')
}

/** Resolve a bundle name the way dsh does: installation anchor first, then the profile dir. */
export function resolveBundleDir(install, profileDir, packageName) {
  for (const anchor of [install?.anchor, join(profileDir, 'package.json')]) {
    if (anchor === undefined) continue
    const dir = packageDirFromAnchor(anchor, packageName)
    if (dir !== undefined) return dir
  }
  return undefined
}

/** Resolve a patch row's module name; relative names resolve against baseUrl. */
export function resolveRowName(name, baseUrlFile, install) {
  if (name === undefined || name === null || name === '') return undefined
  // loader builtins never resolve through node_modules
  if (name === 'cordis:include' || name.startsWith('cordis:')) return name
  if (isAbsolute(name) || name.startsWith('./') || name.startsWith('../') || name.startsWith('.')) {
    const candidate = resolve(dirname(baseUrlFile), name)
    if (existsSync(candidate)) return candidate
    if (existsSync(candidate + '.mjs')) return candidate + '.mjs'
    if (existsSync(candidate + '.js')) return candidate + '.js'
    return undefined
  }
  // package subpath specifiers (e.g. @deepseek-ai/dsh-web-app/startup) need
  // exports-aware resolution, not just a package-dir lookup
  if (name.includes('/')) {
    for (const anchor of [baseUrlFile, install?.anchor]) {
      if (anchor === undefined) continue
      try {
        const resolvedPath = createRequire(anchor).resolve(name)
        if (existsSync(resolvedPath)) return resolvedPath
      } catch { /* next anchor */ }
    }
  }
  for (const anchor of [baseUrlFile, install?.anchor]) {
    if (anchor === undefined) continue
    const dir = packageDirFromAnchor(anchor, name)
    if (dir !== undefined) return dir
  }
  return undefined
}
