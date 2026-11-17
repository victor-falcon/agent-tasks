# agent-tasks

A minimal scheduler for coding agents. You describe a task (what to do, in
which folder, when: once or on a cron schedule) and at that time a fresh
agent does it in its own terminal tab, reports the result and closes itself.
Every scheduled occurrence ends up recorded: succeeded, failed, timed out or
missed, and why.

Status: early development. Design docs in [doc/roadmap](doc/roadmap/README.md).

## How it works

```
agent-tasks runner                 plain process in a tab, no LLM; ticks every 5m
  │
  │ launcher "launch"              Herdr tab, tmux window, Rex window, child process…
  ▼
sub-agent  "/run-agent-task <run_ref>"
  ├─ agent-tasks task <run_ref>    reads what to do
  ├─ … does the work in the task's folder …
  └─ agent-tasks finish <run_ref>  records the result, then launcher "close"
                                   closes the sub-agent's own tab
```

- **The runner** (`agent-tasks runner`) is a normal process you leave open
  in a tab. Each tick it records a heartbeat, works out which slots are due,
  watches running sessions and launches new ones. It shows every launch,
  success and failure live, and can send desktop notifications.
- **One sub-agent per run**, started by a **launcher**: a few commands in your
  config (`launch`, `close`, `status`, `read`, `attach`), from a preset or
  written by hand. The core knows nothing about any multiplexer.
- **Sub-agents close themselves.** `agent-tasks finish` saves the result and
  runs the launcher's `close` on its own session (failed runs stay open by
  default, `keep_open: on_failure`).
- **Nothing gets lost.** An agent that dies without `finish` is recorded as
  `failed` (`exited_without_report`); one past its timeout is closed and
  recorded as `timed_out`; slots that passed while the runner was stopped are
  recorded as `missed` with the reason (`runner_offline`).

Tasks, runs and the heartbeat are JSON files in `~/.local/share/agent-tasks/`.
Your config (launcher, agent command, per-folder profiles, instructions for
the agents) lives in `~/.config/agent-tasks/`, never in this repo.

## Quick setup with your agent

Paste this into your coding agent (Claude Code or similar), in a terminal of
the multiplexer you use (Herdr, tmux, Rex…); the runner will get its own tab.
You don't need to clone anything first.

```text
Set up agent-tasks (https://github.com/victor-falcon/agent-tasks) on this machine.
Fetch and follow the full procedure in
https://github.com/victor-falcon/agent-tasks/blob/main/RECIPE.md
(raw: https://raw.githubusercontent.com/victor-falcon/agent-tasks/main/RECIPE.md),
step by step: check bun and git, clone the repo and run its install, detect my
terminal multiplexer and configure the launcher that opens one tab per task and
closes it when the sub-agent finishes, ask me which command starts my agent,
write my personal instructions for sub-agents, run agent-tasks config check and
agent-tasks doctor, and do the smoke test. Linking agent-tasks into
~/.local/bin and its skills into ~/.claude/skills is expected; ask me before
installing anything else (such as bun) or changing my shell profile. At the
end, report what you set up and what you could not verify.
```

## Manual setup

