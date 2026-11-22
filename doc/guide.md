# agent-tasks guide

Everything the [README](../README.md) leaves to your agent, by hand: the
manual installation, creating and managing tasks with the CLI, and the
details behind them.

- [Manual setup](#manual-setup)
- [Your first task, by hand](#your-first-task-by-hand)
- [Concepts](#concepts)
- [Creating tasks](#creating-tasks)
- [Commands](#commands)
- [The dashboard](#the-dashboard)
- [When a run ends](#when-a-run-ends)
- [Tasks that need credentials](#tasks-that-need-credentials)
- [Configuration](#configuration)
- [Multiple machines](#multiple-machines)
- [Presets](#presets)
- [Troubleshooting](#troubleshooting)
- [Updating and uninstalling](#updating-and-uninstalling)
- [Development](#development)

## Manual setup

You need macOS or Linux (WSL works too), [Bun](https://bun.sh), git, a coding
agent you start from a terminal (the bundled skills are installed for Claude
Code, in `~/.claude/skills`) and `~/.local/bin` on your `PATH`. A terminal
multiplexer (Herdr, tmux or Rex) is optional but recommended.
[RECIPE.md](../RECIPE.md) has every step in detail; this is the short
version. Run it from a terminal of your multiplexer, if you use one: `init`
picks the launcher from the terminal it runs in.

**1. Install.**

```sh
git clone https://github.com/victor-falcon/agent-tasks.git ~/.local/share/agent-tasks-src
cd ~/.local/share/agent-tasks-src
bun install
bin/agent-tasks install   # links agent-tasks into ~/.local/bin and the skills into ~/.claude/skills
agent-tasks init          # creates ~/.config/agent-tasks/ (never overwrites), with the launcher for this terminal
```

The links point into the checkout, so keep it where it is.

**2. Configure.** Open `~/.config/agent-tasks/config.json`:

- `launcher`: how each run is opened. `init` picks `herdr` inside Herdr,
  `rex` inside Rex, `tmux` inside tmux and `process` otherwise (see
  [Presets](#presets)). Change it, or write your own commands.
- `agent`: the command that starts your agent, e.g.
  `{ "command": "claude" }`. With `herdr`, `rex` and `tmux` the agent runs in
  a real shell, so aliases work, and it asks for permissions in its tab as
  usual unless you add flags to `args`. With `process` there is no terminal,
  so `init` writes `claude` in print mode (`--print`, allowed to edit files
  and run `agent-tasks` only; add what your tasks need to `--allowedTools`).
  A different agent per folder goes in `profiles`.

Then write in `~/.config/agent-tasks/instructions/subagent.md` what every
sub-agent should know about your machine (which tools to use, what never to
do). The file has commented examples.

**3. Check.**

```sh
agent-tasks config check  # the config is valid and its commands exist
agent-tasks doctor        # this machine is ready; each problem comes with how to fix it
```

**4. Start the runner** in its own tab, and leave it open. Nothing runs
while it's stopped.

```sh
agent-tasks runner
```

## Your first task, by hand

With the runner open in one tab, go to another one and create a task:

```sh
mkdir -p ~/agent-tasks-hello
agent-tasks add --title "Hello" --cwd ~/agent-tasks-hello \
  --cron "0 9 * * 1" \
  --instructions "Write the current date and the output of uname -a to hello.md. Done when hello.md exists."
```

It would run every Monday at 9:00. To try it now, without waiting:

```sh
agent-tasks run hello
```

A new tab opens (with a multiplexer) and the agent starts. When it finishes
it reports and its tab closes. Check the result:

```sh
agent-tasks runs hello           # the run: succeeded or failed, how long it took
agent-tasks log hello            # what happened in its latest run, with the captured output
cat ~/agent-tasks-hello/hello.md
agent-tasks rm hello             # archive the test task
```

## Concepts

| Word | What it is |
|---|---|
| **Task** | What to do (instructions), where (`cwd`, and the `machine`) and when (`--at` once, or `--cron`). |
| **Run** | One occurrence of a task: the 9:00 run of Monday 17. Its id, the **run_ref**, is `<task-id>/<slot>`, e.g. `hello/20261117T080000Z` (the slot in UTC; manual runs use `manual-<time>`). |
| **Runner** | `agent-tasks runner`: a normal process, not an agent. Every 5 minutes it records a heartbeat, works out what's due, watches running sessions and launches new ones. |
| **Launcher** | A few commands in your config (`launch`, `close`, `status`, `read`, `attach`) that open, watch and close a run's terminal. Pick a [preset](#presets) or write your own; the core knows nothing about any multiplexer. |
| **Sub-agent** | The agent the launcher starts for one run. It gets the task through the `run-agent-task` skill, starts with **no context** beyond the instructions, and reports with `agent-tasks finish`, which also closes its tab (failed runs stay open by default). |

Tasks, runs and the heartbeat are JSON files in `~/.local/share/agent-tasks/`
(`$AGENT_TASKS_HOME`). Never edit them by hand; use the CLI. Your config
lives in `~/.config/agent-tasks/` (`$AGENT_TASKS_CONFIG`).

## Creating tasks

```sh
# Every Monday at 9:00, Madrid time
agent-tasks add --title "Weekly deps report" --cwd ~/Projects/foo \
  --cron "0 9 * * 1" --timezone Europe/Madrid \
  --instructions "Run bun outdated and write reports/deps.md. Don't upgrade anything."

# Once, on a date, with long instructions from a file
agent-tasks add --title "Release notes" --at 2026-12-01T09:00:00+01:00 --instructions-file notes.md

# From a task JSON (see examples/tasks/)
agent-tasks add - --cwd . --id my-deps-report < examples/tasks/weekly-deps-report.json
```

- `--cron` takes a standard 5-field expression (`minute hour day month
  weekday`): `"0 9 * * 1-5"` is weekdays at 9:00, `"*/30 * * * *"` every half
  hour. Without `--timezone`, the `timezone` in your config is used.
- `--at` takes a date and time with its offset, e.g.
  `2026-12-01T09:00:00+01:00`.
- `--cwd` defaults to the current folder; it must exist.
- `add` prints the next 3 runs, so you can check the schedule is the one you
  meant. `agent-tasks help add` lists every option (`--timeout`,
  `--retries`, `--notify`, `--keep-open`, `--catch-up`, `--max-delay`,
  `--agent`, `--machine`…).

**Write the instructions for someone who knows nothing.** The sub-agent
doesn't see the conversation where you created the task. Say what to do,
where to leave the result, what it must not do, and what counts as done
("Done when reports/deps.md exists").

## Commands

| Command | What it answers |
|---|---|
| `agent-tasks top` | The dashboard, without running the scheduler (see [The dashboard](#the-dashboard)). |
| `agent-tasks status` | Is everything fine? Runner, last 24h, what needs attention, what's next. Exits 1 when something needs attention, so it works in scripts and status bars. |
| `agent-tasks list` | Every task, its next run and its last 10 results. |
| `agent-tasks show <id>` | A task's definition and which agent, launcher and profile it resolves to, and why. |
| `agent-tasks runs [<id>]` | The run history: ok, failed, timed out, missed (with the reason). |
| `agent-tasks log <run_ref>` | What happened in one run: events, attempts, the captured log. `--follow` keeps reading a running session. |
| `agent-tasks attach <run_ref>` | Bring a running sub-agent's tab to the front (e.g. when it's blocked on a question). |
| `agent-tasks retry <run_ref>` | Launch a new attempt of a failed, timed-out or missed run. |
| `agent-tasks run <id>` | Run a task now, outside its schedule. |
| `agent-tasks edit <id>` | Change any field: `--cron`, `--instructions`, `--timeout`, `--notify`… |
| `agent-tasks pause`, `resume`, `rm` | Pause, resume or archive a task (its history is kept). |
| `agent-tasks due` | What the runner would do right now, without doing it. |
| `agent-tasks config resolve <id>` | Every setting a task ends up with, and where each one comes from. |
| `agent-tasks runner status` | Whether a runner is alive, where, and when it ticks next. |

Every command takes `--json`, and `agent-tasks help <command>` explains each
one with its filters (`agent-tasks list --status failed`,
`agent-tasks runs --since 24h`, `agent-tasks log <run_ref> --raw`).

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

## The dashboard

`agent-tasks runner` on a terminal shows a live dashboard;
`agent-tasks top` shows the same one without running the scheduler, from
another tab or another machine. The header has the runner's health, when it
ticked and ticks next, and today's counts. Four tabs (`1`–`4`, or
`gt`/`gT`):

- **Overview**: **Needs attention** (blocked runs, and failures and missed
  runs of the last 24 hours you haven't seen), **Running**, **Next** and
  **Recent**, with a preview of the selection on wide terminals.
- **Tasks**: every task with its schedule, next run and last results.
- **Runs**: the whole history, newest first.
- **System**: the runner, its events (`state/runner.log`), machines,
  `doctor`'s checks and unreadable files.

`<CR>` or `l` opens a run or a task; `h`, `q` or `<Esc>` goes back. A run
opens on its result (the summary and the file the agent passed to
`--output-file`), with its details, attempts, events and captured log folded
below: `j`/`k` move between sections, `<CR>` folds or opens one, `/`
searches the log. A task opens on its schedule, with its instructions, runs
and resolved settings beside it (`[`/`]`).

It uses Vim keys (`j`/`k`, `5j`, `gg`/`G`, `<C-d>`/`<C-u>`, `<Tab>` between
sections), and the mouse: a click selects, a double click opens, the wheel
scrolls. `a` attaches, `r` retries, `R` runs a task now, `p` pauses or
resumes (`u` undoes it). `/` filters a list, `:` or `<C-p>` opens a command
palette with every action, task and recent run, and after a prefix such as
`g` a popup lists what can follow. `?` lists the keys of the view.

A failure leaves Needs attention once you open it, or press `x` on it. That
"seen" state is kept in `state/tui.json`, on the machine running the
dashboard, so every dashboard open there agrees. The colors are your
terminal's palette (light or dark theme alike); `NO_COLOR` turns them off.

Keys can be changed in `~/.config/agent-tasks/tui.toml`, where
`mouse = false` leaves the mouse to the terminal; every action and its
default keys are in [examples/tui.example.toml](../examples/tui.example.toml),
and `agent-tasks config check` validates it. `agent-tasks runner --plain`
prints one line per event instead; `top` piped or redirected prints what
`agent-tasks status` prints (use `status` in scripts: its exit code says
when something needs you). `agent-tasks top --json` prints the dashboard's
data once, including `data_dir`, the data folder a UI can watch to know when
to ask again. On a client, `top` runs on the hub, so that path is the hub's.

## When a run ends

| Status | Meaning |
|---|---|
| `succeeded` | The agent reported success with `agent-tasks finish`. |
| `failed` | The agent reported failure, or its terminal closed without reporting (`exited_without_report`). |
| `timed_out` | It ran past the task's `timeout` (45m by default); its log was captured and it was stopped. |
| `blocked` | The agent is waiting for a person (a question, a permission prompt). Use `agent-tasks attach <run_ref>`. Needs a launcher that reports agent state, like `herdr`. |
| `missed` | Nobody launched it in time (`max_delay`), e.g. the runner was stopped or the machine asleep (`runner_offline`). |
| `superseded` | A late slot replaced by a more recent one (`catch_up: latest`, the default: after a night off, a task runs once, not once per missed hour). |
| `cancelled` | The task was paused or archived at that moment. |

Per task, you choose what happens when it finishes:

```sh
# Tell me when it succeeds or fails, with the agent's summary, and leave its
# session open so I can keep talking to the agent.
agent-tasks edit weekly-deps-report --notify succeeded,failed --keep-open always
agent-tasks edit nightly-cleanup --notify none   # never notify for this task
agent-tasks edit nightly-cleanup --notify ""     # unset: inherit (profile, defaults, notifiers' events)
agent-tasks edit nightly-cleanup --retries 2 --timeout 1h
```

- `--keep-open`: `on_failure` (default) keeps failed runs open, `always`
  keeps every run open, `never` closes them all.
- `--notify` replaces every notifier's `events` for that task's runs
  (events: `launched`, `succeeded`, `failed`, `timed_out`, `missed`,
  `blocked`), so list `failed` too if you still want failure alerts. A
  `succeeded` or `failed` notification carries the summary the agent passed
  to `agent-tasks finish` and, when the session was kept open, the
  `agent-tasks attach <run_ref>` to get back to it.

Notifications go to the `notifiers` in the config: a desktop notification by
default, for `failed`, `timed_out` and `blocked`, or any command (e.g. one
that sends a message to your phone). See
[roadmap/runner.md](roadmap/runner.md#notifications-notifiers).

## Tasks that need credentials

Never put a token or password in a task's instructions, in `config.json` or
in a profile's `env`: they are plain files that get printed, logged and sent
between machines. Keep the secret in a password store on the machine the task
runs on, and write in the instructions how to fetch it: the macOS Keychain on
a Mac, `pass` on Linux and WSL.

**macOS.** Store it yourself (`-w` last, with no value, asks for it without echoing it or
leaving it in your shell history):

```sh
security add-generic-password -U -a "$USER" -s agent-tasks.sentry-token -l "agent-tasks: Sentry API token" -w
```

Then, in the task's instructions:

> The Sentry API token is in the macOS keychain, item
> `agent-tasks.sentry-token`. Use it only inline, in the command that needs
> it: `SENTRY_AUTH_TOKEN="$(security find-generic-password -a "$USER" -s agent-tasks.sentry-token -w)" sentry-cli …`.
> Never print it, write it to a file or put it in the summary. If the item is
> missing or the keychain refuses, finish as failed naming the item.

The `schedule-agent-task` skill does this for you: it checks whether the item
exists (without reading it) and, if not, gives you the command to store it
instead of asking for the secret in the chat. For a task on another machine,
store the secret there. The keychain must be unlocked when the run starts: a
Mac you're logged into is fine, but over SSH it is locked, so a task on
another machine can't read a Mac's keychain through `ssh`.

**Linux and WSL.** Use [`pass`](https://www.passwordstore.org/): create a GPG
key (`gpg --full-generate-key`), `pass init <key-id>`, then
`pass insert sentry/token` (it prompts without echoing). The instructions read
it inline: `SENTRY_AUTH_TOKEN="$(pass show sentry/token | head -1)" sentry-cli …`.
Runs have no terminal to ask for the GPG passphrase, so let gpg-agent keep it
in `~/.gnupg/gpg-agent.conf`:

```
default-cache-ttl 34560000
max-cache-ttl 34560000
```

and unlock it once per boot with `pass show sentry/token >/dev/null` in a
terminal. While it's locked, `pass` fails at once and the run should finish as
failed saying so.

Some authentication needs you every time or every few months (a bank consent
with strong customer authentication, such as an Enable Banking session, a 2FA
code, a browser login). Store what can be stored, and say in the instructions
how the agent recognises that you're needed and what to do then: ask and
wait with the exact step for you (e.g. the authorisation URL), which shows the
run as blocked and notifies you, or finish as failed with that explanation.
Add `--notify blocked,failed` so you hear about it.

## Configuration

Everything is optional. `agent-tasks init` copies
[examples/config.example.json](../examples/config.example.json) to
`~/.config/agent-tasks/config.json`:

```json
{
  "timezone": "Europe/Madrid",
  "runner": { "every": "5m" },
  "launcher": { "preset": "herdr" },
  "agent": { "command": "claude" },
  "profiles": [
    { "match": "~/Projects/work/**", "env": { "EXAMPLE_FLAG": "1" }, "instructions": ["work.md"] }
  ],
  "instructions": { "subagent": ["subagent.md"] },
  "notifiers": [{ "type": "system", "events": ["failed", "timed_out", "blocked"] }],
  "defaults": { "catch_up": "latest", "timeout": "45m", "keep_open": "on_failure" }
}
```

- `profiles`: settings for the tasks whose folder matches (another agent
  command, environment variables, extra instructions, timeouts…). The first
  match wins; a task's own value wins over everything.
- `instructions`: Markdown files in `~/.config/agent-tasks/instructions/`
  that every sub-agent reads before its task. Check what one gets with
  `agent-tasks config instructions subagent`.

The full reference (precedence, profiles, instructions, templates, custom
skills) is in [roadmap/user-config.md](roadmap/user-config.md), the launcher
commands and variables in [roadmap/launcher.md](roadmap/launcher.md), and
example tasks in [examples/](../examples/).

## Multiple machines

Tasks can run on another machine: a laptop schedules work that runs on a
desktop, or the other way round. Each task has a `machine`, where it runs:
this machine's name (`machine` in the config, `local` by default) unless
`add --machine <name>` picks one of the `machines` in the config.

One machine is the **hub**: it holds the data and runs the only runner, and
launches each task's sub-agent on the task's machine over SSH, where that
machine's own launcher, agent and profiles are used. The others are
**clients** (`hub` in their config): they keep no data and forward every
command to the hub, so `agent-tasks list`, `add`, `top`, `attach` and
`log --follow` work the same from any of them.

To add a machine, install agent-tasks on it and run

```sh
agent-tasks init --join <hub-alias> --machine <name> --ssh <alias-the-hub-uses>
agent-tasks doctor   # on both machines
```

`agent-tasks machines list` and `agent-tasks machines check` show the
machines and whether the hub reaches them. It needs key-based SSH both ways;
see [Multiple machines](../RECIPE.md#multiple-machines) and
[Client mode](roadmap/user-config.md#client-mode).

## Presets

| Preset | Where each run goes | Notes |
|---|---|---|
| `herdr` | Its own Herdr tab, nested under the runner (without a runner terminal, as on a client machine: in an "Agent Tasks" space, see `space`) | Agent state (working, idle, blocked) from Herdr. Run the runner inside Herdr. |
| `rex` | Its own Rex window in the runner's session | **Untested against a real Rex.** Needs `rex` and `jq`. |
| `tmux` | Its own tmux window | tmux has no agent status: blocked agents are only caught by the timeout. tmux 3.0+. |
| `process` | A child process of the runner, output in the run's log | No terminal and no agent state, so the agent must run non-interactively (`claude --print`). What `init` picks outside a multiplexer. |

The interactive presets (`herdr`, `rex`, `tmux`) start a shell and type the
agent command at its prompt, so shell aliases and functions work. For
anything else (Orca, WezTerm, your own tool), write the commands yourself;
see [RECIPE.md](../RECIPE.md#3a-a-custom-launcher).

## Troubleshooting

Start with `agent-tasks doctor`: it checks the whole setup and says how to
fix each problem. Then:

- **Nothing runs.** The runner must be open: `agent-tasks runner status`.
  `agent-tasks due` shows what it would launch right now.
- **Runs show up as `missed`.** The runner was stopped or the machine was
  asleep at that time (`runner_offline`). With `catch_up: latest`, the
  latest late slot still runs if it's within `max_delay` when the runner
  comes back; raise `--max-delay` for tasks that may run late.
- **`agent-tasks: command not found`.** Add `~/.local/bin` to your `PATH`
  (`export PATH="$HOME/.local/bin:$PATH"` in your shell profile). The runner
  and the sub-agents need it too.
- **A run is `blocked`.** The agent is asking something:
  `agent-tasks attach <run_ref>` takes you to its tab. To avoid it, allow
  what the task needs in the agent's `args` (e.g. `--allowedTools`) or say
  in the instructions what to do instead of asking.
- **A run failed.** `agent-tasks log <run_ref>` shows what happened and the
  captured output; failed runs keep their tab open by default. Fix the
  instructions with `agent-tasks edit` and `agent-tasks retry <run_ref>`.
- **The task uses the wrong agent, launcher or folder settings.**
  `agent-tasks config resolve <id>` shows where each setting comes from.

## Updating and uninstalling

```sh
git -C ~/.local/share/agent-tasks-src pull
cd ~/.local/share/agent-tasks-src && bun install
```

`bun install` is not optional: the dashboard needs its dependencies
(OpenTUI, which ships a native library per platform) at the versions
`package.json` pins, and `agent-tasks doctor` says when they are missing or
out of date. Restart the runner after updating. To uninstall, run
`agent-tasks install --uninstall` (it removes only the links it created),
then delete the checkout. Your config (`~/.config/agent-tasks/`) and data
(`~/.local/share/agent-tasks/`) are left alone; delete them too if you
don't want them.

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
registered in `src/commands/index.ts`. The dashboard is in `src/ui/` (OpenTUI
with Solid; one folder per view under `src/ui/views/`), and the data it shows
in `src/dashboard.ts`. The design docs are in
[roadmap/](roadmap/README.md).
