# User configuration (outside the repo)

agent-tasks will be open source soon. The repo only carries code, skills,
presets, documentation and reasonable defaults. Everything personal lives
outside: how agents are launched, which command is used, accounts, aliases,
rules specific to the environment, and also the tasks and their history.

## Where everything lives

| What | Where | Versioned in the repo |
|---|---|---|
| Code, skills, presets, docs, examples | this repo | yes |
| Personal configuration | `~/.config/agent-tasks/config.json` (or `$AGENT_TASKS_CONFIG`) | no |
| Personal free-text instructions | `~/.config/agent-tasks/instructions/*.md` | no |
| How agents are launched (Herdr, Rex, Orca…) | `launcher` in `config.json`, starting from a preset in the repo | only the presets |
| Tasks, runs, heartbeat | `data_dir`, by default `~/.local/share/agent-tasks/` (or `$AGENT_TASKS_HOME`) | no |

Tasks stay out of the repo because they carry the user's paths, prompts and
results. Anyone who wants them in git can point `data_dir` to their own
private repo.

The repo ships `examples/config.example.json` and `examples/tasks/*.json` as
a reference. `agent-tasks init` creates `~/.config/agent-tasks/` from the
example if it doesn't exist.

## `config.json`

```json
{
  "data_dir": "~/.local/share/agent-tasks",
  "machine": "linux",
  "machines": { "mac": { "ssh": "mac-mini" } },
  "timezone": "Europe/Madrid",

  "runner": { "every": "5m" },

  "launcher": { "preset": "herdr" },

  "agent": { "command": "claude", "args": [], "shell": false },
  "skill": "run-agent-task",

  "profiles": [
    {
      "match": "~/Projects/work/**",
      "agent": { "command": "clc", "shell": true },
      "env": { "SOME_FLAG": "1" },
      "instructions": ["work.md"]
    },
    {
      "match": "~/Projects/**",
      "agent": { "command": "clc", "shell": true }
    }
  ],

  "instructions": {
    "subagent": ["subagent.md"],
    "supervisor": ["supervisor.md"]
  },

  "notifiers": [
    { "type": "system", "events": ["failed", "timed_out", "blocked"] }
  ],

  "supervisor": { "enabled": false },

  "defaults": {
    "catch_up": "latest",
    "timeout": "45m",
    "keep_open": "on_failure"
  }
}
```

- `machine`: this machine's name (lowercase letters, digits and dashes;
  `local` when unset). New tasks run here unless `add --machine` says
  otherwise. Tasks saved before tasks had a `machine` get this name the
  first time a newer CLI reads the data folder, so set it before upgrading;
  set later, `doctor` lists the tasks left on the old name and
  `agent-tasks edit <id> --machine <name>` moves them.
- `machines`: on the hub (the machine that holds the data and runs the
  runner), the other machines tasks can run on, each with exactly one of
  `"ssh": "<host alias>"` or `"local": true`. This machine's own name is
  always local, listed or not. Multi-machine support is in progress: tasks
  already record their machine, but the runner still launches every task
  here.
