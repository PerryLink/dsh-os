#!/usr/bin/env bash
# Check in one command: diff a baseline run against a candidate run.
#
# The two fixtures describe the same task under two DSH/model environments. Only
# `result` differs, and any result difference is a REGRESSION (see
# packages/check/README.md). dsh-check therefore exits 1; this wrapper asserts
# that exit code so the demo itself can finish green.
#
# Run from anywhere: bash examples/os-kit/check-demo/run-check-demo.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here/.."   # examples/os-kit, so ../../packages is the repository's packages/

echo "old: check-demo/old.json — baseline run  (dsh 0.2.1-rc.2 / deepseek-chat)"
echo "new: check-demo/new.json — candidate run (dsh 0.2.2-rc.4 / deepseek-chat)"
echo "[1/2] node ../../packages/check/bin/dsh-check.js diff --old check-demo/old.json --new check-demo/new.json"

set +e
node ../../packages/check/bin/dsh-check.js diff --old check-demo/old.json --new check-demo/new.json
status=$?
set -e

echo "[2/2] dsh-check exit code: $status (expected 1: the regression gate fired)"
if [ "$status" -ne 1 ]; then
  echo "FAIL: expected exit 1, got $status" >&2
  exit 1
fi
echo "PASS: Check caught the result regression and rejected the candidate run."
