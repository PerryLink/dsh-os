import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../bin/dsh-os.js', import.meta.url))
const CATALOG_PATH = fileURLToPath(new URL('../catalog.json', import.meta.url))

const BOUNDED_DSH = '>=0.2.1-rc.2 <0.3.0-0'
const BOUNDED_NODE = '^22.19.0 || >=24.9.0'

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function manifest(overrides) {
  return {
    name: 'dsh-act',
    version: '0.2.0',
    description: 'Fixture Act module.',
    type: 'module',
    engines: { node: BOUNDED_NODE, dsh: BOUNDED_DSH },
    dsh: {
      manifestVersion: 1,
      bundle: { patch: './cordis.patch.yml' },
      os: {
        service: 'act',
        provides: ['act'],
        capabilities: ['fs.read'],
        tools: ['act_list'],
        stability: 'stable',
        since: '0.1.0',
      },
    },
    ...overrides,
  }
}

function makeFixture(t, { rootEngines = { node: '>=22.19.0' }, actDshRange } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-os-cli-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writeJson(join(root, 'package.json'), {
    name: 'dsh-os-fixture',
    private: true,
    workspaces: ['packages/*'],
    engines: rootEngines,
  })

  const act = manifest({
    name: 'dsh-act',
    engines: { node: BOUNDED_NODE, dsh: actDshRange || BOUNDED_DSH },
  })
  writeJson(join(root, 'packages/act/package.json'), act)

  writeJson(
    join(root, 'packages/allow/package.json'),
    manifest({
      name: 'dsh-allow',
      description: 'Fixture Allow module.',
      dsh: { manifestVersion: 1, bundle: { patch: './cordis.patch.yml' } },
    }),
  )

  // A package with dsh.os that is not in the curated catalog: contract, shell
  // and similar infrastructure packages must not leak into the product list.
  writeJson(join(root, 'packages/extra/package.json'), {
    name: 'dsh-extra',
    version: '0.3.0',
    description: 'Unlisted fixture module.',
    type: 'module',
    engines: { node: BOUNDED_NODE, dsh: BOUNDED_DSH },
    dsh: { manifestVersion: 1, os: { service: 'extra', stability: 'experimental' } },
  })

  writeJson(join(root, 'packages/not-a-module/package.json'), {
    name: 'fixture-tool',
    version: '1.0.0',
    bin: { tool: 'bin/tool.js' },
  })

  const emptyBin = join(root, 'empty-bin')
  mkdirSync(emptyBin)
  return { root, emptyBin }
}

function runCli(args, { cwd, env = process.env } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' })
}

function envWithPath(directory) {
  return { ...process.env, PATH: directory, Path: directory }
}

test('list --json merges package manifests into the catalog', t => {
  const { root, emptyBin } = makeFixture(t)
  const result = runCli(['list', '--json'], { cwd: root, env: envWithPath(emptyBin) })
  assert.equal(result.status, 0, result.stderr)

  const modules = JSON.parse(result.stdout)
  assert.deepEqual(modules.map(module => module.name), ['dsh-act', 'dsh-allow'])

  const act = modules.find(module => module.name === 'dsh-act')
  assert.deepEqual(act, {
    name: 'dsh-act',
    product: 'Act',
    service: 'act',
    version: '0.2.0',
    stability: 'stable',
    description: 'Fixture Act module.',
  })

  const allow = modules.find(module => module.name === 'dsh-allow')
  assert.equal(allow.version, '0.2.0')
  assert.equal(allow.product, 'Allow')
  assert.equal(allow.description, 'Fixture Allow module.')

  assert.equal(modules.some(module => module.name === 'dsh-extra'), false)
  assert.equal(modules.some(module => module.name === 'fixture-tool'), false)
})

test('list --all adds optional modules and text output stays tabular', t => {
  const { root, emptyBin } = makeFixture(t)
  const json = runCli(['list', '--json', '--all'], {
    cwd: root,
    env: envWithPath(emptyBin),
  })
  assert.equal(json.status, 0, json.stderr)
  const modules = JSON.parse(json.stdout)
  assert.equal(modules.length, 7)
  const optional = modules.filter(module => module.optional)
  assert.equal(optional.length, 5)
  assert.deepEqual(
    optional.map(module => module.name),
    ['dsh-help', 'dsh-context', 'dsh-cost', 'dsh-backup', 'dsh-notify'],
  )

  const text = runCli(['list'], { cwd: root, env: envWithPath(emptyBin) })
  assert.equal(text.status, 0)
  assert.match(text.stdout, /^NAME\s+PRODUCT\s+SERVICE\s+VERSION\s+STABILITY\s+DESCRIPTION/m)
  assert.match(text.stdout, /dsh-act\s+Act\s+ctx\.act\s+0\.2\.0\s+stable/)
  assert.doesNotMatch(text.stdout, /@perrylink\/dsh-root/)

  const all = runCli(['list', '--all'], { cwd: root, env: envWithPath(emptyBin) })
  assert.match(all.stdout, /not published yet/)
})

