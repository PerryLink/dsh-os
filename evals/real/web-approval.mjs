#!/usr/bin/env node
/**
 * Real-Web interactive approval bridge for dsh-os.
 *
 * Runs a live `dsh --profile eval-gw --no-open --port 0` Web server, creates an
 * `os-gateway` Session through `/api/session/create`, and drives the exact
 * recovery loop:
 *
 *   os_request(cap:act.fs.write) -> human approves over HTTP
 *     -> os_observe(requestId) -> os_do(act.fs.write) writes approved.txt
 *
 * The approval decision and the pending list go through the shipped shell's
 * `/api/os-approvals` bridge, not through a mock. See
 * docs/presets/web-approval.md for the observed output and the shipped
 * integration gaps this script works around at the profile layer.
 *
 * Only Node built-ins are used. The model key is read from
 * /home/yy/.dsh/.credentials.yaml, is passed to the server only through its
 * environment, and is never printed or written to disk.
 *
 * Usage:
 *   node evals/real/web-approval.mjs
 *   DSH_HOME=/tmp/dsh-real-home DSH_PROFILE=eval-gw node evals/real/web-approval.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
const DSH_BIN = process.env.DSH_BIN || '/home/yy/deepseek-harness/apps/cli/lib/bin.js'
const DSH_HOME = process.env.DSH_HOME || '/tmp/dsh-real-home'
const PROFILE = process.env.DSH_PROFILE || 'eval-gw'
const WORKDIR = resolve(process.env.DSH_EVAL_WORKDIR || '/tmp/dsh-web-approval/work')
const CREDENTIALS = process.env.DSH_CREDENTIALS || '/home/yy/.dsh/.credentials.yaml'
const APPROVER = 'eval-human'
const CAP_ID = 'act.fs.write'
const CAP_PERMISSION = `cap:${CAP_ID}`
const MODULE_CAP = 'act:invoke:fs.write'
const FILE_NAME = 'approved.txt'
const FILE_TEXT = 'approved'
const FILE_PATH = join(WORKDIR, FILE_NAME)
const SIX_TOOLS = ['os_find', 'os_do', 'os_request', 'os_observe', 'os_help', 'os_status']
const BRIDGE_ROOT = join(DSH_HOME, 'eval-bridges')
const KERNEL_BRIDGE_NAME = 'dsh-eval-kernel-bridge'
const SHELL_BRIDGE_NAME = 'dsh-eval-approval-bridge'
const SHELL_BRIDGE_DIR = join(BRIDGE_ROOT, 'shell-bridge')
const KERNEL_BRIDGE_DIR = join(BRIDGE_ROOT, 'kernel-bridge')
const SHELL_PACKAGE = join(REPO, 'packages/shell')

/** The key is held only for redaction; it is never printed or persisted. */
let secret = ''
const redact = value => {
  let text = String(value ?? '')
  if (secret) text = text.split(secret).join('<redacted-key>')
  text = text.replace(/([?&]token=)[^\s&]+/g, '$1<redacted-token>')
  text = text.replace(/(dsh-auth-[A-Za-z0-9_-]+=)[^\s;]+/g, '$1<redacted-cookie>')
  return text
}
const log = (...args) => console.error('[web-approval]', ...args)
const sleep = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))
const nowIso = () => new Date().toISOString()

