# Runner, notifications and supervisor

## Decision: one process in a tab, not a looping agent

`agent-tasks runner` is a normal process (no LLM) that you leave open in a
tab, for example in Herdr. It runs a `tick` every few minutes, stays alive and
shows live what it launches and how each run ends.

Running an agent in `/loop` was ruled out:

- **Cost.** It would spend tokens on every iteration even when there is
  nothing to do, which is the usual case.
- **Fragility.** A long session grows, gets compacted, gets stuck or hits
  usage limits.
- **Non-deterministic.** Two iterations with the same data could act
  differently.

All the logic lives in `tick`, which is deterministic. Agents only appear to
do the tasks and, optionally, to supervise when something goes wrong.

This is how it looks in Herdr (verified): the runner shows up with a terminal
icon and each running task in its own tab, hanging from it.

```
Agent Tasks
  ▣ agent-tasks runner                 (normal process, announces itself as an agent)
    └ 🦀 sentry-summary                ← task tab, with its state
```

To get that, the runner writes to its terminal, on startup and whenever it
changes:

- `ESC ] 2 ; agent-tasks runner BEL`: the title (tab name).
- `ESC ] 7501 ; state=idle : app=agent-tasks BEL`: announces itself as an
  agent. Without this, the sidebar does not hang the tasks from it. It becomes
  `working` while tasks are running and goes back to `idle` afterwards. Only
  if the output is a terminal.

Tasks carry `herdr.parent=<runner terminal>`. The details are in the `herdr`
preset in [launcher.md](launcher.md).

## `agent-tasks runner`

On a terminal (stdin and stdout are both a TTY) the runner takes the whole
screen and draws a view that is navigated with vim keys:

```
 agent-tasks · runner ● alive · every 5m · last tick 2m ago · next in 3m · running 1 · today ■4 ✕1 □1 !1
┌ Recent ────────────────────────────────┐┌ Detail ──────────────────────────────────┐
│▸ 09:00  ✕ failed   sentry-summary   3m ││ sentry-summary/20261117T090000Z          │
│  08:30  ◐ running  worktree-cleanup 4m ││ ✕ failed · started 09:12 · 3m · att. 2/2 │
│  08:00  ■ ok       sentry-summary   6m ││ cwd    ~/Projects/foo                    │
│  04:00  □ missed   sentry-summary   —  ││ agent  clc · launcher herdr (t14)        │
│  03:12  ! blocked  review-pr-123    —  ││                                          │
├ Upcoming ──────────────────────────────┤│ Summary                                  │
│  10:00  in 12m  sentry-summary  hourly ││   sentry-cli has no auth                 │
│  23:00  in 13h  backup-notes    daily  ││ Events                                   │
├ Tasks ─────────────────────────────────┤│   09:12:03 claimed                       │
│  ●  weekly-deps   ■■■■■■■□■■           ││   09:12:04 launched handle=t14           │
│  ✕  sentry-summ.  ■■□□□■✕              ││   09:15:10 finish status=failed          │
│  ⏸  backup-notes  ■■■■                 ││                                          │
└────────────────────────────────────────┘└──────────────────────────────────────────┘
 09:15:10  ✕ sentry-summary/20261117T090000Z failed  ·  j/k move  tab panel  ⏎ log  / filter  ? help  q quit
```

- **Header**: the runner's state (alive, degraded, last tick failed,
  stopping), its interval, when it last ticked and ticks next, how many runs
  are in progress and today's results.
- **Recent**: the latest occurrences, newest slot first: slot time, status
  (■ ok, ✕ failed or timed out, ◐ running, □ missed, ! blocked), task id and
  how long the latest attempt took.
- **Upcoming**: the next slots of the active tasks: time, how far away, task
  id and schedule.
- **Tasks**: each task's mark and its last 10 results, with the same marks as
  `agent-tasks list`.
- **Detail** of the selected row: for a run, its ref, status, start,
  duration, attempt, folder, agent, launcher and handle, summary and events;
  for an upcoming slot or a task, the task's definition, next runs, recent
  runs and instructions.
- **Bottom line**: the latest runner event for a few seconds, then the key
  hints. There is no repeated status line.

The view is redrawn every second (relative times), re-reads the data folder
after each tick and every few seconds (runs that finish between ticks), and
redraws on resize. Below 96 columns the Detail panel replaces the lists
when focused (`l`); on a short terminal only the selected panel is shown.

Keys: `j`/`k` move, `gg`/`G` first/last row, `Ctrl-d`/`Ctrl-u` half a page,
`Tab`/`Shift-Tab` or `1`/`2`/`3` switch between Recent, Upcoming and Tasks,
`l`/`h` focus the detail and back (in the detail, `j`/`k` scroll it), `Enter`
opens the run's log full screen (for a task or upcoming slot, its latest run;
a run in progress is followed like `log --follow`), `q`/`Esc` go back from
the log or the help, `/` filters by task id and `n`/`N` jump to the
next/previous match, `?` shows the help, and `q` on the main screen stops the
runner after the current tick, like Ctrl-C (a second Ctrl-C exits at once).
The terminal is restored on exit, on a signal and on a crash.

When the output is not a terminal, or with `--plain`, `--quiet`, `--json` or
`--once`, the runner prints one line per event instead:

