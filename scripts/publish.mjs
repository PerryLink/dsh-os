#!/usr/bin/env node
/**
 * Publish selected workspace packages with npm.
 * Usage: node scripts/publish.mjs [act allow ...]
 * Without arguments, publishes every package whose version is not on npm yet.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = new URL('..', import.meta.url).pathname
const NPMRC = join(ROOT, '.npmrc')
const KEY = join(ROOT, '..', 'deepseek-community-hub', '00-live', '_key.mjs')

if (existsSync(KEY)) {
  await import(KEY)
}
if (!process.env.NPM_TOKEN) {
  console.error('NPM_TOKEN is missing; refusing to publish')
  process.exit(1)
}
if (!existsSync(NPMRC)) {
  console.error('.npmrc is missing')
  process.exit(1)
}

const wanted = new Set(process.argv.slice(2))
const packages = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .filter(dir => wanted.size === 0 || wanted.has(dir))

const env = { ...process.env, NPM_CONFIG_USERCONFIG: NPMRC, NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/' }

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, env, encoding: 'utf8' })
}

let published = 0
let skipped = 0
let failed = 0

for (const dir of packages) {
  const pkgDir = join(ROOT, 'packages', dir)
  const manifestPath = join(pkgDir, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const { name, version } = manifest

  const view = run('npm', ['view', `${name}@${version}`, 'version', '--json'], ROOT)
  if (view.status === 0 && view.stdout.trim()) {
    console.log(`skip ${name}@${version} (already published)`)
    skipped += 1
    continue
  }

  const result = run('npm', ['publish', '--access', 'public', '--ignore-scripts', '--no-audit', '--no-fund'], pkgDir)
  if (result.status === 0) {
    console.log(`published ${name}@${version}`)
    published += 1
  } else {
    console.error(`failed ${name}@${version}`)
    console.error((result.stderr || result.stdout || '').trim().slice(0, 1200))
    failed += 1
  }
}

console.log(`\npublish: ${published} published, ${skipped} skipped, ${failed} failed`)
if (failed > 0) process.exit(1)
