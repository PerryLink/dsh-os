#!/usr/bin/env node
/**
 * Regenerate packages/cli/catalog.json from the workspace package manifests.
 *
 * Product and service names are contract metadata (docs/module-contract-v1.md
 * §3), so they live here rather than being derived from package names.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI_ROOT = fileURLToPath(new URL('../', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const CATALOG_PATH = join(CLI_ROOT, 'catalog.json')

const MODULES = [
  { dir: 'act', product: 'Act', service: 'act' },
  { dir: 'allow', product: 'Allow', service: 'allow' },
  { dir: 'snip', product: 'Snip', service: 'snip' },
  { dir: 'check', product: 'Check', service: 'check' },
  { dir: 'nest', product: 'Nest', service: 'nest' },
  { dir: 'trigger', product: 'Trigger', service: 'triggers' },
  { dir: 'seek', product: 'Seek', service: 'evidence' },
  { dir: 'trace', product: 'Trace', service: 'trace' },
  { dir: 'stage', product: 'Stage', service: 'stage' },
  { dir: 'ring', product: 'Ring', service: 'ring' },
  { dir: 'root', product: 'Root', service: 'env' },
]

const OPTIONAL_MODULES = [
  {
    name: 'dsh-help',
    product: 'Help',
    service: 'help',
    description: 'Optional install doctor and first-run wizard for DeepSeek Harness.',
  },
  {
    name: 'dsh-context',
    product: 'Context',
    service: 'context',
    description:
      'Optional active app, window and selection context provider for DeepSeek Harness.',
  },
  {
    name: 'dsh-cost',
    product: 'Cost',
    service: 'cost',
    description: 'Optional cost adapter for dsh-cost-meter; it ships no new meter.',
  },
  {
    name: 'dsh-backup',
    product: 'Backup',
    service: 'backup',
    description: 'Optional workspace snapshot and restore for DeepSeek Harness.',
  },
  {
    name: 'dsh-notify',
    product: 'Notify',
    service: 'notify',
    description: 'Optional attention router and notification inbox for DeepSeek Harness.',
  },
]

const install = name => `dsh plugin --profile web add ${name}`

const modules = MODULES.map(({ dir, product, service }) => {
  const manifestPath = join(REPO_ROOT, 'packages', dir, 'package.json')
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
  return {
    name: pkg.name,
    product,
    service,
    version: pkg.version,
    stability: pkg.dsh?.os?.stability || 'experimental',
    description: pkg.description,
    install: install(pkg.name),
  }
})

const optional = OPTIONAL_MODULES.map(({ name, product, service, description }) => ({
  name,
  product,
  service,
  version: '0.0.0',
  stability: 'experimental',
  description,
  install: install(name),
  optional: true,
}))

const catalog = [...modules, ...optional]
writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`)
console.log(
  `wrote ${catalog.length} catalog entries (${modules.length} modules, ${optional.length} optional) to ${CATALOG_PATH}`,
)
