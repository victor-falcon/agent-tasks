# TUI v2: design

> Status: decided (see Decisions at the end). Mockups of every view live in
> a design canvas outside the repo; the
> canvas still shows a task editor and a live session tail, both dropped:
> this file is the source of truth for behavior.

## Why

The current dashboard (`src/tui/`, ~1,800 lines) is a hand-rolled renderer:
ANSI strings, its own key matcher, its own wrapping. It does one screen well
(four stacked panels plus a run's detail) but it is read-mostly:

- Acting is limited to attach, retry, run now and pause. Creating, editing,
  archiving a task, reading a task's definition or history beyond the last
  100 runs, checking machines or the config all need the CLI or an agent.
- Nothing is discoverable beyond `?`: no search, no filter, no palette.
- The selection is an index per panel: a reload can move it under you.
- Long text (summaries, outputs, instructions) is plain wrapped text, even
  though agents write Markdown.
- A running agent is a black box until it finishes or you attach.

## Goals

1. **Operate tasks from the TUI**: browse, pause/resume, run now, retry,
   archive, close a kept-open session; read results, outputs, instructions
   and history. Creating and editing tasks stays with the agent
   (`schedule-agent-task`) and the CLI.
2. **Discoverable**: a command palette, a which-key popup for prefixes, a
   footer that shows the keys that work *here*. Vim keys stay first-class;
   the mouse works too.
3. **Live**: data refreshes on its own, blocked runs grab attention, and
   `a` attaches to a running or blocked agent's session.
4. **Same app everywhere**: inside `agent-tasks runner`, as `agent-tasks top`,
   and on a client (reads and acts on the hub through the CLI, as today).

Non-goals: a web UI; creating or editing tasks (no editor, no "new task");
showing a running session's output inside the TUI (attach instead).

## Principles

- **The CLI stays the API.** Every write runs a CLI command with `--json`
  (`run`, `retry`, `pause`, `resume`, `rm`, `session close`,
  `machines check`, `doctor`, `tick`). Reads reuse the
  data layer (`buildDashboard`, `buildRunDetail`, `taskOverview`), which stays
  pure and unit-tested.
- **Selection by identity.** The cursor follows a task id or run ref, never an
  index; reloads keep you where you were, and the selection carries across
  views (select a run in Overview, press `t`, land on its task).
- **Never lose the user's place.** Going back restores scroll, cursor, folds
  and filters of the view you left.
- **Cheap actions are instant and undoable, expensive ones confirm.** Pause,
  resume: instant, toast with `u` undo. Run now, retry, archive, close
  session: confirm dialog stating the consequence.
- **Say what's happening.** Every background command shows a spinner in the
  footer and ends in a toast with the CLI's first line of output (or its
  error).

## Frame

```
 agent-tasks · ● runner every 5m · ticked 11:07 · next 11:12      today ■3 ✕1 □0 !1   hub: wsl
 1 Overview   2 Tasks (12)   3 Runs   4 System !                                       / filter
┌──────────────────────────────────────────────────────┐┌────────────────────────────────────┐
│ body: a list                                         ││ preview of the selection           │
└──────────────────────────────────────────────────────┘└────────────────────────────────────┘
 j/k move · ⏎ open · R run · p pause · : palette · ? keys            ⠋ retrying enable-banking…
```

- **Header**: runner health (dot: green ticking, amber late, red down, with
  the reason), last/next tick, today's counts, which machine/hub we look at.
- **Tab bar**: the four roots. Numbers jump (`1`–`4`), `gt`/`gT` cycle. A tab
  shows a badge when it needs you (`!` on System when a check fails).
- **Body**: a list on the left and a **preview** of the selection on the
  right (≥ 120 columns). Narrower, the preview hides and `⏎` opens the full
  view; under 80 columns tables drop their low-priority columns.
- **Footer**: the keys that act on the current selection (from the keymap,
  so remapped keys show), pending keys (`g…`), spinner and toasts.

## Views

### 1. Overview (home)

What's happening now and what needs you.

- **Needs attention** (only when not empty, always first): blocked runs, and
  failed/timed-out/missed runs of the last 24 h not yet *seen* (opening one,
  or `x` dismiss, marks it seen; kept in `state/tui.json`).
- **Running**: in-progress runs, elapsed time ticking, machine, attempt.
- **Next**: the next slot of every active task (paused ones at the bottom,
  dimmed), relative time.
