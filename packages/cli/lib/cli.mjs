import { CLI_PACKAGE, findRepoRoot, loadCatalog } from './catalog.mjs'
import { parseOptions } from './args.mjs'
import { runApprovals } from './approvals.mjs'
import {
  runDoctorCommand,
  runInfo,
  runInstall,
  runList,
  runUpdate,
} from './commands.mjs'
import { collectModules } from './modules.mjs'
import { DEFAULT_PROFILE, isSafeProfile } from './names.mjs'

const COMMANDS = new Set(['list', 'info', 'install', 'update', 'doctor', 'approvals'])

const HELP = `dsh-os ${CLI_PACKAGE.version} - offline catalog and installer helper for dsh-os modules

Usage:
  dsh-os list [--json] [--all]
  dsh-os info <module> [--json] [--profile <name>]
  dsh-os install <module...> [--profile <name>] [--run]
  dsh-os update [--profile <name>]
  dsh-os doctor
  dsh-os approvals list|approve|deny [options]

Options:
  --json       machine-readable output (list, info, approvals list)
  --all        include optional/planned modules in list
  --profile    DeepSeek Harness profile (default: ${DEFAULT_PROFILE})
  --run        execute "dsh plugin" instead of only printing it (install)
  --state      Allow stateFile JSON for approvals (default: $DSH_OS_ALLOW_STATE)
  -h, --help   show this help
  -v, --version  show the CLI version

Modules may be referenced by package name (dsh-act), product (Act) or
service (act, ctx.act). The CLI never contacts a registry and never writes
a profile or any other user configuration. "approvals" edits only the Allow
state file passed with --state; run "dsh-os approvals --help" for details.
`

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
    if (command === 'approvals') return runApprovals(args, { stdout, stderr })
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
