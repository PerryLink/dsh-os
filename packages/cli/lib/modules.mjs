import { readWorkspacePackages } from './catalog.mjs'
import { installCommand } from './names.mjs'

function packageOs(pkg) {
  const os = pkg?.dsh?.os
  return os && typeof os === 'object' && !Array.isArray(os) ? os : null
}

function mergeCatalogEntry(entry, pkg) {
  const os = packageOs(pkg)
  return {
    name: entry.name,
    product: entry.product,
    service: os && os.service !== undefined ? os.service : entry.service,
    version: typeof pkg?.version === 'string' && pkg.version !== '' ? pkg.version : entry.version,
    stability: os?.stability || entry.stability,
    description:
      typeof pkg?.description === 'string' && pkg.description !== ''
        ? pkg.description
        : entry.description,
    install: entry.install || installCommand(entry.name),
    optional: Boolean(entry.optional),
  }
}

/**
 * The catalog is the curated product family: exactly the modules listed in
 * catalog.json, with workspace manifests overriding version/description/
 * dsh.os fields while developing in the repo. Other dsh-os packages (the
 * contract, the UI shell, this CLI) are not product modules and stay out.
 */
export function collectModules(repoRoot, catalog) {
  if (!repoRoot) {
    return {
      mode: 'catalog',
      repoRoot: null,
      catalog,
      entries: catalog.filter(entry => !entry.optional).map(entry => ({ ...entry })),
      optional: catalog.filter(entry => entry.optional).map(entry => ({ ...entry })),
      packages: [],
    }
  }

  const packages = readWorkspacePackages(repoRoot)
  const byName = new Map(
    packages
      .filter(item => item.pkg && typeof item.pkg.name === 'string')
      .map(item => [item.pkg.name, item]),
  )

  const merge = entry => {
    const item = byName.get(entry.name)
    return item?.pkg ? mergeCatalogEntry(entry, item.pkg) : { ...entry }
  }

  return {
    mode: 'repo',
    repoRoot,
    catalog,
    entries: catalog.filter(entry => !entry.optional).map(merge),
    optional: catalog.filter(entry => entry.optional).map(merge),
    present: new Set(catalog.filter(entry => byName.has(entry.name)).map(entry => entry.name)),
    packages,
  }
}

/**
 * `list` shows the product modules actually checked out (or the packaged
 * catalog when running outside a checkout). `info`/`install` resolve against
 * the whole catalog, because they only need a package name and command.
 */
export function listEntries(context, includeOptional = false) {
  const productEntries =
    context.mode === 'repo'
      ? context.entries.filter(entry => context.present.has(entry.name))
      : [...context.entries]
  return includeOptional ? [...productEntries, ...context.optional] : productEntries
}

export function allEntries(context, includeOptional = false) {
  return includeOptional ? [...context.entries, ...context.optional] : [...context.entries]
}

export function resolveModule(spec, entries) {
  const needle = String(spec).trim().toLowerCase()
  if (needle === '') return null
  const aliases = entry => {
    const packageBase = entry.name.split('/').pop()
    const values = [
      entry.name,
      packageBase,
      entry.product,
      entry.service,
      entry.service ? `ctx.${entry.service}` : null,
    ]
    return values.filter(value => typeof value === 'string').map(value => value.toLowerCase())
  }
  return entries.find(entry => aliases(entry).includes(needle)) || null
}
