# Check POC — scope and price

**Buyer:** a team that ships DSH plugins/prompts and has a CI pipeline.
**Problem:** a plugin/prompt/model upgrade changes agent behavior; nobody notices
until production.

## Scope (2–4 weeks)

1. Baseline 3–5 real tasks from the buyer's repo (redacted).
2. Run them through `dsh-check run --profile headless`; store run JSON.
3. Wire `dsh-check diff` into their CI; fail on result/trajectory/tool/approval
   regressions; allow explicit flaky warnings.
4. One review session: which diffs are signal vs noise; tune thresholds.
5. Handover: `check.tasks.json`, CI job, a short runbook.

## Deliverables

- `check.tasks.json` (3–5 tasks)
- CI job that exits 1 on a real regression
- Baseline + candidate run JSON
- 1-page runbook + 30-day support

## Price

- **¥20,000** fixed (credited against the first annual Team plan).
- Team plan: **¥199/seat/month**, 5-seat minimum.
- Payment: 50% on start, 50% on acceptance; no charge if the gate cannot catch
  the agreed regression.

## Acceptance

- A seeded regression is caught with exit 1.
- A no-change run exits 0.
- CI runtime ≤ 15 minutes for 5 tasks.
- Buyer's engineer can add a task without us.

## Out of scope

- Model quality/benchmark ranking.
- Hosted runner/cloud (0.3.0).
- Prompt rewriting, plugin implementation, data migration.
