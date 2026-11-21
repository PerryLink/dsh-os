const BUG = 'export const add = (a, b) => a + b + 1\n'
const FIX = 'export const add = (a, b) => a + b\n'
const TEST = "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from './math.mjs'\ntest('adds 2+2', () => { assert.equal(add(2, 2), 4) })\n"

export default {
  id: 'fix-failing-test',
  title: '修失败测试',
  goal: '修复 src/math.mjs 的失败测试；只改源码、不改测试，最后 node --test 通过。',
  initial: [
    '临时仓库：src/math.mjs 返回 a+b+1，测试期望 add(2,2)=4',
    'act 提供内置 fs.write（workdir 限定在临时仓库）',
    'check 配置了本地 node --test runner；宿主预授权 check:run，写文件仍需批准',
  ],
  allowedInterventions: ['human.approve', 'human.grant', 'host.registerAction'],
  success: ['node --test 退出 0', '测试文件哈希不变', '源码 diff ≤3 行', '隐藏用例 add(3,5)=8'],
  maxSteps: 12,
  expectedFirstTool: 'check_compare',
  allowedTools: ['check_compare', 'check_run', 'act_list', 'act_invoke', 'allow_request', 'allow_wait', 'allow_check'],
  async setup(env) {
    const dir = env.temp('dsh-eval-fix-')
    env.cwd = dir
    env.write(env.path('src/math.test.mjs'), TEST)
    env.write(env.path('src/math.mjs'), BUG)
    env.state.testHash = env.hash(env.path('src/math.test.mjs'))
    env.state.oldRun = {
      schema: 'dsh.check.run/v1',
      tasks: [{ id: 'math.add', result: { passed: true, detail: 'ok 1 - adds 2+2' }, trajectory: { steps: 1, toolCalls: 1, errors: 0 }, cost: { usd: 0, tokens: 0 }, approvals: { asked: 0, rejected: 0 } }],
    }
    env.state.badRun = {
      schema: 'dsh.check.run/v1',
      tasks: [{ id: 'math.add', result: { passed: false, detail: 'not ok 1 - adds 2+2\n  expected: 4\n  actual: 5' }, trajectory: { steps: 1, toolCalls: 1, errors: 1 }, cost: { usd: 0, tokens: 0 }, approvals: { asked: 0, rejected: 0 } }],
    }
    await env.mount({ act: { workdir: dir }, check: { runner: env.testRunner('src') } })
    // check_run now needs a Grant. The host pre-authorizes the check capability
    // (no human turn); the source write still requires the one approval below.
    env.ctx.get('allow').issue({ subject: env.subject, capability: 'check:run', scope: '*', approver: 'host' })
  },
  async policy(ai) {
    await ai.call('check_compare', { old: ai.state.oldRun, new: ai.state.badRun })
    await ai.call('act_list', {})
    await ai.write(ai.env.path('src/math.mjs'), FIX, '修复 add 的差一错误')
    await ai.call('check_run', { prompt: 'rerun math.add', id: 'math.add' })
  },
  async check(env) {
    const test = env.node(env.path('src'), ['--test', '--test-reporter=tap', 'math.test.mjs'])
    const after = env.read(env.path('src/math.mjs'))
    const beforeLines = BUG.split('\n')
    const afterLines = after.split('\n')
    let changed = Math.max(0, afterLines.length - beforeLines.length)
    for (let index = 0; index < Math.min(beforeLines.length, afterLines.length); index += 1) {
      if (beforeLines[index] !== afterLines[index]) changed += 1
    }
    const hidden = env.node(env.path('src'), ['--input-type=module', '-e', "import {add} from './math.mjs'; console.log(add(3,5))"])
    return [
      { id: 'test-green', ok: test.status === 0, detail: `node --test exit ${test.status}` },
      { id: 'test-unchanged', ok: env.hash(env.path('src/math.test.mjs')) === env.state.testHash, detail: '测试文件哈希不变' },
      { id: 'diff-small', ok: changed <= 3, detail: `源码改动 ${changed} 行` },
      { id: 'hidden-case', ok: hidden.status === 0 && hidden.stdout.trim() === '8', detail: `add(3,5)=${hidden.stdout.trim() || '?'}` },
    ]
  },
}