function fail(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  throw error
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, undefined, 2)}\n`)
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** Read refs.DEEPSEEK_API_KEY without printing the file or the value. */
function readCredentialKey() {
  if (!existsSync(CREDENTIALS)) fail('key/not-found', `credential file not found: ${CREDENTIALS}`)
  const lines = readFileSync(CREDENTIALS, 'utf8').split(/\r?\n/)
  let inRefs = false
  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
    if (inRefs && /^\S/.test(line)) break
    if (!inRefs) continue
    const match = /^\s+DEEPSEEK_API_KEY:\s*(.+?)\s*$/.exec(line)
    if (match === null) continue
    let value = match[1]
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (value.startsWith('env:')) value = process.env[value.slice(4)] ?? ''
    if (value !== '') return value
  }
  if (typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY !== '') {
    return process.env.DEEPSEEK_API_KEY
  }
  fail('key/not-found', `no DEEPSEEK_API_KEY ref in ${CREDENTIALS} and no environment fallback`)
}

/** Run the checkout CLI against the shared test home; never echo the key. */
function runDsh(args, { cwd = REPO, timeout = 240_000 } = {}) {
  const result = spawnSync(process.execPath, [DSH_BIN, ...args], {
    cwd,
    env: { ...process.env, DSH_HOME },
    encoding: 'utf8',
    timeout,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    fail('dsh/failed', `dsh ${args.join(' ')} exited ${result.status}: ${redact(result.stderr || result.stdout).slice(-3000)}`)
  }
  return result
}

/** The bridge packages live outside the repo, under the throwaway DSH home. */
function writeBridgePackages() {
  mkdirSync(KERNEL_BRIDGE_DIR, { recursive: true })
  mkdirSync(SHELL_BRIDGE_DIR, { recursive: true })
  const kernelUrl = pathToFileURL(join(REPO, 'packages/kernel/index.js')).href
  const shellIndexUrl = pathToFileURL(join(REPO, 'packages/shell/index.js')).href
  const shellBridgeUrl = pathToFileURL(join(REPO, 'packages/shell/bridge.js')).href

  writeFileSync(join(KERNEL_BRIDGE_DIR, 'package.json'), `${JSON.stringify({
    name: KERNEL_BRIDGE_NAME,
    version: '0.0.0',
    private: true,
    type: 'module',
    main: 'index.js',
    exports: './index.js',
  }, undefined, 2)}\n`)

  writeFileSync(join(KERNEL_BRIDGE_DIR, 'index.js'), `// Test-only mount wrapper for the shipped @perrylink/dsh-os-kernel.
//
// Two integration seams are missing in the shipped 0.3/0.4 composition:
//   1. the kernel reads \`ctx.allow\` but its exported inject is ['tools'], so
//      real Cordis throws "cannot get property \"allow\" without inject";
//   2. the kernel's six verbs read \`exec.subject\`, but the DSH tool run
//      context exposes only \`exec.agent\` (Act already derives subject from
//      exec.agent.session.id). os_request therefore fails with
//      "os_request needs an executing subject".
// This wrapper declares \`allow\` and maps the host agent identity onto subject
// for the six registered verbs. The kernel file itself is unchanged.
import { apply as kernelApply } from ${JSON.stringify(kernelUrl)}

export const name = ${JSON.stringify(KERNEL_BRIDGE_NAME)}
export const inject = ['tools', 'allow']

const subjectOf = exec => exec?.subject ?? exec?.agent?.session?.id ?? exec?.agent?.id

function wrapDefinition(definition) {
  if (typeof definition.execute !== 'function') return definition
  return {
    ...definition,
    execute(args, exec) {
      const subject = subjectOf(exec)
      return definition.execute(args, subject !== undefined ? { ...exec, subject } : exec)
    },
  }
}

