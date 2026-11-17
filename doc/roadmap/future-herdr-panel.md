# Future: Herdr panel (separate repo)

> Not part of the current plan. The interface is the CLI
> ([phase-2-cli-ui.md](phase-2-cli-ui.md)). This stays as a design in case a
> panel is built later, in its own repo and on top of the CLI's `--json`.

Goal: see in a Herdr panel the same thing as `agent-tasks status`, `list`,
`runs` and `log`, with one-click actions.

## What goes in each repo

The UI is not part of this project, just like the launcher: each environment
will have its own and there is no "official" one.

| Repo | Contains |
|---|---|
| `agent-tasks` (this one) | The CLI with `--json` everywhere (`status`, `list`, `runs`, `log`…) and the commands to act (`run`, `pause`, `retry`, `runner status`…). No graphical UI code. |
| `agent-tasks-herdr` (new) | The Herdr mod described below. It depends only on the installed CLI and the schema version. Installed like any mod from herdr.dev/mods. |
| Others, by whoever wants | A panel for Rex, a TUI, a local web app… on top of the same JSON. |

Contract rules:

- `status --json` carries `"schema": 1`. Adding fields doesn't change the
  version; removing them or changing their meaning does, and the CLI keeps
  the previous one available (`--schema 1`) for a while.
- UIs never read `data_dir` directly to interpret data; at most they watch it
  to know when to ask for `status` again.
- All actions are CLI commands with `--json`.

## How it fits into Herdr (repo `agent-tasks-herdr`)

- Herdr mods are JavaScript (gpui-kit) in `~/.config/herdr-app/mods/<name>/`,
  with `main.js` and `mod.json`. They hot-reload.
- A mod can run programs (`exec`), read files (`readTextFile`),
  watch folders (`watchFolder`), launch app commands (`run`),
  notify (`notify`, `setBadge`) and save state (`setShared`).
- It is installed by copying `mods/agent-tasks/` to the mods folder (with
  `RECIPE.md` and `preview.png` for herdr.dev/mods) and validated with
  `herdr-app check`.
- It opens as a pane (`pane.split {mod: "agent-tasks"}`) from the palette or
  with a shortcut in `keys.json`. Optional: a small block in a cloned layout
  for the sidebar.
- "View terminal" only makes sense if the run's launcher is `herdr`
  (`session.launcher`); with others the panel shows the log.

## Data: a single call

The mod doesn't interpret the calendar. It asks the CLI for a snapshot:

```
agent-tasks status --json [--runs 20] [--since 7d]   # from the CLI, in this repo
```

```json
{
  "schema": 1,
  "now": "2026-11-17T10:05:00+01:00",
  "runner": {
    "terminal": "t12", "every": "15m",
    "last_tick": "2026-11-17T09:42:00+01:00", "next_tick_estimate": "2026-11-17T10:12:00+01:00",
    "healthy": true,
    "gaps": [{ "from": "2026-11-16T22:10:00+01:00", "to": "2026-11-17T08:31:00+01:00" }]
  },
  "counts": { "running": 1, "blocked": 0, "failed_24h": 1, "missed_24h": 3 },
  "tasks": [
    {
      "id": "weekly-deps-report", "title": "…", "description": "…", "cwd": "…",
      "schedule": { "…": "…" }, "schedule_human": "Mon 09:00",
      "enabled": true, "next_run": "…", "last_status": "succeeded",
      "agent_resolved": { "command": "clc", "from": "profile ~/Projects/**" },
      "recent": [{ "slot": "…", "status": "missed", "reason": "runner_offline" }]
    }
  ],
  "runs": [ { "run_ref": "…", "status": "…", "attempts": [ "…" ] } ]
}
```

`data_dir` also comes in the response (`"data_dir": "…"`) so the UI knows
what to watch (`top --json` already carries it). Refresh:
`watchFolder(data_dir)` triggers a new `status`; plus a 60 s timer for
relative times and the runner state.

All of the panel's actions are calls to the CLI (`run`, `pause`, `resume`,
`retry`, `runner install`). The mod does not write JSON.

## Design

### Main view

```
┌ Agent tasks ────────────────────────────────────────────────────────────┐
│ ● Runner active · last tick 2 min ago · next in 3 min          [⟳]      │
│   1 running · 0 blocked · 1 failed (24h) · 3 missed (24h)               │
│   ▁▁▁▁▁▁▁▁▁▁▁▁░░░░░░░░░░░░░░▁▁▁▁▁▁▁▁   ← 24 h heartbeat (░ = no runner) │
├─────────────────────────────────────────────────────────────────────────┤
│ Search…                                   [All ▾] [+ New (skill)]       │
├─────────────────────────────────────────────────────────────────────────┤
│ ● Dependencies report    Mon 09:00       next in 6 d    ■■■■■■■□■■      │
│ ◐ Worktree cleanup       every day 08:00 running 4m     ■■■■■×■■■◐      │
│ ✕ Sentry summary         every hour      next 10:00     ■■□□□■✕         │
│ ○ Review PR #123         Nov 20 09:00    one-off        ·               │
│ ⏸ Notes backup          every day 23:00 paused         ■■■■             │
└─────────────────────────────────────────────────────────────────────────┘
 ■ succeeded  ✕ failed/timed_out  □ missed  ◐ running  ! blocked  · pending
```

