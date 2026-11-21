/**
 * dsh-help — read-only install doctor and first-run wizard for DeepSeek Harness.
 *
 * The service inspects the Cordis context with `ctx.get(...)` and returns
 * findings and command plans. It never installs, spawns a process, writes a
 * file or opens a socket: the user runs every returned command.
 * @module dsh-help
 */

/** Cordis plugin name. */
export const name = 'dsh-help'

/** The tool registry is optional; the service works without it. */
export const inject = ['tools']

export const PRODUCT = 'Help'
export const PROFILE = 'web'
export const NODE_RANGE = '^22.19.0 || >=24.9.0'

/**
 * The 11 dsh-os modules in dependency-safe installation order: Allow before
 * Act, Check standalone, then the rest in catalog order.
 */
export const MODULES = Object.freeze([
  { product: 'Check', package: 'dsh-canary', service: 'check' },
  { product: 'Allow', package: 'dsh-allow', service: 'allow' },
  { product: 'Act', package: 'dsh-act', service: 'act' },
  { product: 'Snip', package: 'dsh-snip', service: 'snip' },
  { product: 'Nest', package: 'dsh-nest', service: 'nest' },
  { product: 'Trigger', package: 'dsh-trigger', service: 'triggers' },
  { product: 'Seek', package: 'dsh-seek', service: 'evidence' },
  { product: 'Trace', package: 'dsh-record', service: 'trace' },
  { product: 'Stage', package: 'dsh-stage', service: 'stage' },
  { product: 'Ring', package: 'dsh-ring', service: 'ring' },
  { product: 'Root', package: 'dsh-runtime-env', service: 'env' },
])

/** The one command shape this module ever emits. */
export const addCommand = packageName => `dsh plugin --profile ${PROFILE} add ${packageName}`

const fail = (code, message) => {
  throw Object.assign(new Error(message), { code })
}

/** Check the declared Node range without a semver dependency. */
export function checkNode(version = process.version) {
  const match = /^v?(\d+)\.(\d+)\./.exec(String(version))
  if (match === null) return { version: String(version), required: NODE_RANGE, ok: false }
  const major = Number(match[1])
  const minor = Number(match[2])
  const ok = major > 24 || (major === 24 && minor >= 9) || (major === 22 && minor >= 19)
  return { version: String(version), required: NODE_RANGE, ok }
}

/** Read the DSH version from the context seam, then the environment, else unknown. */
export function checkDshVersion(ctx) {
  if (ctx && typeof ctx.get === 'function') {
    try {
      const value = ctx.get('dshVersion')
      if (typeof value === 'string' && value.trim() !== '') return { version: value.trim(), source: 'ctx' }
      if (value && typeof value === 'object' && typeof value.version === 'string' && value.version.trim() !== '') {
        return { version: value.version.trim(), source: 'ctx' }
      }
    } catch {
      // A missing or throwing seam means "unknown", not a doctor error.
    }
  }
  const fallback = typeof process !== 'undefined' ? process.env.DSH_VERSION : undefined
  if (typeof fallback === 'string' && fallback.trim() !== '') return { version: fallback.trim(), source: 'env' }
  return { version: 'unknown', source: 'unknown' }
}

