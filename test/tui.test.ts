import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { commands } from "../src/commands/index.ts";
import { createContext } from "../src/context.ts";
import { createStyle } from "../src/output/style.ts";
import type { StatusInfo } from "../src/runner-render.ts";
import type { Run, RunStatus, Task } from "../src/schema.ts";
import { writeRun } from "../src/store.ts";
import { fit, sanitize, width, wrap } from "../src/tui/ansi.ts";
import { loadData, type TuiData } from "../src/tui/data.ts";
import { parseKeys } from "../src/tui/keys.ts";
import { type Bounds, flash, initialModel, type Model, reanchor, update } from "../src/tui/model.ts";
import { render, rowRefs, type ViewInput, viewBounds } from "../src/tui/render.ts";
import { makeTask, makeTempHome, type TempHome } from "./helpers.ts";

const TZ = "Europe/Madrid";
const NOW = new Date("2026-11-17T09:15:00Z"); // 10:15 in Madrid
const plain = createStyle(false);
const color = createStyle(true);
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

function run(task_id: string, slot: string, status: RunStatus, opts: { summary?: string; minutes?: number; attempts?: number; reason?: string } = {}): Run {
  const start = Date.parse(slot) + MIN;
  const attempts =
    status === "missed"
      ? []
      : Array.from({ length: opts.attempts ?? 1 }, (_, i) => ({
          n: i + 1,
          started_at: iso(start),
          finished_at: status === "running" || status === "blocked" ? null : iso(start + (opts.minutes ?? 3) * MIN),
          session: { launcher: "herdr", handle: "t14", name: task_id, pid: null, closed_at: null },
          agent: { command: "clc" },
          status,
          summary: opts.summary ?? null,
          log: null,
        }));
  const events = [
    { at: iso(start - 1000), event: "claimed" },
    ...(attempts.length ? [{ at: iso(start), event: "launched", handle: "t14" }] : []),
    ...(attempts[0]?.finished_at ? [{ at: attempts[0].finished_at, event: "finish", status }] : []),
  ];
  return { task_id, slot, trigger: "schedule", status, reason: opts.reason ?? null, attempts, events };
}

function taskItem(task: Task, runs: Run[], next: string[], state: "active" | "paused" = "active"): TuiData["tasks"][number] {
  const statuses = runs.map((r) => r.status);
  const failing = statuses.filter((s) => s === "succeeded" || s === "failed").at(-1) === "failed";
  return {
    task,
    state,
    row: {
      id: task.id,
      title: task.title,
      cwd: task.cwd,
      state,
      indicator: state === "paused" ? "paused" : statuses.includes("running") ? "running" : failing ? "failing" : "ok",
      schedule: "",
      next_run: next[0] ?? null,
      last_status: statuses.at(-1) ?? null,
      last_slot: runs.at(-1)?.slot ?? null,
      history: statuses.slice(-10),
      in_progress: null,
      active_since: null,
      failing,
      failed_7d: 0,
      missed_7d: 0,
    },
    schedule: task.schedule.type === "cron" ? "every hour" : "",
    schedule_detail: task.schedule.type === "cron" ? `cron "${task.schedule.cron}" in ${TZ}` : "",
    timezone: TZ,
    agent: "clc",
    launcher: "herdr",
    timeout: "45m",
    retries: task.retries ?? 0,
    catch_up: "latest",
    next,
    recent: runs
      .slice()
      .reverse()
      .slice(0, 5)
      .map((r) => ({ slot: ref(r).split("/")[1]!, ref: ref(r), run: r })),
  };
}

const ref = (r: Run) => `${r.task_id}/${r.slot.replace(/[-:]/g, "")}`;

