#!/usr/bin/env node
/**
 * Guard the README media that upstream feature commits keep clobbering:
 * the hero webp, the structure flow svg and the demo gif must all be
 * referenced from docs/assets/, and every local docs/assets/ reference in
 * README.md must resolve to a file in the checkout.
 *
 * Zero dependencies. Exits non-zero when a family media reference is missing
 * or when a referenced asset does not exist on disk.
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const README = join(ROOT, 'README.md')

let readme
try {
  readme = readFileSync(README, 'utf8')
} catch (error) {
  console.error(`readme-media: cannot read README.md (${error.code ?? error.message})`)
  process.exit(1)
}

// The family convention names the assets after the package:
// <name>-hero-*.webp, <name>-flow-*.svg, <name>-demo.gif.
let base = basename(ROOT)
try {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  if (typeof manifest.name === 'string' && manifest.name !== '') {
    base = manifest.name.replace(/^@[^/]+\//, '')
  }
} catch {
  // No readable package.json: keep the directory name as the family base.
}

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const required = [
  { label: `hero webp (docs/assets/${base}-hero-*.webp)`, pattern: new RegExp(`docs/assets/${escape(base)}-hero-[^\\s\"'()]+\\.webp`) },
  { label: `structure flow svg (docs/assets/${base}-flow*.svg)`, pattern: new RegExp(`docs/assets/${escape(base)}-flow[^\\s\"'()]*\\.svg`) },
  { label: `demo gif (docs/assets/${base}-demo.gif)`, pattern: new RegExp(`docs/assets/${escape(base)}-demo\\.gif`) },
]

const problems = []
for (const { label, pattern } of required) {
  if (!pattern.test(readme)) problems.push(`README.md is missing the ${label} reference`)
}

const referenced = [...new Set(readme.match(/docs\/assets\/[A-Za-z0-9._/@-]+/g) ?? [])]
for (const target of referenced) {
  if (target.includes('..') || target.endsWith('/')) continue
  if (!existsSync(join(ROOT, target))) {
    problems.push(`README.md references ${target}, but the file does not exist`)
  }
}

if (problems.length > 0) {
  console.error('readme-media guard FAILED:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`readme-media: OK — README.md references the hero webp, flow svg and demo gif; ${referenced.length} docs/assets reference(s) resolve`)
