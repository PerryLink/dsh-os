#!/usr/bin/env node
/**
 * dsh-os conformance suite — static checks for `packages/*`.
 *
 * Implements the machine-checkable parts of `docs/module-contract-v1.md` §1/§8.
 * Packages are split into two kinds:
 *
 *   plugin  — has `dsh.bundle`; full checks:
 *             patch exists and mentions the package name, dsh.os (service enum,
 *             tool prefix, capabilities, stability, since), bounded
 *             engines.dsh, zero runtime deps, `files` ships index.js /
 *             cordis.patch.yml / README.md, runtime <= 450 lines and no
 *             `console.log`.
 *   library — has `dsh.os` but no `dsh.bundle`; only manifest, zero-dependency
 *             and runtime-size checks. Patch/engines/tool-registration checks
 *             are skipped (it is not a mountable plugin).
 *
 * Wave 1 policy: packages without `dsh.os` are checked in warning mode (they do
 * not fail the run); packages that declare `dsh.os` must pass every applicable
 * check. Wave 2 加完 dsh.os 后，把 warning 改成 error：把下面的
 * `LEGACY_WARNINGS` 改成 `false`（届时所有包都声明 manifest，warning 会升为
 * error）。
 *
 * Pure Node, zero dependencies. Usage:
 *   node scripts/conformance.mjs [--json] [--strict] [--root <dir>]
 *
 * Exit codes: 0 = pass (warnings allowed), 1 = at least one error, 2 = bad usage.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

// Wave 2 TODO: after every package ships `dsh.os`, change this to `false`.
const LEGACY_WARNINGS = true

export const MAX_RUNTIME_LINES = 450

export const SERVICE_PREFIX = Object.freeze({
  act: 'act_',
  allow: 'allow_',
  snip: 'snip_',
  check: 'check_',
  nest: 'nest_',
  triggers: 'trigger_',
  evidence: 'seek_',
  trace: 'trace_',
  stage: 'stage_',
  ring: 'ring_',
  env: 'root_',
  help: 'help_',
  context: 'context_',
  cost: 'cost_',
  backup: 'backup_',
  notify: 'notify_',
  kernel: 'os_',
})

export const CAPABILITIES = Object.freeze([
  'fs.read',
  'fs.write',
  'net',
  'secret',
  'spawn',
  'model',
  'clipboard',
  'ui',
  'notify',
])

export const STABILITIES = Object.freeze(['experimental', 'stable', 'frozen', 'archived'])

const REQUIRED_FILES = Object.freeze(['index.js', 'cordis.patch.yml', 'README.md'])
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const TOOL_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/
const CONSOLE_LOG_PATTERN = /\bconsole\s*\.\s*log\s*\(/

const USAGE = `Usage: node scripts/conformance.mjs [options]

Options:
  --json         print the report as JSON (stdout only)
  --strict       treat Wave-1 warnings as errors (use after Wave 2)
  --root <dir>   repository root to scan (default: this repository)
  -h, --help     show this help

Exit codes: 0 = pass (warnings allowed), 1 = errors, 2 = bad usage.
`

/** Count lines the way an editor does: a trailing newline does not add a line. */
export function countLines(text) {
  if (text.length === 0) return 0
  const lines = text.split(/\r\n|\r|\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/**
 * Blank out comments and string literals while preserving newlines, so line
 * numbers stay accurate and `console.log` inside a string is not a hit.
 */
function codeOnly(text) {
  let out = ''
  let state = 'code'
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]

    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line-comment'
        out += ' '
        index += 1
      } else if (char === '/' && next === '*') {
        state = 'block-comment'
        out += ' '
        index += 1
      } else if (char === "'") {
        state = 'single'
        out += ' '
      } else if (char === '"') {
        state = 'double'
        out += ' '
      } else if (char === '`') {
        state = 'template'
        out += ' '
      } else {
        out += char
      }
      continue
    }

    if (state === 'line-comment') {
      if (char === '\n') {
        state = 'code'
        out += '\n'
      } else {
        out += ' '
      }
      continue
    }

    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        state = 'code'
        out += '  '
        index += 1
      } else {
        out += char === '\n' ? '\n' : ' '
      }
      continue
    }

    // Inside a string/template literal.
    if (char === '\\') {
      const escaped = text[index + 1]
      if (escaped === '\n') {
        out += '\n'
        index += 1
      } else if (escaped === '\r') {
        out += '\r'
        index += 1
        if (text[index + 1] === '\n') {
          out += '\n'
          index += 1
        }
      } else {
        out += '  '
        index += 1
      }
      continue
    }

    const closes = (state === 'single' && char === "'")
      || (state === 'double' && char === '"')
      || (state === 'template' && char === '`')
    if (closes) {
      state = 'code'
      out += ' '
    } else if (char === '\n') {
      // Unterminated literal: fail open to a new line.
      state = 'code'
      out += '\n'
    } else {
      out += ' '
    }
  }

  return out
}