function fixture(): TuiData {
  const sentry = makeTask({ id: "sentry-summary", title: "Sentry summary", schedule: { type: "cron", cron: "0 * * * *", timezone: TZ, starts_at: null, until: null }, retries: 1 });
  const cleanup = makeTask({ id: "worktree-cleanup", title: "Worktree cleanup", schedule: { type: "cron", cron: "30 * * * *", timezone: TZ, starts_at: null, until: null } });
  const backup = makeTask({ id: "backup-notes", title: "Backup notes", enabled: false, schedule: { type: "cron", cron: "0 23 * * *", timezone: TZ, starts_at: null, until: null } });
  const sentryRuns = [
    run("sentry-summary", "2026-11-17T03:00:00Z", "missed", { reason: "runner_offline" }),
    run("sentry-summary", "2026-11-17T07:00:00Z", "succeeded", { summary: "3 new issues in notes/sentry.md", minutes: 6 }),
    run("sentry-summary", "2026-11-17T08:00:00Z", "failed", { summary: "sentry-cli has no auth", attempts: 2 }),
  ];
  const cleanupRuns = [run("worktree-cleanup", "2026-11-17T08:30:00Z", "running")];
  const backupRuns = [run("backup-notes", "2026-11-16T22:00:00Z", "succeeded", { summary: "backed up 120 files", minutes: 2 })];
  const all = [...sentryRuns, ...cleanupRuns, ...backupRuns, run("review-pr-123", "2026-11-17T02:12:00Z", "blocked")];
  all.sort((a, b) => Date.parse(b.slot) - Date.parse(a.slot));
  return {
    recent: all.map((r) => ({ ref: ref(r), task_id: r.task_id, run: r, cwd: "~/Projects/foo", max_attempts: r.task_id === "sentry-summary" ? 2 : 1 })),
    upcoming: [
      { task_id: "worktree-cleanup", at: "2026-11-17T09:30:00Z", schedule: "every hour at :30" },
      { task_id: "sentry-summary", at: "2026-11-17T10:00:00Z", schedule: "every hour" },
      { task_id: "sentry-summary", at: "2026-11-17T11:00:00Z", schedule: "every hour" },
    ],
    tasks: [
      taskItem(backup, backupRuns, [], "paused"),
      taskItem(sentry, sentryRuns, ["2026-11-17T10:00:00Z", "2026-11-17T11:00:00Z"]),
      taskItem(cleanup, cleanupRuns, ["2026-11-17T09:30:00Z"]),
    ],
    errors: [],
    timezone: TZ,
    loaded: true,
  };
}

const STATUS: StatusInfo = {
  health: "healthy",
  last_tick: new Date("2026-11-17T09:13:00Z"),
  next_tick: new Date("2026-11-17T09:18:00Z"),
  running: 1,
  today: { succeeded: 4, failed: 1, missed: 1, blocked: 1 },
};

function input(model: Model, overrides: Partial<ViewInput> = {}): ViewInput {
  return { model, data: fixture(), runner: { every: "5m", status: STATUS }, log: null, size: { width: 120, height: 30 }, now: NOW, style: plain, ...overrides };
}

const screen = (i: ViewInput) => render(i).join("\n");

/** Feeds keys one by one, recomputing the bounds like the IO layer does. */
function press(model: Model, keys: string[], overrides: Partial<ViewInput> = {}): { model: Model; effects: string[] } {
  const effects: string[] = [];
  for (const key of keys) {
    const result = update(model, key, viewBounds(input(model, overrides)));
    model = result.model;
    effects.push(...result.effects.map((e) => (e.type === "open-log" ? `open-log ${e.ref}` : e.type)));
  }
  return { model, effects };
}

describe("keys", () => {
  test("named keys, escapes and printable characters", () => {
    expect(parseKeys("jk")).toEqual(["j", "k"]);
    expect(parseKeys("\x1b[A\x1b[B\x1b[C\x1b[D")).toEqual(["up", "down", "right", "left"]);
    expect(parseKeys("\x1b[Z\t\r")).toEqual(["shift-tab", "tab", "enter"]);
    expect(parseKeys("\x1b")).toEqual(["esc"]);
    expect(parseKeys("\x03\x04\x15\x7f")).toEqual(["ctrl-c", "ctrl-d", "ctrl-u", "backspace"]);
    expect(parseKeys("\x1b[5~\x1b[6~\x1bOH\x1b[1;5A")).toEqual(["pageup", "pagedown", "home", "up"]);
    expect(parseKeys("/é?G")).toEqual(["/", "é", "?", "G"]);
  });
});

describe("text helpers", () => {
  test("fit pads, cuts with … and keeps colors balanced", () => {
    expect(fit("abc", 5)).toBe("abc  ");
    expect(fit("abcdef", 4)).toBe("abc…");
    const cut = fit(color.paint("red", "abcdef"), 4);
    expect(width(cut)).toBe(4);
    expect(cut).toContain("\x1b[0m");
    expect(width(fit("■■✕◐日本語", 6))).toBe(6);
  });

  test("wrap breaks on words", () => {
    expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
  });

  test("sanitize keeps colors and drops cursor moves, titles and control characters", () => {
    const text = "\x1b[31mred\x1b[0m \x1b[2J\x1b[Hclear\x1b]0;title\x07\tx\rover\nbell\x07ok";
    expect(sanitize(text)).toEqual(["over", "bellok"]);
    expect(sanitize("\x1b[32m■ ok\x1b[39m\tdone")).toEqual(["\x1b[32m■ ok\x1b[39m  done"]);
    expect(sanitize("a\x1bMb")).toEqual(["ab"]);
  });
});

