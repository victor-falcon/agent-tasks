# Phase 2: the CLI as the interface

Goal: know from the terminal whether everything is fine, what ran, what
failed and what was missed (and why), without opening JSON by hand. There is
no graphical panel: the runner's tab shows a live, keyboard-driven view
([runner.md](runner.md#agent-tasks-runner)) and, for everything else, a few commands with good output are enough.

A panel in Herdr or another environment stays as a future idea, in a separate repo
([future-herdr-panel.md](future-herdr-panel.md)). To make that possible
without touching this project, every command below accepts `--json`.

## Commands

### `agent-tasks status`: is everything fine?

```
$ agent-tasks status
Runner      ● alive in t12 (Herdr) · every 5m · last tick 2m ago · next in 3m
Last 24h    12 ok · 1 failed · 3 missed (runner stopped 01:10–08:30) · 1 running
Attention
  ✕ sentry-summary/20261117T080000Z  failed     "sentry-cli has no auth"       1h ago
  ! review-pr-123/20261117T090000Z   blocked    asks to confirm the merge      12m ago
  □ sentry-summary  3 missed (02:00, 03:00, 04:00)  runner_offline
Upcoming
  10:00  sentry-summary       every hour
  23:00  backup-notes         every day 23:00
  Mon    weekly-deps-report   Mon 09:00
```

Exits with a non-zero code if the runner is not alive or there is anything
under "Attention", so it can be used in scripts or in the status bar.

### `agent-tasks list`: the tasks

```
$ agent-tasks list
   ID                   SCHEDULE          NEXT         LAST 10         FOLDER
●  weekly-deps-report   Mon 09:00         in 6d        ■■■■■■■□■■      ~/Projects/foo
◐  worktree-cleanup     every day 08:00   running 4m   ■■■■■×■■■◐      ~/Projects/bar
✕  sentry-summary       every hour        10:00        ■■□□□■✕         ~/Projects/foo
○  review-pr-123        Nov 20 09:00      one-off      ·               ~/Projects/foo
⏸  backup-notes         every day 23:00   paused       ■■■■            ~/notes
```

`■` ok, `✕` failed/timed_out, `□` missed, `◐` running, `!` blocked, `·`
pending. Filters: `--status failed`, `--cwd ~/Projects/foo`, `--all`
(includes finished and archived ones).

### `agent-tasks show <id>`: one task

Full definition (description, folder, schedule as cron and as text, time
zone, grace period, `catch_up`, timeout, retries), the resolved agent,
launcher and skill with their origin (`clc` ← profile `~/Projects/**`), the
next 3 runs and the last 10 occurrences. `--instructions` prints the
instructions exactly as the subagent will receive them (including the
personal ones).

### `agent-tasks runs`: history

```
$ agent-tasks runs sentry-summary --since 1d
SLOT           STATUS      START   DURATION  ATT.  SUMMARY
Nov 17 09:00   ✕ failed    09:12   3m        2/2   sentry-cli has no auth
Nov 17 08:00   ■ ok        08:31   6m        1     3 new issues in notes/sentry.md
Nov 17 04:00   □ missed    —       —         —     runner_offline
```

Filters: `[<id>]`, `--status`, `--since`, `--limit`.

### `agent-tasks log <run-ref>`: what happened in a run

Events of the occurrence (claimed, launched, states, warnings), each attempt
with its agent, launcher and handle, the subagent's summary and then the
captured log. Options:

- `--attempt N`: a specific attempt.
- `--follow`: if it is still running, shows the output live (the launcher's `read`).
- `--raw`: only the log, to pipe into `less` or another agent.
- `agent-tasks log <task-id>` without a slot shows the latest run.

### `agent-tasks attach <run-ref>`

If the subagent is still alive, attaches to its terminal with the launcher's `attach` (in Herdr,
`hc attach`). To see what a `blocked` is asking and answer it.

### To act

They already exist in phase 1: `run`, `retry`, `pause`, `resume`, `edit`, `rm`,
`runner status`.

## Output details

- Colors and symbols only if the output is a terminal; without one, plain text.
  `NO_COLOR` is respected.
- Relative dates close to now ("4m ago", "in 6d") and absolute ones far away;
  always in the user's time zone.
- `--json` everywhere, with `"schema": 1`. Adding fields doesn't change the
  version; removing them or changing their meaning does.
- No read command modifies data or runs `tick`.

## Steps

| # | Step | Done when |
|---|---|---|
| 14 | Common format: tables, symbols, relative dates, colors, `NO_COLOR`, `--json` with `schema` | snapshot tests of the output with a fixed clock |
| 15 | `status` with exit code | a stopped runner gives a code ≠ 0 and says so on the first line |
| 16 | `list` with compact history and filters | you can see at a glance which task is failing |
| 17 | `show` with resolved agent/launcher/skill and `--instructions` | it's clear why a task uses `clc` |
| 18 | `runs` and `log` (`--attempt`, `--follow`, `--raw`) | from a `failed` you reach the cause without opening files |
| 19 | `attach` | you can answer a `blocked` from the terminal |
| 20 | "Daily use" section in the README with real examples | a newcomer understands it without reading the roadmap |