test('info resolves aliases and prints install and update commands', t => {
  const { root } = makeFixture(t)
  const result = runCli(['info', 'Act'], { cwd: root })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /package:\s+dsh-act/)
  assert.match(result.stdout, /service:\s+ctx\.act/)
  assert.match(result.stdout, /version:\s+0\.2\.0/)
  assert.match(result.stdout, /dsh plugin --profile web add dsh-act/)
  assert.match(result.stdout, /dsh plugin --profile web add dsh-act@latest/)

  const byService = runCli(['info', 'ctx.env'], { cwd: root })
  assert.equal(byService.status, 0, byService.stderr)
  assert.match(byService.stdout, /package:\s+@perrylink\/dsh-root/)

  const byPackage = runCli(['info', '@perrylink/dsh-check', '--json'], { cwd: root })
  assert.equal(byPackage.status, 0, byPackage.stderr)
  const detail = JSON.parse(byPackage.stdout)
  assert.equal(detail.name, '@perrylink/dsh-check')
  assert.equal(detail.install, 'dsh plugin --profile web add @perrylink/dsh-check')
  assert.equal(detail.update, 'dsh plugin --profile web add @perrylink/dsh-check@latest')

  const optional = runCli(['info', 'help'], { cwd: root })
  assert.equal(optional.status, 0, optional.stderr)
  assert.match(optional.stdout, /optional:\s+yes \(planned; not yet published\)/)

  const unknown = runCli(['info', 'nope'], { cwd: root })
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /unknown module "nope"/)
})

test('install prints commands and never executes dsh by default', t => {
  const { root, emptyBin } = makeFixture(t)
  const result = runCli(['install', 'act', 'allow', '--profile', 'dev'], {
    cwd: root,
    env: envWithPath(emptyBin),
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    result.stdout,
    'dsh plugin --profile dev add dsh-act\ndsh plugin --profile dev add dsh-allow\n',
  )

  const optional = runCli(['install', 'help'], { cwd: root, env: envWithPath(emptyBin) })
  assert.equal(optional.status, 1)
  assert.match(optional.stderr, /optional\/planned and is not published yet/)

  const unknown = runCli(['install', 'nope'], { cwd: root, env: envWithPath(emptyBin) })
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /unknown module "nope"/)
})

test(
  'install --run executes dsh with a fixed argv and propagates failure',
  { skip: process.platform === 'win32' ? 'POSIX shell fixture only' : false },
  t => {
    const { root } = makeFixture(t)
    const fakeBin = mkdtempSync(join(tmpdir(), 'dsh-os-fake-dsh-'))
    t.after(() => rmSync(fakeBin, { recursive: true, force: true }))
    const marker = join(fakeBin, 'argv.txt')
    const dsh = join(fakeBin, 'dsh')
    writeFileSync(
      dsh,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${marker}"\nexit "\${DSH_FAKE_EXIT:-0}"\n`,
    )
    chmodSync(dsh, 0o755)

    const ok = runCli(['install', 'act', '--run'], {
      cwd: root,
      env: { ...envWithPath(fakeBin), DSH_FAKE_EXIT: '0' },
    })
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(ok.stdout, /dsh plugin --profile web add dsh-act/)
    assert.equal(
      readFileSync(marker, 'utf8'),
      'plugin\n--profile\nweb\nadd\ndsh-act\n',
    )

    const failed = runCli(['install', 'act', '--run'], {
      cwd: root,
      env: { ...envWithPath(fakeBin), DSH_FAKE_EXIT: '7' },
    })
    assert.equal(failed.status, 7)
  },
)

test('update prints @latest commands for every product module', t => {
  const { root, emptyBin } = makeFixture(t)
  const result = runCli(['update'], { cwd: root, env: envWithPath(emptyBin) })
  assert.equal(result.status, 0, result.stderr)
  const lines = result.stdout.trim().split('\n')
  assert.equal(lines.length, 11)
  assert.ok(lines.every(line => line.startsWith('dsh plugin --profile web add ')))
  assert.ok(lines.every(line => line.endsWith('@latest')))
  assert.ok(lines.includes('dsh plugin --profile web add @perrylink/dsh-root@latest'))

  const dev = runCli(['update', '--profile', 'dev'], { cwd: root, env: envWithPath(emptyBin) })
  assert.match(dev.stdout, /^dsh plugin --profile dev add dsh-act@latest$/m)
})

