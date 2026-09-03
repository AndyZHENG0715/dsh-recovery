// Minimal YAML subset parser, sufficient for dsh profile/patch/settings files:
// block sequences and mappings, nested indent, flow [] / {}, quoted and plain
// scalars, block scalars (|, >), tags (!!js), anchors/aliases, comments,
// document markers. Unknown YAML constructs produce a parse error that the
// caller reports as a diagnostic instead of round-tripping the file.

export function parseYaml(text) {
  try {
    const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/)
    const anchors = new Map()
    const fail = (message, idx) => { const error = new Error(message); error.line = idx + 1; throw error }

    const skipIgnorable = (idx) => {
      while (idx < lines.length) {
        const line = lines[idx]
        const t = line.trimEnd().trim()
        if (t === '' || t.startsWith('#') || /^(---|\.\.\.)(\s+#.*)?$/.test(t)) { idx++; continue }
        return idx
      }
      return idx
    }
    const indentOf = (line) => { const m = /^[ ]*/.exec(line); return m[0].length }

    // Find a top-level ':' (outside quotes and flow brackets).
    const splitKey = (t) => {
      let quote = null, depth = 0
      for (let i = 0; i < t.length; i++) {
        const c = t[i]
        if (quote !== null) {
          if (c === '\\') { i++; continue }
          if (c === quote) quote = null
          continue
        }
        if (c === "'" || c === '"') { quote = c; continue }
        if (c === '[' || c === '{') depth++
        else if (c === ']' || c === '}') depth--
        else if (c === ':' && depth === 0) {
          if (i + 1 >= t.length || t[i + 1] === ' ' || t[i + 1] === '\t') return { key: t.slice(0, i), rest: t.slice(i + 1) }
        }
      }
      return null
    }
    const stripComment = (t) => {
      let quote = null, depth = 0
      for (let i = 0; i < t.length; i++) {
        const c = t[i]
        if (quote !== null) {
          if (c === '\\') { i++; continue }
          if (c === quote) quote = null
          continue
        }
        if (c === "'" || c === '"') { quote = c; continue }
        if (c === '[' || c === '{') depth++
        else if (c === ']' || c === '}') depth--
        else if (c === '#' && depth === 0 && (i === 0 || t[i - 1] === ' ' || t[i - 1] === '\t')) return t.slice(0, i)
      }
      return t
    }
    const unquote = (s) => {
      s = s.trim()
      if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'")
      if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
        return s.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      }
      return s
    }
    const parsePlain = (s) => {
      if (s === '' || s === '~' || /^null$/i.test(s)) return null
      if (/^true$/i.test(s)) return true
      if (/^false$/i.test(s)) return false
      if (/^[-+]?\d+$/.test(s)) { const n = Number(s); if (Number.isSafeInteger(n)) return n }
      if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) { const n = Number(s); if (Number.isFinite(n)) return n }
      return s
    }
    const parseFlow = (s) => {
      let i = 0
      const failFlow = (msg) => fail(msg + ' in flow: ' + s.slice(0, 40), 0)
      const parseValue = () => {
        while (i < s.length && /[\s,]/.test(s[i])) i++
        if (i >= s.length) failFlow('unexpected end')
        const c = s[i]
        if (c === '[') {
          i++; const out = []
          while (true) {
            while (i < s.length && /[\s,]/.test(s[i])) i++
            if (s[i] === ']') { i++; return out }
            out.push(parseValue())
          }
        }
        if (c === '{') {
          i++; const out = {}
          while (true) {
            while (i < s.length && /[\s,]/.test(s[i])) i++
            if (s[i] === '}') { i++; return out }
            let key
            if (s[i] === "'" || s[i] === '"') { const start = i; i++; while (i < s.length && s[i] !== s[start]) i++; key = s.slice(start + 1, i); i++ }
            else { const start = i; while (i < s.length && s[i] !== ':' && s[i] !== ' ' && s[i] !== ',') i++; key = s.slice(start, i) }
            while (i < s.length && /[\s]/.test(s[i])) i++
            if (s[i] !== ':') failFlow('expected : in flow map')
            i++
            out[key] = parseValue()
          }
        }
        if (c === "'" || c === '"') {
          const quote = c; const start = ++i; let out = ''
          while (i < s.length && s[i] !== quote) {
            if (s[i] === '\\' && quote === '"' && i + 1 < s.length) { out += s[i + 1]; i += 2; continue }
            out += s[i++]
          }
          if (i >= s.length) failFlow('unterminated string'); i++
          return quote === "'" ? out.replace(/''/g, "'") : out
        }
        const start = i
        while (i < s.length && !/[\s,\]\}]/.test(s[i])) i++
        return parsePlain(s.slice(start, i))
      }
      const value = parseValue()
      return value
    }
    const parseBlockScalar = (idx, indent, chomp, fold) => {
      const content = []
      let contentIndent = null
      let j = idx + 1
      while (true) {
        j = skipIgnorable(j)
        if (j >= lines.length) break
        const ind = indentOf(lines[j])
        if (ind <= indent) break
        let text = lines[j].slice(ind)
        if (contentIndent === null) contentIndent = ind
        if (ind > contentIndent) text = lines[j].slice(contentIndent)
        content.push(text)
        j++
      }
      let joined
      if (fold) {
        joined = content.map((t, n) => (t === '' ? '\n' : t)).join(' ')
        joined = joined.replace(/\n /g, '\n').replace(/ \n/g, '\n')
      } else joined = content.join('\n')
      if (chomp === '-') return { idx: j, value: joined }
      if (chomp === '+') return { idx: j, value: joined + '\n' }
      return { idx: j, value: joined + '\n' }
    }

    // Every return advances at least one line: inline scalars consume their
    // own line, block scalars consume the indicator line plus every content line.
    const parseInlineValue = (rest, idx, indent) => {
      let s = stripComment(rest).trim()
      if (s === '') return { idx: idx + 1, value: null }
      if (/^[|>][+-]?$/.test(s)) return parseBlockScalar(idx, indent, s.includes('+') ? '+' : s.includes('-') ? '-' : '', s[0] === '>')
      if (s.startsWith('[') || s.startsWith('{')) return { idx: idx + 1, value: parseFlow(s) }
      const tagMatch = /^!![^\s]+\s*(.*)$/.exec(s)
      if (tagMatch) return { idx: idx + 1, value: { tag: s.slice(0, s.length - tagMatch[1].length).trim(), raw: tagMatch[1] || null } }
      const anchorMatch = /^&(\S+)(\s+(.*))?$/.exec(s)
      if (anchorMatch) {
        const inner = parseInlineValue(anchorMatch[3] ?? '', idx, indent)
        anchors.set(anchorMatch[1], inner.value)
        return inner
      }
      const aliasMatch = /^\*(\S+)$/.exec(s)
      if (aliasMatch) {
        if (!anchors.has(aliasMatch[1])) fail('unknown anchor *' + aliasMatch[1], idx)
        return { idx: idx + 1, value: anchors.get(aliasMatch[1]) }
      }
      if ((s.startsWith("'") && s.endsWith("'") && s.length > 1) || (s.startsWith('"') && s.endsWith('"') && s.length > 1)) {
        return { idx: idx + 1, value: unquote(s) }
      }
      return { idx: idx + 1, value: parsePlain(s) }
    }

    const parseNode = (idx, indent) => {
      idx = skipIgnorable(idx)
      if (idx >= lines.length) return { idx, done: true, value: undefined }
      const ind = indentOf(lines[idx])
      if (ind < indent) return { idx, done: true, value: undefined }
      const t = lines[idx].slice(ind).trimEnd()
      if (t === '-' || t.startsWith('- ')) return parseSequence(idx, indent)
      if (splitKey(t) !== null) return parseMapping(idx, indent)
      if (t.startsWith('[') || t.startsWith('{')) return parseInlineValue(t, idx, indent)
      if (t.startsWith('|') || t.startsWith('>')) return parseInlineValue(t, idx, indent)
      return parseInlineValue(t, idx, indent)
    }

    const parseMapping = (idx, indent) => {
      const out = {}
      while (true) {
        idx = skipIgnorable(idx)
        if (idx >= lines.length) break
        const ind = indentOf(lines[idx])
        if (ind !== indent) break
        const t = lines[idx].slice(ind).trimEnd()
        const split = splitKey(t)
        if (split === null) break
        const key = unquote(split.key.trim())
        const rest = split.rest.trim()
        if (rest === '') {
          const next = skipIgnorable(idx + 1)
          if (next < lines.length && indentOf(lines[next]) > indent) {
            const nested = parseNode(next, indentOf(lines[next]))
            out[key] = nested.value
            idx = nested.idx
          } else { out[key] = null; idx = next }
          continue
        }
        const parsed = parseInlineValue(rest, idx, indent)
        out[key] = parsed.value
        idx = parsed.idx
      }
      return { idx, value: out }
    }

    const parseSequence = (idx, indent) => {
      const out = []
      while (true) {
        idx = skipIgnorable(idx)
        if (idx >= lines.length) break
        const ind = indentOf(lines[idx])
        if (ind !== indent) break
        const t = lines[idx].slice(ind).trimEnd()
        if (!(t === '-' || t.startsWith('- '))) break
        if (t === '-') {
          const next = skipIgnorable(idx + 1)
          if (next >= lines.length || indentOf(lines[next]) <= indent) { out.push(null); idx = next; continue }
          const nested = parseNode(next, indentOf(lines[next]))
          out.push(nested.value)
          idx = nested.idx
          continue
        }
        const content = t.slice(2).trimEnd()
        if (splitKey(content) !== null) {
          // '- key: value' — a mapping item whose keys sit at indent+2.
          const item = {}
          const keyIndent = indent + 2
          let c = content
          let at = idx
          while (true) {
            const split = splitKey(c)
            if (split === null) break
            const key = unquote(split.key.trim())
            const rest = split.rest.trim()
            if (rest === '') {
              const next = skipIgnorable(at + 1)
              if (next < lines.length && indentOf(lines[next]) > keyIndent) {
                const nested = parseNode(next, indentOf(lines[next]))
                item[key] = nested.value
                at = nested.idx
              } else { item[key] = null; at = next }
            } else {
              const parsed = parseInlineValue(rest, at, keyIndent)
              item[key] = parsed.value
              at = parsed.idx
            }
            const following = skipIgnorable(at)
            if (following >= lines.length || indentOf(lines[following]) !== keyIndent) break
            const ft = lines[following].slice(keyIndent).trimEnd()
            if (splitKey(ft) === null) break
            c = ft
            at = following
          }
          out.push(item)
          idx = at
          continue
        }
        const parsed = parseInlineValue(content, idx, indent)
        out.push(parsed.value)
        idx = parsed.idx
      }
      return { idx, value: out }
    }

    const root = parseNode(0, 0)
    if (root.done) return { ok: true, value: undefined }
    return { ok: true, value: root.value }
  } catch (error) {
    return { ok: false, error: { message: String(error?.message ?? error), line: error?.line ?? 0 } }
  }
}
