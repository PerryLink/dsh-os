import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseVersion } from './semver.mjs'

export const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
export const CATALOG_PATH = join(PACKAGE_ROOT, 'catalog.json')
export const CLI_PACKAGE = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))

const STABILITIES = new Set(['experimental', 'stable', 'frozen', 'archived'])
const REQUIRED_FIELDS = [
  'name',
  'product',
  'service',
  'version',
  'stability',
  'description',
  'install',
]

export function loadCatalog() {
  let catalog
  try {
    catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read catalog.json: ${error.message}`)
  }
  if (!Array.isArray(catalog)) {
    throw new Error('catalog.json must be a JSON array of modules')
  }

  const names = new Set()
  for (const [index, entry] of catalog.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`catalog.json entry ${index} is not an object`)
    }
    for (const field of REQUIRED_FIELDS) {
      if (!(field in entry)) {
        throw new Error(`catalog.json entry ${index} is missing "${field}"`)
      }
    }
    if (typeof entry.name !== 'string' || entry.name === '') {
      throw new Error(`catalog.json entry ${index} has an invalid name`)
    }
    if (names.has(entry.name)) throw new Error(`catalog.json contains duplicate "${entry.name}"`)
    names.add(entry.name)
    if (entry.service !== null && typeof entry.service !== 'string') {
      throw new Error(`catalog.json entry "${entry.name}" has a non-string service`)
    }
    if (typeof entry.product !== 'string' || typeof entry.description !== 'string') {
      throw new Error(`catalog.json entry "${entry.name}" has invalid text fields`)
    }
    if (typeof entry.install !== 'string' || !entry.install.startsWith('dsh plugin ')) {
      throw new Error(`catalog.json entry "${entry.name}" has an invalid install command`)
    }
    if (!STABILITIES.has(entry.stability)) {
      throw new Error(`catalog.json entry "${entry.name}" has an invalid stability`)
    }
    if (!parseVersion(entry.version)) {
      throw new Error(`catalog.json entry "${entry.name}" has an invalid version`)
    }
    if ('optional' in entry && typeof entry.optional !== 'boolean') {
      throw new Error(`catalog.json entry "${entry.name}" has a non-boolean optional flag`)
    }
  }
  return catalog
}

export function readRootPackage(repoRoot) {
  try {
    return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

export function readWorkspacePackages(repoRoot) {
  const packagesDir = join(repoRoot, 'packages')
  if (!existsSync(packagesDir)) return []
  const packages = []
  for (const dirent of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    const dir = join(packagesDir, dirent.name)
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    try {
      const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
      packages.push({ dir, name: dirent.name, pkg })
    } catch (error) {
      packages.push({ dir, name: dirent.name, pkg: null, error })
    }
  }
  return packages.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )
}

/**
 * Walk up from `start` until a pnpm/npm workspace rooted at a dsh-os checkout
 * is found. A random project with a `packages/*` workspace is not enough:
 * the root must be named `dsh-os`, or at least one workspace package must be a
 * known catalog module. Plugin monorepos that merely declare `dsh.os` stay in
 * catalog mode.
 */
export function findRepoRoot(start, knownNames = new Set()) {
  let dir = resolve(start)
  while (true) {
    const rootManifest = join(dir, 'package.json')
    const packagesDir = join(dir, 'packages')
    if (existsSync(rootManifest) && existsSync(packagesDir)) {
      try {
        const rootPackage = JSON.parse(readFileSync(rootManifest, 'utf8'))
        const workspaces = Array.isArray(rootPackage.workspaces)
          ? rootPackage.workspaces
          : rootPackage.workspaces?.packages
        if (Array.isArray(workspaces) && workspaces.includes('packages/*')) {
          const children = readWorkspacePackages(dir)
          const looksLikeDshOs =
            rootPackage.name === 'dsh-os' ||
            children.some(
              child =>
                typeof child.pkg?.name === 'string' && knownNames.has(child.pkg.name),
            )
          if (looksLikeDshOs) return dir
        }
      } catch {
        // Keep walking: this directory is not a readable workspace root.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
