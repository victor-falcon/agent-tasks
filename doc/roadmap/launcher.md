# Launcher: how subagents are launched

How and where a subagent is launched is user configuration. The core knows
nothing about Herdr, Rex or `clc`: the launcher is a set of commands with
variables, and the repo ships ready-to-use presets.

## The lifecycle of a run

```
runner (tick)                    subagent                          runner (next tick)
─────────────                    ────────                          ──────────────────
claims the slot
launch ──────────────▶ starts in task.cwd with
                       "/run-agent-task <run_ref>"
                       agent-tasks task <run_ref>   ← reads instructions and context
                       … does the work …
                       agent-tasks finish <run_ref> --status … --summary … [--output-file …]
                         └ saves the result and runs `close` on its own session
                                                                   if still open: close
                                                                   if it died without finish: failed
```

1. The runner launches the agent with a minimal prompt: `/{{skill}} {{run_ref}}`.
   No pasting the instructions on the command line, so there are no quoting
   or length problems.
2. The skill (`run-agent-task`, global) knows what to do:
   - `agent-tasks task <run_ref>` prints the task: title, instructions,
     folder, slot, attempt, personal instructions (`instructions/subagent.md`
     and those of the profile) and the exact command to finish.
   - It runs the instructions.
   - When done, or if something fails, it calls `agent-tasks finish <run_ref>`
     with `--status succeeded|failed`, a short `--summary` and, if there is
     long output, `--output-file` (copied next to the log).
3. **Closing itself.** `finish` saves the result and then runs the launcher's
   `close` command on that run's session, which it already knows from the
   record. The agent does not need to know which multiplexer it is in.
   `keep_open: "on_failure"` leaves failed ones open so they can be inspected.
4. **Safety net.** If the agent dies without `finish`, the next tick detects
   it with `status` and marks it `failed` (`exited_without_report`). If it
   exceeds the `timeout`, it captures the output with `read`, closes it with
   `close` and marks it `timed_out`.

## Launcher config

A launcher is a set of commands (argument vectors, no shell in between unless
requested) with `{{…}}` variables:

| Command | Required | Purpose |
|---|---|---|
| `launch` | yes | Starts the agent. Its output (or a regex over it) gives the `handle`. |
| `close` | no | Closes the session when done (called by `finish`) or on timeout. |
| `status` | no | Agent state: `working`, `idle`, `blocked`, `exited`, with `status_map`. Without it, `blocked` and death without `finish` are not detected (only the `timeout` counts). |
| `read` | no | Last lines of output, for the log and `agent-tasks log --follow`. |
| `attach` | no | For `agent-tasks attach <run_ref>`. |

