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
  { dir: 'kernel', product: 'Kernel', service: 'kernel' },
]

const OPTIONAL_MODULES = [
  { dir: 'help', product: 'Help', service: 'help' },
  { dir: 'context', product: 'Context', service: 'context' },
  { dir: 'cost', product: 'Cost', service: 'cost' },
  { dir: 'backup', product: 'Backup', service: 'backup' },
  { dir: 'notify', product: 'Notify', service: 'notify' },
  { dir: 'shell', product: 'Shell', service: null },
  { dir: 'kit', product: 'Kit', service: null },
]

const install = name => `dsh plugin --profile web add ${name}`

function entry({ dir, product, service }, optional = false) {
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
    ...(optional ? { optional: true } : {}),
  }
}

const modules = MODULES.map(module => entry(module))
const optional = OPTIONAL_MODULES.map(module => entry(module, true))
const catalog = [...modules, ...optional]
writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`)
console.log(
  `wrote ${catalog.length} catalog entries (${modules.length} modules, ${optional.length} optional) to ${CATALOG_PATH}`,
)