describe("model", () => {
  test("j/k move within the list and stop at the ends; gg and G jump", () => {
    let { model } = press(initialModel(), ["j", "j"]);
    expect(model.cursor.recent).toBe(2);
    ({ model } = press(model, ["k", "k", "k"]));
    expect(model.cursor.recent).toBe(0);
    ({ model } = press(model, ["G"]));
    expect(model.cursor.recent).toBe(5);
    ({ model } = press(model, ["g", "g"]));
    expect(model.cursor.recent).toBe(0);
    ({ model } = press(model, ["g", "j"])); // `g` then another key: the key counts on its own
    expect(model.cursor.recent).toBe(1);
  });

  test("Ctrl-d and Ctrl-u move half the panel's height", () => {
    const { model } = press(initialModel(), ["ctrl-d"], { size: { width: 120, height: 20 } });
    const height = viewBounds(input(initialModel(), { size: { width: 120, height: 20 } })).listHeight.recent;
    expect(model.cursor.recent).toBe(Math.min(5, Math.floor(height / 2)));
    expect(press(model, ["ctrl-u"]).model.cursor.recent).toBe(0);
  });

  test("Tab, Shift-Tab and 1/2/3 switch panels, each keeping its own selection", () => {
    let { model } = press(initialModel(), ["j", "tab"]);
    expect(model.panel).toBe("upcoming");
    ({ model } = press(model, ["tab", "tab"]));
    expect(model.panel).toBe("recent");
    expect(model.cursor.recent).toBe(1);
    ({ model } = press(model, ["shift-tab"]));
    expect(model.panel).toBe("tasks");
    ({ model } = press(model, ["2"]));
    expect(model.panel).toBe("upcoming");
  });

  test("l focuses the detail, where j/k scroll it; h goes back", () => {
    let { model } = press(initialModel(), ["3", "j", "l"], { size: { width: 120, height: 14 } });
    expect(model.focus).toBe("detail");
    ({ model } = press(model, ["j", "j"], { size: { width: 120, height: 14 } }));
    expect(model.detailScroll).toBe(2);
    expect(model.cursor.tasks).toBe(1);
    ({ model } = press(model, ["h", "j"]));
    expect(model.focus).toBe("list");
    expect(model.cursor.tasks).toBe(2);
    expect(model.detailScroll).toBe(0);
  });

  test("Enter opens the selected run's log; on a task, its latest run; q goes back", () => {
    let { model, effects } = press(initialModel(), ["enter"]);
    expect(effects).toEqual(["open-log worktree-cleanup/20261117T083000Z"]);
    expect(model.screen).toBe("log");
    ({ model, effects } = press(model, ["q"]));
    expect(effects).toEqual(["close-log"]);
    expect(model.screen).toBe("main");
    ({ effects } = press(model, ["3", "j", "enter"]));
    expect(effects).toEqual(["open-log sentry-summary/20261117T080000Z"]);
  });

  test("the log scrolls; following sticks to the bottom until scrolled up", () => {
    const log = { lines: Array.from({ length: 100 }, (_, i) => `line ${i}`), following: true };
    let model: Model = { ...initialModel(), screen: "log", log: { ref: "x/1", scroll: 0, follow: true } };
    ({ model } = press(model, ["k"], { log }));
    expect(model.log).toEqual({ ref: "x/1", scroll: 100 - 26 - 1, follow: false });
    ({ model } = press(model, ["g", "g"], { log }));
    expect(model.log?.scroll).toBe(0);
    ({ model } = press(model, ["G"], { log }));
    expect(model.log?.follow).toBe(true);
  });

  test("/ filters by task id: jumps to the first match while typing, n/N cycle, Esc clears", () => {
    // Recent: worktree-cleanup, sentry ×3, review-pr-123, backup-notes.
    let { model } = press(initialModel(), ["/", "s", "e", "n"]);
    expect(model.search).toEqual({ query: "sen", typing: true });
    expect(model.cursor.recent).toBe(1);
    ({ model } = press(model, ["enter"]));
    expect(model.search?.typing).toBe(false);
    ({ model } = press(model, ["n"]));
    expect(model.cursor.recent).toBe(2);
    ({ model } = press(model, ["n"]));
    expect(model.cursor.recent).toBe(3);
    ({ model } = press(model, ["n"]));
    expect(model.cursor.recent).toBe(1);
    ({ model } = press(model, ["N"]));
    expect(model.cursor.recent).toBe(3);
    ({ model } = press(model, ["esc"]));
    expect(model.search).toBeNull();
  });

  test("a query with no match in the panel moves to a panel that has one", () => {
    const { model } = press(initialModel(), ["3", "/", "r", "e", "v"]);
    expect(model.panel).toBe("recent");
    expect(model.cursor.recent).toBe(4);
  });

  test("? opens the help and q closes it; q on the main screen quits once; Ctrl-c always quits", () => {
    let { model, effects } = press(initialModel(), ["?"]);
    expect(model.screen).toBe("help");
    ({ model, effects } = press(model, ["j", "q"]));
    expect(model.screen).toBe("main");
    expect(effects).toEqual([]);
    ({ model, effects } = press(model, ["q", "q"]));
    expect(effects).toEqual(["quit"]);
    expect(model.stopping).toBe(true);
    expect(press(model, ["ctrl-c"]).effects).toEqual(["quit"]);
  });

  test("reanchor keeps the selection on the same run when new ones arrive", () => {
    const data = fixture();
    const before = rowRefs(data);
    const model = { ...initialModel(), cursor: { recent: 2, upcoming: 0, tasks: 1 } };
    const extra = run("sentry-summary", "2026-11-17T09:00:00Z", "running");
    const after: Bounds["rows"] = { ...before, recent: [{ key: ref(extra), task_id: extra.task_id, ref: ref(extra) }, ...before.recent] };
    expect(reanchor(model, before, after).cursor).toEqual({ recent: 3, upcoming: 0, tasks: 1 });
    expect(reanchor(model, before, { ...before, recent: before.recent.slice(0, 1) }).cursor.recent).toBe(0);
  });
});

