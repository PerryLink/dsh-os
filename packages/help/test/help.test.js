import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  apply,
  checkNode,
  HelpService,
  NODE_RANGE,
  addCommand,
} from '../index.js'

/** Fake Cordis context from docs/implementation-contract.md. */
function fakeContext(services = {}) {
  const tools = new Map()
  const provided = new Map(Object.entries(services))
  return {
    tools: { register: tool => (tools.set(tool.name, tool), () => tools.delete(tool.name)) },
    provide: (name, value) => provided.set(name, value),
    get: name => provided.get(name),
    _tools: tools,
    _services: provided,
  }
}

function setup(services = {}) {
  const ctx = fakeContext(services)
  const service = apply(ctx)
  return { ctx, service }
}

const ALL_SERVICES = {
  act: {},
  allow: {},
  snip: {},
  check: {},
  nest: {},
  triggers: {},
  evidence: {},
  trace: {},
  stage: {},
  ring: {},
  env: {},
}

test('apply provides ctx.help and registers the three help tools', () => {
  const { ctx, service } = setup()
  assert.ok(ctx.get('help') instanceof HelpService)
  assert.equal(ctx.get('help'), service)
  assert.deepEqual([...ctx._tools.keys()], ['help_doctor', 'help_first_run', 'help_install_plan'])
  for (const [name, tool] of ctx._tools) {
    assert.equal(tool.name, name)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.deepEqual(tool.output.render({}, { ok: true }), [{ type: 'text', text: '{"ok":true}' }])
  }
  assert.deepEqual(ctx._tools.get('help_install_plan').parameters.required, ['modules'])
})

test('doctor reports all 11 modules missing in an empty context', () => {
  const { service } = setup()
  const report = service.doctor()
  assert.equal(report.modules.length, 11)
  assert.deepEqual(report.installed, [])
  assert.equal(report.missing.length, 11)
  assert.equal(report.node.required, NODE_RANGE)
  assert.equal(typeof report.node.ok, 'boolean')
  for (const item of report.missing) {
    assert.equal(item.command, addCommand(item.package))
    assert.ok(report.suggestions.includes(item.command))
  }
  assert.equal(report.ok, false)
  assert.match(report.summary, /^0\/11 dsh-os modules installed; /)
})

test('doctor reports no missing modules when every seam resolves', () => {
  const { service } = setup({ ...ALL_SERVICES, dshVersion: '0.2.2-rc.4' })
  const report = service.doctor()
  assert.deepEqual(report.missing, [])
  assert.equal(report.installed.length, 11)
  assert.equal(report.ok, report.node.ok)
  assert.deepEqual(report.suggestions, ['dsh --dump-config'])
})

test('doctor reads the DSH version from the context first', () => {
  const { service } = setup({ ...ALL_SERVICES, dshVersion: '0.2.2-rc.4' })
  assert.deepEqual(service.doctor().dsh, { version: '0.2.2-rc.4', source: 'ctx' })
})

test('doctor falls back to DSH_VERSION and reports unknown when neither exists', () => {
  const previous = process.env.DSH_VERSION
  try {
    process.env.DSH_VERSION = '0.2.2-env-test'
    assert.deepEqual(setup().service.doctor().dsh, { version: '0.2.2-env-test', source: 'env' })

    delete process.env.DSH_VERSION
    const report = setup().service.doctor()
    assert.deepEqual(report.dsh, { version: 'unknown', source: 'unknown' })
    assert.ok(report.suggestions.some(item => item.includes('DSH_VERSION')))
  } finally {
    if (previous === undefined) delete process.env.DSH_VERSION
    else process.env.DSH_VERSION = previous
  }
})

test('checkNode enforces the declared Node range', () => {
  assert.equal(checkNode('v22.19.0').ok, true)
  assert.equal(checkNode('v22.18.9').ok, false)
  assert.equal(checkNode('v24.9.0').ok, true)
  assert.equal(checkNode('v24.8.0').ok, false)
  assert.equal(checkNode('v25.0.0').ok, true)
  assert.equal(checkNode('v23.5.0').ok, false)
  assert.equal(checkNode('not-a-version').ok, false)
})

test('first_run returns the five ordered steps, each with a command', () => {
  const { service } = setup()
  const guide = service.firstRun()
  assert.equal(guide.total, 5)
  assert.deepEqual(guide.steps.map(step => step.step), [1, 2, 3, 4, 5])
  assert.deepEqual(
    guide.steps.map(step => step.id),
    ['install-check', 'generate-run', 'diff', 'install-act-allow', 'inspect-config'],
  )
  for (const step of guide.steps) assert.ok(step.command.trim().length > 0)
  assert.match(guide.steps[0].command, /dsh-canary/)
  assert.match(guide.steps[1].command, /dsh --profile headless --json/)
  assert.match(guide.steps[2].command, /dsh-check diff/)
  assert.match(guide.steps[3].command, /dsh-allow.*dsh-act/)
  assert.match(guide.steps[4].command, /dsh --dump-config/)
})

test('install_plan orders Allow before Act and keeps Check independent', () => {
  const { service } = setup()
  const plan = service.installPlan(['act', 'check', 'allow'])
  assert.deepEqual(plan.packages, ['dsh-canary', 'dsh-allow', 'dsh-act'])
  assert.deepEqual(plan.commands, [
    'dsh plugin --profile web add dsh-canary',
    'dsh plugin --profile web add dsh-allow',
    'dsh plugin --profile web add dsh-act',
  ])
  assert.deepEqual(plan.steps.find(step => step.service === 'act').requires, ['allow'])
  assert.deepEqual(plan.steps.find(step => step.service === 'check').requires, [])
  assert.equal(plan.executes, false)
})

test('install_plan accepts aliases, dedupes, and handles an empty array', () => {
  const { service } = setup()
  const plan = service.installPlan(['dsh-runtime-env', 'Root', 'env', 'triggers'])
  assert.deepEqual(plan.modules, ['triggers', 'env'])
  assert.deepEqual(plan.packages, ['dsh-trigger', 'dsh-runtime-env'])
  assert.equal(plan.steps.length, 2)

  const empty = service.installPlan([])
  assert.equal(empty.ok, true)
  assert.deepEqual(empty.commands, [])
  assert.deepEqual(empty.steps, [])
  assert.equal(empty.empty, true)
  assert.match(empty.note, /Check/)
})

test('install_plan rejects malformed and unknown modules with E_INVALID_ARGUMENT', () => {
  const { service } = setup()
  assert.throws(() => service.installPlan('act'), { code: 'E_INVALID_ARGUMENT' })
  assert.throws(() => service.installPlan([42]), { code: 'E_INVALID_ARGUMENT' })
  assert.throws(() => service.installPlan(['nope']), { code: 'E_INVALID_ARGUMENT' })
})

test('tools delegate to the service and return plain JSON', async () => {
  const { ctx } = setup()
  const doctor = await ctx._tools.get('help_doctor').execute({})
  assert.equal(doctor.modules.length, 11)
  const guide = await ctx._tools.get('help_first_run').execute({})
  assert.equal(guide.steps.length, 5)
  const plan = await ctx._tools.get('help_install_plan').execute({ modules: ['act', 'allow'] })
  assert.deepEqual(plan.packages, ['dsh-allow', 'dsh-act'])
})

test('runtime source has no process-spawning or network imports and writes no files', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /node:(child_process|net|http|https|dgram|tls)/)
  assert.doesNotMatch(source, /\bfetch\s*\(/)
  assert.doesNotMatch(source, /\bwriteFile(Sync)?\s*\(/)
})
