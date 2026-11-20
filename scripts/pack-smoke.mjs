#!/usr/bin/env node
/**
 * Pack smoke test for every workspace package.
 *
 * For each `packages/*` directory this runs
 *   npm pack --dry-run --json
 * and verifies that the tarball contains the files a DSH bundle needs:
 * package.json, index.js, cordis.patch.yml, README.md and LICENSE.
 *
 * Zero dependencies, no network access, and no tarball is written.
 * Exits non-zero if any package fails or a tarball lacks a required file.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PACKAGES_DIR = join(ROOT, 'packages')
const BUNDLE_REQUIRED = ['package.json', 'index.js', 'cordis.patch.yml', 'README.md', 'LICENSE']
const LIBRARY_REQUIRED = ['package.json', 'README.md', 'LICENSE']
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} kB`
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

function fail(dir, rows, failures, message, version = '-', files = '-', size = '-') {
  rows.push([dir, dir, version, files, size, 'FAIL'])
  failures.push(`${dir}: ${message}`)
}

const directories = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort()

if (directories.length === 0) {
  console.error('pack-smoke: no packages found under packages/')
  process.exit(1)
}

const rows = []
const failures = []

for (const dir of directories) {
  const packageDir = join(PACKAGES_DIR, dir)

  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  } catch (error) {
    fail(dir, rows, failures, `cannot read package.json (${error.message})`)
    continue
  }

  const name = typeof manifest.name === 'string' ? manifest.name : dir
  const version = typeof manifest.version === 'string' ? manifest.version : '-'

  const result = spawnSync(NPM, ['pack', '--dry-run', '--json'], {
    cwd: packageDir,
    encoding: 'utf8',
    // npm.cmd needs a shell on Windows; CI and POSIX keep the fast path.
    shell: process.platform === 'win32',
  })
  if (result.error) {
    fail(dir, rows, failures, `cannot run ${NPM}: ${result.error.message}`, version)
    continue
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' | ')
    fail(dir, rows, failures, `npm pack exited ${result.status}${detail ? `: ${detail}` : ''}`, version)
    continue
  }

  let report
  try {
    report = JSON.parse(result.stdout)
  } catch (error) {
    fail(dir, rows, failures, `npm pack did not return JSON (${error.message})`, version)
    continue
  }

  const entry = Array.isArray(report) ? report[0] : report
  if (!entry || !Array.isArray(entry.files)) {
    fail(dir, rows, failures, 'npm pack JSON has no files list', version)
    continue
  }

  const files = new Set(entry.files.map(file => String(file.path ?? '').replace(/^\.\//, '')))
  const isBundle = Boolean(manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch)
  const required = isBundle ? BUNDLE_REQUIRED : LIBRARY_REQUIRED
  const missing = required.filter(file => !files.has(file))
  const binFiles = Object.values(manifest.bin ?? {}).map(value => String(value).replace(/^\.\//, ''))
  const hasEntry = files.has('index.js') || binFiles.some(file => files.has(file))
  if (!isBundle && !hasEntry) missing.push('index.js or a bin entry')

  if (missing.length > 0) {
    rows.push([dir, name, version, String(files.size), formatSize(entry.size), 'FAIL'])
    failures.push(
      `${name}: tarball is missing ${missing.join(', ')} ` +
        `(contains: ${[...files].join(', ') || 'nothing'})`,
    )
    continue
  }

  rows.push([dir, name, version, String(files.size), formatSize(entry.size), 'ok'])
}

printTable(['dir', 'package', 'version', 'files', 'size', 'status'], rows)
console.log('')

for (const failure of failures) console.error(`FAIL ${failure}`)
console.log(`pack-smoke: ${rows.length} package(s), ${failures.length} failed`)
if (failures.length > 0) process.exit(1)
