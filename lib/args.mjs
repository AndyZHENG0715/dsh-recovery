// Minimal argv parser: subcommand, positionals, --flag value / --flag=value.
export function parseArgs(argv, flagSpec) {
  const options = {}
  const positionals = []
  const bools = new Set(Object.entries(flagSpec).filter(([, t]) => t === 'boolean').map(([k]) => k))
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') { positionals.push(...argv.slice(i + 1)); break }
    if (arg.startsWith('--')) {
      let name = arg.slice(2)
      let inline
      const eq = name.indexOf('=')
      if (eq !== -1) { inline = name.slice(eq + 1); name = name.slice(0, eq) }
      if (!(name in flagSpec)) throw new Error('unknown option --' + name)
      if (bools.has(name)) {
        if (inline !== undefined) options[name] = inline !== 'false' && inline !== '0'
        else options[name] = true
      } else {
        if (inline !== undefined) options[name] = inline
        else { if (i + 1 >= argv.length) throw new Error('option --' + name + ' needs a value'); options[name] = argv[++i] }
      }
      continue
    }
    positionals.push(arg)
  }
  return { options, positionals }
}
