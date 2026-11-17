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

```
$ agent-tasks runner
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
- The same lines go to `<data_dir>/state/runner.log`.

Options: `--every 5m` (default, from the config), `--once` (a single tick and
exit, for testing), `--quiet` (events only, no status line).

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

### Remote machines

The runner only runs on the hub. A task whose `machine` is not the hub is
launched, watched and closed on that machine over SSH: the hub runs
`ssh -o BatchMode=yes -o ConnectTimeout=10 <machines[name].ssh>
~/.local/bin/agent-tasks remote <op> --json` with a JSON payload on stdin
(`"protocol": 1`) and reads a JSON answer on stdout. The `remote` commands
always run on the machine itself (a client never forwards them):

| Op | Payload (besides `protocol`) | Answer |
|---|---|---|
| `launch` | `machine`, `task` (`id`, `title`, `cwd`, `agent`), `run_ref`, `slot`, `slot_id`, `attempt` | `launcher`, `handle`, `pid`, `delivered`, `error`, `agent`, `cwd` |
| `status` | the same plus `handle` | `state` (null without a `status` command), `raw` |
| `read` | the same plus `mode`: `screen` or `capture` | `output`, `source` |
| `close` | the same plus `handle` | `closed` (null without a `close` command), `error` |
| `check-cwd` | `cwd` | `exists`, `path`, `cwd` (with `~`) |
| `instructions` | `task` (`cwd`, `agent`) | `cwd`, `personal_instructions`, `missing_instructions` |

The execution machine resolves the launcher, agent, profile (matched by the
task's `cwd` there), skill, env, prompt template and personal instructions
with its own config; the hub keeps time zones, scheduling, timeouts, retries,
`keep_open` and notifiers (those come from the hub's config, its profiles
matched against the task's `cwd`). Errors come back as the usual `--json`
error object, and both sides check `protocol`. The attempt's session records
`machine`, so later status, read and close go to the same place; runs
without it ran on the hub.

The agent's environment points `AGENT_TASKS_CONFIG` at the execution
machine's config, so its `agent-tasks task` and `finish` reach the hub
through the client's forwarding (t2). `task` asks the execution machine
(`instructions`) for the task folder and personal instructions.

- **Logs**: a background launcher (`process`) writes to
  `<data_dir>/remote/<task>/<slot>[.n].log` on the machine; when the session
  ends, `read --mode capture` copies it (or the screen) into the hub's log.
- **Unreachable at launch** (ssh exit 255): the due slot keeps no attempt and
  waits (status `running`, reason `machine_unreachable`, one
  `machine_unreachable` event); every tick tries again until `max_delay` has
  passed, then it is `missed` with reason `machine_unreachable` and notified
  like any missed slot. If the task is paused or removed meanwhile, the slot
  is `cancelled` (`paused`/`archived`). Manual runs and retries fail right
  away with that reason.
- **Launch is idempotent per attempt**: exit 255 also happens when the
  connection breaks after the remote command started. The machine keeps
  `<data_dir>/remote/<task>/<slot>[.n].launch.json` and, while that session
  is alive, answers a repeated `launch` with it (`reused: true`) instead of
  starting a second agent. A launch that times out on the hub (no answer in
  90s) still ends as `launch_failed`, and its session, if any, is left there.
- **Unreachable while running**: never `gone`. Tick adds one
  `machine_unreachable` event per outage and tries again on the next pass;
  timeouts still apply. A close that cannot reach the machine sets
  `close_pending` (it closes on a later tick whatever `keep_open` says), does
  not count as a failed close, and is retried quietly until the machine is
  back.
- **One wait per tick**: once a machine is found unreachable, the rest of
  that tick skips it, so a machine that is off costs one SSH connect timeout
  (10s) per tick, not one per run.
- **`finish`** (forwarded from the client to the hub) closes the session on
  its machine.
- **`add`/`edit`** check a remote task's `cwd` with `check-cwd`: a missing
  folder is an error; an unreachable machine saves the task with a warning
  (stderr, and `warnings` with `--json`). The `cwd` must be absolute or start
  with `~`.
- `attach` and `log --follow` of remote sessions come later (t4).

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
- A single `succeeded` or `failed` run carries the summary the agent passed
  to `agent-tasks finish --summary` (up to 300 characters) as its message and,
  when `keep_open` left the session open, a line
  `Session still open: agent-tasks attach <run_ref>`. Several runs grouped
  in one tick keep the short form (the task titles).

### Per task: `notify`

Each notifier's `events` is the default for every task. A task can say which
of its run events to notify instead, with `notify` (`agent-tasks add|edit
--notify succeeded,failed`):

| `notify` | For this task's run events |
|---|---|
| `null` (unset) | each notifier sends the events in its own `events` |
| `["succeeded", "failed"]` | every notifier sends exactly these, ignoring its `events` |
| `[]` (`--notify none`) | nothing is sent |

Only run events can be listed (`launched`, `succeeded`, `failed`,
`timed_out`, `missed`, `blocked`); `anomaly` and `runner_recovered` are not
about a task's runs and stay with the notifiers' `events`. The list goes to
every notifier: there is no per-task routing to one notifier, and a list
without `failed` also silences failure alerts for that task. `--notify ""`
resets the task to `null`, which inherits the profile's or
`defaults.notify` when set. Like `keep_open` and `timeout`, it resolves
task > first matching profile > `defaults.notify` > `null`, and
`agent-tasks show` / `agent-tasks config resolve` print the value and where
it came from.

With `--keep-open always` as well, the user is told the result and can open
the session (`agent-tasks attach <run_ref>`) to keep talking to the agent.

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
