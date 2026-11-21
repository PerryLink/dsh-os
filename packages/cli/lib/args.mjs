export function parseOptions(args, { flags = [], values = [] } = {}) {
  const options = {}
  const positional = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') {
      positional.push(...args.slice(index + 1))
      break
    }
    if (arg === '-h' || arg === '--help') {
      options.help = true
      continue
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=')
      const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals)
      const inline = equals === -1 ? undefined : arg.slice(equals + 1)
      if (flags.includes(name)) {
        if (inline !== undefined) throw new Error(`option --${name} does not take a value`)
        options[name] = true
        continue
      }
      if (values.includes(name)) {
        const value = inline !== undefined ? inline : args[index + 1]
        if (value === undefined || value.startsWith('--')) {
          throw new Error(`option --${name} requires a value`)
        }
        options[name] = value
        if (inline === undefined) index += 1
        continue
      }
      throw new Error(`unknown option --${name}`)
    }
    if (arg.startsWith('-') && arg !== '-') throw new Error(`unknown option ${arg}`)
    positional.push(arg)
  }
  return { options, positional }
}