- **Recent**: finished runs with their summary's first line.
- **Preview**: for a run, its result (Markdown), or for a failed one the last
  lines of its captured log; for a blocked one a banner with `a` attach; for
  a task in Next, its schedule, the next 5 slots and its last results as a
  strip (`■■✕■■`).
- The runner's event log moves to System; the Overview keeps only a one-line
  "last event" in the header area when it is relevant (runner restarted,
  warning).

### 2. Tasks

All tasks as a table: state, id/title, schedule (human), next, last results
strip, machine, folder.

- Filters (`/` text, `f` cycles active · paused · archived · all, `m`
  machine). Sort with `s` (next run, id, last result).
- Actions: `R` run now, `p` pause/resume, `D` archive (confirm), `y` copy
  id, `⏎` open.
- Preview: description, schedule with next slots, resolved settings summary
  (agent, timeout, retries, keep_open), last 5 runs.

### 3. Task detail

One task, with sub-tabs (`[`/`]` or `<Tab>`):

- **Overview**: title, id, description, folder (`o` opens it in a new
  multiplexer tab), machine, schedule (human + cron + time zone), next 5
  slots, state.
- **Instructions**: the task's instructions rendered as Markdown; `i` toggles
  *as the agent receives them* (`show --instructions`: template + personal
  files).
- **Runs**: this task's history (same table as Runs, pre-filtered).
- **Settings**: `config resolve`: every resolved setting and where it comes
  from (task, profile, config, default). Read-only.

### 4. Runs

The full history (archived tasks included), newest first, paged on demand.

- Filters: status chips (`f` cycles: all · failures · blocked · ok · missed),
  `/` text over task id and summary, `since` (`S`: 24h · 7d · 30d · all).
- Columns: status, slot, task, machine, took, attempts, summary/reason.
- Actions: `⏎` open, `r` retry, `a` attach, `t` go to task, `y` copy ref.

### 5. Run detail

What it did, first.

- Title: ref, status, duration (ticking while running).
- Sections, as today, but rendered with real components: **Result**
  (Markdown summary), **Output** (Markdown or code by extension),
  **Details**, **Attempts**, **Events**,
  **Log** (monospace, search with `/`, `n`/`N`).
- Keep today's model: `j`/`k` between sections, `⏎`/`za` fold, `zR`/`zM`.
- Actions: `a` attach, `r` retry, `R` run task again, `c` close session
  (confirm; for `keep_open` sessions), `t` go to task, `o` open the output
  file in `$PAGER`, `y` copy ref, `Y` copy summary (OSC 52).
- Blocked: a banner at the top saying it is waiting for you, with `a`.

### 6. System

The runner and the machine: what used to be the Events panel, plus health.

- **Runner**: alive or not, where, pid, every, last/next tick; `T` runs one
  tick now (`agent-tasks tick`, confirm).
- **Events**: `runner.log`, follow mode, `/` search, level filter.
- **Machines** (hub only): each machine, reachable or not, launcher ready;
  `c` re-checks.
- **Checks**: `doctor` results (✓ ! ✕) with the fix for each; `c` re-runs.
- **Problems**: unreadable task/run files the data layer reported.

## Overlays

