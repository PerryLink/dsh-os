#!/usr/bin/env node
import { main } from '../lib/server.mjs'

// A closed pipe (`dsh-os-mcp | head -1`) is a normal way to stop reading.
process.stdout.on('error', error => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

process.exitCode = main(process.argv.slice(2))
