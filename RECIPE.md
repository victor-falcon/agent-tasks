# RECIPE: set up agent-tasks on this machine

This file is for an AI coding agent that is setting up agent-tasks on the
user's machine. Follow the steps in order. Run every command exactly as
written, read its output, and fix what it reports before moving on. Ask the
user only where a step says so.

What you are setting up: `agent-tasks runner` is a plain process (not an
agent) that the user leaves open in a terminal tab. Every few minutes it
checks which scheduled tasks are due and launches a **sub-agent** for each
one, in its own tab or window, through a **launcher** (a set of commands in
the user's config). The sub-agent starts with `/run-agent-task <run_ref>`,
reads its task with `agent-tasks task`, does the work, reports with
`agent-tasks finish`, and `finish` closes the sub-agent's own tab with the
launcher's `close` command.

Rules while you work:

- Everything personal goes in `~/.config/agent-tasks/` (or
  `$AGENT_TASKS_CONFIG`). Never edit files inside the agent-tasks checkout to
  configure it.
- Never edit the data folder (`~/.local/share/agent-tasks/`, or
  `$AGENT_TASKS_HOME`) by hand. Use the `agent-tasks` CLI.
- Don't read, copy or print credentials. Don't put secrets in `config.json`.
- Don't start long-running processes detached (`nohup`, `setsid`, `&` +
  `disown`). The runner lives in a terminal tab (step 9).

## 1. Prerequisites

```sh
bun --version
git --version
```

- If `bun` is missing, ask the user before installing it. The official
  installer is `curl -fsSL https://bun.sh/install | bash` (or
  `brew install oven-sh/bun/bun` on macOS with Homebrew).
- If `git` is missing, ask the user to install it.
- `~/.local/bin` must be on `PATH` (that is where `agent-tasks` gets linked).
  Check with `echo "$PATH" | tr ':' '\n' | grep -x "$HOME/.local/bin"`. If it
  is not there, tell the user which line to add to their shell profile
  (`export PATH="$HOME/.local/bin:$PATH"`); don't edit the profile without
  asking. Until it is on `PATH`, write `~/.local/bin/agent-tasks` wherever
  this recipe says `agent-tasks`. The runner and the sub-agents need it on
  `PATH` too, so the setup is not finished until the user has fixed it.

## 2. Clone and install

Ask the user where to keep the checkout if they have a preference; otherwise
use `~/.local/share/agent-tasks-src`. The links point into this checkout, so
it must stay where it is. If that folder already holds a clone of this repo,
run `git -C <folder> pull` instead of `git clone`, then continue from
`bun install`.

```sh
git clone https://github.com/victor-falcon/agent-tasks.git ~/.local/share/agent-tasks-src
cd ~/.local/share/agent-tasks-src
bun install
bin/agent-tasks install
agent-tasks init
```

- `bin/agent-tasks install` links `~/.local/bin/agent-tasks` and the skills
  `run-agent-task` and `schedule-agent-task` into `~/.claude/skills/`. If the
  user's agent reads skills from another folder, pass
  `--skills-dir <dir>` (and use the same flag with `agent-tasks doctor`).
  If something is already in the way it fails and says what; ask the user
  before re-running with `--force` (it moves what was there to
  `~/.config/agent-tasks/backups/`).
- `agent-tasks init` creates `~/.config/agent-tasks/config.json` and
  `instructions/*.md`. It never overwrites a file. If the config already
  exists, keep it and edit it in the next steps.
- If `agent-tasks` is not found after install, `~/.local/bin` is not on
  `PATH` (step 1). Until the user fixes it, call it as
  `~/.local/bin/agent-tasks`.

From here on, "the config" is `~/.config/agent-tasks/config.json`. Edit it
as JSON (keep it valid). Every field is optional; the full reference is
[doc/roadmap/user-config.md](doc/roadmap/user-config.md).

## 3. Detect the environment and pick the launcher

The launcher decides where each sub-agent runs. Check, in this order, in the
terminal where the user will run the runner:

