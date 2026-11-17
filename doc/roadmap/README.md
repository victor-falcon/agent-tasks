# agent-tasks: roadmap

A minimal scheduled-task system for agents. Tasks are JSON files in a user
data folder (outside the repo). `agent-tasks runner` is a normal process (not
an agent) that you leave open in a tab, for example in Herdr. Every few
minutes it checks what is due, launches a subagent in the task's folder with
the commands the user has configured, and shows live what was launched and how
it ended. The subagent starts with `/run-agent-task <run_ref>`, reads the task,
does it, saves the result and closes itself. Everything is recorded: what ran,
what failed and what was skipped. The interface is the CLI itself.

## Pieces

| Piece | What it is | Where it lives |
|---|---|---|
| Data | `tasks/*.json` (definitions) and `runs/<task>/<slot>.json` (each occurrence) | `data_dir`, by default `~/.local/share/agent-tasks/` |
| Personal config | launcher, agent command (e.g. an alias), per-folder profiles, notifications, own instructions | `~/.config/agent-tasks/` |
| `agent-tasks` CLI | The only entry point to the data and also the interface: create, list, view logs, `task`, `finish` | `bin/agent-tasks` + `src/` (Bun + TypeScript), linked in `~/.local/bin` |
| Runner | `agent-tasks runner`: LLM-free loop in a tab, with a live log | started by the user by hand in a tab |
| Launcher | Commands to launch, watch and close subagents; presets `herdr`, `rex`, `process`, `tmux` | presets in `presets/`; the one in use, in the user's config |
| Notifiers | Alerts for `failed`, `missed`, `blocked`… outside the runner's screen | `src/notifiers/`; chosen in the config |
| `run-agent-task` skill | Used by each task's subagent: read, execute, report | `skills/run-agent-task/`, linked in `~/.claude/skills/` |
| `schedule-agent-task` skill | How to create tasks from any other project | `skills/schedule-agent-task/`, linked in `~/.claude/skills/` |
| `supervise-tasks` skill | Optional: a one-off agent for blocks, repeated failures or anomalies | `skills/supervise-tasks/` |

```
 other project                      data_dir (~/.local/share/agent-tasks)
┌──────────────┐  agent-tasks add  ┌──────────────────────────────────────┐
│ agent +      │ ────────────────▶ │ tasks/*.json                          │
│ global skill │                   │ runs/<task>/<slot>.json               │
└──────────────┘                   │ state/ticks.jsonl                     │
                                   └───────▲───────────────▲──────────────┘
                                           │ tick          │ task / finish
 Herdr tab                                 │               │
┌──────────────────────────────────┐       │      ┌────────┴──────────────────┐
│ agent-tasks runner               ├───────┘      │ subagent (runner's        │
│ 10:00 ▶ sentry-summary launched  │   launch     │ sub-agent in Herdr)       │
│ 10:06 ✓ sentry-summary 6m        ├─────────────▶│ /run-agent-task <run_ref> │
│ 10:15 ✕ backup-notes failed      │              │ … when done: finish →     │
│ ● healthy · next 10:20           │              │ closes itself             │
└──────────────┬───────────────────┘              └───────────────────────────┘
               │ notifiers
               ▼
            alerts (system, Herdr, Slack…)
```

## Decisions

1. **JSON on disk, one file per occurrence.** No database. One file per
   `(task, slot)` avoids write conflicts and allows claiming an occurrence
   atomically (create with `O_EXCL`).
2. **The runner is a process, not an agent.** An agent in a loop would spend
   tokens on every turn, degrade over time and add nothing to the calendar.
   `agent-tasks runner` does the deterministic `tick`, stays alive and shows
   events in its tab. Agents only appear to do tasks (and, optionally, to
   supervise). See [runner.md](runner.md).
3. **How an agent is launched is user configuration.** The launcher is a set
   of commands with variables (`launch`, `close`, `status`, `read`, `attach`).
   The repo ships presets; in Herdr, the task appears as a sub-agent of the
   runner. See [launcher.md](launcher.md).