test('doctor warns (exit 0) for a missing dsh.os manifest and version drift', t => {
  const { root } = makeFixture(t)
  const result = runCli(['doctor'], { cwd: root })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /\[ok\] node: v.+,? satisfies engines\.node/)
  assert.match(result.stdout, /\[warn\] dsh-allow: missing dsh\.os manifest/)
  assert.match(result.stdout, /\[warn\] dsh-act: version 0\.2\.0 differs from catalog/)
  assert.match(result.stdout, /0 error\(s\), [1-9]\d* warning\(s\)/)
  assert.doesNotMatch(result.stdout, /dsh-extra/)
})

test('doctor exits 1 for an unsupported Node range and an unbounded engines.dsh', t => {
  const { root } = makeFixture(t, {
    rootEngines: { node: '>=99.0.0' },
    actDshRange: '>=0.2.1-rc.2',
  })
  const result = runCli(['doctor'], { cwd: root })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /\[error\] node: v.+ does not satisfy engines\.node/)
  assert.match(result.stdout, /\[error\] dsh-act: engines\.dsh ">=0\.2\.1-rc\.2" has no upper bound/)
  assert.match(result.stdout, /[1-9]\d* error\(s\)/)
})

test('catalog.json describes 11 modules plus 5 optional modules', () => {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'))
  assert.equal(catalog.length, 16)
  assert.deepEqual(
    catalog.filter(entry => !entry.optional).map(entry => entry.name),
    [
      'dsh-act',
      'dsh-allow',
      'dsh-snip',
      '@perrylink/dsh-check',
      'dsh-nest',
      'dsh-trigger',
      'dsh-seek',
      '@perrylink/dsh-trace',
      'dsh-stage',
      'dsh-ring',
      '@perrylink/dsh-root',
    ],
  )
  assert.equal(catalog.filter(entry => entry.optional).length, 5)
  for (const entry of catalog) {
    for (const field of [
      'name',
      'product',
      'service',
      'version',
      'stability',
      'description',
      'install',
    ]) {
      assert.equal(typeof entry[field], 'string', `${entry.name} ${field}`)
    }
    assert.match(entry.version, /^\d+\.\d+\.\d+/)
    assert.equal(entry.install, `dsh plugin --profile web add ${entry.name}`)
  }
})

test('help and version are available without a workspace', t => {
  const { root, emptyBin } = makeFixture(t)
  const version = runCli(['--version'], { cwd: root, env: envWithPath(emptyBin) })
  assert.equal(version.status, 0)
  assert.equal(version.stdout.trim(), '0.1.0')

  const help = runCli([], { cwd: root, env: envWithPath(emptyBin) })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Usage:/)
  assert.match(help.stdout, /never contacts a registry/)

  const unknown = runCli(['nope'], { cwd: root, env: envWithPath(emptyBin) })
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /unknown command "nope"/)
})

test('a plugin monorepo that only declares dsh.os stays in catalog mode', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-os-plugin-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeJson(join(root, 'package.json'), {
    name: 'some-plugin-monorepo',
    private: true,
    workspaces: ['packages/*'],
    engines: { node: '>=22.19.0' },
  })
  writeJson(join(root, 'packages/my-plugin/package.json'), {
    name: 'my-plugin',
    version: '1.0.0',
    dsh: { os: { service: null, stability: 'experimental' } },
  })
  const emptyBin = join(root, 'empty-bin')
  mkdirSync(emptyBin)

  const list = runCli(['list', '--json'], { cwd: root, env: envWithPath(emptyBin) })
  assert.equal(list.status, 0, list.stderr)
  assert.equal(JSON.parse(list.stdout).length, 11)

  const doctor = runCli(['doctor'], { cwd: root, env: envWithPath(emptyBin) })
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr)
  assert.match(doctor.stdout, /mode: catalog/)
})

test('catalog mode is used outside a dsh-os checkout', t => {
  const outside = mkdtempSync(join(tmpdir(), 'dsh-os-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  const emptyBin = join(outside, 'bin')
  mkdirSync(emptyBin)

  const result = runCli(['list', '--json'], { cwd: outside, env: envWithPath(emptyBin) })
  assert.equal(result.status, 0, result.stderr)
  const modules = JSON.parse(result.stdout)
  assert.equal(modules.length, 11)
  assert.equal(modules[0].name, 'dsh-act')

  const doctor = runCli(['doctor'], { cwd: outside, env: envWithPath(emptyBin) })
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr)
  assert.match(doctor.stdout, /mode: catalog/)
  assert.match(doctor.stdout, /not in a dsh-os checkout/)
})
