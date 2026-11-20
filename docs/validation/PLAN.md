# 0.2.0 validation plan (30 days)

Goal: **10 design partners, 3 real installs, 1 Check POC.** No vanity metrics;
nothing counts until a real person runs a real task.

## Funnel

| Stage | Target | Definition |
|---|---:|---|
| Outreach | 20 | personalized message to a DSH plugin author / heavy user / team lead |
| Call | 10 | 20-minute call; they describe one real regression/approval/clipboard task |
| Install | 5 | `dsh plugin add` on their machine, `--dump-config` shows the module |
| Active | 3 | runs the module on a real task at least twice in 14 days |
| POC | 1 | Check runner in a real CI repo, 2–4 weeks, paid or written LOI |

## Who to ask (in order)

1. Authors of DSH plugins with ≥100 weekly downloads who ship tests.
2. Teams using DSH in CI (look for `dsh` in GitHub Actions / Makefile).
3. People who complained about plugin upgrades / flaky prompts / missing approvals.
4. Existing users of `dsh-locator`, `dsh-ee`, `dsh-market`, `dsh-hooks` (adjacent, not competitors).

Do **not** mass-DM; one personalized message per person, no follow-up after one
polite bump.

## 20-minute call script

1. What does your team run DSH for? Which profile?
2. What broke last time you upgraded DSH or a plugin? How did you find it?
3. How do you approve writes/dangerous actions today?
4. Where does context (clipboard, selection, recent files) get lost?
5. What would you pay to stop a regression before merge?
6. Show them one demo only after they describe the problem.
7. Ask: "Can I watch you install it now?" (install or explicit no)
8. Ask for one real task to try in the next 7 days.
9. Ask: who else has this problem?
10. Close: next step, date, and what you will send.

## Success / stop rules

- **Continue** if ≥3 installs and ≥1 person asks "can I use this in CI?"
- **Narrow** if installs happen but nobody runs twice: pick one module and one task.
- **Stop** the paid POC track if 10 calls produce 0 LOI; keep the OSS modules.

## 30-day calendar

| Week | Action | Evidence |
|---|---|---|
| W1 | list 20 people; send 10 messages | tracker rows 1–10 |
| W2 | 5 calls; 3 installs; fix top blocker | call notes + install logs |
| W3 | 5 calls; 1 real task; Check POC scope | task output + POC doc |
| W4 | 1 POC/LOI; publish a redacted case note | signed scope or LOI |

## Rules

- Never invent a user, quote, install or POC.
- Ask before quoting; redact names/paths.
- If someone says no, record it and move on.
- Do not post the official Discussions showcase (user stopped that action).