Requires [Bun](https://bun.sh) and git. [RECIPE.md](RECIPE.md) has every step
in detail.

```sh
git clone https://github.com/victor-falcon/agent-tasks.git ~/.local/share/agent-tasks-src
cd ~/.local/share/agent-tasks-src
bun install
bin/agent-tasks install   # links agent-tasks into ~/.local/bin and the skills into ~/.claude/skills
agent-tasks init          # creates ~/.config/agent-tasks/ (never overwrites), with the launcher for this terminal
```

Then edit `~/.config/agent-tasks/config.json`:

1. `launcher`: `init` picks it from the terminal it runs in: `herdr` inside
   Herdr, `rex` inside Rex, `tmux` inside tmux, `process` otherwise (see
   [Presets](#presets)). Change it, or write your own commands.
2. `agent`: the command that starts your agent, e.g.
   `{ "command": "claude" }`. With `process` there is no terminal, so `init`
   writes `claude` in print mode (`--print`, allowed to edit files and run
   `agent-tasks` only; add what your tasks need to `--allowedTools`). With
   the other presets the agent asks for permissions in its tab as usual,
   unless you add flags to `args`. Different commands per folder go in
   `profiles`.
3. `instructions/subagent.md`: what every sub-agent must know about your
   machine.

Check and start:

```sh
agent-tasks config check
agent-tasks doctor
agent-tasks runner        # in its own tab; leave it open
```

## Daily use

Create tasks by asking your agent ("every Monday at 9, write a dependencies
report in ~/Projects/foo"): the `schedule-agent-task` skill writes
self-contained instructions and calls `agent-tasks add`. Or directly:

```sh
agent-tasks add --title "Weekly deps report" --cwd ~/Projects/foo \
  --cron "0 9 * * 1" --timezone Europe/Madrid \
  --instructions "Run bun outdated and write reports/deps.md. Don't upgrade anything."
agent-tasks add --title "Release notes" --at 2026-12-01T09:00:00+01:00 --instructions-file notes.md
```

| Command | What it answers |
|---|---|
| `agent-tasks status` | Is everything fine? Runner, last 24h, what needs attention, what's next. Exits 1 when something needs attention. |
| `agent-tasks list` | Every task, its next run and its last 10 results. |
| `agent-tasks show <id>` | A task's definition and which agent, launcher and profile it resolves to, and why. |
| `agent-tasks runs [<id>]` | The occurrence history: ok, failed, timed out, missed (with the reason). |
| `agent-tasks log <run_ref>` | What happened in one run: events, attempts, the captured log. `--follow` keeps reading a running session. |
| `agent-tasks attach <run_ref>` | Bring a running sub-agent's tab to the front (e.g. when it is blocked on a question). |
| `agent-tasks retry <run_ref>` | Launch a new attempt of a failed, timed-out or missed run. |
| `agent-tasks run <id>` | Run a task now, outside its schedule. |
| `agent-tasks edit`, `pause`, `resume`, `rm` | Change, pause, resume or archive a task. |

Per task, you choose what happens when it finishes:

```sh
# Tell me when it succeeds or fails, with the agent's summary, and leave its
# session open so I can keep talking to the agent.
agent-tasks edit weekly-deps-report --notify succeeded,failed --keep-open always
agent-tasks edit nightly-cleanup --notify none   # never notify for this task
agent-tasks edit nightly-cleanup --notify ""     # unset: inherit (profile, defaults, notifiers' events)
```

`--notify` replaces every notifier's `events` for that task's runs (events:
`launched`, `succeeded`, `failed`, `timed_out`, `missed`, `blocked`), so list
`failed` too if you still want failure alerts. A
`succeeded` or `failed` notification carries the summary the agent passed to
`agent-tasks finish` and, when the session was kept open, the
`agent-tasks attach <run_ref>` to get back to it.

Every command takes `--json`. `agent-tasks help <command>` explains each one,
with its filters (`agent-tasks list --status failed`, `agent-tasks runs --since 24h`,
`agent-tasks log <run_ref> --raw`).

```
$ agent-tasks status
Runner    ● alive · every 5m · last tick 2m ago · next in 3m
Last 24h  3 ok · 1 failed · 4 missed (runner stopped 01:10–08:30)
Now       2 running · 1 blocked
Attention
  ✕  sentry-summary/20261117T080000Z  failed    "sentry-cli has no auth"     52m ago
  !  review-pr-123/20261117T083000Z   blocked   "asks to confirm the merge"  11m ago
  □  inbox-triage                     1 missed  (06:00)                      runner_offline
Upcoming
  11:00      sentry-summary      every hour
  Wed 06:00  inbox-triage        every day 06:00
```

## Configuration

Everything is optional. Start from
[examples/config.example.json](examples/config.example.json) (what
`agent-tasks init` copies) and the example tasks in [examples/](examples/).
The full reference (precedence, profiles, instructions, templates, custom
skills) is in [doc/roadmap/user-config.md](doc/roadmap/user-config.md), and
the launcher commands and variables in
[doc/roadmap/launcher.md](doc/roadmap/launcher.md).

Each task has a `machine`, where it runs: this machine's name (`machine` in
the config, `local` by default) unless `add --machine <name>` picks one of
the `machines` in the config. Running tasks on other machines is in
progress; see [doc/roadmap/user-config.md](doc/roadmap/user-config.md).

Notifications go to the `notifiers` in the config (a desktop notification by
default, for `failed`, `timed_out` and `blocked`; or any command, e.g. one that
sends a message to your phone). A task's `notify`, a profile's or
`defaults.notify` picks which of a task's run events they send; see
[doc/roadmap/runner.md](doc/roadmap/runner.md#notifications-notifiers).

## Presets

| Preset | Where each run goes | Notes |
|---|---|---|
| `herdr` | Its own Herdr tab, nested under the runner | Agent state (working, idle, blocked) from Herdr. Run the runner inside Herdr. |
| `rex` | Its own Rex window in the runner's session | **Untested against a real Rex.** Needs `rex` and `jq`. |
| `tmux` | Its own tmux window | tmux has no agent status: blocked agents are only caught by the timeout. tmux 3.0+. |
| `process` | A child process of the runner, output in the run's log | No terminal and no agent state, so the agent must run non-interactively (`claude --print`). What `init` picks outside a multiplexer; for tests and machines without one. |

The interactive presets (`herdr`, `rex`, `tmux`) start a shell and type the
agent command at its prompt, so shell aliases and functions work. For
anything else (Orca, WezTerm, your own tool), write the commands yourself; see
[RECIPE.md](RECIPE.md#3a-a-custom-launcher).

## Development

```sh
bun install
bun test             # tests never touch your real home
bunx tsc --noEmit    # type check
bin/agent-tasks help
```

An end-to-end test runs the `herdr` preset in a real Herdr, with no LLM: from
a terminal inside Herdr, it opens a runner in a new tab of the current space,
schedules two one-off tasks a minute ahead for a stand-in agent
(`test/e2e/herdr-agent.sh`), checks that each one gets its own tab nested
under the runner, that the succeeded one closes its tab and the failed one
keeps it open, then kills everything it started. It takes about two minutes
and is skipped unless you ask for it:

```sh
AGENT_TASKS_E2E_HERDR=1 bun test test/e2e
```

Each CLI command lives in its own file under `src/commands/` and is
registered in `src/commands/index.ts`. The design docs are in
[doc/roadmap/](doc/roadmap/README.md).

## License

[MIT](LICENSE)