- Header: runner state. Red if there is no heartbeat for more than 2× the
  interval, with instructions to start it (`agent-tasks runner`).
- Heartbeat strip: 24 h of ticks; the gaps explain the `missed` runs.
- Each row: state of the latest occurrence, title, readable schedule,
  next run or current state, and the last 10 occurrences as small
  squares (hover: time, state, reason).
- Order: first what needs attention (`blocked`, `failed`, unreviewed
  `missed`), then by next run.

### Task detail

```
┌ ← Sentry summary ──────────────────────────────── [Run now] [Pause] [Edit] ┐
│ Checks new Sentry errors and leaves a summary in notes/sentry.md           │
│ Folder   ~/Projects/foo            Agent  clc (profile ~/Projects/**)      │
│ Schedule 0 * * * * (Europe/Madrid) Grace 2h · catch_up latest              │
│ Timeout  20m · retries 1           Terminal: kept if it fails              │
│ ▸ Instructions                                                             │
├────────────────────────────────────────────────────────────────────────────┤
│ Slot          Status      Start   Duration  Att.  Summary                  │
│ Nov 17 10:00  pending     —       —         —                              │
│ Nov 17 09:00  ✕ failed    09:12   3m        2/2   "sentry-cli has no auth" │
│                           [View terminal] [View log] [Retry]               │
│ Nov 17 08:00  ■ ok        08:31   6m        1     "3 new issues…"          │
│ Nov 17 07:00  □ missed    —       —         —     runner stopped           │
│ Nov 17 06:00  □ missed    —       —         —     runner stopped           │
└────────────────────────────────────────────────────────────────────────────┘
```

- Header with everything that defines the task, including the resolved agent
  and where it comes from (useful when there are personal profiles).
- Collapsible instructions, rendered as Markdown.
- History: one row per occurrence; expandable to see attempts and events.
- Actions per occurrence:
  - **View terminal**: `terminal.peek` if the subagent is still alive.
  - **View log**: opens the `.log` in a Markdown/Files viewer pane.
  - **Retry**: `agent-tasks retry <run-ref>`.
- Task actions: run now, pause/resume, edit (opens a terminal
  with `agent-tasks edit <id>`), archive (with confirmation).

### Notifications

- When a new `failed`, `timed_out`, `blocked` or `missed` appears:
  `notify({ title, body, level, action })`, which opens the detail on click.
- `setBadge(n)` with what is pending review.
- "Reviewed" is saved with `setShared("agent-tasks.seen", …)`: it is screen
  state, not data state.

### Mini-panel (optional)

A one-line block for the sidebar of a cloned layout:
`● runner ok · ✕1 □3` with a click that opens the full panel.

## Mod structure

```
agent-tasks-herdr/
├── RECIPE.md         # brief for herdr.dev/mods
├── preview.png
└── mods/agent-tasks/
├── mod.json          # { "place": "none", "title": "Agent tasks" }
├── main.js           # view: list ↔ detail
├── data.js           # exec("agent-tasks", ["status","--json"]) + watchFolder + timer
├── header.js         # runner + counters + heartbeat strip
├── task-row.js
├── task-detail.js
├── run-row.js
├── notify.js         # differences between snapshots → notify/badge
└── jsconfig.json     # types from gpui-kit.d.ts and herdr.d.ts
```

## Steps (if it gets built)

1. Visual design in a "Design" Artifact (list, detail, empty/error states, light and dark theme).
2. Create the `agent-tasks-herdr` repo, mod skeleton and install instructions + `herdr-app check`.
3. Runner header and heartbeat strip.
4. Task detail and history.
5. Actions (run, pause, retry, view terminal, view log, start runner).
6. Notifications and badge.
7. `RECIPE.md`, screenshots with `herdr-app shot` and publishing to herdr.dev/mods.

## Empty and error states

- No `config.json` or tasks: explain how to create the first one with the
  global skill and how to start the runner.
- `agent-tasks` not found in the PATH: message with `agent-tasks install`.
- Unsupported schema version: say which version the mod expects and which one the CLI provides.
- `status` fails or returns invalid JSON: show the error and the command,
  and keep the last good snapshot.