- `hub`: only on a client machine, `{ "ssh": "<host alias>" }` to reach the
  hub. A config with `hub` is a client and has no `machines`; see
  [Client mode](#client-mode).
- `runner`: how often it ticks. See [runner.md](runner.md).
- `launcher`: the commands that launch, watch and close each subagent
  (create the sub-tab in Herdr, etc.). A preset from the repo, partly
  overridden or written from scratch. See [launcher.md](launcher.md).
- `agent`: the agent command that goes into the `launch`. `shell: true` runs
  it in an interactive shell (`$SHELL -ic …`) so aliases and functions like
  `clc` work, with their per-project account logic.
- `skill`: the skill each subagent starts with (`/{{skill}} <run_ref>`).
- `profiles`: rules by task folder (`cwd`), in order; the first one that
  matches wins. They can change the agent, the launcher, the skill, add
  non-secret environment variables and add instructions.
- `instructions`: Markdown files from `~/.config/agent-tasks/instructions/`
  that `agent-tasks task <run_ref>` adds to what the subagent reads, or that
  the supervisor reads when it starts.
- `notifiers`, `supervisor`: alerts outside the runner's screen and the
  optional agent for when something needs judgment. See [runner.md](runner.md).
- `defaults`: override the project's default values for new tasks.
  `catch_up`, `max_delay`, `timeout`, `keep_open` and `notify` can also be set
  per profile; a task's own value wins over both.
- `notify` (task, profile or `defaults`): which of a task's run events every
  notifier sends, replacing the notifiers' own `events` (`[]`: never; unset
  everywhere: the notifiers' `events`). See
  [runner.md](runner.md#per-task-notify).

No secrets in this file. Credentials keep coming from wherever they already
come from (direnv, the alias itself); the CLI neither reads nor copies them.

## Customizing what the agents do

The runner is not an agent: what it does is decided by the config and the
launcher commands. The ones that are agents (each task's subagent and, if
enabled, the supervisor) need to know the user's environment: which
multiplexer they are in, that `clc` is used, what they must not do on that
machine…
There are three levels, from least to most invasive; most people will only
need the first.

```
~/.config/agent-tasks/
├── config.json
├── instructions/
│   ├── subagent.md        # level 1: added to what each subagent reads
│   ├── supervisor.md      # level 1: added to the supervisor skill
│   └── work.md            # a profile's instructions
├── templates/
│   ├── task.md            # level 2: what `agent-tasks task <run_ref>` prints
│   └── prompt.md          # level 2: the startup prompt (default `/{{skill}} {{run_ref}}`)
└── skills/
    └── run-agent-task/    # level 3: replaces the whole skill
        └── SKILL.md
```

### Level 1: added instructions

Free-form Markdown. `agent-tasks task <run_ref>` includes it in what the
subagent reads, marked as user instructions that take priority over the
defaults. Example `instructions/subagent.md`:

```markdown
- You run inside Herdr as a sub-agent of the agent-tasks runner. Use `hc` if
  you need to read or wait for another terminal; don't open new windows.
- If you need to start another agent, use `clc`, never plain `claude`: it
  picks the right account for each project. It's a shell alias, so run it in
  an interactive shell.
- Don't run detached scripts (`nohup`, `setsid`): this machine has an EDR
  that kills the whole terminal server.
- Don't read credentials; the environment comes from direnv.
```

The same applies to `supervisor.md` and to the files a profile lists.

### Level 2: templates

If the added instructions aren't enough, the whole text is replaced.
Templates use `{{…}}` variables; unknown ones cause an error when loading
(`agent-tasks config check`), not a broken prompt in the middle of the night.

- `templates/prompt.md`: the prompt the agent starts with. By default
  `/{{skill}} {{run_ref}}`. Useful for an agent without skills (another
  CLI): for example, `Run: agent-tasks task {{run_ref}} and follow it.`
- `templates/task.md`: what `agent-tasks task` prints. Variables:
  `{{title}}`, `{{task_id}}`, `{{slot}}`, `{{attempt}}`, `{{cwd}}`,
  `{{instructions}}`, `{{finish_command}}`, `{{personal_instructions}}`.
  If `{{finish_command}}` is missing, `config check` warns: without it the
  agent doesn't know how to close the run and everything would end as
  `exited_without_report`.

### Level 3: custom skill

`"skill": "my-skill"` in the config (or in a profile) changes the skill the
subagent starts with. `agent-tasks install` links the ones in
`~/.config/agent-tasks/skills/` into `~/.claude/skills/`. For anyone who
wants an entirely different flow; it has to read the task with
`agent-tasks task` and finish with `agent-tasks finish` so the registry keeps
working. The same applies to the supervisor (`supervisor.skill`). It is
documented as "at your own risk": it isn't guaranteed to work across versions.

## Precedence

For each value, the winner is, from strongest to weakest:

1. what the task says (`task.agent`, `task.timeout`, …);
2. the first `profile` whose `match` fits `task.cwd` (it can change the agent, launcher, skill, environment and instructions);
3. the root of `config.json`;
4. the project's default value (`claude`, preset `process`, `5m`, …).

`agent-tasks config resolve <task-id|path>` shows the final result and where
each value comes from, so you can debug without guessing.

## How the pieces use it

- **Runner / `tick`**: resolves each task's agent, launcher and skill with
  the precedence above, runs the `launch` and saves what was resolved in the
  attempt (`attempt.agent`, `attempt.session`) so the history says exactly
  what was launched and how.
- **`agent-tasks task <run_ref>`**: the project template + the task's
  instructions + the personal instructions from `subagent` and from the
  matching profile.
- **Skills `run-agent-task` and `supervise-tasks`**: contain nothing from the
  user; personal content reaches them through `agent-tasks task` and
  `agent-tasks config instructions supervisor`.
- **Skill `schedule-agent-task`**: doesn't need to know any of this; the
  agent creates the task and the configuration is applied when it runs.

## Steps (added to phase 1)

| # | Step | Done when |
|---|---|---|
| C1 | `src/config.ts`: loading, validation, `~` and globs, precedence | precedence and profile tests |
| C2 | `data_dir` outside the repo; `agent-tasks init` with the example | the clean repo contains no data after use |
| C3 | Agent with `shell: true` (aliases like `clc`) inside the `launch` | the subagent starts with `clc` in Herdr |
| C4 | `config resolve` and `config instructions <subagent\|supervisor>` | readable output, also with `--json` |
| C5 | `examples/` and a configuration section in the public README | someone without `clc` or Herdr uses it with `claude` and the `process` preset without changing anything |
| C6 | Personal instructions (level 1) and templates (level 2) with `config check` | the subagent follows `instructions/subagent.md` |
| C7 | Custom skill (level 3) | a profile with another skill uses it on launch |
| C8 | `agent-tasks init` creates `instructions/subagent.md` with commented examples | guided first install |

## Client mode

A machine whose config has `hub` is a client: it keeps no tasks or runs.
Every data command (`add`, `list`, `show`, `edit`, `log`, `finish`, `task`…)
runs on the hub over SSH, as `ssh -o BatchMode=yes -o ConnectTimeout=10
<hub> ~/.local/bin/agent-tasks <args>`, with its output, `--json` and exit
code passed through. The hub needs agent-tasks installed (`agent-tasks
install` links it at `~/.local/bin`) and the client a key-based SSH alias
for the hub. The client must set `machine`, and the hub must list that name
in its `machines` (e.g. `"mac": { "ssh": "mac" }`). If the hub can't be
reached, the command fails with `hub_unreachable`; nothing is queued.

- Always local: `help`, `version`, `init`, `install`, `doctor`, `config …`
  (they describe this machine) and `remote …` (what the hub runs on this
  machine).
- Refused: `runner` and `tick`, which only the hub runs. `runner status`
  and `due` only read the hub's state, so they are forwarded.
- `add` from a client defaults `--machine` to the client's `machine` and
  `--cwd` to the current folder, checked on the client and written with
  `~` for the client's home. A task for another machine needs `--cwd`. `edit --cwd`, `list --cwd`, a task JSON or
  patch on stdin or in a file, `--instructions-file` and
  `finish --output-file` are read on the client and sent to the hub.

On the hub, the cwd of a task that runs on another machine must be absolute
or start with `~`, and is stored as given (that machine checks it exists).

**Protocol check.** A client puts the hidden global flag
`--client-protocol=<n>` first in every forwarded command; the hub refuses a
different protocol (`protocol_mismatch`, naming which side to update). A hub
too old to know the flag fails with a usage error naming it: the client holds
the first 300ms of output back to catch that, drops the old hub's message and
reports `protocol_mismatch` ("update agent-tasks on the hub"). A forwarded
command that reaches a machine that is itself a client is refused
(`not_a_hub`) instead of being forwarded again.

**Joining.** `agent-tasks init --join <hub-alias> --machine <name> [--ssh
<alias>]` on the new machine pings the hub (`remote ping`: same protocol, a
hub and not a client, a different name), sets `machine` and `hub` in this
machine's config (created from the example when missing; otherwise only those
two keys change, the rest of the file is kept byte for byte, and it refuses
with the lines to add by hand if that can't be done safely), runs
`machines add <name> --ssh <alias>` on the hub and reports whether the hub
reaches the machine back. `--ssh` is the alias the hub uses for this machine
(default: its name). `machines list|add|rm|check` manage and check the
registry on the hub (forwarded from a client); `machines rm` is refused while
tasks still run on the machine.
