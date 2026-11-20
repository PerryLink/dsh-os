# Outreach templates (do not mass-send)

## Chinese DM (plugin author)

> 你好，我是 PerryLink，在做 DSH 的 OS 原语（Act/Allow/Check 等，MIT，非官方）。
> 看到你的插件 <name> 有 <specific feature>，想请教一个具体问题：
> 你升级 DSH 或插件时，怎么确认 agent 的行为没有回归？
> 我做了个 `dsh-check`，能对两次 run 做四维 diff 并在 CI 里 exit 1。
> 不推销，只想用 20 分钟听你现在的做法；如果愿意，我可以帮你的插件跑一次基线。

## English DM

> Hi — I'm PerryLink, building small MIT-licensed OS primitives for DeepSeek
> Harness (not affiliated). I saw <repo/plugin> does <specific thing>.
> Quick question: how do you catch agent regressions when you upgrade DSH or a
> plugin? I built `dsh-check` (four-dimension run diff, CI exit 1) and would
> like to learn your current workflow in a 20-minute call — no pitch. If useful,
> I can run a baseline for your plugin.

## Email (team lead)

> Subject: 20 min on DSH upgrade regressions?
>
> Hi <name>, we're building an independent MIT toolkit for DSH (actions,
> grants, regression checks; not affiliated with DeepSeek). I'm trying to
> understand how teams verify agent behavior before merging a plugin/prompt
> change. Would you be open to a 20-minute call? I can share a 90-second demo
> and a one-page POC scope; no obligation.

## Rules

- Mention one specific thing about them; no template blast.
- Disclose not affiliated; link the repo only once.
- One follow-up maximum, then stop.
- Never ask for credentials or private data.
