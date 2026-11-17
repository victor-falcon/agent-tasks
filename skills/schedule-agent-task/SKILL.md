---
name: schedule-agent-task
description: Schedule work for a coding agent to do later, once or on a recurring schedule, with the agent-tasks CLI. Use when the user asks to schedule something or have an agent do it later ("every Monday…", "on the 20th do…", "remind an agent to…", "tomorrow at 9 check…"), or to list, change, pause, remove, run now or retry scheduled agent tasks, or to check how they went ("did anything fail last night?", "why did it fail?").
argument-hint: <what to do and when>
---

# Schedule an agent task

agent-tasks runs a fresh agent in a folder at a scheduled time. That agent
starts with **no context** from this conversation: it only gets the
instructions you write now.

## 1. Gather

Ask only for what you can't infer:

- **What** to do, and what counts as **done** (a file written, a PR opened, a
  message sent…).
- **Where**: the working directory. Default: the current folder.
- **When**:
  - once: an ISO time with offset, e.g. `2026-11-20T09:00:00+01:00` (`--at`);
  - recurring: a 5-field cron expression plus a time zone, e.g.
    `0 9 * * 1` and `Europe/Madrid` (`--cron`, `--timezone`).

  Resolve relative dates ("tomorrow", "on the 20th") against today's date and
  the user's time zone, and say the exact time back to the user.

## 2. Write self-contained instructions

Write them for someone who has never seen this project or conversation:

- the goal and why, in one or two sentences;
- exact paths, commands, URLs, branch names and accounts to use;
- where to leave the result (file path, PR, issue, message);
- the done criteria, and what to do when blocked or when there is nothing to do;
- anything it must not do (e.g. "don't push", "don't upgrade anything").

## 3. Create it

With flags:

```sh
agent-tasks add --title "Weekly dependencies report" --cwd ~/Projects/foo \
  --cron "0 9 * * 1" --timezone Europe/Madrid --instructions-file - <<'TEXT'
Run `bun outdated` in this repo and write reports/deps-<YYYY-MM-DD>.md with one
line per outdated package (current → latest), major upgrades first. Don't
upgrade anything. Done when the report file exists. If nothing is outdated,
write the file anyway saying so.
TEXT
```

Or with the task as JSON on stdin (useful for long instructions):

```sh
agent-tasks add - <<'JSON'
{
  "title": "Release notes for v2.3",
  "cwd": "~/Projects/foo",
  "schedule": { "type": "once", "at": "2026-11-20T09:00:00+01:00" },
  "instructions": "List the commits merged into main since tag v2.2 (`git log --oneline v2.2..origin/main` after `git fetch --tags`), group them by feature/fix/chore and write docs/release-notes/v2.3.md. Don't publish anything. Done when the file exists and every merged change is in it."
}
JSON
```

Other options: `--timeout 45m`, `--retries 1`, `--catch-up latest|all|none`,
`--max-delay 2h`. Leave them unset unless the user asks: the user's config
provides the defaults (agent, launcher, profiles).

`--machine <name>` picks the machine the task runs on. Pass it only when the
user names one ("on the mac, every morning…"); otherwise leave it out and the
task runs on this machine. A task for another machine needs `--cwd` with its
folder on that machine, absolute or starting with `~` (that machine checks it
exists). `agent-tasks machines list` shows the machine names. `agent-tasks
list` shows each task's machine once there is more than one.

Two per-task options decide what happens when a run ends. Offer them when the
user's request hints at it ("let me know", "tell me what it found", "I want to
follow up with it"), and use them when the user asks:

- `--notify <events>`: be told about this task's runs, with the agent's
  summary in the message. `--notify succeeded,failed` for "tell me when it's
  done"; `--notify failed,timed_out` for "only if something goes wrong";
  `--notify none` for a task that must stay silent. Unset, the user's
  notifiers decide (by default only failures). The list replaces those
  defaults for this task, so keep `failed` in it unless the user wants
  silence on failure too. Events: `launched`,
  `succeeded`, `failed`, `timed_out`, `missed`, `blocked`.
- `--keep-open always|on_failure|never`: whether the agent's session stays
  open after it finishes. `always` when the user wants to keep talking to the
  agent afterwards (the notification then says how to get back to it:
  `agent-tasks attach <run_ref>`); the default is `on_failure`.

Both can be changed later with `agent-tasks edit <id>` (`--notify ""` goes
back to the default from the user's config).

Then tell the user the task **id** and the **next runs** that `add` printed.

## 4. Manage

```sh
agent-tasks list                   # tasks, next run, last status
agent-tasks show <id>              # definition, resolved settings, recent runs
agent-tasks edit <id> --cron "0 8 * * 1-5"   # same flags as add
agent-tasks edit <id> --notify succeeded,failed --keep-open always
agent-tasks pause <id>             # stop scheduling (resume <id> to restart)
agent-tasks resume <id>
agent-tasks rm <id>                # archive it (its history is kept)
agent-tasks runs <id>              # past occurrences and their results
agent-tasks run <id>               # run it now, outside its schedule
```

## 5. Check how they went

```sh
agent-tasks status                 # runner alive? last 24h, what needs attention, what's next
agent-tasks runs --since 24h       # every run of the last day, with its result
agent-tasks log <id>               # the latest run of a task: events, summary, captured output
agent-tasks log <run_ref>          # one run (run refs are in "runs")
agent-tasks retry <run_ref>        # a new attempt of a failed, timed-out or missed run
agent-tasks attach <run_ref>       # bring a running or blocked run's tab to the front
```

When asked why a run failed, read its log and explain the cause in a
sentence or two; if the instructions were the problem, offer to fix them
with `agent-tasks edit` and retry. A `missed` run with reason
`runner_offline` means the runner was stopped or the machine asleep.

Always go through the CLI; never edit the agent-tasks data folder by hand.
