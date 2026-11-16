# agent-tasks

Scheduled tasks for coding agents. Tasks are JSON files. `agent-tasks runner`
is a plain process (not an agent) that you leave open in a terminal tab, for
example in Herdr. Every few minutes it checks what is due and launches a
sub-agent in the task's folder using launch commands from your own config
(presets for Herdr, Rex, tmux or a plain process). The sub-agent starts with
`/run-agent-task <run_ref>`, reads its task, does it, records the result and
closes itself. The runner shows every launch, success and failure live, and
every scheduled occurrence ends up recorded: succeeded, failed, timed out, or
missed (and why).

The CLI is the interface: `agent-tasks runner`, `status`, `list`, `runs`, `log`.

Personal setup (launch commands, which agent command to use, per-folder
profiles, notifications, extra instructions for agents) lives in
`~/.config/agent-tasks/`, never in this repo.

Status: planning. See [doc/roadmap](doc/roadmap/README.md).

## Daily use

Four commands answer most questions. They only read: none of them changes a
task or starts a run. Every one takes `--json` (with `"schema": 1`) for
scripts and other tools, and colors are used only in a terminal (set
`NO_COLOR=1` to turn them off). Times are in your time zone (`timezone` in
the config, else the system's).

**Is everything fine?**

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
  Wed 08:00  worktree-cleanup    every day 08:00
  Fri 09:00  release-notes       Nov 20 09:00
  Mon 09:00  weekly-deps-report  Mon 09:00
```

It exits with 1 when the runner is not running or something is under
"Attention" (a task whose latest result failed, a run waiting for a person,
occurrences missed in the last 24 hours that nothing has made up for yet), so `agent-tasks status >/dev/null
|| notify …` works in a script or a status bar.

**Which task is failing?**

```
$ agent-tasks list
   ID                  SCHEDULE         NEXT         LAST 10     FOLDER
⏸  backup-notes        every day 23:00  paused       ■■■■        ~/notes
●  inbox-triage        every day 06:00  in 20h       ■■■□        ~/Projects/foo
○  release-notes       Nov 20 09:00     in 3d        ·           ~/Projects/foo
!  review-pr-123       Nov 17 09:30     blocked 12m  !           ~/Projects/foo
◐  sentry-summary      every hour       running 1m   ■□□□---■✕◐  ~/Projects/foo
●  weekly-deps-report  Mon 09:00        in 6d        ■■■■■■■□■■  ~/Projects/foo
◐  worktree-cleanup    every day 08:00  running 4m   ■■✕■■■◐     ~/Projects/bar
```

`LAST 10` reads oldest to newest: `■` ok, `✕` failed or timed out, `□`
missed, `◐` running, `!` blocked, `-` superseded or cancelled, `·` still to
come. Filter with `--status failed` (latest result failed, even while a
retry runs), `--status paused`, `--cwd ~/Projects/foo` or `--all` (finished
and archived tasks too).

**What ran, and why did it fail?**

```
$ agent-tasks runs sentry-summary --since 12h
RUN                              SLOT          STATUS        START  DURATION  ATT.  SUMMARY
sentry-summary/20261117T090000Z  Nov 17 10:00  ◐ running     10:01  1m        1
sentry-summary/20261117T080000Z  Nov 17 09:00  ✕ failed      09:02  3m        2/2   sentry-cli has no auth
sentry-summary/20261117T070000Z  Nov 17 08:00  ■ ok          08:31  6m        1     3 new issues in notes/sentry.md
sentry-summary/20261117T030000Z  Nov 17 04:00  □ missed      —      —         —     runner_offline

$ agent-tasks log sentry-summary/20261117T080000Z
✕ failed  sentry-summary/20261117T080000Z · slot Nov 17 09:00

Events
  09:02:00  claimed   by=tick
  09:02:01  launched  handle=p18

Attempt 1 · ✕ failed · started 09:02 · 2m
  agent     claude  ← default
  launcher  process · handle=p18
  summary   first try failed

Attempt 2 · ✕ failed · started 09:07 · 3m
  agent     claude  ← default
  launcher  process · handle=p28
  summary   sentry-cli has no auth
  log       ~/.local/share/agent-tasks/runs/sentry-summary/20261117T080000Z.log

Log (shared by attempts 1, 2): ~/.local/share/agent-tasks/runs/sentry-summary/20261117T080000Z.log

$ sentry-cli issues list
error: Auth token is required for this request.
```

`agent-tasks log <task-id>` shows the task's latest run, `--attempt 1` an
earlier attempt, and `--raw` only the captured log (`agent-tasks log
sentry-summary --raw | less`).

**Why does a task use that agent?**

`agent-tasks show <id>` prints the task with every setting it resolves to
and where each one comes from:

```
Agent         clc (shell)                          ← profile ~/Projects/**
Launcher      herdr                                ← config
Skill         run-agent-task                       ← default
Instructions  task + 2 personal files              ← profile ~/Projects/** (after config)
```

`agent-tasks show <id> --instructions` prints the text the agent will
receive (what `agent-tasks task <run_ref>` gives it): your task template
filled with the task's instructions and your personal ones
(`instructions.subagent` in the config, then the matching profile's), with
the slot shown as `<slot>`.

When the runner has not ticked recently, `status`, `list`, `runs` and `show`
start with a warning on stderr:

```
! runner is not running (last tick 3h ago, expected every 5m); scheduled tasks won't start. Start it with: agent-tasks runner
```

## Development

Requires [Bun](https://bun.sh).

```sh
bun install          # dependencies
bun test             # tests (they never touch your real home)
bunx tsc --noEmit    # type check
./bin/agent-tasks --help
```

Each CLI command lives in its own file under `src/commands/` and is
registered in `src/commands/index.ts`.

## License

[MIT](LICENSE)
