import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, OsShellService, render } from '../index.js'
import * as ui from '../ui/index.js'

/** Fake Cordis context from docs/implementation-contract.md. */
function fakeContext() {
  const tools = new Map()
  const services = new Map()
  return {
    tools: { register: tool => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    provide: (name, value) => services.set(name, value),
    get: name => services.get(name),
    _tools: tools,
    _services: services,
  }
}

const view = (id, extra = {}) => ({ id, title: `View ${id}`, module: 'dsh-demo', ...extra })

function setup(config) {
  const ctx = fakeContext()
  const service = apply(ctx, config)
  return { ctx, service }
}

test('apply provides ctx.osShell and three plain-object tools', () => {
  const { ctx, service } = setup()
  assert.ok(service instanceof OsShellService)
  assert.equal(ctx.get('osShell'), service)
  assert.deepEqual([...ctx._tools.keys()], ['os_shell_views', 'os_shell_open', 'os_shell_close'])
  for (const tool of ctx._tools.values()) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.equal(typeof tool.execute, 'function')
    assert.deepEqual(tool.output.render({}, { ok: true }), [{ type: 'text', text: '{"ok":true}' }])
  }
})

test('register, list, open and close a view', () => {
  const { service } = setup({ now: () => 123 })
  const registered = service.registerView(view('act.panel'))
  service.registerView(view('ring.panel', { mount() {} }))
  assert.deepEqual(registered, { id: 'act.panel', title: 'View act.panel', module: 'dsh-demo' })
  assert.deepEqual(service.listViews().map(item => item.id), ['act.panel', 'ring.panel'])

  const opened = service.open('act.panel')
  assert.deepEqual(opened, {
    view: { id: 'act.panel', title: 'View act.panel', module: 'dsh-demo' },
    state: 'opened',
  })
  assert.deepEqual(service.history, [{ id: 'act.panel', at: 123 }])
  assert.deepEqual(service.openViews, ['act.panel'])
  assert.deepEqual(service.close('act.panel'), { view: opened.view, state: 'closed' })
  assert.equal(service.close('act.panel').state, 'closed')
  assert.deepEqual(service.openViews, [])
  assert.equal(service.history.length, 1, 'close is not an open and adds no history')
})

test('duplicate ids are rejected and unregister allows re-registration', () => {
  const { service } = setup()
  service.registerView(view('act.panel'))
  assert.throws(() => service.registerView(view('act.panel')), { code: 'E_CONFLICT' })
  assert.deepEqual(service.unregisterView('act.panel'), {
    id: 'act.panel', title: 'View act.panel', module: 'dsh-demo',
  })
  assert.deepEqual(service.listViews(), [])
  assert.doesNotThrow(() => service.registerView(view('act.panel')))
})

test('invalid ids, titles, modules and mounts fail closed', () => {
  const { service } = setup()
  for (const id of ['', 'a', 'A.panel', '1panel', '.panel', 'act panel', 'act/panel']) {
    assert.throws(() => service.registerView(view(id)), { code: 'E_INVALID_ARGUMENT' }, id)
  }
  for (const title of ['', '   ', 'x'.repeat(81)]) {
    assert.throws(() => service.registerView(view('ok.panel', { title })), { code: 'E_INVALID_ARGUMENT' })
  }
  for (const module of ['', 'Not A Module', '@Bad/Name', 'x'.repeat(215)]) {
    assert.throws(() => service.registerView(view('ok.panel', { module })), { code: 'E_INVALID_ARGUMENT' })
  }
  assert.throws(() => service.registerView(view('ok.panel', { mount: 'nope' })), { code: 'E_INVALID_ARGUMENT' })
  assert.throws(() => service.registerView(view('ok.panel', { extra: true })), { code: 'E_INVALID_ARGUMENT' })
  assert.throws(() => service.registerView(null), { code: 'E_INVALID_ARGUMENT' })

  for (const call of [() => service.open('missing.panel'), () => service.close('missing.panel'),
    () => service.unregisterView('missing.panel')]) {
    assert.throws(call, { code: 'E_NOT_FOUND' })
  }
})

test('history is capped at the 50 most recent opens', () => {
  let clock = 0
  const { service } = setup({ now: () => (clock += 1) })
  service.registerView(view('act.panel'))
  for (let index = 0; index < 55; index += 1) service.open('act.panel')

  const history = service.history
  assert.equal(history.length, 50)
  assert.deepEqual(history[0], { id: 'act.panel', at: 6 })
  assert.deepEqual(history.at(-1), { id: 'act.panel', at: 55 })
  history.push({ id: 'tampered' })
  assert.equal(service.history.length, 50, 'history getter returns a copy')
})

test('listViews returns defensive copies and mount stays host-only', () => {
  const { service } = setup()
  const mount = () => {}
  service.registerView(view('act.panel', { mount }))
  service.listViews()[0].title = 'mutated'
  assert.equal(service.listViews()[0].title, 'View act.panel')
  assert.equal(service.listViews()[0].mount, mount)
})

test('render escapes module-supplied titles without a DOM', () => {
  const { service } = setup()
  service.registerView({ id: 'act.panel', title: '<Act & "co">', module: 'dsh-act' })
  assert.equal(
    service.render(),
    '<ul class="dsh-os-views">\n'
      + '  <li data-view-id="act.panel" data-module="dsh-act">&lt;Act &amp; &quot;co&quot;&gt;</li>\n'
      + '</ul>',
  )
  assert.equal(render([]), '<ul class="dsh-os-views"></ul>')
  assert.throws(() => render('nope'), { code: 'E_INVALID_ARGUMENT' })
})

test('agent tools list, open and close; ui entry exports no views yet', async () => {
  const { ctx, service } = setup()
  service.registerView(view('act.panel', { mount() {} }))
  const tools = ctx._tools

  assert.deepEqual(await tools.get('os_shell_views').execute({}, {}), {
    views: [{ id: 'act.panel', title: 'View act.panel', module: 'dsh-demo', mountable: true }],
  })
  const opened = await tools.get('os_shell_open').execute({ id: 'act.panel' }, {})
  assert.equal(opened.state, 'opened')
  assert.equal(opened.view.id, 'act.panel')
  assert.equal(opened.view.mountable, true)
  const closed = await tools.get('os_shell_close').execute({ id: 'act.panel' }, {})
  assert.equal(closed.state, 'closed')
  assert.deepEqual(ui.views, [])
})
