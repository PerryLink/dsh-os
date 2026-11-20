#!/usr/bin/env node
/**
 * Test fixture standing in for a DSH CLI. It speaks the headless `--json`
 * NDJSON contract but never loads DSH or a model, so CLI tests stay offline.
 */
const prompt = process.argv.at(-1) ?? ''
const sessionId = 'fake-session'
const fail = prompt.includes('FAIL')
const events = [
  { type: 'session', sessionId, cwd: process.cwd() },
  { type: 'status', phase: 'step_end', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } },
  { type: 'tool_call', callId: 'call-1', tool: 'read' },
  { type: 'tool_result', callId: 'call-1', status: 'completed' },
  fail
    ? {
        type: 'final',
        sessionId,
        reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL' } },
        text: '',
      }
    : { type: 'final', sessionId, reason: { kind: 'completed' }, text: `pong: ${prompt}` },
]
process.stdout.write(`${events.map(event => JSON.stringify(event)).join('\n')}\n`)
if (fail) process.exitCode = 1