```
$ agent-tasks runner --plain
agent-tasks runner · every 5m · launcher: herdr (clc) · data: ~/.local/share/agent-tasks
10:00:02  tick  1 due · 0 running
10:00:03  ▶ sentry-summary/20261117T090000Z      launched in t45
10:05:01  tick  0 due · 1 running
10:06:40  ✓ sentry-summary/20261117T090000Z      succeeded in 6m · "3 new issues in notes/sentry.md"
10:10:01  tick  0 due · 0 running
10:15:02  ✕ backup-notes/20261117T091500Z        failed (exited_without_report) · agent-tasks log backup-notes
10:20:01  □ weekly-deps/20261117T080000Z         missed (runner_offline 07:55–10:00)
10:25:01  ! review-pr-123/20261117T100000Z       blocked · agent-tasks attach review-pr-123
─────────────────────────────────────────────────────────────────────────────
● healthy · last tick 10:25:01 · next 10:30 · running 1 · today ✓4 ✕1 □1 !1
```

- At the top, a log with time, symbol and color per event: `▶` launched,
  `✓` succeeded, `✕` failed/timed_out, `□` missed, `!` blocked, `⚠` anomaly.
  Each error line says which command to run to see more.
- At the bottom, a fixed status line that is redrawn (only if the output is a
  terminal; otherwise, only the log).
- The same lines go to `<data_dir>/state/runner.log`, in the full-screen view
  too.

Options: `--every 5m` (default, from the config), `--once` (a single tick and
exit, for testing), `--quiet` (events only, no status line), `--plain` (line
output even on a terminal).

### Staying alive

- **An error in a tick does not take the runner down.** It is caught, logged
  as `⚠` and the runner carries on with the next tick.
- **Only one runner at a time.** `state/runner.lock` stores pid, terminal and
  start time. A second `agent-tasks runner` says where the running one is and
  exits. If the pid no longer exists, the lock is taken again.
- **Heartbeat.** Each tick appends a line to `ticks.jsonl`. If the runner goes
  down, the gap is recorded, and the lost occurrences show up as `missed`
  with `reason: runner_offline` when it comes back.
- **No detached processes** (`nohup`, `setsid`): the process lives in its
  terminal, and in Herdr herdr-core keeps it alive.
- **The user starts it by hand.** After a machine restart, Herdr restores the
  tab with a shell but does not run the command again: you type
  `agent-tasks runner` once more. So that it does not get forgotten, any
  `agent-tasks` command (and `status`) says "the runner is not running" at the
  top if there is no recent heartbeat. While it was stopped, scheduled work is
  left as `missed` (`runner_offline`) and `catch_up` is applied when it
  returns.

### What each tick does

As described in [phase-1-core.md](phase-1-core.md#tick-step-by-step):

1. Watches the runs in progress.
2. Reconciles the slots and marks `missed`/`superseded`.
3. Launches what is due with the launcher from the user's config
   ([launcher.md](launcher.md)).
4. Closes the subagents that have already finished but are still open.
5. Notifies and writes to the screen.

## Notifications (notifiers)

The runner screen is the main notification. To find out without watching it,
the runner sends events to the notifiers in the config:

```json
"notifiers": [
  { "type": "system", "events": ["failed", "timed_out", "blocked", "missed"] },
  { "type": "command", "events": ["failed"], "run": ["slack-notify", "{{title}}: {{message}}"] }
]
```

- `system`: system notification (`osascript` on macOS, `notify-send` on Linux).
- `command`: any command with variables (`{{event}}`, `{{task_id}}`,
  `{{title}}`, `{{run_ref}}`, `{{message}}`). Works for Herdr, Slack, ntfy…
  `herdr-app` has no notification command (Herdr notifications can only be
  triggered by mods with `notify()`). OSC 777
  (`ESC ] 777 ; notify ; title ; text BEL`) was also tried from a terminal:
  no notification showed up. That is why the default notifier is `system`.
- Events: `launched`, `succeeded`, `failed`, `timed_out`, `missed`,
  `blocked`, `anomaly`, `runner_recovered` (the heartbeat returns after a gap).
- They are grouped per tick and not repeated: each event is marked on the
  occurrence (`events[].notified`).

## Supervisor (optional)

If a tick finds something that needs judgment (a `blocked` subagent, repeated
failures in the same task, anomalies), it can launch a supervisor agent with
the same launcher and the `supervise-tasks` skill (`supervisor.enabled`,
disabled by default):

1. The runner writes a report to `state/supervisor/<timestamp>.json`.
2. It launches it like any task, with `/{{supervisor_skill}} <report>`.
3. There is at most one supervisor at a time, with its own `timeout`.
4. It acts only through the CLI (`session read`, `retry`, `pause`) and ends
   with `agent-tasks supervisor finish <report> --summary "…"`.

It is customized like everything else ([user-config.md](user-config.md)):
`instructions/supervisor.md`, template and your own skill.

## Configuration

```json
{
  "runner": { "every": "5m" },
  "notifiers": [ { "type": "system", "events": ["failed", "timed_out", "blocked"] } ],
  "supervisor": { "enabled": false, "on": ["blocked", "repeated_failure", "anomaly"] }
}
```

`max_delay` defaults to 3× `runner.every` (15 min with 5 min) and is never
less than 15 min.

## Steps

| # | Step | Done when |
|---|---|---|
| R1 | `agent-tasks runner`: loop, lock, caught errors, `--once`, `--every` | a tick is made to fail on purpose and the runner keeps going |
| R2 | Output: log with colors and symbols, status line, `runner.log` | what was launched and what failed is clear at a glance |
| R3 | "Runner stopped" warning in the rest of the commands | `agent-tasks list` without a runner says so at the top |
| R4 | Runner title (OSC 2) and agent state (OSC 7501) | tasks hang from the runner in the Herdr sidebar |
| R5 | `system` and `command` notifiers, grouped and not repeated | one failure produces a single notification |
| R6 | Optional supervisor + `supervise-tasks` skill | a `blocked` launches a supervisor that summarizes it |
| R7 | Full-screen view on a terminal (read-only), `--plain` for lines | recent runs, upcoming slots, tasks and a run's live log are a few keys away |
