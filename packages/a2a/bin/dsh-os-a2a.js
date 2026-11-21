#!/usr/bin/env node
import { PACKAGE_VERSION } from '../lib/card.mjs'
import { runStdio } from '../lib/server.mjs'

// A closed pipe (`dsh-os-a2a | head -1`) is a normal way to stop reading.
process.stdout.on('error', error => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

const args = process.argv.slice(2)
if (args.includes('--version') || args.includes('-v')) {
  console.log(PACKAGE_VERSION)
} else if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: dsh-os-a2a

Stdio A2A prototype for dsh-os: newline-delimited JSON-RPC 2.0 on stdin/stdout.

Methods: agent/card, message/send, tasks/get, tasks/list, tasks/cancel,
         tasks/approve, tasks/deny
Version: ${PACKAGE_VERSION}`)
} else {
  runStdio().catch(error => {
    console.error(`dsh-os-a2a: ${error.message}`)
    process.exitCode = 1
  })
}
