#!/usr/bin/env node
/**
 * Run `node --test` for every package that has a test directory.
 */
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = new URL('..', import.meta.url).pathname
const packages = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)

let failed = 0
let ran = 0
for (const dir of packages) {
  const pkgDir = join(ROOT, 'packages', dir)
  if (!existsSync(join(pkgDir, 'test'))) continue
  ran += 1
  const result = spawnSync('node', ['--test'], { cwd: pkgDir, encoding: 'utf8' })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  if (result.status !== 0) failed += 1
}

if (existsSync(join(ROOT, 'test'))) {
  ran += 1
  const result = spawnSync('node', ['--test'], { cwd: ROOT, encoding: 'utf8' })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  if (result.status !== 0) failed += 1
}
console.log(`\ntest: ${ran} package(s), ${failed} failed`)
if (failed > 0) process.exit(1)
