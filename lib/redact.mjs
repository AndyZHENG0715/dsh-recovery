const SECRET_KEY = /(key|token|secret|password|credential|authorization|api[-_]?key)/i

export function isSecretKey(key) {
  return typeof key === 'string' && SECRET_KEY.test(key)
}

/** Deep-walk and replace values whose key looks secret with '***'. */
export function redact(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redact(item, seen))
  const out = {}
  for (const [key, val] of Object.entries(value)) {
    if (isSecretKey(key)) out[key] = '***'
    else if (key === 'raw' && val !== null && typeof val === 'object') out[key] = val
    else out[key] = redact(val, seen)
  }
  return out
}

/** Replace every scalar with '***' — used for credential-file structure checks. */
export function redactAllScalars(value, seen = new Set()) {
  if (value === null) return null
  if (typeof value !== 'object') return '***'
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactAllScalars(item, seen))
  const out = {}
  for (const [key, val] of Object.entries(value)) out[key] = redactAllScalars(val, seen)
  return out
}