4. **The subagent fends for itself.** It starts with `/run-agent-task <run_ref>`,
   reads the task with `agent-tasks task`, executes it and ends with
   `agent-tasks finish`, which saves the result and closes it with the
   launcher's `close`. The agent does not need to know which multiplexer it is in.
5. **Cron for recurring, ISO date for one-off.** Agents already know how to
   write cron; the `croner` library resolves it with a time zone.
6. **An occurrence never disappears silently.** Every scheduled slot ends in a
   final state: `succeeded`, `failed`, `timed_out`, `missed`, `superseded` or
   `cancelled`. A slot with no file past its margin is recorded as `missed`
   on the next `tick`, with the reason.
7. **Runner heartbeat.** Every `tick` appends a line to `ticks.jsonl`. This
   way a `missed` can explain whether the runner was stopped or was alive and
   still did not launch the task (a bug).
8. **Open source: personal stuff stays out of the repo.** The repo holds code,
   skills, presets and defaults; the user's configuration (launcher, aliases
   such as `clc`, accounts, machine-specific rules) and the data live in
   `~/.config/agent-tasks/` and `data_dir`. See [user-config.md](user-config.md).
9. **The CLI is the interface.** The runner tab for what is happening now;
   `status`, `list`, `show`, `runs`, `log` and `attach` for the rest. Everything
   has `--json`, so a graphical panel could be built later in another repo
   without touching this one.

## Documents

- [Phase 1: core (data, CLI, tick, skills)](phase-1-core.md)
- [Runner, notifications and supervisor](runner.md)
- [Launcher: how subagents are launched](launcher.md)
- [User configuration (outside the repo)](user-config.md)
- [Phase 2: the CLI as the interface](phase-2-cli-ui.md)
- [Future: Herdr panel in a separate repo](future-herdr-panel.md) (outside the current plan)

## Step-by-step plan (summary)

Phase 1
1. Project skeleton: Bun + TS, `bin/agent-tasks`, license, `.gitignore`.
2. Data model and validation (task, run, tick) with tests.
3. Calendar engine: `once`/`cron` slots, margin, `catch_up`, with an injectable clock (`--now`).
4. User configuration: `config.json`, profiles, personal instructions, templates, `data_dir` outside the repo (C1–C8).
5. Management commands: `add`, `list`, `show`, `edit`, `pause`, `resume`, `rm`, `runs`, `due`.
6. Launcher and presets `process` and `herdr`; `task`, `finish` with `close` (L1–L6).
7. `tick`: heartbeat, reconciliation (`missed`/`superseded`), watching in-progress runs, launching.
8. `run` (manual), `retry`, log capture.
9. `agent-tasks runner`: loop, lock, live output, agent state for Herdr, notifiers (R1–R5).
10. Global skill `run-agent-task`.
11. Global skill `schedule-agent-task` + `agent-tasks install` + `doctor`.
12. End-to-end test in Herdr: the task hangs off the runner, closes itself; runner stopped (→ `missed`), failure, timeout, `blocked`.
13. Optional: supervisor + skill `supervise-tasks` (R6); preset `rex` (L7).

Phase 2 (details in [phase-2-cli-ui.md](phase-2-cli-ui.md))
14. Common output format (tables, symbols, relative dates, `--json` with `schema`).
15. `status` with exit code.
16. `list` with compact history and filters.
17. `show` with resolved agent/launcher/skill and `--instructions`.
18. `runs` and `log` (`--attempt`, `--follow`, `--raw`).
19. `attach` to answer a `blocked`.
20. README with "Daily use".

## Out of scope for now

- Dependencies between tasks, queues or priorities.
- Multiple machines: in progress. Tasks carry a `machine` and the config has
  `machine`, `machines` (on the hub) and `hub` (on clients); forwarding
  commands from clients and launching on other machines are not implemented yet.
- Graphical interface (see [future-herdr-panel.md](future-herdr-panel.md)).
