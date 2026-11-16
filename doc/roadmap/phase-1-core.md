# Phase 1: core

Goal: be able to create tasks from anywhere, start the runner with one
command and have a reliable record of every occurrence, including those nobody
ran.

## Repo structure

```
agent-tasks/
├── bin/agent-tasks                  # #!/usr/bin/env bun → src/cli.ts
├── src/
│   ├── cli.ts                       # command parsing
│   ├── paths.ts                     # resolves the root (AGENT_TASKS_HOME or the bin's own)
│   ├── schema.ts                    # types + task/run validation
│   ├── schedule.ts                  # slots, margin, catch_up (croner)
│   ├── store.ts                     # atomic JSON read/write
│   ├── tick.ts                      # reconcile + watch + launch
│   ├── launcher.ts                  # launcher command templates (see launcher.md)
│   ├── runner.ts                    # loop, lock, live output (see runner.md)
│   └── task-context.ts              # what `agent-tasks task <run_ref>` prints
├── presets/                         # herdr.json, rex.json, process.json, tmux.json
├── test/                            # bun test, with a fixed clock
├── src/config.ts                    # user config and precedence (see user-config.md)
├── examples/                        # config.example.json, example tasks
└── …

<data_dir>/                          # outside the repo; by default ~/.local/share/agent-tasks
│   ├── tasks/<task-id>.json
│   ├── runs/<task-id>/<slot>.json
│   ├── runs/<task-id>/<slot>.log    # captured subagent output (launcher's `read`)
│   ├── archive/<task-id>.json       # deleted tasks
│   └── state/
│       ├── ticks.jsonl              # runner heartbeat, one line per tick
│       ├── runner.lock              # runner lock (pid, terminal, start time)
│       ├── runner.log               # same as what the runner shows on screen
│       └── supervisor/              # reports for the supervisor (see runner.md)

agent-tasks/ (continued)
├── skills/run-agent-task/SKILL.md        # global: used by each task's subagent
├── skills/schedule-agent-task/SKILL.md   # global: create tasks from any project
├── skills/supervise-tasks/SKILL.md       # optional: used by the supervisor
└── doc/roadmap/
```

The code is located from the real path of `bin/agent-tasks` (following the
symlink) and the data from `data_dir` in the user's configuration, so the
CLI works the same from any folder. The paths below such as
`runs/…` are relative to `data_dir`.

## Data model

### Task: `<data_dir>/tasks/<id>.json`

```json
{
  "id": "weekly-deps-report",
  "title": "Weekly dependencies report",
  "description": "Why the task exists; read by a person.",
  "cwd": "~/Projects/foo",
  "instructions": "Full prompt for the subagent: what to do, what to deliver, where to leave it.",
  "schedule": { "type": "cron", "cron": "0 9 * * 1", "timezone": "Europe/Madrid",
                "starts_at": null, "until": null },
  "agent": null,
  "catch_up": "latest",
  "max_delay": "2h",
  "timeout": "45m",
  "retries": 0,
  "keep_open": "on_failure",
  "enabled": true,
  "created_at": "2026-11-16T15:00:00+01:00",
  "created_by": { "cwd": "~/Projects/foo", "session": "t12" },
  "updated_at": "2026-11-16T15:00:00+01:00"
}
```

- `agent`: normally `null`; it is resolved from the user's configuration
  (per-folder profiles, aliases such as `clc`). Only filled in if the task
  needs a specific agent.
- One-off `schedule`: `{ "type": "once", "at": "2026-11-20T09:00:00+01:00" }`.
- `catch_up`, what to do with late slots that are still within `max_delay`:
  - `latest` (default): launches only the most recent; earlier ones become `superseded`.
  - `all`: launches all of them, one at a time.
  - `none`: recovers nothing; late slots become `missed`.
- `max_delay`: how late a slot can be and still run. By default,
  3× the runner interval and never less than 15 min. Past that time, `missed`.
- `id`: slug derived from the title; the CLI adds a suffix if it already exists.

### Occurrence: `<data_dir>/runs/<task-id>/<slot>.json`

