#!/usr/bin/env node
/**
 * Generate the 11 package manifests for the dsh-os monorepo.
 * The generated packages are intentionally dependency-free: they only rely on
 * the host-provided Cordis context, so `npm publish` needs no build step.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const REPO = 'https://github.com/PerryLink/dsh-os'

/** @type {Array<{dir:string,name:string,product:string,desc:string}>} */
export const PACKAGES = [
  { dir: 'act', name: 'dsh-act', product: 'Act', desc: 'Typed action registry and natural-language action panel for DeepSeek Harness.' },
  { dir: 'allow', name: 'dsh-allow', product: 'Allow', desc: 'Revocable capability grants and an audit-ready permission center for DeepSeek Harness.' },
  { dir: 'snip', name: 'dsh-snip', product: 'Snip', desc: 'Encrypted, searchable clipboard ledger for DeepSeek Harness with secret exclusion and agent handles.' },
  { dir: 'check', name: 'dsh-check', product: 'Check', desc: 'Paired-environment regression canary for DeepSeek Harness upgrades, model changes and plugin updates.' },
  { dir: 'nest', name: 'dsh-nest', product: 'Nest', desc: 'Versioned workspace profiles for DeepSeek Harness: context, permissions, environment and defaults.' },
  { dir: 'trigger', name: 'dsh-trigger', product: 'Trigger', desc: 'Event-to-agent trigger fabric for DeepSeek Harness with retries, dedupe and dead letters.' },
  { dir: 'seek', name: 'dsh-seek', product: 'Seek', desc: 'Cross-source evidence search for DeepSeek Harness with verifiable refs and freshness.' },
  { dir: 'trace', name: 'dsh-trace', product: 'Trace', desc: 'Auditable long-term memory governance for DeepSeek Harness: provenance, expiry, conflict and forget.' },
  { dir: 'stage', name: 'dsh-stage', product: 'Stage', desc: 'Display, window and space topology for DeepSeek Harness agents, with reversible layouts.' },
  { dir: 'ring', name: 'dsh-ring', product: 'Ring', desc: 'Approval SLA and escalation receipts for DeepSeek Harness: ack, escalate, audit.' },
  { dir: 'root', name: 'dsh-root', product: 'Root', desc: 'Named, explainable and snapshot-able environment profiles for DeepSeek Harness.' },
]

const LICENSE = `MIT License

Copyright (c) 2026 PerryLink contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

function packageJson(pkg) {
  return {
    name: pkg.name,
    version: '0.0.1',
    description: pkg.desc,
    type: 'module',
    main: 'index.js',
    exports: { '.': './index.js', './package.json': './package.json' },
    files: ['index.js', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md'],
    keywords: ['dsh', 'dsh-plugin', 'deepseek-harness', 'agent-os', pkg.product.toLowerCase()],
    license: 'MIT',
    author: 'PerryLink contributors',
    repository: { type: 'git', url: `git+${REPO}.git`, directory: `packages/${pkg.dir}` },
    homepage: `${REPO}/tree/main/packages/${pkg.dir}#readme`,
    bugs: { url: `${REPO}/issues` },
    engines: { node: '^22.19.0 || >=24.9.0', dsh: '>=0.2.1-rc.2 <0.3.0 || >=0.2.2-0 <0.3.0' },
    dsh: { manifestVersion: 1, bundle: { patch: './cordis.patch.yml' } },
    publishConfig: { access: 'public' },
  }
}

function readme(pkg) {
  return `# ${pkg.product} · \`${pkg.name}\`

> ${pkg.desc}

**Status: 0.0.1 name reservation.** The working design lives in the
[dsh-os design notes](${REPO}#readme). A functional MVP is planned for 0.1.0.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

## Install

\`\`\`sh
dsh plugin --profile web add ${pkg.name}
\`\`\`

## Design

- Host seam: \`ctx.${pkg.product.toLowerCase()}\` (planned)
- Agent tools and CLI are declared in the package's design doc.
- License: MIT.
`
}

function patch(pkg) {
  return `# ${pkg.name} bundle patch: mount the plugin.
- insert:
    - id: ${pkg.name}
      name: ${pkg.name}
`
}

function index(pkg) {
  return `/**
 * ${pkg.name} — ${pkg.desc}
 *
 * 0.0.1 placeholder: the bundle loads and provides a stable package name.
 * The functional implementation lands in 0.1.0.
 * @module ${pkg.name}
 */

/** Cordis plugin name. */
export const name = '${pkg.name}'

/** Mount the plugin. The 0.0.1 placeholder intentionally has no side effects. */
export function apply() {}
`
}

function changelog(pkg) {
  return `# Changelog

## 0.0.1

- Reserve the \`${pkg.name}\` package name.
- Publish the bundle manifest and an empty, side-effect-free plugin entry.
`
}

let created = 0
for (const pkg of PACKAGES) {
  const dir = join(ROOT, 'packages', pkg.dir)
  mkdirSync(dir, { recursive: true })
  const files = {
    'package.json': JSON.stringify(packageJson(pkg), null, 2) + '\n',
    'index.js': index(pkg),
    'cordis.patch.yml': patch(pkg),
    'README.md': readme(pkg),
    'CHANGELOG.md': changelog(pkg),
    'LICENSE': LICENSE,
  }
  for (const [file, content] of Object.entries(files)) {
    const path = join(dir, file)
    if (!existsSync(path)) {
      writeFileSync(path, content)
      created += 1
    }
  }
}

console.log(`scaffold: ${PACKAGES.length} packages, ${created} new files`)