describe("render", () => {
  test("wide: Recent, Upcoming and Tasks on the left, the selected run's detail on the right", () => {
    expect(screen(input(initialModel()))).toMatchSnapshot();
  });

  test("a task's detail: definition, next runs, recent runs, instructions", () => {
    const { model } = press(initialModel(), ["3", "j"]);
    expect(screen(input(model))).toMatchSnapshot();
  });

  test("an upcoming slot's detail", () => {
    const { model } = press(initialModel(), ["2"]);
    expect(screen(input(model, { size: { width: 110, height: 24 } }))).toMatchSnapshot();
  });

  test("narrow: the lists alone; l shows the detail alone", () => {
    const size = { width: 70, height: 24 };
    expect(screen(input(initialModel(), { size }))).toMatchSnapshot();
    expect(screen(input(press(initialModel(), ["l"], { size }).model, { size }))).toMatchSnapshot();
  });

  test("short: only the selected panel", () => {
    expect(screen(input(press(initialModel(), ["2"]).model, { size: { width: 60, height: 11 } }))).toMatchSnapshot();
  });

  test("too small: says so", () => {
    expect(render(input(initialModel(), { size: { width: 30, height: 5 } }))[0]!.trimEnd()).toBe("Too small: 30×5, needs 40×8");
  });

  test("help, log and filter screens", () => {
    expect(screen(input(press(initialModel(), ["?"]).model, { size: { width: 100, height: 22 } }))).toMatchSnapshot();
    const log = { lines: ["◐ running  worktree-cleanup/20261117T083000Z", "", ...Array.from({ length: 30 }, (_, i) => `step ${i + 1}`)], following: true };
    const logModel: Model = { ...initialModel(), screen: "log", log: { ref: "worktree-cleanup/20261117T083000Z", scroll: 0, follow: true } };
    expect(screen(input(logModel, { log, size: { width: 80, height: 14 } }))).toMatchSnapshot();
    const typing = press(initialModel(), ["/", "s", "e", "n"]).model;
    expect(render(input(typing)).at(-1)).toBe(" /sen▏  ⏎ keep  esc clear".padEnd(120));
    const kept = press(typing, ["enter"]).model;
    expect(render(input(kept)).at(-1)).toStartWith(" /sen 1/3 · n/N next/prev · esc clear");
  });

  test("the bottom line shows the latest event for a while, then the key hints again", () => {
    const model = flash(initialModel(), "10:15:03  ✕ sentry-summary/20261117T080000Z  failed", NOW.getTime());
    expect(render(input(model)).at(-1)).toStartWith(" 10:15:03  ✕ sentry-summary/20261117T080000Z  failed  ·  j/k move");
    expect(render(input(model, { now: new Date(NOW.getTime() + 7_000) })).at(-1)).toStartWith(" j/k move");
  });

  test("the header: health, interval, last and next tick, running, today", () => {
    expect(render(input(initialModel()))[0]).toBe(" agent-tasks · runner ● alive · every 5m · last tick 2m ago · next in 3m · running 2 · today ■4 ✕1 □1 !1".padEnd(120));
    expect(render(input(initialModel(), { runner: { every: "30s", status: { ...STATUS, last_tick: new Date(NOW.getTime() - 12_000), next_tick: new Date(NOW.getTime() + 18_000) } } }))[0]).toContain("last tick 12s ago · next in 18s");
    expect(render(input({ ...initialModel(), stopping: true }))[0]).toContain("● stopping after this tick…");
    expect(render(input(initialModel(), { runner: { every: "5m", status: { ...STATUS, last_tick: null } } }))[0]).toContain("● starting…");
  });

  test("every line fits the width exactly, with colors too, at any size", () => {
    for (const size of [
      { width: 140, height: 40 },
      { width: 96, height: 30 },
      { width: 95, height: 30 },
      { width: 40, height: 8 },
      { width: 200, height: 12 },
    ]) {
      for (const model of [initialModel(), press(initialModel(), ["l"]).model, press(initialModel(), ["3", "l"]).model]) {
        const lines = render(input(model, { size, style: color }));
        expect(lines).toHaveLength(size.height);
        for (const line of lines) expect(width(line)).toBe(size.width);
      }
    }
  });

  test("empty data: the panels say so", () => {
    const empty: TuiData = { recent: [], upcoming: [], tasks: [], errors: [], timezone: TZ, loaded: true };
    const text = screen(input(initialModel(), { data: empty, size: { width: 100, height: 20 } }));
    expect(text).toContain("no runs yet");
    expect(text).toContain("nothing scheduled");
    expect(text).toContain("no tasks");
  });
});