- **Command palette** (`:` or `<C-p>`): fuzzy search over actions ("Run
  task now…", "Pause…", "Retry…"), tasks and recent runs. Choosing a task
  or run opens it; choosing an action that needs a target asks for one in
  the same palette.
- **Which-key**: after a prefix (`g`, `z`), a small popup lists what can
  follow (`gg` top, `gt` next tab, `go` overview, `gk` tasks, `gr` runs,
  `gs` system).
- **Help** (`?`): every key of the current view, grouped, with the
  `tui.toml` in use.
- **Confirm**: title, consequence in one line, `y` / `n` (`⏎` = the safe
  choice).
- **Toasts**: bottom right, stacked, 6 s; errors stay until dismissed.
- **Filter bar** (`/`): inline at the top of the list, live filtering, `⏎`
  keeps the filter (shown as a chip), `<Esc>` clears it.

## Navigation

- Tabs are roots. `⏎`/`l` pushes a detail, `<Esc>`/`h`/`q` pops; `q` on a
  root quits (asks if a command is still running).
- Cross-links: from a run, `t` → its task; from a task, `⏎` on a run → the
  run; from Overview's attention list, `⏎` → the run.
- Mouse, on by default: click selects, double-click opens, wheel scrolls,
  click a tab or a footer hint to trigger it. Text selection copies
  (OpenTUI selection). `tui.toml` can turn it off (`mouse = false`).

## Default keys

| Where | Keys |
|---|---|
| Everywhere | `1`–`4` tabs · `gt`/`gT` next/prev tab · `:` / `<C-p>` palette · `?` help · `<C-l>` reload · `q` back/quit · `<C-c>` quit |
| Lists | `j`/`k` · `gg`/`G` · `<C-d>`/`<C-u>` · `<Tab>` next section · `/` filter · `f` filter cycle · `⏎`/`l` open · `y` copy |
| Run (list or detail) | `a` attach · `r` retry · `R` run task now · `t` task · `c` close session |
| Task (list or detail) | `R` run now · `p` pause/resume · `D` archive · `o` open folder |
| Run detail | `j`/`k` sections · `{`/`}` · `⏎`/`za` fold · `zR`/`zM` · `/` `n` `N` search log |
| After pause/resume | `u` undo (while the toast shows) |

`tui.toml` keeps today's action names (existing files keep working) and adds
the new ones. `{count}j` works (keymap counts).

## Live data

- Same sources as today: an fs watcher on the data folder (debounced 1 s),
  a 15 s reload fallback, a 1 s clock for relative times.
- Reload is keyed: rows are reconciled by id, so selection, scroll and
  folds survive.
- On a client, `top` reads the hub (as today); writes go through the same
  CLI commands, which already forward to the hub.

## Architecture

- **OpenTUI with the Solid reconciler** (`@opentui/solid`). Fine-grained
  signals fit a UI where a clock ticks every second and one row changes at a
  time; it is what opencode (the largest OpenTUI app) uses. React
  (`@opentui/react`) is the alternative if we prefer its familiarity.
- **`@opentui/keymap`** for bindings: layers per view and overlay, sequences
  (`gg`, `za`), counts, which-key data from `getActiveKeys()`. It replaces
  `keys.ts`'s matcher; `tui.toml` is translated into bindings.
- **Components**: `<box>` panes, `<scrollbox>` lists and sections,
  `<tab-select>` tabs, `<input>` for filters and the palette,
  `<markdown>` for summaries, outputs and instructions, `<code>` for logs and
  JSON.
- **Colors**: only the terminal's own palette (the 16 ANSI colors plus
  default foreground/background, bold, dim, inverse), so the TUI follows the
  user's theme, light or dark. No truecolor values. `NO_COLOR` keeps working.
- **State**: one store (signals) fed by the data layer; views are pure
  functions of store + view state. Commands go through the existing
  `CommandRunner` (`selfCommand`).
- **Runner integration**: `runner` on a TTY mounts the app in the same
  process; `--plain` is unchanged. Attach suspends the renderer and resumes
  it after. Quit goes through `renderer.destroy()` (never `process.exit`).
- **Tests**: data layer unit tests stay; views get `createTestRenderer`
  snapshot and interaction tests replacing `test/tui.test.ts`'s string
  frames.
- **Dependency risk**: `@opentui/core` ships a native library per platform.
  Verify on macOS arm64, Linux x64 and WSL, and in RECIPE's install, before
  committing to it (spike in phase 1).

## Phases

1. **Foundation + Overview**: OpenTUI/Solid set up, native library checked on
   macOS arm64 and Linux/WSL, frame (header, tabs, footer), theme, keymap with
   `tui.toml`, mouse, confirm/toasts/help, Overview with today's actions.
   Runs next to the old TUI until the swap.
2. **Views** (in parallel once 1 is merged): Run detail; Tasks + Task detail;
   Runs; System; palette, which-key, filter and the attention "seen" state.
3. **Swap**: `top` and `runner` use the new app, the old `src/tui` goes, docs
   and screenshot updated.

## Decisions

1. Solid (`@opentui/solid`).
2. No task editor in the TUI.
3. No "new task" in the TUI: creating tasks is the agent's job.
4. Mouse on by default.
5. No live session tail: attach is enough.
6. The attention "seen" state is persisted (`state/tui.json`, local to the
   machine running the TUI).
7. Colors adapt to the terminal's palette (ANSI 16, no truecolor).