```sh
echo "HC_TERMINAL_ID=$HC_TERMINAL_ID REX_SESSION=$REX_SESSION TMUX=$TMUX"
```

| Found | Launcher | Notes |
|---|---|---|
| `$HC_TERMINAL_ID` set | `{ "preset": "herdr" }` | Each run in its own Herdr tab, nested under the runner. Needs `hc` on `PATH`. |
| `$REX_SESSION` set | `{ "preset": "rex" }` | Each run in its own Rex window. **Untested against a real Rex**: tell the user, and test each command of `presets/rex.json` by hand as described in 3a. Needs `rex` and `jq` on `PATH`. |
| `$TMUX` set | `{ "preset": "tmux" }` | Each run in its own tmux window. tmux has no agent state, so a blocked agent is not detected (only the timeout catches it). Needs tmux 3.0+. |
| none of them | ask the user | Ask which terminal or multiplexer they use. If they have none, or for a first try, use `{ "preset": "process" }`: the agent runs as a child process of the runner with its output in the run's log. It has no terminal, so the agent command must run without one: plain `claude` (the `init` default) will not work there; see step 4. |
| something else (Orca, WezTerm, kitty, a custom tool) | a custom launcher | See 3a. |

Your own environment may not be the user's: if you are not running in the
terminal where the runner will live, ask the user instead of trusting these
variables.

Set it in the config:

```json
"launcher": { "preset": "herdr" }
```

A preset can be partly overridden, e.g.
`{ "preset": "herdr", "close": ["hc", "kill", "{{handle}}"] }`. The presets
are in `presets/*.json` in the checkout; read the one you pick.

### 3a. A custom launcher

Write every command yourself under `launcher`. Each command is an argument
vector (no shell) or a string run with `/bin/sh -c`, with `{{…}}` variables:

| Field | Required | Purpose |
|---|---|---|
| `launch` | yes | Starts the session (an interactive shell in a new tab/window, in `{{cwd}}`). Its output gives the handle. |
| `handle` | no | How to read the handle from `launch`'s output: `json:.path.to.field` or a regex with one group. Without it, the whole trimmed output. |
| `then` | no | Commands run after `launch`, with `{{handle}}` known. Use it to type the agent command into the new shell. |
| `close` | no | Closes the session. Called by `finish` and on timeout. Without it, tabs stay open. |
| `status` | no | Prints the session's state, mapped with `status_map` to `working`, `idle`, `blocked` or `exited`; a non-zero exit means the session is gone. Without it, an agent that died without `finish` is only caught by the timeout. |
| `read` | no | Prints the last lines of the session (for the log on timeout and `agent-tasks log --follow`). |
| `attach` | no | Brings the session to the front (`agent-tasks attach <run_ref>`). |

