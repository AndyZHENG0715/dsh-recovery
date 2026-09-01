import { homedir } from 'node:os'
import { join, resolve, basename, dirname } from 'node:path'

const DSH_HOME_DIR = '.dsh'
export const PROFILES_DIR = 'profiles'
export const RECOVERY_DIR = 'recovery'
export const USER_PRESETS_DIR = '.agent-presets'
export const SESSIONS_DIR = 'sessions'
export const STORAGES_DIR = 'storages'

export const PROFILE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml']

export function resolveDshHome(env, configured) {
  const fromEnv = env.DSH_HOME
  return resolve(configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), DSH_HOME_DIR)))
}

export function resolveProfileDir(home, name) {
  if (name === '' || name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name === 'node_modules') {
    throw new Error('invalid profile name ' + JSON.stringify(name))
  }
  return join(home, PROFILES_DIR, name)
}

export const recoveryDir = (home) => join(home, RECOVERY_DIR)
export const snapshotsRoot = (home) => join(recoveryDir(home), 'snapshots')
export const statePath = (home) => join(recoveryDir(home), 'state.json')
export const journalPath = (home) => join(recoveryDir(home), 'journal.log')
export const quarantineDir = (home) => join(recoveryDir(home), 'quarantine')
export const userPresetsDir = (home) => join(home, USER_PRESETS_DIR)
export const sessionsDir = (home) => join(home, SESSIONS_DIR)
export const storagesDir = (home) => join(home, STORAGES_DIR)
export const settingsPath = (home) => join(home, 'settings.yaml')
export const credentialsPath = (home) => join(home, '.credentials.yaml')
export const homePatchPath = (home) => join(home, 'cordis.patch.yml')
export const profilePatchPath = (home, profile) => join(resolveProfileDir(home, profile), 'cordis.patch.yml')

// Mirrors the shipped profile templates the dsh launcher initializes.
export const SAFEMODE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
export const SHIPPED_PRESET_IDS = ['standard', 'code', 'minimal', 'cordis']

export const PROFILE_ROOT_CONFIG = '# dsh profile root — an empty entry list. The tree is composed as patches:\n[]\n'
export const PATCH_TEMPLATE = '# Your patch layer for this dsh profile, applied after every bundle layer:\n[]\n'
export const PNPM_WORKSPACE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'

export function profileNameOf(profileDir) { return basename(dirname(profileDir)) === PROFILES_DIR ? basename(profileDir) : null }
