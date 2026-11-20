import { CLI_PACKAGE, findRepoRoot, loadCatalog } from './catalog.mjs'
import {
  runDoctorCommand,
  runInfo,
  runInstall,
  runList,
  runUpdate,
} from './commands.mjs'
import { collectModules } from './modules.mjs'
import { DEFAULT_PROFILE, isSafeProfile } from './names.mjs'

const COMMANDS = new Set(['list', 'info', 'install', 'update', 'doctor'])

const HELP = `dsh-os ${CLI_PACKAGE.version} - offline catalog and installer helper for dsh-os modules

Usage:
  dsh-os list [--json] [--all]
  dsh-os info <module> [--json] [--profile <name>]
  dsh-os install <module...> [--profile <name>] [--run]
  dsh-os update [--profile <name>]
  dsh-os doctor

Options:
  --json       machine-readable output (list, info)
  --all        include optional/planned modules in list
  --profile    DeepSeek Harness profile (default: ${DEFAULT_PROFILE})
  --run        execute "dsh plugin" instead of only printing it (install)
  -h, --help   show this help
  -v, --version  show the CLI version

Modules may be referenced by package name (dsh-act), product (Act) or
service (act, ctx.act). The CLI never contacts a registry and never writes
a profile or any other user configuration.
`

function parseOptions(args, { flags = [], values = [] } = {}) {
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

function profileOf(options) {
  const profile = options.profile ?? DEFAULT_PROFILE
  if (!isSafeProfile(profile)) throw new Error(`invalid profile name "${profile}"`)
  return profile
}

export function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr
  const cwd = io.cwd ?? process.cwd()
  const [command, ...args] = argv

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    stdout.write(HELP)
    return 0
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    stdout.write(`${CLI_PACKAGE.version}\n`)
    return 0
  }
  if (!COMMANDS.has(command)) {
    stderr.write(`dsh-os: unknown command "${command}"\nRun "dsh-os --help" for usage.\n`)
    return 1
  }

  try {
    const catalog = loadCatalog()
    const repoRoot = findRepoRoot(cwd, new Set(catalog.map(entry => entry.name)))
    const context = collectModules(repoRoot, catalog)

    if (command === 'list') {
      const { options, positional } = parseOptions(args, { flags: ['json', 'all'] })
      if (options.help) {
        stdout.write(HELP)
        return 0
      }
      if (positional.length > 0) throw new Error('list does not take positional arguments')
      return runList(
        context,
        { json: Boolean(options.json), all: Boolean(options.all) },
        stdout,
      )
    }

    if (command === 'info') {
      const { options, positional } = parseOptions(args, {
        flags: ['json'],
        values: ['profile'],
      })
      if (options.help) {
        stdout.write(HELP)
        return 0
      }
      if (positional.length !== 1) throw new Error('info requires exactly one module')
      return runInfo(
        context,
        positional[0],
        { json: Boolean(options.json), profile: profileOf(options) },
        stdout,
      )
    }

    if (command === 'install') {
      const { options, positional } = parseOptions(args, {
        flags: ['run'],
        values: ['profile'],
      })
      if (options.help) {
        stdout.write(HELP)
        return 0
      }
      if (positional.length === 0) throw new Error('install requires at least one module')
      return runInstall(
        context,
        positional,
        { run: Boolean(options.run), profile: profileOf(options) },
        stdout,
      )
    }

    if (command === 'update') {
      const { options, positional } = parseOptions(args, { values: ['profile'] })
      if (options.help) {
        stdout.write(HELP)
        return 0
      }
      if (positional.length > 0) throw new Error('update does not take positional arguments')
      return runUpdate(context, { profile: profileOf(options) }, stdout)
    }

    const { options, positional } = parseOptions(args)
    if (options.help) {
      stdout.write(HELP)
      return 0
    }
    if (positional.length > 0) throw new Error('doctor does not take positional arguments')
    return runDoctorCommand(context, stdout)
  } catch (error) {
    stderr.write(`dsh-os: ${error.message}\n`)
    return 1
  }
}