Variables: `{{run_ref}}`, `{{task_id}}`, `{{title}}`, `{{cwd}}`,
`{{session_name}}` (`task-<id>-<slot>`), `{{skill}}`, `{{prompt}}`
(`/{{skill}} {{run_ref}}`), `{{agent}}` (the resolved agent command, e.g.
`clc`), `{{handle}}`, `{{shell}}`, `{{path}}` (the runner's `PATH`), and the
runner's own: `{{runner_terminal}}` (`$HC_TERMINAL_ID`), `{{runner_space}}`
(its `herdr.space` label) and `{{new_tab_id}}` (`tb` + 32 random hex chars, one
per launch). `{{env.NAME}}` is a variable of agent-tasks' own environment
(the runner's for `tick`, the agent's for `finish`), e.g. `{{env.REX_SESSION}}`;
an unset or empty one is an error, not an empty string. Add `_quoted` to any variable for a shell-quoted value. A `json:` handle
path indexes arrays with numbers (`json:.block_ids.0`).

### `herdr` preset (verified in Herdr on 2026-11-16)

Each task goes in **its own tab, in the runner's space, nested under the
runner** in the sidebar:

```json
"launcher": {
  "preset": "herdr",
  "launch": ["hc", "run", "--bg", "--json", "--no-parent", "--no-notify", "--keep",
             "--name", "{{session_name}}", "--cwd", "{{cwd}}",
             "--label", "herdr.space={{runner_space}}",
             "--label", "herdr.tab={{new_tab_id}}",
             "--label", "herdr.parent={{runner_terminal}}",
             "--label", "agent-tasks.run={{run_ref}}",
             "--", "/usr/bin/env", "PATH={{path}}", "{{shell}}", "-ic", "{{agent}} {{prompt_quoted}}"],
  "handle": "json:.address",
  "close": ["hc", "kill", "{{handle}}"],
  "status": ["hc", "get", "{{handle}}", "--json"],
  "status_map": "herdr",
  "read": ["hc", "read", "--lines", "200", "{{handle}}"],
  "attach": ["hc", "attach", "{{handle}}"]
}
```

What was verified, with test terminals in the "Agent Tasks" space:

- **A new tab** appears as soon as a terminal carries the labels
  `herdr.space=<runner's space>` and `herdr.tab=<new id>`; the id is made up
  by the launcher (`tb` + 32 hex). The visible name is the terminal's title
  (OSC 2); Claude Code sets its own. `herdr-app do tab.rename` right after
  `hc run` fails (`no tab "tb…"`) because the tab does not exist yet: to
  rename it, retry a moment later.
- **Nested under the runner**: the sidebar from your mods (`auto-spaces`,
  `nest()` function) hangs one agent from another when it has the label
  `herdr.parent=<parent address>` **and the parent is an agent**. It does not
  use the `parent` field of `hc`. That is why it is launched with
  `--no-parent` (as the `delegate` skill does): the task does not die if the
  runner is restarted and herdr-core does not write notes to the runner
  through its input.
- **The runner has to announce itself as an agent.** A normal process becomes
  an agent for Herdr if it writes to its terminal
  `ESC ] 7501 ; state=<idle|working|done|blocked|error> : app=agent-tasks BEL`
  (separated by `:`, not `;`). Without that, tasks show up loose in the space.
  With it, the runner shows up with a terminal icon and the tasks below it, as
  in the screenshot. The runner emits it on startup (`idle`) and updates it
  (e.g. `working` while tasks are running).
- **Closing**: `hc kill <handle>` ends the terminal and Herdr closes its tab.
- **`hc get --json` fields**: `address` (`t17g`), `state` (`live` /
  `finished`), `status` (`null` or `{app, state}` with `idle`, `working`,
  `done`, `blocked`, `error`), `exit_code`, `labels`, `parent`.
  `status_map: "herdr"` translates that: `finished` → `exited`, `status.state`
  as is.
- **Explicit `PATH`**: herdr-core starts terminals with its own environment,
  which may not have `~/.local/bin` (where `hc`, `claude` and `agent-tasks`
  live). `delegate` solves it the same way, passing `PATH` through
  `/usr/bin/env`.
- `{{shell}} -ic` makes aliases such as `clc` work.
- `--keep`: if herdr-core loses the terminal, it leaves a shell in its place
  instead of closing the tab, so you can see what happened.


### Other presets

| Preset | How |
|---|---|
| `process` | Child process of the runner with output to a file. No agent `status`: only `exited`. For tests and machines without a multiplexer. |
| `tmux` | Each run in its own tmux window (tested against a real tmux). |
| `rex` | Each run in its own Rex window. **Untested against a real Rex.** |

**`tmux`** (3.0 or later). The window goes into the runner's tmux session when
the runner runs inside tmux (`$TMUX` set; the session of `$TMUX_PANE`),
otherwise into a detached `agent-tasks` session on the default server, created
on the first launch (`tmux attach -t agent-tasks` to look at it). It is named `{{session_name}}` and starts in
`{{cwd}}`. Like `herdr`, it starts an interactive `{{shell}} -i` (through
`/usr/bin/env PATH=…`, because the tmux server keeps the environment it was
started with) and types ` {{agent}} {{prompt_quoted}}; exit` + Enter with
`send-keys`, so aliases work and the window closes with the agent. The handle
is the server's socket and the agent's pane (`/private/tmp/tmux-501/default
%12`), and every later command passes `-S <socket> -t <pane>`, so a `tick` or
`finish` without `$TMUX` (cron, another server) still reaches that pane and
never a window of another server. `close` is `kill-window`, `read` is
`capture-pane -p -J -S -200`, `attach` is `select-window` plus `switch-client`
(inside tmux) or `attach-session`. Limits:

- **tmux has no agent status.** `status` (`display-message -t <pane>
  '#{pane_dead}'`) only says whether the agent's pane is there: `working`
  while it lives, `gone` once it closed, `exited` only for a dead pane that
  `remain-on-exit` keeps. So a `blocked` agent is not detected; only the
  `timeout` catches it.
- The shell exits with the agent, so the window closes by itself and
  `keep_open` cannot keep it around (unless you set `remain-on-exit`).
- The commands are small `/bin/sh -c` scripts (pick or create the session,
  split the handle). To start windows on another server, override `launch`
  or put a `tmux` wrapper first on the runner's `PATH` (`tmux -L <name>
  "$@"`), which is what the real-tmux test does.

**`rex`.** Written from the `rex` CLI calls of the `delegate` skill's
`multiplexer.sh`, which work, but **never run against a real Rex**: treat it
as a starting point and expect to fix flags. Each run gets a window in the
runner's session (`rex window new -s {{env.REX_SESSION}} {{session_name}} -c
{{cwd}} --focus=false --json -- /usr/bin/env PATH=… {{shell}} -i`); the handle is
the new block (`json:.block_ids.0`). The agent command is typed with
`rex send … -b <block>` + `rex send-key … enter`, with `; exit` as in the other
presets. `status` checks the block exists (`rex block inspect`) and maps
`rex block call … program_status` (`.records[0].state`: `working`, `blocked`,
`idle`/`done`/`error` → `idle`, nothing reported → `working`). `read` is
`rex capture --trim --unwrap` (visible screen only). `close` and `attach` find
the block's window with `rex block inspect` and run `rex window close` /
`rex focus`. Limits:

- Needs `rex` and `jq` on the runner's `PATH` (`$REX_BIN_DIR` is not used).
- Needs `$REX_SESSION` in every process that runs launcher commands. That
  holds for a runner inside a Rex block and for the agent's `finish` (same
  session), but not for a `tick` run by cron or launchd, nor for
  `agent-tasks session …` typed outside that session: those fail with
  "`$REX_SESSION` is not set".
- The command is typed into a shell that has just been created. `multiplexer.sh`
  warns that Rex can lose text typed while a shell starts (its one-off agent
  tab does the same and works). If it happens, the shell just sits at its
  prompt, `program_status` stays empty (`working`) and only the `timeout`
  catches it; check this first when trying the preset.
- `done` and `error` both map to `idle`, and the shell exiting with the agent
  should show up as `gone` (the block disappears), never `exited`.

A preset can be used as is, partially overridden
(`{ "preset": "herdr", "close": [...] }`) or not used at all, defining every
command by hand, which is the way to go for Orca or any other environment.

### What goes where

| What | Where |
|---|---|
| Presets (`herdr`, `rex`, `process`, `tmux`) | this repo, `presets/*.json` |
| The launcher you use and its changes | `~/.config/agent-tasks/config.json` → `launcher` |
| The agent command (`clc`, `claude`…) | `agent` in the config and in the per-folder `profiles` |
| The skill that is invoked | `skill` in the config (`run-agent-task` by default); can be swapped for your own |

## Steps

| # | Step | Done when |
|---|---|---|
| L1 | Command template engine (variables, quoting, `handle` by regex or JSON) | tests with prompts containing quotes and spaces |
| L2 | `process` preset | full cycle without a multiplexer |
| L3 | `herdr` preset (own tab, `herdr.space/tab/parent` labels, explicit `PATH`) | the task appears in its tab, hanging from the runner, and the tab closes itself when done |
| L4 | `agent-tasks task <run_ref>` and `finish` with `close` and `--output-file` | the agent does not need to know anything about Herdr to close itself |
| L5 | Global `run-agent-task` skill | an agent launched with `/run-agent-task <ref>` does the task and closes itself |
| L6 | `session status\|read\|close`, `attach` over the launcher | `agent-tasks attach` opens the subagent in Herdr |
| L7 | `rex` and `tmux` presets | same cycle as L3, against fake `rex`/`tmux` and a real tmux on a private socket |