describe("loadData", () => {
  let home: TempHome;
  beforeEach(() => {
    home = makeTempHome();
    home.writeConfig({ timezone: TZ, notifiers: [] });
  });
  afterEach(() => home.cleanup());

  test("reads recent runs (removed tasks included), upcoming slots and task rows", () => {
    home.writeTask(makeTask({ id: "hourly", schedule: { type: "cron", cron: "0 * * * *", timezone: TZ, starts_at: null, until: null }, retries: 1 }));
    home.writeTask(makeTask({ id: "paused-one", enabled: false }));
    writeRun(home.paths, run("hourly", "2026-11-17T07:00:00Z", "succeeded"));
    writeRun(home.paths, run("hourly", "2026-11-17T08:00:00Z", "failed"));
    writeRun(home.paths, run("gone", "2026-11-17T08:30:00Z", "succeeded"));
    const ctx = createContext({ now: NOW, json: false, env: home.env, cwd: home.root, stdout: { write() {} }, stderr: { write() {} }, commands });
    const data = loadData(ctx);
    expect(data.recent.map((r) => [r.ref, r.max_attempts])).toEqual([
      ["gone/20261117T083000Z", null],
      ["hourly/20261117T080000Z", 2],
      ["hourly/20261117T070000Z", 2],
    ]);
    expect(data.upcoming.map((u) => [u.task_id, u.at, u.schedule])).toEqual([
      ["hourly", "2026-11-17T11:00:00+01:00", "every hour"],
      ["hourly", "2026-11-17T12:00:00+01:00", "every hour"],
      ["hourly", "2026-11-17T13:00:00+01:00", "every hour"],
    ]);
    expect(data.tasks.map((t) => [t.task.id, t.state, t.row.indicator, t.row.history.join(",")])).toEqual([
      ["hourly", "active", "failing", "succeeded,failed"],
      ["paused-one", "paused", "paused", ""],
    ]);
    expect(data.tasks[0]!.recent.map((r) => r.ref)).toEqual(["hourly/20261117T080000Z", "hourly/20261117T070000Z"]);
  });
});