`<slot>` is the scheduled time in UTC and in a file-safe format
(`20261117T080000Z`). Manual runs use `manual-<timestamp>`.

```json
{
  "task_id": "weekly-deps-report",
  "slot": "2026-11-17T09:00:00+01:00",
  "trigger": "schedule",
  "status": "running",
  "reason": null,
  "attempts": [
    {
      "n": 1,
      "started_at": "2026-11-17T09:12:03+01:00",
      "finished_at": null,
      "session": { "launcher": "herdr", "handle": "t45", "name": "task-weekly-deps-report-20261117t0800" },
      "agent": { "command": "clc", "shell": true, "from": "profile ~/Projects/**" },
      "status": "running",
      "summary": null,
      "log": "runs/weekly-deps-report/20261117T080000Z.log"
    }
  ],
  "events": [
    { "at": "2026-11-17T09:12:03+01:00", "event": "claimed", "by": "tick" },
    { "at": "2026-11-17T09:12:04+01:00", "event": "launched", "handle": "t45" }
  ]
}
```

Statuses (the occurrence's `status`, which reflects the latest attempt):

| Status | Meaning | Set by |
|---|---|---|
| `running` | subagent launched, not closed | `tick` |
| `succeeded` | the subagent considered it a success | `finish` |
| `failed` | it tried and failed, or the terminal died without reporting | `finish` / `tick` |
| `timed_out` | exceeded `timeout`; the log was captured and it was stopped | `tick` |
| `blocked` | the subagent is waiting for a person (the launcher's `status` reports it as `blocked`) | `tick` (shown by the runner, alerts via the notifiers and may launch the supervisor) |
| `missed` | nobody launched it within `max_delay` | `tick` |
| `superseded` | late, replaced by a more recent slot (`catch_up: latest`) | `tick` |
| `cancelled` | task paused or deleted at that moment, or manual cancellation | `tick` / CLI |

`reason` in `missed` distinguishes `runner_offline` (there was no tick at all
between the slot and slot + `max_delay`: runner stopped, machine off or asleep)
from `runner_skipped` (there were ticks and it did not launch it: this is a bug
and is notified as an anomaly).

### Heartbeat: `<data_dir>/state/ticks.jsonl`

```json
{"at":"2026-11-17T09:12:00+01:00","mode":"system","launched":1,"missed":0,"finished":2,"errors":[]}
```

## CLI

Every command accepts `--json` (output for agents and other tools) and `--now <iso>`
(fixed clock for tests and manual testing).

| Command | What it does |
|---|---|
| `add` | Creates a task. With flags (`--title --cwd --at\|--cron --instructions-file -`) or a JSON on stdin. Validates, checks that `cwd` exists and shows the next 3 runs. |
| `list` | Tasks with next run, last status and how many `failed`/`missed` in 7 days. |
| `show <id>` | Definition + latest occurrences. |
| `edit <id>` | Changes fields (`--cron`, `--instructions-file`, …) or opens `$EDITOR`. Revalidates. |
| `pause <id>` / `resume <id>` | `enabled`. While paused, its slots are left as `cancelled` with `reason: paused`. |
| `rm <id>` | Moves the task to `<data_dir>/archive/` (the history stays). |
| `due` | What `tick` would do now, without touching anything. |
| `tick` | One pass (see below). Run by the runner; by hand, for testing. |
| `run <id>` | Immediate manual run (`trigger: manual`). |
| `finish <run-ref> --status succeeded\|failed --summary "…" [--output-file f]` | Called by the subagent when done. Saves the result and closes its session with the launcher's `close`. `run-ref` = `<task-id>/<slot>`. |
| `retry <run-ref>` | New attempt of a `failed`/`timed_out`/`missed` occurrence. |
| `runs [<id>] [--status …] [--since 7d]` | Filterable history. |
| `runner [--every 5m] [--once]` | The loop, in the foreground, with live output. See [runner.md](runner.md). |
| `runner status` | Says whether a runner is alive, where, and its last heartbeat. |
| `task <run_ref>` | Called by the subagent at start: instructions, context and how to finish. |
| `supervisor finish <report> --summary "…"` | Called by the supervisor when done. |
| `log <run-ref>`, `status` | Views for people: see [phase 2](phase-2-cli-ui.md). |
| `install` | Links `bin/agent-tasks` into `~/.local/bin` and the global skills into `~/.claude/skills/`. |
| `doctor` | Checks the launcher (that its commands exist and what it can do), the PATH, that the data can be read and that the runner shows signs of life. |

### `tick`, step by step

1. **Heartbeat**: appends the line to `ticks.jsonl` (at the end, with the totals).
2. **Watch what is in progress** (each `running`/`blocked` occurrence):
   - launcher's `status`: if it no longer exists or exited without `finish` → `failed`, `reason: exited_without_report`.
   - If it says `blocked` → `blocked` (event for notifiers and supervisor).
   - If `timeout` passed → `read` to the `.log`, `close` → `timed_out`.
   - (If the launcher has no `status`, only `finish` and `timeout` count.)
   - If there is already a `finish` and the subagent is still alive (`finish`'s `close`
     failed or `keep_open` left it open) → captures the log and closes it according to `keep_open`
     (`always`, `on_failure`, `never`).
   - If `retries` remain after a failure → new attempt.
3. **Reconcile**: for each task, computes the slots between
   `max(created_at, now - 30d)` and `now`. Each slot without a file:
   - outside `max_delay` → `missed` with its `reason`;
   - inside → candidate; `catch_up` is applied.
   - task paused → `cancelled`.
4. **Launch** each candidate:
   - claims it by creating the file with `wx` (if it already exists, another process took it: skip);
   - resolves the agent (`clc`, `claude`…) and runs the launcher's `launch` from the user's config with the prompt `/{{skill}} <run-ref>` (in Herdr: a new tab in the runner's space with `herdr.parent=<runner>`, so the task hangs off it); see [launcher.md](launcher.md);
   - if the launcher reports that the prompt was not delivered (in Herdr, `first_message.sent: false`), `failed` with `reason: prompt_not_delivered` and the log.
5. **Notify**: writes the events to the runner's screen and sends them to the notifiers, grouped.
6. **Supervisor**: if something needs judgment (`blocked`, repeated failures,
   anomalies) and it is enabled, writes a report and launches the supervisor.
7. **Output**: readable summary, or JSON with `launched`, `finished`, `failed`,
   `missed`, `blocked`, `anomalies` with `--json`.

A `once` task that ends in a final state generates no more slots; `list` shows
it as finished.

### The subagent: `/run-agent-task <run_ref>`

The runner does not paste the instructions into the command line. It launches the agent
with `/{{skill}} <run_ref>` (by default `/run-agent-task`) and the global skill
does the rest:

1. `agent-tasks task <run_ref>`, which prints:

   ```
   Task "<title>" (<task-id>), slot <slot>, attempt <n>
   Working directory: <cwd>

   <instructions>

   <personal instructions: instructions/subagent.md + the profile's>

   When you are done, or if it fails, run:
     agent-tasks finish <run_ref> --status succeeded|failed --summary "<what you did, where the result is>" [--output-file <file>]
   ```

2. Does the work. If it needs a person, it asks and waits (the runner will
   see it as `blocked`).
3. Always ends with `finish`, even if it fails. `finish` saves the
   result and closes the agent's session with the launcher's `close`.

Anyone who wants a different flow can change `skill` in the config to their own.

### Runner, notifications and supervisor

`agent-tasks runner` is a normal process (not an agent) that you leave open
in a Herdr tab: it does a `tick` every few minutes, stays alive,
shows live what it launches and how it ends, and alerts through the notifiers. An
optional supervisor is launched only when something needs judgment. Details in
[runner.md](runner.md).

## Optional skill: `supervise-tasks`

For the supervisor (disabled by default), which receives the path of a runner report:

1. `agent-tasks config instructions supervisor`: read and follow the user's personal instructions (they do not live in the repo).
2. Read the report.
3. For each `blocked`: `agent-tasks session read <run-ref>`, summarize what it asks for and
   notify (`agent-tasks notify`). Do not answer on its behalf unless the task
   allows it.
4. For repeated failures: read the logs (`agent-tasks log <run-ref>`), propose
   the cause and decide between `retry`, `pause` or just notifying.
5. For anomalies (`runner_skipped`, `prompt_not_delivered`, corrupt
   JSON): explain what it saw, without fixing data by hand.
6. End with `agent-tasks supervisor finish <report> --summary "…"`.
7. Never edit `data_dir` directly; always through the CLI.

## Global skill: `schedule-agent-task`

For any agent, in any project:

1. When to use it: "schedule…", "remind me that an agent…", "every Monday…",
   "on day X do…".
2. Gather: what to do, in which folder (by default the current one), when (a
   one-off date or cron + time zone) and what counts as done.
3. Write self-sufficient `instructions`: the subagent starts without context
   (paths, commands, where to leave the result, success criterion).
4. `agent-tasks add --json` with the task on stdin; show the user the id and
   the next runs it returns.
5. Query or change: `agent-tasks list|show|edit|pause|rm`.

## Steps

| # | Step | Done when |
|---|---|---|
| 1 | Skeleton: Bun + TS, `croner`, `bin/agent-tasks`, MIT license, `.gitignore` | `agent-tasks --help` works from another folder |
| 2 | `schema.ts` + `store.ts` (atomic write: temp file + `rename`; claim with `wx`) | validation and concurrent-claim tests |
| 3 | `schedule.ts`: slots, `max_delay`, `catch_up`, time zone, `once` | tests with a fixed `--now`: clock change, lost slots, `latest` vs `all` |
| 3b | User configuration: steps C1–C5 of [user-config.md](user-config.md) | `config resolve` correct with and without `config.json` |
| 4 | `add`, `list`, `show`, `edit`, `pause`, `resume`, `rm`, `runs`, `due` | create and list tasks from another project |
| 4b | Launcher and presets: steps L1–L7 of [launcher.md](launcher.md) | full cycle with `process` and with `herdr` |
| 5 | `tick` (heartbeat, reconcile, watch, launch) on top of the launcher | a `tick` launches a subagent that hangs off the runner in Herdr |
| 6 | `task`, `finish` (with `close`), `run`, `retry`, log capture, `keep_open` | full cycle with `succeeded` and with `failed` |
| 7 | Runner, notifiers and supervisor: steps R1–R6 of [runner.md](runner.md) | the runner survives a failing tick and shows every event |
| 8 | Skill `run-agent-task` (and `supervise-tasks`, optional) | an agent launched with `/run-agent-task <ref>` does the task, reports and closes |
| 9 | Skill `schedule-agent-task` + `install` + `doctor` | from another repo, "schedule X every day at 9" creates the task |
| 10 | End-to-end test (below) | all scenarios leave the expected record |

### End-to-end test scenarios

- One-off task in 5 min → `succeeded`, with log and summary.
- Cron every 15 min with the runner stopped for 1 h → `missed` slots with
  `reason: runner_offline`; on return, only the last one is launched (`latest`)
  and the runner shows `runner_recovered`.
- Machine asleep during a slot → on waking, the next tick applies
  `max_delay`/`catch_up`.
- `blocked` subagent → `!` in the runner and an alert.
- Subagent that finishes well → `✓` in the runner and its session disappears from Herdr.
- Subagent that calls `finish --status failed` → `failed`; with `retries: 1`, second attempt.
- Subagent that does not finish → `timed_out`, log saved, terminal stopped.
- Subagent closed by hand without `finish` → `failed`, `exited_without_report`.
- Two runners at once → the second says where the first is and exits; two manual `tick`s → a single run per slot.
- Restart the runner with a task in progress → the task continues and the new runner watches it.

## Open questions

- Resolved: the runner is started by the user by hand; Herdr nests the tasks if
  the runner announces itself as an agent (OSC 7501) and the tasks carry `herdr.parent`.
