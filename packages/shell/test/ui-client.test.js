import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = new URL('../ui/client.js', import.meta.url)
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

test('ui/client.js is a syntactically valid classic-script bundle', () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', fileURLToPath(CLIENT)], {
    cwd: PACKAGE_DIR,
    stdio: 'pipe',
  }))
})

test('the client keeps the five tabs and talks only to the owner-only routes', () => {
  const source = readFileSync(CLIENT, 'utf8')
  for (const label of ['Approvals', 'Activity', 'Act', 'Snip', 'Check']) {
    assert.match(source, new RegExp("'" + label + "'"), label)
  }
  for (const route of ['api/os-approvals', 'api/os-activity', 'api/os-shell/snapshot']) {
    assert.ok(source.includes(route), route)
  }
  assert.match(source, /Approver \(required\)/)
  assert.match(source, /agent identities are rejected/)
})

test('the bundle hands off its package id and registers main + sidebar.panellist', async () => {
  let handoff
  globalThis.window = { __ModuleLoader__: { load: value => { handoff = value } } }
  try {
    await import(CLIENT.href + '?test=' + Date.now())
  } finally {
    delete globalThis.window
  }

  assert.ok(handoff, 'window.__ModuleLoader__.load was not called')
  assert.equal(handoff.id, 'dsh-os-shell')
  assert.equal(typeof handoff.factory, 'function')

  const react = {
    createElement: () => null,
    useState: () => [null, () => {}],
    useEffect: () => {},
  }
  const exported = handoff.factory(spec => {
    assert.equal(spec, 'react')
    return react
  })
  assert.equal(typeof exported.apply, 'function')
  assert.deepEqual(exported.inject, ['slots'])

  const injections = []
  const registrations = []
  const ctx = {
    slots: {
      inject(name, callback) { injections.push(name); return callback() },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  exported.apply(ctx)

  assert.deepEqual(injections, ['main', 'sidebar.panellist'])
  assert.equal(registrations.length, 2)
  assert.deepEqual(registrations[0].options, { name: 'main', key: 'os' })
  assert.deepEqual(registrations[1].options, {
    name: 'sidebar.panellist', id: 'os', order: 30, label: 'OS',
  })
  assert.equal(typeof registrations[0].component, 'function')
  assert.equal(typeof registrations[1].component, 'function')
})