Useful variables: `{{cwd}}`, `{{session_name}}`, `{{agent}}` (the agent
command with its args), `{{prompt}}` (`/run-agent-task <run_ref>`),
`{{handle}}`, `{{shell}}` (`$SHELL`), `{{path}}` (the runner's `PATH`),
`{{run_ref}}`, `{{log}}` (the run's log file), `{{env.NAME}}` (an environment variable; unset is an error).
Add `_quoted` to any variable for a shell-quoted value
(`{{prompt_quoted}}`). The argv element `{{env_argv}}` expands to the
`KEY=value` pairs the agent needs (`AGENT_TASKS_RUN`, `AGENT_TASKS_ATTEMPT`,
the config and data folders, and the profile's `env`); always pass it to the
new shell, or `finish` can't tell which attempt it closes. Full list:
[doc/roadmap/launcher.md](doc/roadmap/launcher.md).

Worked example, for a tool called `mux` whose CLI can open a tab and print
its id (replace `mux …` with the real commands of the user's tool; ask the
user or read the tool's `--help`):

```json
"launcher": {
  "launch": ["mux", "new-tab", "--cwd", "{{cwd}}", "--title", "{{session_name}}", "--print-id",
             "--", "/usr/bin/env", "PATH={{path}}", "{{env_argv}}", "{{shell}}", "-i"],
  "handle": "regex:^(\\S+)",
  "then": [["mux", "send-text", "{{handle}}", " {{agent}} {{prompt_quoted}}; exit\n"]],
  "close": ["mux", "close-tab", "{{handle}}"],
  "status": "mux tab-exists {{handle_quoted}} && echo working",
  "status_map": { "working": "working" },
  "read": ["mux", "dump-text", "--lines", "200", "{{handle}}"],
  "attach": ["mux", "focus-tab", "{{handle}}"]
}
```

Why it is built this way:

- `launch` starts an **interactive shell** (`{{shell}} -i`) and `then`
  types the agent command into it. That way the user's shell profile, aliases
  and functions are loaded exactly as when they type it by hand (step 4).
- `; exit` closes the shell when the agent quits, so a session whose agent
  died without `finish` disappears and `status` reports it gone.
- `/usr/bin/env PATH={{path}}` passes the runner's `PATH`: many multiplexers
  start new tabs with their own environment, without `~/.local/bin`.
- The leading space in `" {{agent}} …"` keeps the line out of the shell
  history in most setups.

**Test each command by hand before saving it.** In a terminal of the user's
tool, with a scratch folder:

1. Run the `launch` command with the variables filled in by hand (cwd = a
   scratch folder, the shell = `$SHELL`). A new tab/window must appear in
   that folder with a shell prompt. Note the handle it prints and check that
   your `handle` rule extracts exactly it.
2. Run the `then` command with a harmless line instead of the agent:
   ` echo hello; exit`. The tab must print `hello` and close. Launch again
   for the next steps.
3. Run `status`: it must print something your `status_map` maps (or exit 0)
   while the tab lives, and exit non-zero after you close the tab.
4. Run `read`: it must print the tab's last lines.
5. Run `attach`: the tab must come to the front.
6. Run `close`: the tab must disappear.

Only then write it into the config and run `agent-tasks config check`.

## 4. Pick the agent command

Ask the user: **"Which command do you type to start your coding agent?"**
For example `claude`, an alias such as `cc`, or a wrapper script. Then check
what it is in the user's shell:

```sh
$SHELL -ic 'type <command>'
```

- **A program on `PATH`** (`claude is /…/claude`):

  ```json
  "agent": { "command": "claude", "args": [], "shell": false }
  ```

- **An alias or shell function** (`… is an alias for …`, `… is a shell
  function`): with the `herdr`, `rex`, `tmux` presets (or a custom launcher
  built as in 3a), it just works: they open an interactive shell and type the
  command at its prompt, the same as the user would. Keep `"shell": false`
  there; `shell` only matters for launchers that use `{{agent_argv}}`.

  With the `process` preset, the agent runs as `$SHELL -ic '<command> …'`
  when `"shell": true`. That loads the shell's rc files, but **not** aliases
  or functions that are loaded lazily at the first prompt (zsh plugins with
  deferred loading, `zsh-defer`, files sourced from a precmd hook): those are
  not visible to `zsh -ic`. If `$SHELL -ic 'type <command>'` says "not
  found", use the program the alias calls instead, or use an
  interactive-shell preset.

  With an interactive-shell preset, a "not found" from `$SHELL -ic 'type …'`
  does not mean it won't work: a lazily loaded alias only exists at the
  prompt, which is exactly where these presets type it. Don't replace the
  user's command; keep it and let the smoke test (step 9) prove it.

- **Agent flags**: put them in `args`, e.g.
  `"args": ["--model", "opus"]`. Don't put the prompt there; agent-tasks
  adds `/run-agent-task <run_ref>` itself.

- **The `process` preset needs an agent that runs without a terminal.**
  Interactive TUIs can't run there. Use the agent's non-interactive mode if it
  has one and the user agrees (for Claude Code, print mode: `"args":
  ["-p"]` plus whatever permission flags the user accepts; this combination
  is not tested by agent-tasks, so rely on the smoke test), or an
  interactive-shell preset.

**Different command per folder.** If the user uses different commands,
accounts or flags per project, add `profiles`. The first profile whose `match`
fits the task's folder wins:

```json
"profiles": [
  {
    "match": "~/Projects/work/**",
    "agent": { "command": "work-claude", "shell": false },
    "env": { "SOME_FLAG": "1" },
    "instructions": ["work.md"]
  },
  { "match": "~/Projects/**", "agent": { "command": "claude" } }
]
```

A profile can also set its own `launcher` or `skill`. `env` is for
non-secret variables only. Remove the example profile `init` wrote if it
does not apply (`~/Projects/work/**` with `instructions: ["work.md"]`).

`agent-tasks config check` validates every profile. Which profile a task
actually picks can only be checked once a task exists:
`agent-tasks config resolve <task-id>` (or `agent-tasks show <task-id>`)
prints the agent, launcher and skill it resolves to and where each value
comes from. Do it for the smoke-test task in step 9.

## 5. Sub-agents close themselves

Explain this to the user, because it is what keeps their tabs clean:

```
runner tick ──▶ launcher launch (new tab, in the task's folder)
                  └▶ agent "/run-agent-task <run_ref>"
                       ├▶ agent-tasks task <run_ref>      reads what to do
                       ├▶ … does the work …
                       └▶ agent-tasks finish <run_ref> --status … --summary …
                            ├ records the result
                            └ runs the launcher's close on its own session
next tick: a session still open is closed; one that died without finish
           is recorded as failed (exited_without_report); one past its
           timeout is read, closed and recorded as timed_out
```

- `keep_open` decides whether `finish` closes the session: `on_failure`
  (the default) keeps failed runs open so the user can look at them,
  `always` never closes, `never` always closes. Set the default in the
  config (`"defaults": { "keep_open": "on_failure" }`) or per task
  (`agent-tasks add … --keep-open never`).
- A session kept open is closed by hand with
  `agent-tasks session close <run_ref>`.
- The interactive presets type ` <agent> …; exit`, so the shell exits when
  the agent quits. With `tmux` that closes the window, so `keep_open` keeps a
  failed session only until its agent quits. Other multiplexers may keep the
  tab after the shell exits; check it in the smoke test.
- Verify `close` in the smoke test (step 9): the run must end `succeeded`
  and its tab/window must be gone.

## 6. Personal instructions for sub-agents

Every sub-agent reads `~/.config/agent-tasks/instructions/subagent.md`
(through `agent-tasks task`), marked as user instructions that take priority
over the defaults. `init` created it with commented examples; text inside
`<!-- … -->` is ignored.

Ask the user what a fresh agent needs to know on this machine, and write it
there as short bullet points, outside the comment. Suggest:

- where it runs (e.g. "You run inside Herdr as a sub-agent of the
  agent-tasks runner; don't open new windows");
- which command to use if it needs to start another agent (sub-sub-agents),
  and how (e.g. an alias that needs an interactive shell);
- things never to do on this machine (e.g. no detached processes, no
  reading credentials, no pushing to main, no installing global packages);
- language and format of reports.

Leave the file empty (only comments) if the user has nothing to add. Check
what a sub-agent will get:

```sh
agent-tasks config instructions subagent
```

The config lists `instructions/supervisor.md` and `instructions/work.md`
too. Every file listed must exist; remove entries the user doesn't want.

## 7. Skills

`bin/agent-tasks install` (step 2) already linked them. The user's agent
must be able to run `/run-agent-task` (sub-agents start with it) and has
`/schedule-agent-task` to create tasks. If the agent is not Claude Code and
reads skills from another folder, re-run
`bin/agent-tasks install --skills-dir <that folder>`. If the agent has no
skills at all, ask the user, then create
`~/.config/agent-tasks/templates/prompt.md` with:

```
Run `agent-tasks task {{run_ref}}`, follow what it prints, and always end with the finish command it gives you.
```

## 8. Check

```sh
agent-tasks config check
agent-tasks doctor
```

Fix every `✕` error (each line says how) and re-run until both pass. A `!`
warning "no runner heartbeat yet" is expected until step 9. A warning that
the agent command is not on `PATH` is fine for a shell alias used with an
interactive-shell preset.

## 9. Smoke test

Prove the whole cycle works: a task runs, succeeds, and its session closes.

1. Create a scratch folder and a one-off task due in about two minutes.
   Use a new id every time (an archived task keeps its id, so a fixed id
   fails the second time you run this recipe). Note the id: the next steps
   use it as `$ID`; if your shell does not keep variables between commands,
   write the value instead.

   ```sh
   ID=agent-tasks-smoke-$(date +%s)
   mkdir -p ~/agent-tasks-smoke-test
   cd ~/agent-tasks-smoke-test
   agent-tasks add --id "$ID" --title "agent-tasks smoke test" \
     --cwd ~/agent-tasks-smoke-test \
     --at "$(bun -e 'console.log(new Date(Date.now() + 2 * 60000).toISOString())')" \
     --timeout 10m --keep-open never \
     --instructions 'Write the text "hello from agent-tasks" to hello.txt in the working directory. Do nothing else. Done when the file exists.'
   agent-tasks config resolve "$ID"
   ```

   `config resolve` must show the agent and launcher you configured.
   `--keep-open never` closes the session even if the run fails (you read
   the result in the run's record); `--timeout 10m` ends a stuck run quickly.

   Tell the user before it starts: the agent may stop at a prompt the first
   time (a "trust this folder" dialog for a new folder, a permission to write
   a file). They should answer it in the sub-agent's tab; you can bring it to
   the front with `agent-tasks attach <run_ref>` once it is launched.

2. Start the runner in **a new tab or window of the user's multiplexer**,
   where it will keep running: `agent-tasks runner`. If you can open tabs
   (for example `hc run`, `tmux new-window`, `rex window new`), do it;
   otherwise ask the user to open a tab and run `agent-tasks runner` there,
   and wait until they confirm. Don't run it as a detached background
   process. For the `herdr` preset it must run inside a Herdr terminal; for
   `rex`, inside the same Rex session.

3. Wait: the runner ticks every `runner.every` (5 minutes by default), so
   the task starts within about 7 minutes. Check:

   ```sh
   agent-tasks runner status
   agent-tasks status
   agent-tasks runs "$ID"
   ```

   `runs` shows the run ref (`<id>/<slot>`) in its first column. When the
   run is no longer `running`:

   ```sh
   agent-tasks log "$ID"
   cat ~/agent-tasks-smoke-test/hello.txt
   ```

   Success means: the run is `ok` (succeeded), `hello.txt` exists, and the
   sub-agent's tab/window is gone (ask the user to confirm, or check with the
   multiplexer's CLI). With a launcher that has `status`,
   `agent-tasks session status <run_ref>` must say the session is `gone`.

4. If it failed: `agent-tasks log "$ID"` shows the events, the launcher
   command and the captured output. Common causes: the agent command isn't
   found inside the new tab (`PATH`, alias, step 4), the agent is waiting at
   a trust or permission prompt (`agent-tasks attach <run_ref>`), the skill
   isn't installed (step 7), or `close` doesn't work (step 3a). Fix it, then
   `agent-tasks retry <run_ref>` and check again.

5. Clean up:

   ```sh
   agent-tasks rm "$ID"
   rm -r ~/agent-tasks-smoke-test
   ```

   Leave the runner running: that tab is where scheduled tasks start from.

## 10. Report to the user

Tell the user, briefly:

- where the checkout is and that `agent-tasks` is linked in `~/.local/bin`;
- the launcher (preset or custom) and the agent command, with any profiles;
- what you wrote in `instructions/subagent.md`;
- the result of `config check`, `doctor` and the smoke test (run ref,
  status, whether the session closed);
- anything you could not verify or left for them (e.g. `PATH` in their
  shell profile, the `rex` preset being untested);
- how to use it from now on: keep the `agent-tasks runner` tab open; ask
  their agent to schedule work (the `schedule-agent-task` skill) or use
  `agent-tasks add`; check with `agent-tasks status`.
