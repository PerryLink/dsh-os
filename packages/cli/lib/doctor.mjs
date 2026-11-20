import { CATALOG_PATH, CLI_PACKAGE, readRootPackage } from './catalog.mjs'
import { inspectUpperBound, parseRange, parseVersion, satisfies } from './semver.mjs'

const STABILITIES = new Set(['experimental', 'stable', 'frozen', 'archived'])

export function runDoctor(context) {
  const checks = []
  const add = (level, subject, message) => checks.push({ level, subject, message })

  add(
    'ok',
    'catalog',
    `${context.entries.length} module(s) listed, ${context.optional.length} optional`,
  )

  const rootPackage = context.repoRoot ? readRootPackage(context.repoRoot) : null
  if (context.mode === 'repo') {
    add('ok', 'workspace', context.repoRoot)
    if (!rootPackage) {
      add('error', 'package.json', 'cannot read the workspace root package.json')
    } else if (typeof rootPackage.engines?.node !== 'string') {
      add('warn', 'node', 'workspace root has no engines.node; checked against the CLI requirement')
    }
  } else {
    add('warn', 'workspace', 'not in a dsh-os checkout; package manifest checks were skipped')
  }

  const nodeVersion = process.versions.node
  const nodeRange = rootPackage?.engines?.node || CLI_PACKAGE.engines?.node
  if (!nodeRange) {
    add('warn', 'node', `v${nodeVersion}; no engines.node declared`)
  } else if (!parseRange(nodeRange).valid) {
    add('error', 'node', `invalid engines.node range "${nodeRange}"`)
  } else if (!satisfies(nodeVersion, nodeRange)) {
    add('error', 'node', `v${nodeVersion} does not satisfy engines.node "${nodeRange}"`)
  } else {
    add('ok', 'node', `v${nodeVersion} satisfies engines.node "${nodeRange}"`)
  }

  if (context.mode === 'repo') {
    if (context.packages.length === 0) {
      add('warn', 'workspace', 'no package.json found under packages/')
    }
    for (const item of context.packages) {
      const pkg = item.pkg
      if (item.error || !pkg || typeof pkg !== 'object') {
        add('error', `packages/${item.name}`, 'invalid package.json')
        continue
      }
      if (typeof pkg.name !== 'string' || pkg.name === '') {
        add('error', `packages/${item.name}`, 'package.json has no name')
        continue
      }

      const catalogEntry = context.catalog.find(entry => entry.name === pkg.name)
      // Not a product module (contract, shell, CLI, tooling): out of scope.
      if (!catalogEntry) continue
      const os = pkg.dsh?.os

      const findings = []
      if (!parseVersion(pkg.version)) {
        findings.push(['error', `invalid or missing version "${pkg.version ?? ''}"`])
      } else if (catalogEntry.version !== pkg.version) {
        findings.push([
          'warn',
          `version ${pkg.version} differs from catalog ${catalogEntry.version}; run "node packages/cli/scripts/build-catalog.mjs"`,
        ])
      }

      if (!os) {
        findings.push(['warn', 'missing dsh.os manifest'])
      } else {
        if (os.service !== undefined && os.service !== null && typeof os.service !== 'string') {
          findings.push(['warn', 'dsh.os.service must be a string or null'])
        } else if (os.service !== undefined && os.service !== catalogEntry.service) {
          findings.push([
            'warn',
            `dsh.os.service "${os.service}" differs from catalog "${catalogEntry.service}"`,
          ])
        }
        if (!STABILITIES.has(os.stability)) {
          findings.push([
            'warn',
            `dsh.os.stability "${os.stability ?? ''}" is not one of ${[...STABILITIES].join(', ')}`,
          ])
        }
      }

      const dshRange = pkg.engines?.dsh
      if (typeof dshRange !== 'string' || dshRange.trim() === '') {
        findings.push(['error', 'missing engines.dsh range'])
      } else {
        const upper = inspectUpperBound(dshRange)
        if (!upper.valid) {
          findings.push(['error', `invalid engines.dsh range "${dshRange}"`])
        } else if (!upper.bounded) {
          findings.push(['error', `engines.dsh "${dshRange}" has no upper bound`])
        }
      }

      if (findings.length === 0) {
        add('ok', pkg.name, `version ${pkg.version}; engines.dsh bounded; dsh.os present`)
      } else {
        for (const [level, message] of findings) add(level, pkg.name, message)
      }
    }
  }

  const errors = checks.filter(check => check.level === 'error').length
  const warnings = checks.filter(check => check.level === 'warn').length
  return { checks, errors, warnings }
}

export function formatDoctor(result, context) {
  const lines = [
    `dsh-os doctor (${CLI_PACKAGE.name}@${CLI_PACKAGE.version})`,
    context.repoRoot
      ? `mode: repo (${context.repoRoot})`
      : `mode: catalog (${CATALOG_PATH})`,
    '',
  ]
  for (const check of result.checks) {
    lines.push(`[${check.level}] ${check.subject}: ${check.message}`)
  }
  lines.push('', `${result.errors} error(s), ${result.warnings} warning(s)`)
  return `${lines.join('\n')}\n`
}
