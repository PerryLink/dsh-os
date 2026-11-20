#!/usr/bin/env node
/**
 * Enforce the release invariants for every workspace package:
 *   - `version` is a valid semver version;
 *   - `engines.dsh` exists and declares an upper bound (so DSH 0.3 cannot
 *     load an incompatible 0.2 plugin);
 *   - `publishConfig.registry` points at the public npm registry;
 *   - `dependencies` is empty (host services come from DSH / Cordis).
 *
 * Zero dependencies. Exits non-zero if any package violates an invariant.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PACKAGES_DIR = join(ROOT, 'packages')
const NPM_REGISTRY = 'https://registry.npmjs.org'

// https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/** True when every `||` alternative of a semver range has an upper bound. */
function hasUpperBound(range) {
  if (typeof range !== 'string' || range.trim() === '') return false
  return range.split('||').every(part => {
    const alternative = part.trim()
    if (alternative === '' || alternative === '*' || alternative === 'latest') return false
    // Hyphen ranges (`0.2.1 - 0.3.0`) always have an upper endpoint.
    if (/\s-\s/.test(alternative)) return true
    // `<` / `<=` comparators (but not `>=` / `=>`).
    return /(?:^|\s)<\s*\S+/.test(alternative)
  })
}

function emptyDependencies(manifest) {
  const dependencies = manifest.dependencies
  if (dependencies === undefined) return { ok: true, count: 0 }
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    return { ok: false, count: '?' }
  }
  const count = Object.keys(dependencies).length
  return { ok: count === 0, count }
}

function printTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map(row => String(row[index]).length)),
  )
  const render = cells => cells.map((cell, index) => String(cell).padEnd(widths[index])).join('  ')
  console.log(render(headers))
  console.log(widths.map(width => '-'.repeat(width)).join('  '))
  for (const row of rows) console.log(render(row))
}

const directories = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort()

if (directories.length === 0) {
  console.error('check-versions: no packages found under packages/')
  process.exit(1)
}

const rows = []
const failures = []
const seenNames = new Map()

for (const dir of directories) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(PACKAGES_DIR, dir, 'package.json'), 'utf8'))
  } catch (error) {
    rows.push([dir, '-', '-', '-', '-', '-', 'FAIL'])
    failures.push(`${dir}: cannot read package.json (${error.message})`)
    continue
  }

  const name = typeof manifest.name === 'string' ? manifest.name : dir
  const version = typeof manifest.version === 'string' ? manifest.version : ''
  const isBundle = Boolean(manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch)
  const dsh = manifest.engines?.dsh
  const registry = manifest.publishConfig?.registry
  const dependencies = emptyDependencies(manifest)
  const issues = []

  if (version === '') {
    issues.push('missing version')
  } else if (!SEMVER.test(version)) {
    issues.push(`invalid semver version "${version}"`)
  }

  if (isBundle && dsh === undefined) {
    issues.push('missing engines.dsh')
  } else if (dsh !== undefined && !hasUpperBound(dsh)) {
    issues.push(`engines.dsh "${dsh}" has no upper bound`)
  }

  if (typeof registry !== 'string') {
    issues.push('missing publishConfig.registry')
  } else if (registry.replace(/\/+$/, '').toLowerCase() !== NPM_REGISTRY) {
    issues.push(`publishConfig.registry is not ${NPM_REGISTRY}/ ("${registry}")`)
  }

  if (!dependencies.ok) {
    issues.push(`dependencies must be empty (found ${dependencies.count})`)
  }

  if (seenNames.has(name)) {
    issues.push(`duplicate package name (also in packages/${seenNames.get(name)})`)
  } else {
    seenNames.set(name, dir)
  }

  rows.push([
    dir,
    name,
    version || '-',
    typeof dsh === 'string' && dsh !== '' ? dsh : '-',
    typeof registry === 'string' ? registry.replace(/^https?:\/\//, '').replace(/\/+$/, '') : '-',
    String(dependencies.count),
    issues.length === 0 ? 'ok' : 'FAIL',
  ])

  if (issues.length > 0) failures.push(`${name}: ${issues.join('; ')}`)
}

printTable(['dir', 'package', 'version', 'engines.dsh', 'registry', 'deps', 'status'], rows)
console.log('')

for (const failure of failures) console.error(`FAIL ${failure}`)
console.log(`check-versions: ${rows.length} package(s), ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