/** Return the 1-based line numbers that contain a `console.log(...)` call. */
export function findConsoleLogLines(text) {
  return codeOnly(text)
    .split(/\r?\n/)
    .flatMap((line, index) => CONSOLE_LOG_PATTERN.test(line) ? [index + 1] : [])
}

/** Compare only the numeric x.y.z part; prerelease ordering is not needed here. */
function compareVersions(left, right) {
  const a = left.split('-')[0].split('.').map(Number)
  const b = right.split('-')[0].split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

function isFile(path) {
  const stats = statSync(path, { throwIfNoEntry: false })
  return Boolean(stats?.isFile())
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function toPosixPath(path) {
  return path.split(sep).join('/')
}

function checkBundlePatch(pkg, pkgDir, packageName, add) {
  const bundle = pkg.dsh?.bundle
  if (typeof bundle !== 'object' || bundle === null || Array.isArray(bundle)) {
    add('dsh.bundle', 'dsh.bundle must be an object')
    return
  }
  const patch = bundle.patch
  if (typeof patch !== 'string' || patch.trim() === '') {
    add('dsh.bundle.patch', 'dsh.bundle.patch must be a non-empty string when dsh.bundle is present')
    return
  }

  const absolute = resolve(pkgDir, patch)
  const inside = relative(pkgDir, absolute)
  if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) {
    add('dsh.bundle.patch-path', `dsh.bundle.patch escapes the package directory: ${patch}`)
    return
  }
  if (!isFile(absolute)) {
    add('dsh.bundle.patch-missing', `bundle patch not found: ${patch}`)
    return
  }

  const text = readFileSync(absolute, 'utf8')
  if (!text.includes(packageName)) {
    add('dsh.bundle.patch-name', `bundle patch ${patch} does not mention package name "${packageName}"`)
  }
}

function checkOs(os, pkg, add, { checkTools = true } = {}) {
  if (typeof os !== 'object' || os === null || Array.isArray(os)) {
    add('dsh.os.shape', 'dsh.os must be an object')
    return
  }

  // service: canonical Host seam name, or null for CLI-only modules.
  if (!hasOwn(os, 'service')) {
    add('dsh.os.service', 'dsh.os.service is required (see docs/module-contract-v1.md §3)')
  } else if (os.service !== null && !hasOwn(SERVICE_PREFIX, os.service)) {
    add(
      'dsh.os.service',
      `invalid service ${JSON.stringify(os.service)}; expected one of ${Object.keys(SERVICE_PREFIX).join(', ')} or null`,
    )
  }

  const prefix = typeof os.service === 'string' && hasOwn(SERVICE_PREFIX, os.service)
    ? SERVICE_PREFIX[os.service]
    : null

  // provides / requires: arrays of unique seam names.
  const checkStringArray = (value, code, required) => {
    if (value === undefined) {
      if (required) add(code, `${code} is required`)
      return
    }
    if (!Array.isArray(value)) {
      add(code, `${code} must be an array of strings`)
      return
    }
    const seen = new Set()
    for (const item of value) {
      if (typeof item !== 'string') {
        add(code, `${code} must contain only strings`)
        continue
      }
      if (seen.has(item)) add(`${code}-unique`, `${code} contains duplicate "${item}"`)
      seen.add(item)
    }
  }
  checkStringArray(os.provides, 'dsh.os.provides', true)
  checkStringArray(os.requires, 'dsh.os.requires', false)

  // capabilities: enum + unique.
  if (!hasOwn(os, 'capabilities')) {
    add('dsh.os.capabilities', 'dsh.os.capabilities is required')
  } else if (!Array.isArray(os.capabilities)) {
    add('dsh.os.capabilities', 'dsh.os.capabilities must be an array')
  } else {
    const seen = new Set()
    for (const capability of os.capabilities) {
      if (typeof capability !== 'string' || !CAPABILITIES.includes(capability)) {
        add(
          'dsh.os.capabilities',
          `invalid capability ${JSON.stringify(capability)}; expected one of ${CAPABILITIES.join(', ')}`,
        )
        continue
      }
      if (seen.has(capability)) add('dsh.os.capabilities-unique', `duplicate capability "${capability}"`)
      seen.add(capability)
    }
  }

  // tools: exact agent tool names, prefixed with the service's tool prefix.
  // Libraries (no dsh.bundle) skip the tool-registration surface entirely;
  // see the plugin/library split in checkPackage().
  if (checkTools) {
    if (!hasOwn(os, 'tools')) {
      add('dsh.os.tools', 'dsh.os.tools is required')
    } else if (!Array.isArray(os.tools)) {
      add('dsh.os.tools', 'dsh.os.tools must be an array')
    } else {
      const seen = new Set()
      for (const tool of os.tools) {
        if (typeof tool !== 'string') {
          add('dsh.os.tools', 'dsh.os.tools must contain only strings')
          continue
        }
        if (seen.has(tool)) add('dsh.os.tools-unique', `duplicate tool "${tool}"`)
        seen.add(tool)
        if (!TOOL_PATTERN.test(tool)) {
          add('dsh.os.tools', `tool "${tool}" does not match <prefix>_<verb>`)
        }
        if (prefix !== null && !tool.startsWith(prefix)) {
          add(
            'dsh.os.tools-prefix',
            `tool "${tool}" must start with "${prefix}" for service "${os.service}"`,
          )
        }
      }
    }
  }

  // stability enum.
  if (typeof os.stability !== 'string' || !STABILITIES.includes(os.stability)) {
    add(
      'dsh.os.stability',
      `invalid stability ${JSON.stringify(os.stability)}; expected one of ${STABILITIES.join(', ')}`,
    )
  }

  // since: a released semver version, not newer than the package.
  if (typeof os.since !== 'string' || !SEMVER_PATTERN.test(os.since)) {
    add('dsh.os.since', `invalid since ${JSON.stringify(os.since)}; expected a semver version`)
  } else if (typeof pkg.version === 'string' && SEMVER_PATTERN.test(pkg.version)) {
    if (compareVersions(os.since, pkg.version) > 0) {
      add('dsh.os.since-future', `since ${os.since} is newer than package version ${pkg.version}`)
    }
  }
}

/**
 * Check one package directory. Exported so tests can exercise it directly.
 * @returns {{name:string, dir:string, hasManifest:boolean, errors:object[], warnings:object[], ok:boolean}}
 */
export function checkPackage(pkgDir, { root, strict = false, legacyWarnings = LEGACY_WARNINGS } = {}) {
  const base = root ? resolve(root) : REPO_ROOT
  const relDir = toPosixPath(relative(base, pkgDir)) || toPosixPath(pkgDir)
  const fallbackName = relDir.split('/').pop() || pkgDir
  let pkg

  try {
    pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  } catch (error) {
    return {
      name: fallbackName,
      dir: relDir,
      kind: 'invalid',
      hasManifest: false,
      ok: false,
      errors: [{
        code: 'package.json',
        message: `cannot read ${relDir}/package.json: ${error.message}`,
        severity: 'error',
      }],
      warnings: [],
    }
  }

  const name = typeof pkg.name === 'string' && pkg.name ? pkg.name : fallbackName
  const hasDsh = typeof pkg.dsh === 'object' && pkg.dsh !== null && !Array.isArray(pkg.dsh)
  const declaresOs = hasDsh && hasOwn(pkg.dsh, 'os')
  const hasBundle = hasDsh && hasOwn(pkg.dsh, 'bundle')
  const kind = hasBundle ? 'plugin' : declaresOs ? 'library' : 'legacy'
  const errorMode = declaresOs || strict || !legacyWarnings

  const errors = []
  const warnings = []
  const add = (code, message, forceError = false) => {
    const target = forceError || errorMode ? errors : warnings
    target.push({ code, message, severity: target === errors ? 'error' : 'warning' })
  }

  if (!declaresOs) {
    add(
      'dsh.os.missing',
      'no dsh.os manifest yet (Wave 2); package checks are reported as warnings',
    )
  }

  // dsh envelope (manifestVersion + bundle patch when this is a bundle).
  if (!hasDsh) {
    add('dsh', 'package.json must contain a dsh object')
  } else {
    if (pkg.dsh.manifestVersion !== 1) {
      add('dsh.manifestVersion', 'dsh.manifestVersion must be 1')
    }
    if (hasBundle) checkBundlePatch(pkg, pkgDir, name, add)
  }

  // Plugin-only checks. A package without dsh.bundle is a library (types,
  // validators, CLI helper, ...): it ships no mountable patch and does not
  // declare the host tool surface. Per the wave-1 split requested by the lead,
  // libraries only get manifest + zero-dependency + runtime-size checks.
  if (hasBundle) {
    // engines.dsh: present and bounded above with `<`.
    const dshRange = pkg.engines?.dsh
    if (typeof dshRange !== 'string' || dshRange.trim() === '') {
      add('engines.dsh', 'engines.dsh is required')
    } else if (!/(?:^|\s)<\s*\d+\.\d+\.\d+/.test(dshRange)) {
      add(
        'engines.dsh.range',
        `engines.dsh must be a bounded range with a "<" upper bound: ${dshRange}`,
      )
    }

    // Published files: a mountable bundle ships index, patch and README.
    if (!Array.isArray(pkg.files)) {
      add('files', 'package.json must contain a files array')
    } else {
      const entries = new Set(
        pkg.files
          .filter(entry => typeof entry === 'string')
          .map(entry => entry.replace(/^\.\//, '')),
      )
      for (const required of REQUIRED_FILES) {
        if (!entries.has(required)) add('files.missing', `"files" must include "${required}"`)
      }
    }
  }

  // Zero runtime dependencies: applies to plugins and libraries alike.
  // The meta kit is the only documented exception (it installs other modules).
  const isKit = pkg.dsh && pkg.dsh.kit === true
  if (!isKit && pkg.dependencies !== undefined) {
    if (typeof pkg.dependencies !== 'object' || pkg.dependencies === null || Array.isArray(pkg.dependencies)) {
      add('dependencies', 'dependencies must be an object')
    } else {
      const deps = Object.keys(pkg.dependencies)
      if (deps.length > 0) {
        add('dependencies', `runtime dependencies are not allowed: ${deps.join(', ')}`)
      }
    }
  }

  // Runtime: size cap always; console.log is a plugin-entry rule (CLI/README
  // may log). Libraries are intentionally exempt from the console.log check.
  // A bundle's runtime entry is index.js; a library/CLI uses its `main`.
  const entryName = hasBundle
    ? 'index.js'
    : (typeof pkg.main === 'string' && pkg.main.trim() !== '' ? pkg.main : 'index.js')
  const entryPath = resolve(pkgDir, entryName)
  const entryInside = relative(pkgDir, entryPath)
  const entryIsInside = !isAbsolute(entryInside)
    && entryInside !== '..'
    && !entryInside.startsWith(`..${sep}`)
  if (!entryIsInside || !isFile(entryPath)) {
    add('runtime.index', `${entryName} is missing from the package directory`)
  } else {
    const runtime = readFileSync(entryPath, 'utf8')
    const lines = countLines(runtime)
    if (lines > MAX_RUNTIME_LINES) {
      add('runtime.lines', `${entryName} has ${lines} lines (max ${MAX_RUNTIME_LINES})`)
    }
    if (hasBundle) {
      const logLines = findConsoleLogLines(runtime)
      if (logLines.length > 0) {
        const shown = logLines.slice(0, 5).join(', ')
        const suffix = logLines.length > 5 ? `, ... (${logLines.length} total)` : ''
        add('runtime.console-log', `index.js uses console.log on line(s) ${shown}${suffix}`)
      }
    }
  }

  // dsh.os contract. Tool-registration checks only apply to mountable bundles;
  // a library may expose helper tools without a canonical Host service.
  if (declaresOs) checkOs(pkg.dsh.os, pkg, add, { checkTools: hasBundle })

  return {
    name,
    dir: relDir,
    kind,
    hasManifest: declaresOs,
    ok: errors.length === 0,
    errors,
    warnings,
  }
}

/** List `packages/*` directories, sorted. */
export function listPackageDirs(root) {
  const packagesDir = join(root, 'packages')
  if (!existsSync(packagesDir)) {
    throw new Error(`packages directory not found: ${packagesDir}`)
  }
  if (!statSync(packagesDir).isDirectory()) {
    throw new Error(`packages is not a directory: ${packagesDir}`)
  }
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
    .map(name => join(packagesDir, name))
}

/** Run every check and return a JSON-serialisable report. */
export function runConformance({
  root = REPO_ROOT,
  strict = false,
  legacyWarnings = LEGACY_WARNINGS,
} = {}) {
  const absoluteRoot = resolve(root)
  const packages = listPackageDirs(absoluteRoot).map(pkgDir =>
    checkPackage(pkgDir, { root: absoluteRoot, strict, legacyWarnings }))

  const errors = packages.reduce((total, result) => total + result.errors.length, 0)
  const warnings = packages.reduce((total, result) => total + result.warnings.length, 0)

  return {
    root: absoluteRoot,
    strict: Boolean(strict),
    ok: errors === 0,
    packages,
    summary: {
      packages: packages.length,
      passed: packages.filter(result => result.ok && result.warnings.length === 0).length,
      warned: packages.filter(result => result.ok && result.warnings.length > 0).length,
      failed: packages.filter(result => !result.ok).length,
      errors,
      warnings,
    },
  }
}

function statusOf(result) {
  if (result.errors.length > 0) return 'FAIL'
  if (result.warnings.length > 0) return 'WARN'
  return 'PASS'
}

/** Render the human-readable table + per-package details. */
export function formatReport(report) {
  const header = ['PACKAGE', 'KIND', 'dsh.os', 'ERRORS', 'WARNINGS', 'STATUS']
  const rows = report.packages.map(result => [
    result.name,
    result.kind,
    result.hasManifest ? 'yes' : 'no',
    String(result.errors.length),
    String(result.warnings.length),
    statusOf(result),
  ])
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map(row => row[index].length)))
  const formatRow = row => row.map((cell, index) => cell.padEnd(widths[index])).join('  ').trimEnd()

  const lines = [
    `dsh-os conformance — ${report.root}`,
    '',
    formatRow(header),
    ...rows.map(formatRow),
    '',
  ]

  for (const result of report.packages) {
    if (result.errors.length === 0 && result.warnings.length === 0) continue
    lines.push(`${result.name} (${result.dir}) — ${statusOf(result)}`)
    for (const issue of result.errors) lines.push(`  ERROR ${issue.code}: ${issue.message}`)
    for (const issue of result.warnings) lines.push(`  WARN  ${issue.code}: ${issue.message}`)
    lines.push('')
  }

  const { summary } = report
  lines.push(
    `${summary.packages} package(s): ${summary.errors} error(s), ${summary.warnings} warning(s) — ${report.ok ? 'PASS' : 'FAIL'}`,
  )
  if (report.ok && summary.warnings > 0) {
    lines.push('Warnings do not fail Wave 1; Wave 2 adds dsh.os, then flip LEGACY_WARNINGS to false.')
  }
  if (report.strict) {
    lines.push('Strict mode: Wave-1 warnings are treated as errors.')
  }

  return lines.join('\n')
}

function usageError(message, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`)
  } else {
    process.stderr.write(`conformance: ${message}\n\n${USAGE}`)
  }
  return 2
}

/** CLI entry point; returns the process exit code. */
export function main(argv = process.argv.slice(2)) {
  let json = false
  let strict = false
  let help = false
  let root = REPO_ROOT

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      json = true
    } else if (arg === '--strict') {
      strict = true
    } else if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === '--root') {
      const value = argv[index + 1]
      if (!value) return usageError('--root requires a value', json)
      root = value
      index += 1
    } else if (arg.startsWith('--root=')) {
      root = arg.slice('--root='.length)
      if (!root) return usageError('--root requires a value', json)
    } else {
      return usageError(`unknown argument "${arg}"`, json)
    }
  }

  if (help) {
    process.stdout.write(USAGE)
    return 0
  }

  let report
  try {
    report = runConformance({ root, strict })
  } catch (error) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`)
    } else {
      process.stderr.write(`conformance: ${error.message}\n`)
    }
    return 2
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`${formatReport(report)}\n`)
  }

  return report.ok ? 0 : 1
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) {
  process.exitCode = main()
}
