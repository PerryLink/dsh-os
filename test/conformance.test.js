import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { countLines, findConsoleLogLines } from '../scripts/conformance.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts', 'conformance.mjs')
const FIXTURES = join(ROOT, 'test', 'fixtures', 'conformance')

function run(fixture, args = []) {
  return spawnSync(
    process.execPath,
    [SCRIPT, '--root', join(FIXTURES, fixture), ...args],
    { encoding: 'utf8' },
  )
}

function runJson(fixture, args = []) {
  const result = run(fixture, ['--json', ...args])
  assert.equal(result.stderr, '', '--json must not write to stderr')
  assert.ok(result.status === 0 || result.status === 1, `unexpected exit ${result.status}`)
  return { result, report: JSON.parse(result.stdout) }
}

function packageNamed(report, name) {
  const found = report.packages.find(entry => entry.name === name)
  assert.ok(found, `report is missing package ${name}`)
  return found
}

const codes = issues => issues.map(issue => issue.code)

test('a fully conformant plugin passes with no warnings', () => {
  const { result, report } = runJson('good')

  assert.equal(result.status, 0)
  assert.equal(report.ok, true)
  assert.deepEqual(report.summary, {
    packages: 1,
    passed: 1,
    warned: 0,
    failed: 0,
    errors: 0,
    warnings: 0,
  })

  const pkg = packageNamed(report, 'dsh-good')
  assert.equal(pkg.kind, 'plugin')
  assert.equal(pkg.hasManifest, true)
  assert.deepEqual(pkg.errors, [])
  assert.deepEqual(pkg.warnings, [])
})

test('a library with dsh.os but no dsh.bundle skips plugin-only checks', () => {
  const { result, report } = runJson('library')

  assert.equal(result.status, 0)
  assert.equal(report.ok, true)
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)

  const pkg = packageNamed(report, 'dsh-library')
  assert.equal(pkg.kind, 'library')
  assert.equal(pkg.hasManifest, true)
  assert.deepEqual(pkg.errors, [])
  assert.deepEqual(pkg.warnings, [])
})

test('a malformed manifest is rejected', () => {
  const { result, report } = runJson('bad')
  assert.equal(result.status, 1)
  assert.equal(report.ok, false)

  const manifestCodes = codes(packageNamed(report, 'dsh-bad-manifest').errors)
  for (const expected of [
    'dsh.manifestVersion',
    'engines.dsh.range',
    'files.missing',
    'dependencies',
    'runtime.console-log',
    'dsh.os.capabilities',
    'dsh.os.capabilities-unique',
    'dsh.os.tools-prefix',
    'dsh.os.stability',
    'dsh.os.since',
  ]) {
    assert.ok(manifestCodes.includes(expected), `expected ${expected}, got ${manifestCodes.join(', ')}`)
  }
})

test('a service outside the canonical enum is rejected', () => {
  const { result, report } = runJson('bad')
  assert.equal(result.status, 1)

  const pkg = packageNamed(report, 'dsh-bad-service')
  assert.equal(pkg.ok, false)
  assert.ok(codes(pkg.errors).includes('dsh.os.service'))
})

test('a bundle patch that names another package is rejected', () => {
  const { result, report } = runJson('bad')
  assert.equal(result.status, 1)

  const pkg = packageNamed(report, 'dsh-bad-patch')
  assert.deepEqual(codes(pkg.errors), ['dsh.bundle.patch-name'])
  assert.match(pkg.errors[0].message, /does not mention package name "dsh-bad-patch"/)
})

test('a runtime over 450 lines is rejected', () => {
  const { result, report } = runJson('bad')
  assert.equal(result.status, 1)

  const pkg = packageNamed(report, 'dsh-too-long')
  assert.deepEqual(codes(pkg.errors), ['runtime.lines'])
  assert.match(pkg.errors[0].message, /451 lines \(max 450\)/)
})

test('a Wave-1 package without dsh.os warns but still exits 0', () => {
  const { result, report } = runJson('legacy')

  assert.equal(result.status, 0)
  assert.equal(report.ok, true)
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 2)

  const pkg = packageNamed(report, 'dsh-legacy')
  assert.equal(pkg.kind, 'plugin')
  assert.equal(pkg.ok, true)
  assert.deepEqual(codes(pkg.warnings), ['dsh.os.missing', 'dsh.bundle.patch-name'])
})

test('--strict promotes Wave-1 warnings to errors', () => {
  const { result, report } = runJson('legacy', ['--strict'])

  assert.equal(result.status, 1)
  assert.equal(report.ok, false)
  assert.equal(report.strict, true)

  const pkg = packageNamed(report, 'dsh-legacy')
  assert.deepEqual(codes(pkg.errors), ['dsh.os.missing', 'dsh.bundle.patch-name'])
  assert.deepEqual(pkg.warnings, [])
})

test('human output includes the table and issue details', () => {
  const result = run('bad')
  assert.equal(result.status, 1)
  assert.match(result.stdout, /PACKAGE\s+KIND\s+dsh\.os\s+ERRORS\s+WARNINGS\s+STATUS/)
  assert.match(result.stdout, /dsh-bad-manifest\s+plugin\s+yes/)
  assert.match(result.stdout, /ERROR dsh\.os\.tools-prefix:/)
  assert.match(result.stdout, /package\(s\): \d+ error\(s\), \d+ warning\(s\) — FAIL/)
})

test('human output reports a clean pass', () => {
  const result = run('good')
  assert.equal(result.status, 0)
  assert.match(result.stdout, /PASS/)
  assert.match(result.stdout, /1 package\(s\): 0 error\(s\), 0 warning\(s\) — PASS/)
})

test('countLines follows editor semantics', () => {
  assert.equal(countLines(''), 0)
  assert.equal(countLines('one'), 1)
  assert.equal(countLines('one\n'), 1)
  assert.equal(countLines('one\ntwo\n'), 2)
})

test('findConsoleLogLines ignores comments but reports real calls', () => {
  const source = [
    "const x = 'console.log not a call'",
    '// console.log(\'commented out\')',
    '/* console.log(\'block comment\') */',
    'console.log(x)',
  ].join('\n')
  assert.deepEqual(findConsoleLogLines(source), [4])
})

test('bad usage exits 2', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--unknown'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /unknown argument "--unknown"/)
})
