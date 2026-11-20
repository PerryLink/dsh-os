# Ring · `dsh-ring`

> Approval SLA and escalation receipts for DeepSeek Harness: ack, escalate, audit.

**Status: 0.0.1 name reservation.** The working design lives in the
[dsh-os design notes](https://github.com/PerryLink/dsh-os#readme). A functional MVP is planned for 0.1.0.

**Not affiliated with DeepSeek.** DeepSeek and DeepSeek Harness are trademarks
of their respective owners.

## Install

```sh
dsh plugin --profile web add dsh-ring
```

## Design

- Host seam: `ctx.ring` (planned)
- Agent tools and CLI are declared in the package's design doc.
- License: MIT.