export function apply(ctx, config) {
  const tools = {
    register: (definition, options) => ctx.tools.register(wrapDefinition(definition), options),
    schemas: (...args) => ctx.tools.schemas(...args),
    get: (...args) => ctx.tools.get(...args),
    restrict: (...args) => ctx.tools.restrict(...args),
  }
  const patched = new Proxy(ctx, {
    get(target, prop) {
      if (prop === 'tools') return tools
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return kernelApply(patched, config)
}
`)

  writeFileSync(join(SHELL_BRIDGE_DIR, 'package.json'), `${JSON.stringify({
    name: SHELL_BRIDGE_NAME,
    version: '0.0.0',
    private: true,
    type: 'module',
    main: 'index.js',
    dsh: { manifestVersion: 1, bundle: { patch: './cordis.patch.yml' } },
  }, undefined, 2)}\n`)
  writeFileSync(join(SHELL_BRIDGE_DIR, 'cordis.patch.yml'), `- insert:
    - id: ${SHELL_BRIDGE_NAME}
      name: ${SHELL_BRIDGE_NAME}
`)
  writeFileSync(join(SHELL_BRIDGE_DIR, 'index.js'), `// Test-only mount adapter for the shipped @perrylink/dsh-os-shell approval
// bridge. The shipped shell's apply() reads ctx.webServer without declaring it
// in \`inject\`, so Cordis rejects the plugin before its bridge mounts. This
// adapter mounts the SAME OsShellService and registerBridge code with the
// missing service declared; it does not reimplement any approval logic.
import { OsShellService } from ${JSON.stringify(shellIndexUrl)}
import { registerBridge } from ${JSON.stringify(shellBridgeUrl)}

export const name = ${JSON.stringify(SHELL_BRIDGE_NAME)}
export const inject = ['webServer']

export function apply(ctx) {
  const getService = name => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)
  const service = new OsShellService({ getService })
  ctx.provide('osShell', service)
  const register = () => registerBridge(ctx.webServer, service)
  if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-eval-approval-bridge: routes')
  else register()
  return service
}
`)
}

function profileDir() {
  return join(DSH_HOME, 'profiles', PROFILE)
}

function readProfile() {
  const dir = profileDir()
  const manifest = readJson(join(dir, 'package.json'))
  return { dir, manifest }
}

function dedupe(values) {
  return [...new Set(values)]
}

/**
 * Make eval-gw a Web profile and install the shipped kernel/Allow/shell plus
 * the two profile-layer bridges. The profile is test infrastructure; the
 * repository's packages/* tree is never modified.
 */
function prepareProfile() {
  if (!existsSync(DSH_BIN)) fail('dsh/not-found', `dsh checkout CLI not found: ${DSH_BIN}`)
  if (!existsSync(profileDir())) {
    log(`initializing profile ${PROFILE} from the shipped web template`)
    runDsh(['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'])
  }

  let { dir, manifest } = readProfile()
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? [...manifest.dsh.profile.bundles] : []
  const deps = manifest.dependencies ?? {}
  let changed = false

  // The existing profile was created from the headless template. The preset
  // registry and the Web server only exist on the Web bundle.
  const swapped = bundles.map(bundle => bundle === '@deepseek-ai/dsh-headless' ? '@deepseek-ai/dsh-web-app' : bundle)
  if (JSON.stringify(swapped) !== JSON.stringify(bundles)) changed = true
  if (!swapped.includes('@deepseek-ai/dsh-web-app')) {
    const base = swapped.indexOf('@deepseek-ai/dsh-base')
    swapped.splice(base >= 0 ? base + 1 : 0, 0, '@deepseek-ai/dsh-web-app')
    changed = true
  }
  if (changed) {
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: dedupe(swapped) } }
    writeJson(join(dir, 'package.json'), manifest)
  }

  // A profile-local npm copy of the registry shadows the Web bundle's row and
  // fails on the checkout's newer @deepseek-ai/cordis-plugin-include peer.
  if (deps['@deepseek-ai/dsh-agent-preset-registry'] !== undefined) {
    log('removing the profile-local agent-preset-registry copy')
    runDsh(['plugin', '--profile', PROFILE, 'remove', '@deepseek-ai/dsh-agent-preset-registry'])
  }

  writeBridgePackages()

  const wanted = [
    ['@perrylink/dsh-os-kernel', join(REPO, 'packages/kernel')],
    ['dsh-allow', join(REPO, 'packages/allow')],
    ['dsh-act', join(REPO, 'packages/act')],
    ['@perrylink/dsh-os-shell', SHELL_PACKAGE],
    [KERNEL_BRIDGE_NAME, KERNEL_BRIDGE_DIR],
    [SHELL_BRIDGE_NAME, SHELL_BRIDGE_DIR],
  ]
  ;({ manifest } = readProfile())
  const currentDeps = manifest.dependencies ?? {}
  const add = wanted.filter(([name, path]) => currentDeps[name] !== `link:${path}`).map(([, path]) => path)
  if (add.length > 0) {
    log(`installing ${add.length} profile package(s) with dsh plugin add`)
    runDsh(['plugin', '--profile', PROFILE, 'add', ...add])
  }

  ;({ manifest } = readProfile())
  const finalBundles = Array.isArray(manifest.dsh?.profile?.bundles) ? [...manifest.dsh.profile.bundles] : []
  const requiredBundles = [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    'dsh-act',
    'dsh-allow',
    '@perrylink/dsh-os-kernel',
    '@perrylink/dsh-os-shell',
    SHELL_BRIDGE_NAME,
  ]
  for (const bundle of requiredBundles) {
    if (!finalBundles.includes(bundle)) finalBundles.push(bundle)
  }
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: dedupe(finalBundles) } }
  writeJson(join(dir, 'package.json'), manifest)

  const verify = readJson(join(dir, 'package.json'))
  const verifyDeps = verify.dependencies ?? {}
  for (const [name] of wanted) {
    if (verifyDeps[name] === undefined) fail('profile/install-failed', `profile dependency missing after install: ${name}`)
  }
  if (!verify.dsh?.profile?.bundles?.includes('@deepseek-ai/dsh-web-app')) {
    fail('profile/web-missing', 'profile bundle list does not contain @deepseek-ai/dsh-web-app')
  }

  writeProfilePatch(verify)
}

/**
 * The profile patch owns the gateway preset. The test-only capability bridges
 * the missing Act capability projection; its handler calls the real Act
 * fs.write action, so both the kernel grant (cap:act.fs.write) and Act's
 * module-owned grant (act:invoke:fs.write) are enforced.
 */
function writeProfilePatch(manifest) {
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const shellRow = bundles.includes('@perrylink/dsh-os-shell')
    ? "- id: '@perrylink/dsh-os-shell'\n  disabled: true\n\n"
    : ''
  const patch = `# Generated by evals/real/web-approval.mjs for profile ${PROFILE}.
# The shipped shell 0.3.0 cannot mount (ctx.webServer is read without inject);
# ${SHELL_BRIDGE_NAME} mounts the same OsShellService/registerBridge instead.
${shellRow}# The Web bundle already composes agent-preset-registry. Override it; do not
# insert a second row (a profile-local npm copy shadows the shipped one).
- id: agent-preset-registry
  config:
    default: os-gateway

- insert:
    - id: preset-os-gateway
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: os-gateway
        name: OS Gateway
        description: Only os_find / os_do / os_request / os_observe / os_help / os_status.
        order: 4
        plugins:
          - id: os-persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: >-
                You reach the operating system only through the six os_* verbs.
                Discover with os_find, request write/execute access with
                os_request, refresh an approval with os_observe, then execute
                with os_do. Never assume a grant exists.
              complete: true
              includeRuntimeContext: false
          # Isolate the kernel service so this preset coexists with the global
          # kernel bundle without registering the kernel service twice.
          - id: os-kernel-group
            name: cordis:group
            group: true
            isolate:
              kernel: true
            config:
              - id: os-kernel
                name: ${KERNEL_BRIDGE_NAME}
                config:
                  gatewayOnly: true
                  # The shipped kernel has no module capability projection;
                  # this test capability calls Act's real fs.write action. The
                  # kernel gate asks for cap:act.fs.write; Act independently
                  # checks its module grant act:invoke:fs.write.
                  capabilities: !!js |
                    [{
                      id: '${CAP_ID}',
                      title: 'Write a workspace file through Act',
                      summary: 'Write one file inside the workspace via the Act fs.write action.',
                      whenToUse: ['Write or create a file in the workspace.'],
                      whenNotToUse: ['Only read an existing file.'],
                      inputSchema: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['path', 'text'],
                        properties: { path: { type: 'string' }, text: { type: 'string' } }
                      },
                      risk: 'write',
                      permissions: ['fs.write'],
                      tags: ['fs', 'write', 'act'],
                      idempotency: 'idempotent',
                      handler: async (input, ctx, exec) => {
                        const act = ctx.get('act');
                        if (!act) throw Object.assign(new Error('act service unavailable'), { code: 'E_UNAVAILABLE' });
                        return act.invoke('fs.write', input, { subject: exec.subject, origin: 'kernel', tainted: false });
                      }
                    }]
`
  writeFileSync(join(profileDir(), 'cordis.patch.yml'), patch)
}

function prepareWorkdir() {
  const tmpRoot = resolve(tmpdir())
  if (WORKDIR !== tmpRoot && !WORKDIR.startsWith(`${tmpRoot}${sep}`)) {
    fail('workdir/unsafe', `refusing to clean a workdir outside ${tmpRoot}: ${WORKDIR}`)
  }
  rmSync(WORKDIR, { recursive: true, force: true })
  mkdirSync(WORKDIR, { recursive: true })
}

/** Boot the Web profile on a random loopback port and parse the printed URL. */
async function bootServer() {
  const child = spawn(process.execPath, [DSH_BIN, '--profile', PROFILE, '--no-open', '--port', '0'], {
    cwd: WORKDIR,
    env: { ...process.env, DSH_HOME, DEEPSEEK_API_KEY: secret },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const server = { child, stdout: () => stdout, stderr: () => stderr }

  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/?\?token=[^\s]+)/.exec(stdout)
    if (match !== null) {
      const url = match[1]
      return { ...server, url, base: new URL(url).origin }
    }
    if (child.exitCode !== null) {
      fail('server/exited', `server exited before printing a URL (code ${child.exitCode}): ${redact(stderr || stdout).slice(-3000)}`)
    }
    await sleep(200)
  }
  child.kill('SIGKILL')
  fail('server/timeout', `server did not print a URL in 90s: ${redact(stderr || stdout).slice(-3000)}`)
}

async function stopServer(server) {
  if (server === undefined || server.child === undefined) return
  const child = server.child
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  const deadline = Date.now() + 10_000
  while (child.exitCode === null && Date.now() < deadline) await sleep(100)
  if (child.exitCode === null) child.kill('SIGKILL')
  await sleep(100)
}

async function login(url) {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) })
  const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  const cookie = setCookies
    .map(value => value.split(';', 1)[0])
    .find(value => value.startsWith('dsh-auth-'))
  if (cookie === undefined) {
    fail('login/no-cookie', `login returned HTTP ${response.status} without a dsh-auth cookie (set-cookie count ${setCookies.length})`)
  }
  return cookie
}

/** One Host Remote call through the Connection RPC envelope. */
async function rpc(api, method, args) {
  const envelope = { type: 'client-request', rpcId: randomUUID(), method, payload: { args } }
  const response = await fetch(`${api.base}/api/${method}`, {
    method: 'POST',
    headers: { cookie: api.cookie, 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(300_000),
  })
  const text = await response.text()
  if (!response.ok) fail('rpc/http', `${method}: HTTP ${response.status}: ${redact(text).slice(0, 800)}`)
  let body
  try { body = JSON.parse(text) } catch { fail('rpc/json', `${method}: response is not JSON: ${redact(text).slice(0, 500)}`) }
  if (body.result?.ok !== true) {
    const error = body.result?.error ?? {}
    fail('rpc/refused', `${method}: ${error.code ?? 'unknown'}: ${error.message ?? redact(text).slice(0, 500)}`, { rpcError: error })
  }
  return body.result.value
}

/** One shipped-shell bridge call (plain JSON, owner-only route). */
async function httpJson(api, method, path, payload) {
  const response = await fetch(`${api.base}${path}`, {
    method,
    headers: {
      cookie: api.cookie,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch {
    fail('approval/json', `${method} ${path}: HTTP ${response.status} is not JSON: ${redact(text).slice(0, 500)}`)
  }
  if (!response.ok || body.ok !== true) {
    fail('approval/refused', `${method} ${path}: HTTP ${response.status} ${body.code ?? ''} ${body.message ?? ''}`.trim(), { body })
  }
  return body
}

async function getEvents(api, sessionId) {
  const value = await rpc(api, 'session/events', {
    request: { address: { kind: 'session', sessionId }, maxMessages: 600 },
  })
  return value.records.map(record => record.event)
}

function safeJson(text) {
  try { return JSON.parse(text) } catch { return undefined }
}

/** Pair tool/call events with tool/result events and parse the JSON payload. */
function parseToolRuns(events) {
  const calls = new Map()
  const runs = []
  for (const event of events) {
    if (event.type === 'tool/call') {
      calls.set(event.data.callId, {
        name: event.data.name,
        args: safeJson(event.data.arguments),
      })
    } else if (event.type === 'tool/result') {
      const data = event.data
      const message = data.message ?? data
      const callId = message.toolCallId ?? data.callId
      const call = calls.get(callId) ?? { name: data.name ?? 'unknown', args: {} }
      const text = (message.content ?? [])
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
      runs.push({
        callId,
        name: call.name,
        args: call.args,
        text,
        json: safeJson(text),
        isError: message.isError === true,
      })
    }
  }
  return runs
}

function assertGatewayHeaders(events) {
  const headers = events
    .filter(event => event.type === 'request/header')
    .map(event => (event.data?.header?.tools ?? []).map(tool => tool.name))
  if (headers.length === 0) fail('surface/no-header', 'no request/header event; cannot prove the model-facing tool surface')
  for (const names of headers) {
    const sorted = [...names].sort()
    if (JSON.stringify(sorted) !== JSON.stringify([...SIX_TOOLS].sort())) {
      fail('surface/not-gateway', `model-visible tools are ${JSON.stringify(sorted)}, not the six os_* verbs`)
    }
  }
  return SIX_TOOLS
}

function findKernelRequest(runs) {
  const matched = runs.filter(run => run.name === 'os_request'
    && run.json?.ok === true
    && run.json.capability === CAP_PERMISSION
    && typeof run.json.requestId === 'string')
  const run = matched.at(-1)
  if (run === undefined) {
    const errors = runs.filter(item => item.name === 'os_request').map(item => item.text).slice(-3)
    fail('request/kernel-missing', `the model did not create a ${CAP_PERMISSION} request: ${redact(errors.join(' | ')).slice(0, 1200)}`)
  }
  const requestedArgs = run.args?.args
  if (requestedArgs === null || typeof requestedArgs !== 'object'
    || requestedArgs.path !== FILE_PATH || requestedArgs.text !== FILE_TEXT) {
    fail('request/args-mismatch', `os_request args ${JSON.stringify(requestedArgs)} do not match { path: ${JSON.stringify(FILE_PATH)}, text: ${JSON.stringify(FILE_TEXT)} }`)
  }
  if (run.args?.id !== CAP_ID) fail('request/id-mismatch', `os_request id ${JSON.stringify(run.args?.id)} is not ${CAP_ID}`)
  return { id: run.json.requestId, run }
}

function findModuleRequest(runs, sessionId) {
  const matched = runs.filter(run => run.name === 'os_do'
    && run.args?.id === 'legacy.allow_request'
    && run.json?.ok === true
    && typeof run.json.data?.requestId === 'string')
  const run = matched.at(-1)
  if (run === undefined) {
    const errors = runs.filter(item => item.name === 'os_do' && item.args?.id === 'legacy.allow_request')
      .map(item => item.text).slice(-3)
    fail('request/module-missing', `the model did not create the ${MODULE_CAP} module request: ${redact(errors.join(' | ')).slice(0, 1200)}`)
  }
  const args = run.args?.args ?? {}
  if (args.capability !== MODULE_CAP) fail('request/module-capability', `module request capability is ${JSON.stringify(args.capability)}, not ${MODULE_CAP}`)
  if (args.subject !== sessionId) fail('request/module-subject', `module request subject ${JSON.stringify(args.subject)} is not the session id ${sessionId}`)
  return { id: run.json.data.requestId, run }
}

function findObserve(runs, requestId) {
  return runs.filter(run => run.name === 'os_observe'
    && run.args?.requestId === requestId
    && run.json?.ok === true).at(-1)
}

function findWrite(runs) {
  return runs.filter(run => run.name === 'os_do'
    && run.args?.id === CAP_ID
    && run.json?.ok === true
    && run.json.data?.actionId === 'fs.write').at(-1)
}

async function promptAndWait(api, sessionId, text) {
  await rpc(api, 'session/prompt', {
    request: {
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    },
  })
  const value = await rpc(api, 'session/wait', { request: { sessionId, timeoutMs: 180_000 } })
  if (value.reason !== 'idle' || value.state?.running !== false) {
    fail('session/not-idle', `session/wait returned reason=${JSON.stringify(value.reason)} running=${JSON.stringify(value.state?.running)}`)
  }
}

function promptOne(sessionId) {
  return `This is an approval-bridge evaluation run by a human. Do exactly these two pending-request steps, in order, and nothing else.

1. Call os_request with:
   id: "${CAP_ID}"
   args: {"path": ${JSON.stringify(FILE_PATH)}, "text": ${JSON.stringify(FILE_TEXT)}}
   reason: "write ${FILE_NAME} for the web approval bridge eval"
   This creates a PENDING request for a human; it does not write.

2. Call os_do with:
   id: "legacy.allow_request"
   args: {"subject": "${sessionId}", "capability": "${MODULE_CAP}", "scope": "*", "reason": "module grant for the web approval bridge eval"}
   This creates a second PENDING request for the same human; it does not write. The module-owned Act grant is separate from the kernel's cap:${CAP_ID} grant, and both must be approved by the human.

Do not call os_observe, do not call os_do("${CAP_ID}"), and do not attempt any file write.
Then report: (a) the os_request result's requestId and capability, (b) the second result's data.requestId. If a step fails, report the exact error code and message.`
}

function promptTwo(requestId) {
  return `The human approved the pending requests. Complete the bridge in this exact order:

1. Call os_observe with requestId "${requestId}". Report state, grantAvailable, id and capability.
2. Only if state is "approved" and grantAvailable is true, call os_do exactly once with:
   id: "${CAP_ID}"
   args: {"path": ${JSON.stringify(FILE_PATH)}, "text": ${JSON.stringify(FILE_TEXT)}}
   Then report whether os_do returned ok, and the path/bytes in its result.

Do not call os_request again. Do not call any other tool. Do not change the path or the text. If os_observe or os_do fails, report the exact error code and message instead of retrying.`
}

async function approvePending(api, kernelRequestId, moduleRequestId, recordPath) {
  const list = await httpJson(api, 'GET', '/api/os-approvals?status=pending')
  const pending = new Map((list.items ?? []).map(item => [item.id, item]))
  const approvals = { kernel: undefined, module: undefined }

  for (const [label, id, capability] of [
    ['module', moduleRequestId, MODULE_CAP],
    ['kernel', kernelRequestId, CAP_PERMISSION],
  ]) {
    const item = pending.get(id)
    if (item === undefined) {
      fail('approval/not-pending', `${label} request ${id} is not in the pending inbox; got ${JSON.stringify([...pending.keys()])}`)
    }
    if (item.capability !== capability) {
      fail('approval/capability', `${label} request ${id} capability is ${JSON.stringify(item.capability)}, not ${capability}`)
    }
    const response = await httpJson(api, 'POST', `/api/os-approvals/${encodeURIComponent(id)}/approve`, { by: APPROVER })
    const request = response.approval?.request
    const grant = response.approval?.grant
    if (request?.status !== 'approved' || typeof grant?.id !== 'string') {
      fail('approval/not-approved', `${label} request ${id} did not return an approved request + grant: ${JSON.stringify(response).slice(0, 1000)}`)
    }
    approvals[label] = { id, capability, status: request.status, grantId: grant.id, decidedBy: request.decidedBy }
  }

  const record = readJson(recordPath)
  record.status = 'approved'
  record.requests.kernel = { ...record.requests.kernel, ...approvals.kernel }
  record.requests.module = { ...record.requests.module, ...approvals.module }
  record.approvedAt = nowIso()
  writeJson(recordPath, record)
  return approvals
}

async function main() {
  prepareWorkdir()
  secret = readCredentialKey()
  prepareProfile()
  const server = await bootServer()
  const api = { base: server.base }
  try {
    api.cookie = await login(server.url)

    // Preflight the exact HTTP approval bridge before spending a model turn.
    let preflight
    try {
      preflight = await httpJson(api, 'GET', '/api/os-approvals?status=pending')
    } catch (error) {
      fail('approval/unavailable', `the shipped-shell approval API is unavailable: ${redact(error.message)}. `
        + 'The 0.3.0 shell fails to mount with "cannot get property \"webServer\" without inject"; '
        + `the eval mounts ${SHELL_BRIDGE_NAME} around the same bridge/oversight code.`, { cause: error })
    }
    if (!Array.isArray(preflight.items)) fail('approval/shape', 'approval preflight did not return an items array')

    const presets = await rpc(api, 'agentPresets/list', {})
    const gateway = (presets.presets ?? []).find(preset => preset.id === 'os-gateway')
    if (gateway === undefined) fail('preset/missing', 'agentPresets/list does not contain os-gateway')

    const created = await rpc(api, 'session/create', {
      request: { cwd: WORKDIR, agentPreset: 'os-gateway' },
    })
    if (created.agentPreset !== 'os-gateway') {
      fail('session/preset', `session/create returned agentPreset=${JSON.stringify(created.agentPreset)}`)
    }
    const sessionId = created.sessionId
    log(`session ${sessionId} created with agentPreset=os-gateway`)

    await promptAndWait(api, sessionId, promptOne(sessionId))
    const eventsOne = await getEvents(api, sessionId)
    const tools = assertGatewayHeaders(eventsOne)
    const runsOne = parseToolRuns(eventsOne)
    const kernel = findKernelRequest(runsOne)
    const module = findModuleRequest(runsOne, sessionId)
    const requestPath = join(WORKDIR, 'request.json')
    writeJson(requestPath, {
      capability: CAP_PERMISSION,
      requestId: kernel.id,
      moduleRequestId: module.id,
      sessionId,
      agentPreset: 'os-gateway',
      status: 'pending',
      approvedBy: APPROVER,
      workdir: WORKDIR,
      file: { path: FILE_PATH, text: FILE_TEXT },
      requests: {
        kernel: { id: kernel.id, capability: CAP_PERMISSION, status: 'pending' },
        module: { id: module.id, capability: MODULE_CAP, status: 'pending' },
      },
      createdAt: nowIso(),
    })
    log(`pending requests: kernel=${kernel.id} module=${module.id}`)

    const approvals = await approvePending(api, kernel.id, module.id, requestPath)

    await promptAndWait(api, sessionId, promptTwo(kernel.id))
    const eventsTwo = await getEvents(api, sessionId)
    assertGatewayHeaders(eventsTwo)
    const runsTwo = parseToolRuns(eventsTwo)
    const observe = findObserve(runsTwo, kernel.id)
    if (observe === undefined) fail('observe/missing', `the model did not call os_observe for ${kernel.id}`)
    if (observe.json.state !== 'approved' || observe.json.grantAvailable !== true) {
      fail('observe/not-approved', `os_observe returned state=${JSON.stringify(observe.json.state)} grantAvailable=${JSON.stringify(observe.json.grantAvailable)}`)
    }
    const write = findWrite(runsTwo)
    if (write === undefined) {
      const errors = runsTwo.filter(item => item.name === 'os_do').map(item => item.text).slice(-3)
      fail('write/missing', `the model did not complete os_do(${CAP_ID}): ${redact(errors.join(' | ')).slice(0, 1200)}`)
    }
    if (write.json.data?.ok !== true || write.json.data?.result?.bytes !== Buffer.byteLength(FILE_TEXT)) {
      fail('write/result', `os_do result is not a successful fs.write: ${JSON.stringify(write.json).slice(0, 1200)}`)
    }

    const content = readFileSync(FILE_PATH, 'utf8')
    if (content !== FILE_TEXT) fail('file/content', `${FILE_PATH} contains ${JSON.stringify(content)}, not ${JSON.stringify(FILE_TEXT)}`)
    const fileStat = { path: FILE_PATH, content, bytes: Buffer.byteLength(content), sha256: sha256(content) }

    const record = readJson(requestPath)
    record.status = 'done'
    record.observe = { state: observe.json.state, grantAvailable: observe.json.grantAvailable }
    record.do = { ok: write.json.ok, actionId: write.json.data.actionId, result: write.json.data.result }
    record.file = fileStat
    record.completedAt = nowIso()
    writeJson(requestPath, record)

    const summary = {
      ok: true,
      surface: { tools, note: 'request/header model-facing tools from both turns' },
      preset: { id: gateway.id, isDefault: gateway.isDefault === true },
      session: { id: sessionId, agentPreset: created.agentPreset, cwd: WORKDIR },
      approvalApi: {
        base: server.base,
        list: 'GET /api/os-approvals?status=pending',
        approve: 'POST /api/os-approvals/:id/approve',
        approver: APPROVER,
      },
      requests: {
        kernel: approvals.kernel,
        module: approvals.module,
      },
      observe: record.observe,
      write: record.do,
      file: fileStat,
      artifacts: {
        approvedFile: FILE_PATH,
        requestJson: requestPath,
      },
      workarounds: [
        'shipped @perrylink/dsh-os-shell 0.3.0: ctx.webServer read without inject -> mounted the same bridge/oversight through dsh-eval-approval-bridge',
        'shipped @perrylink/dsh-os-kernel 0.3.0: ctx.allow read without inject -> dsh-eval-kernel-bridge declares allow and mounts the same apply()',
        'shipped kernel os_* verbs read exec.subject; dsh-eval-kernel-bridge maps exec.agent.session.id -> exec.subject',
        `shipped registry has no ${CAP_ID} capability (capabilities: 0); the profile registers a test capability whose handler calls Act's real fs.write action`,
        'the module-owned act:invoke:fs.write grant is created via legacy.allow_request and approved by the same human over the same HTTP bridge',
      ],
      notes: [
        'the model key was read from the credentials file and passed only via the server environment',
        'the server ran on a random loopback port; the finally block stops it after this summary is printed',
      ],
    }
    console.log(JSON.stringify(summary, undefined, 2))
  } catch (error) {
    const tail = redact(`${server.stderr()}\n${server.stdout()}`).split(/\r?\n/).filter(Boolean).slice(-30).join('\n')
    console.error(JSON.stringify({
      ok: false,
      code: error.code ?? 'eval/failed',
      error: redact(error.message),
      stage: error.stage ?? undefined,
      serverLogTail: tail,
    }, undefined, 2))
    process.exitCode = 1
  } finally {
    await stopServer(server)
  }
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, code: error.code ?? 'eval/failed', error: redact(error.message) }, undefined, 2))
  process.exitCode = 1
})