/** Normalize package, product and service names into one lookup key. */
const normalizeKey = value =>
  String(value).trim().toLowerCase().replace(/^@[^/]+\//, '').replace(/^dsh-/, '')

const ALIASES = new Map()
for (const module of MODULES) {
  for (const alias of [module.product, module.package, module.package.replace(/^@[^/]+\//, ''), module.service]) {
    ALIASES.set(normalizeKey(alias), module)
  }
}

/** Host seam `ctx.help`: install doctor, first-run guide and install planner. */
export class HelpService {
  #ctx

  constructor(ctx) {
    this.#ctx = ctx
  }

  /** True when a dsh-os module's Host seam answers through `ctx.get`. */
  #installed(service) {
    if (!this.#ctx || typeof this.#ctx.get !== 'function') return false
    try {
      const value = this.#ctx.get(service)
      return value !== undefined && value !== null && value !== false
    } catch {
      return false
    }
  }

  /** Read-only health report: Node, DSH version, installed and missing modules. */
  doctor() {
    const node = checkNode()
    const dsh = checkDshVersion(this.#ctx)
    const modules = MODULES.map(module => ({ ...module, installed: this.#installed(module.service) }))
    const installed = modules.filter(module => module.installed).map(module => module.service)
    const missing = modules
      .filter(module => !module.installed)
      .map(({ product, package: packageName, service }) => ({
        product,
        package: packageName,
        service,
        command: addCommand(packageName),
      }))
    const suggestions = missing.map(module => module.command)
    if (!node.ok) suggestions.unshift(`# install Node.js ${NODE_RANGE}`)
    if (dsh.version === 'unknown') suggestions.push('# set DSH_VERSION (or use ctx.dshVersion) to report the DSH version')
    if (suggestions.length === 0) suggestions.push('dsh --dump-config')
    return {
      ok: node.ok && missing.length === 0,
      node,
      dsh,
      modules,
      installed,
      missing,
      suggestions,
      summary:
        `${installed.length}/${modules.length} dsh-os modules installed; `
        + `Node ${node.version} ${node.ok ? 'ok' : `does not satisfy ${NODE_RANGE}`}; DSH ${dsh.version}`,
    }
  }

  /** The five-step first-run quickstart; one command per step. */
  firstRun() {
    const steps = [
      {
        step: 1,
        id: 'install-check',
        title: 'Install Check',
        command: addCommand('dsh-canary'),
        note: 'Check is standalone. It diffs runs and has no module dependencies.',
      },
      {
        step: 2,
        id: 'generate-run',
        title: 'Generate a run',
        command: 'dsh --profile headless --json "<task>" > run-baseline.ndjson',
        note: 'Headless emits NDJSON. Normalize one environment per file into dsh.check.run/v1 '
          + 'run JSON (run-baseline.json, run-candidate.json) before step 3; the Check runner '
          + 'does this automatically from 0.2.0.',
      },
      {
        step: 3,
        id: 'diff',
        title: 'Diff two runs',
        command: 'dsh-check diff --old run-baseline.json --new run-candidate.json',
        note: 'Exit codes: 0 pass or warning, 1 regression, 2 usage error; add --json for the report.',
      },
      {
        step: 4,
        id: 'install-act-allow',
        title: 'Install Act and Allow',
        command: `${addCommand('dsh-allow')} && ${addCommand('dsh-act')}`,
        note: 'Allow first: Act checks Allow grants before invoking an action.',
      },
      {
        step: 5,
        id: 'inspect-config',
        title: 'Inspect the composed profile',
        command: 'dsh --dump-config',
        note: 'Prints the composed profile tree and exits; no task runs.',
      },
    ]
    return { title: 'dsh-os first run', total: steps.length, steps }
  }

  /**
   * Turn module names (package, product or service) into an ordered plan.
   * The plan is data only: nothing is installed and no command is executed.
   */
  installPlan(modules) {
    if (!Array.isArray(modules)) fail('E_INVALID_ARGUMENT', 'modules must be an array of strings')
    const requested = new Map()
    modules.forEach((raw, index) => {
      if (typeof raw !== 'string' || raw.trim() === '') {
        fail('E_INVALID_ARGUMENT', `modules[${index}] must be a non-empty string`)
      }
      const module = ALIASES.get(normalizeKey(raw))
      if (module === undefined) {
        fail('E_INVALID_ARGUMENT', `unknown module "${raw}"; expected one of ${MODULES.map(item => item.package).join(', ')}`)
      }
      requested.set(module.service, module)
    })
    const order = MODULES.filter(module => requested.has(module.service))
    const steps = order.map((module, index) => ({
      step: index + 1,
      product: module.product,
      package: module.package,
      service: module.service,
      command: addCommand(module.package),
      requires: module.service === 'act' ? ['allow'] : [],
    }))
    return {
      ok: true,
      profile: PROFILE,
      modules: order.map(module => module.service),
      packages: order.map(module => module.package),
      steps,
      commands: steps.map(step => step.command),
      empty: steps.length === 0,
      ...(steps.length === 0
        ? { note: `No modules requested. Start with Check: ${addCommand('dsh-canary')}` }
        : {}),
      dependencies: [
        { product: 'Act', requires: ['allow'] },
        { product: 'Check', requires: [] },
      ],
      executes: false,
    }
  }
}

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

const noArgs = { type: 'object', additionalProperties: false, properties: {} }

/** Plain ToolDefinition objects; no dependency on `@deepseek-ai/dsh-tools`. */
export function createTools(service) {
  return [
    {
      name: 'help_doctor',
      description: 'Check Node, the DSH version and which dsh-os modules are installed; '
        + 'list missing modules and suggested install commands. Read-only.',
      parameters: noArgs,
      output: OUTPUT,
      async execute() {
        return service.doctor()
      },
    },
    {
      name: 'help_first_run',
      description: 'Return the five-step dsh-os quickstart (Check, run, diff, Act/Allow, '
        + '--dump-config) with one command per step. Read-only.',
      parameters: noArgs,
      output: OUTPUT,
      async execute() {
        return service.firstRun()
      },
    },
    {
      name: 'help_install_plan',
      description: 'Turn module names into an ordered `dsh plugin --profile web add ...` plan '
        + '(Allow before Act; Check independent). Returns the commands; never installs.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          modules: {
            type: 'array',
            items: { type: 'string' },
            description: 'Package, product or service names; may be empty for a next-step hint.',
          },
        },
        required: ['modules'],
      },
      output: OUTPUT,
      async execute(args) {
        return service.installPlan(args?.modules)
      },
    },
  ]
}

/** Mount the plugin at `ctx.help` and register the three agent tools. */
export function apply(ctx, config = {}) {
  const service = new HelpService(ctx, config)
  ctx.provide('help', service)
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    for (const definition of createTools(service)) ctx.tools.register(definition)
  }
  return service
}
