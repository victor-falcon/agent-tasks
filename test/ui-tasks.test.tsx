import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { commands } from "../src/commands/index.ts";
import { createContext } from "../src/context.ts";
import { archiveTask, readTask } from "../src/store.ts";
import type { CommandRunner } from "../src/tui/app.ts";
import { alignRow, columnWidths } from "../src/ui/components/cells.ts";
import { matchesQuery } from "../src/ui/components/filter.ts";
import { buildKeymap } from "../src/ui/keymap/config.ts";
import { type AppHandle, mountApp } from "../src/ui/main.tsx";
import { instructionsOf, readTaskItem, runSections, settingRows } from "../src/ui/views/task/model.ts";
import { cycle, filterTasks, loadTaskItems, nextMachine, SORTS, sortTasks, STATE_FILTERS, stripCell, type TaskItem, taskCells, taskSections } from "../src/ui/views/tasks/model.ts";
import { FIXTURE_NOW, FIXTURE_TZ, writeFixture } from "./fixtures/views.ts";
import { makeTempHome, type TempHome } from "./helpers.ts";

// The Tasks tab, the Task detail and the `/` filter bar of the new dashboard
// (src/ui), on OpenTUI's test renderer, plus their pure models. The fixture
// has every kind of task; one more is archived here. Commands go to a fake
// runner; nothing touches the real home.

const NOW = new Date(FIXTURE_NOW);
const sink = { write: () => {} };

let home: TempHome;
let handle: AppHandle | null = null;
beforeEach(() => {
  home = makeTempHome();
  home.writeConfig({ timezone: FIXTURE_TZ });
  writeFixture(home.paths);
  // An archived task, with a description.
  archiveTask(home.paths, { ...readTask(home.paths, "backup-notes"), id: "old-digest", title: "Old digest", description: "The digest we used to send" });
});
afterEach(() => {
  handle?.stop();
  handle = null;
  home.cleanup();
});

function context() {
  return createContext({ now: NOW, json: false, env: home.env, cwd: home.root, stdout: sink, stderr: sink, commands });
}

interface Started {
  setup: TestRendererSetup;
  handle: AppHandle;
  calls: { args: string[]; interactive: boolean }[];
  shells: string[];
  copies: string[];
  screen(): Promise<string>;
  press(...keys: string[]): Promise<void>;
  type(text: string): Promise<void>;
}

/** The dashboard on the Tasks tab (`2`). */
async function start(opts: { width?: number; height?: number; exec?: CommandRunner; copy?: boolean } = {}): Promise<Started> {
  const setup = await createTestRenderer({ width: opts.width ?? 160, height: opts.height ?? 40 });
  const calls: Started["calls"] = [];
  const shells: string[] = [];
  const copies: string[] = [];
  handle = await mountApp(setup.renderer, {
    title: "agent-tasks top",
    config: { keymap: buildKeymap(), mouse: true, file: null },
    now: () => NOW,
    context: (now) => createContext({ now, json: false, env: home.env, cwd: home.root, stdout: sink, stderr: sink, commands }),
    env: home.env,
    exec: async (args, o) => {
      calls.push({ args, interactive: o.interactive });
      return opts.exec ? opts.exec(args, o) : { code: 0, output: `did ${args.join(" ")}\n` };
    },
    watchDir: null,
    onQuit: () => {},
    waitForKey: async () => {},
    handOver: { suspend: async () => {}, resume: async () => {} },
    shell: async (dir) => (shells.push(dir), 0),
    copyText: (text) => (opts.copy === false ? false : (copies.push(text), true)),
  });
  const s = setup;
  const screen = async () => {
    await s.renderOnce();
    return s
      .captureCharFrame()
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n");
  };
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      if (key === "<CR>") s.mockInput.pressEnter();
      else if (key === "<Tab>") s.mockInput.pressTab();
      else if (key === "<Esc>") {
        s.mockInput.pressEscape();
        await Bun.sleep(60); // a lone Esc is only told from Alt+key after a moment
      } else if (/^[A-Z]$/.test(key)) s.mockInput.pressKey(key.toLowerCase(), { shift: true });
      else s.mockInput.pressKey(key);
      await Bun.sleep(1);
    }
    await s.renderOnce();
  };
  const type = async (text: string) => {
    await s.mockInput.typeText(text);
    await s.renderOnce();
  };
  await s.renderOnce();
  await press("2");
  await Bun.sleep(450); // `2` also starts a count (`2j`): it runs alone after a moment
  await s.renderOnce();
  return { setup: s, handle: handle!, calls, shells, copies, screen, press, type };
}

/** The selected row (`› …`), its cells squeezed. */
function selectedRow(screen: string): string {
  const line = screen
    .split("\n")
    .map((l) => l.trimStart())
    .find((l) => l.startsWith("› "));
  return line ? line.slice(2, 90).replace(/\s+/g, " ").trim() : "";
}

/** The ids in the list, top to bottom. */
function listedIds(screen: string): string[] {
  return screen
    .split("\n")
    .map((l) => /^[› ] {1,2}\S {2}([a-z0-9-]+)/.exec(l)?.[1])
    .filter((id): id is string => id !== undefined);
}

const settle = () => Bun.sleep(5);

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

describe("Tasks model", () => {
  const items = () => loadTaskItems(context()).items;
  const all = { state: "all" as const, machine: null, query: "" };
  const ids = (list: readonly TaskItem[]) => list.map((i) => i.task.id);

  test("every task, saved and archived, with its state, next slots and last results", () => {
    const list = items();
    expect(ids(list).sort()).toEqual(["backup-notes", "inbox-triage", "old-digest", "release-notes", "review-pr-123", "sentry-summary", "weekly-deps-report", "worktree-cleanup"]);
    const sentry = list.find((i) => i.task.id === "sentry-summary")!;
    expect(sentry.state).toBe("active");
    expect(sentry.next).toHaveLength(5);
    expect(sentry.strip).toEqual(["missed", "missed", "succeeded", "failed", "running"]); // superseded left out
    expect(sentry.active?.status).toBe("running");
    const old = list.find((i) => i.task.id === "old-digest")!;
    expect([old.archived, old.state, old.next]).toEqual([true, "archived", []]);
  });

  test("filters: state, machine and text", () => {
    const list = items();
    expect(ids(filterTasks(list, { ...all, state: "paused" }))).toEqual(["backup-notes"]);
    expect(ids(filterTasks(list, { ...all, state: "archived" }))).toEqual(["old-digest"]);
    expect(filterTasks(list, { ...all, state: "active" }).every((i) => i.state === "active")).toBe(true);
    expect(filterTasks(list, { ...all, machine: "elsewhere" })).toEqual([]);
    expect(ids(filterTasks(list, { ...all, query: "digest send" }))).toEqual(["old-digest"]); // id + description
    expect(ids(filterTasks(list, { ...all, query: "~/notes" }))).toEqual(["backup-notes", "old-digest"]); // folder
  });

  test("matchesQuery: every word somewhere, ignoring case; empty matches all", () => {
    expect(matchesQuery("", ["x"])).toBe(true);
    expect(matchesQuery("SEN fail", ["sentry-summary", "it failed"])).toBe(true);
    expect(matchesQuery("sen nope", ["sentry-summary", null])).toBe(false);
  });

  test("sorts: next run (none last), id, worst latest result first", () => {
    const list = items();
    const byNext = ids(sortTasks(list, "next"));
    expect(byNext[0]).toBe("sentry-summary");
    expect(byNext.slice(-3).sort()).toEqual(["backup-notes", "old-digest", "review-pr-123"]);
    expect(ids(sortTasks(list, "id"))).toEqual([...ids(list)].sort());
    expect(ids(sortTasks(list, "last")).slice(0, 2)).toEqual(["review-pr-123", "sentry-summary"]); // blocked, then running (its latest decisive result failed, but it runs)
  });

  test("f and s cycle; m goes through the machines and back to all", () => {
    expect(cycle(STATE_FILTERS, "archived")).toBe("all");
    expect(cycle(SORTS, "next")).toBe("id");
    const list = items();
    expect(nextMachine(list, null)).toBe("local");
    expect(nextMachine(list, "local")).toBeNull();
  });

  test("rows: a multi-colored strip, the next run or what the task is doing; archived in its own section", () => {
    const list = items();
    const input = { now: NOW, timezone: FIXTURE_TZ, showMachine: false, showTitle: true, showFolder: true };
    const text = (id: string) => taskCells(list.find((i) => i.task.id === id)!, input).map((c) => c.text);
    expect(text("inbox-triage")).toEqual(["●", "inbox-triage", "Inbox triage", "every day 06:00", "in 20h", "■■■□", "~/Projects/foo"]);
    expect(text("backup-notes")[4]).toBe("paused");
    expect(text("worktree-cleanup")[4]).toBe("running 4m");
    expect(text("old-digest")[4]).toBe("archived");
    const pausedRunning = { ...list.find((i) => i.task.id === "worktree-cleanup")!, state: "paused" as const };
    expect(taskCells(pausedRunning, input)[4]!.text).toBe("running 4m · paused");
    expect(stripCell({ strip: ["succeeded", "failed"], state: "active" }).parts?.map((p) => p.color)).toEqual(["green", "red"]);
    expect(stripCell({ strip: [], state: "active" }).text).toBe("·");
    const sections = taskSections(list, "all", input);
    expect(sections.map((s) => [s.id, s.rows.length])).toEqual([["tasks", 7], ["archived", 1]]);
    expect(taskSections(list, "paused", input).map((s) => s.id)).toEqual(["tasks"]);
    expect(taskSections(list, "archived", input).map((s) => s.id)).toEqual(["archived"]);
  });

  test("alignRow keeps the colors of a multi-part cell and pads after it", () => {
    const cells = [{ text: "■✕", parts: [{ text: "■", color: "green" as const }, { text: "✕", color: "red" as const }] }, { text: "x" }];
    const widths = columnWidths([cells, [{ text: "■■■■" }, { text: "y" }]]);
    expect(alignRow(cells, widths, 80)).toEqual([{ text: "■", color: "green" }, { text: "✕", color: "red" }, { text: "  " }, { text: "  " }, { text: "x", color: undefined }]);
  });
});

describe("Task detail model", () => {
  test("a saved or archived task; a missing one says so", () => {
    expect(readTaskItem(context(), "inbox-triage").item?.archived).toBe(false);
    expect(readTaskItem(context(), "old-digest").item?.archived).toBe(true);
    expect(readTaskItem(context(), "nope")).toEqual({ item: null, error: 'task "nope" is not saved or archived any more' });
  });

  test("instructions as written, and as the agent receives them with the personal files", () => {
    const file = join(home.root, "personal.md");
    writeFileSync(file, "Always write in English.");
    home.writeConfig({ timezone: FIXTURE_TZ, instructions: { subagent: [file, join(home.root, "gone.md")] } });
    const ctx = context();
    const item = readTaskItem(ctx, "inbox-triage").item!;
    expect(instructionsOf(ctx, item, false)).toEqual({ text: "Do inbox triage.", missing: [join(home.root, "gone.md")], personal: 2 });
    const asAgent = instructionsOf(ctx, item, true).text;
    expect(asAgent).toContain("Do inbox triage.");
    expect(asAgent).toContain("Always write in English.");
  });

  test("settings with where each comes from; runs newest first", () => {
    const ctx = context();
    const item = readTaskItem(ctx, "sentry-summary").item!;
    const rows = settingRows(ctx, item);
    expect(rows.find((r) => r.key === "retries")).toEqual({ key: "retries", value: "1", source: "task" });
    expect(rows.find((r) => r.key === "timeout")?.source).toBe("default");
    const runs = runSections(item, NOW, FIXTURE_TZ)[0]!;
    expect(runs.rows[0]!.key).toBe("runs:sentry-summary/20261117T090000Z"); // the 10:00 slot in Madrid
    expect(runs.rows).toHaveLength(item.runs.length);
  });
});

// ---------------------------------------------------------------------------
// The Tasks tab
// ---------------------------------------------------------------------------

describe("Tasks tab", () => {
  test("the table and the preview (160 columns)", async () => {
    const { screen } = await start();
    expect(await screen()).toMatchSnapshot();
  });

  test("below 120 columns the preview hides and the title shows", async () => {
    const { screen } = await start({ width: 110, height: 24 });
    const text = await screen();
    expect(text).toMatchSnapshot();
    expect(text).not.toContain("Last 5 results");
  });

  test("f cycles the state filter, s the sort; they survive opening a task", async () => {
    home.writeTask({ ...readTask(home.paths, "inbox-triage"), id: "far-away", machine: "mac" });
    const { screen, press } = await start();
    expect(listedIds(await screen())).toHaveLength(9);
    // With two machines, m goes through them.
    await press("m");
    expect(listedIds(await screen())).not.toContain("far-away");
    await press("m");
    expect(listedIds(await screen())).toEqual(["far-away"]);
    await press("m");
    await press("f"); // active
    let text = await screen();
    expect(text).toContain("── Tasks · active");
    expect(listedIds(text)).not.toContain("backup-notes");
    await press("f"); // paused
    expect(listedIds(await screen())).toEqual(["backup-notes"]);
    await press("f"); // archived
    text = await screen();
    expect(text).toContain("── Archived (1)");
    expect(listedIds(text)).toEqual(["old-digest"]);
    await press("f", "s"); // all, by id
    expect(listedIds(await screen())).toEqual(["backup-notes", "far-away", "inbox-triage", "release-notes", "review-pr-123", "sentry-summary", "weekly-deps-report", "worktree-cleanup", "old-digest"]);
    await press("<CR>", "q");
    text = await screen();
    expect(text).toContain("sort id");
    expect(selectedRow(text)).toStartWith("- old-digest"); // the selection followed it through the filters
  });

  test("/ filters as you type; Enter keeps it as a chip, Esc clears it", async () => {
    const { screen, press, type } = await start();
    await press("/");
    await type("sentry");
    let text = await screen();
    expect(listedIds(text)).toEqual(["sentry-summary"]);
    expect(text).toContain("⏎ keep");
    // While typing, letters are text: `j` and `q` don't move or quit.
    await type("j");
    expect(listedIds(await screen())).toEqual([]);
    await press("BACKSPACE");
    expect(listedIds(await screen())).toEqual(["sentry-summary"]);
    await press("<CR>");
    text = await screen();
    expect(text).toContain(" / sentry ");
    expect(listedIds(text)).toEqual(["sentry-summary"]);
    // The list keys work again, with the filter kept.
    await press("j");
    expect(selectedRow(await screen())).toContain("sentry-summary");
    // Esc on the list clears a kept filter (when no message is showing).
    await press("<Esc>");
    text = await screen();
    expect(text).not.toContain(" / sentry ");
    expect(listedIds(text)).toHaveLength(8);
    // Esc while typing drops the text.
    await press("/");
    await type("inbox");
    await press("<Esc>");
    expect(listedIds(await screen())).toHaveLength(8);
  });

  test("R asks first, p is instant with undo, D asks and says the history is kept, y copies", async () => {
    const { screen, press, calls, copies } = await start();
    expect(selectedRow(await screen())).toStartWith("◐ sentry-summary");
    await press("R");
    expect(await screen()).toContain("Run sentry-summary now?");
    await press("y");
    await settle();
    expect(calls.map((c) => c.args)).toEqual([["run", "sentry-summary"]]);
    await press("p");
    await settle();
    expect(await screen()).toContain("did pause sentry-summary · u undo");
    await press("u");
    await settle();
    expect(calls.at(-1)!.args).toEqual(["resume", "sentry-summary"]);
    await press("D");
    const text = await screen();
    expect(text).toContain("Archive sentry-summary?");
    expect(text).toContain("its run history is kept");
    await press("y");
    await settle();
    expect(calls.at(-1)!.args).toEqual(["rm", "sentry-summary"]);
    await press("y");
    expect(copies).toEqual(["sentry-summary"]);
    expect(await screen()).toContain("copied task id sentry-summary");
  });

  test("m with every task on one machine says so; a filter that hides everything says it is the filter", async () => {
    const { screen, press, type } = await start();
    expect(await screen()).not.toContain("machine all"); // no machine chip with one machine
    await press("m");
    expect(await screen()).toContain("every task runs on local: nothing to filter");
    await press("<Esc>", "/");
    await type("zzz");
    const text = await screen();
    expect(text).toContain("no tasks match the filters");
    expect(text).not.toContain("ask an agent");
  });

  test("an archived task can't be run, paused or archived again", async () => {
    const { screen, press, calls } = await start();
    await press("G"); // old-digest, the last row
    expect(selectedRow(await screen())).toContain("old-digest");
    for (const key of ["R", "p", "D"]) {
      await press(key);
      expect(await screen()).toContain("old-digest is archived");
      expect(await screen()).toContain("agent-tasks resume old-digest");
      await press("<Esc>");
    }
    expect(calls).toEqual([]);
  });

  test("a terminal that can't copy says so and shows the id", async () => {
    const { screen, press } = await start({ copy: false });
    await press("y");
    expect(await screen()).toContain("the task id is sentry-summary");
  });

  test("o hands the terminal to a shell in the task's folder; a missing folder or another machine says why", async () => {
    const { screen, press, type, shells, handle: h } = await start();
    await press("o");
    await settle();
    expect(await screen()).toContain("~/Projects/foo does not exist");
    await press("<Esc>");
    mkdirSync(join(home.root, "Projects", "foo"), { recursive: true });
    await press("o");
    await settle();
    expect(shells).toEqual([join(home.root, "Projects", "foo")]);
    expect(h.app.ui.tab()).toBe("tasks");
    // A task of another machine: its folder is there.
    home.writeTask({ ...readTask(home.paths, "inbox-triage"), id: "far-away", machine: "mac" });
    h.app.store.reload();
    await press("<Esc>", "/");
    await type("far-away");
    await press("<CR>", "o");
    await settle();
    expect(await screen()).toContain("far-away runs on mac: its folder is there, not on local");
    expect(shells).toHaveLength(1);
  });

  test("mouse: a click selects, a double click opens, a click on a chip changes it", async () => {
    const { screen, setup: s } = await start();
    let text = await screen();
    const y = text.split("\n").findIndex((l) => l.includes("inbox-triage"));
    await s.mockMouse.click(10, y);
    expect(selectedRow(await screen())).toContain("inbox-triage");
    await s.mockMouse.doubleClick(10, y);
    text = await screen();
    expect(text).toContain("Inbox triage · inbox-triage · active");
    expect(text).toContain("Instructions");
    await s.mockMouse.click(10, 0); // nothing there
    s.mockInput.pressKey("q");
    await Bun.sleep(5);
    text = await screen();
    const chips = text.split("\n")[2]!;
    await s.mockMouse.click(chips.indexOf("sort") + 1, 2);
    expect(await screen()).toContain("s sort id");
  });
});

// ---------------------------------------------------------------------------
// The Task detail
// ---------------------------------------------------------------------------

describe("Task detail", () => {
  const openSentry = async () => {
    const started = await start();
    await started.press("<CR>");
    return started;
  };

  test("Overview: the task, its schedule, next slots and settings", async () => {
    const { screen } = await openSentry();
    expect(await screen()).toMatchSnapshot();
  });

  test("] [ and <Tab> switch parts; Instructions toggles with i; Settings shows sources", async () => {
    const { screen, press } = await openSentry();
    await press("]");
    let text = await screen();
    expect(text).toContain("As written in the task.");
    expect(text).toContain("Do sentry summary.");
    await press("i");
    text = await screen();
    expect(text).toContain("As the agent receives them");
    await press("<Tab>", "<Tab>");
    text = await screen();
    expect(text).toMatch(/retries\s+1\s+← task/);
    expect(text).toMatch(/timeout\s+45m\s+← default/);
    await press("[");
    expect(await screen()).toContain("── Runs (");
  });

  test("Runs: j/k move, Enter opens the run, back returns to the same part and row", async () => {
    const { screen, press } = await openSentry();
    await press("]", "]");
    expect(selectedRow(await screen())).toStartWith("◐ 10:00 running");
    expect(await screen()).toContain("◐ Sentry summary · sentry-summary · active"); // the header stays above the list
    await press("j");
    expect(selectedRow(await screen())).toStartWith("✕ 09:00 failed");
    await press("<CR>");
    expect(await screen()).toContain("Run sentry-summary/20261117T080000Z");
    await press("q");
    const text = await screen();
    expect(selectedRow(text)).toStartWith("✕ 09:00 failed");
    // Back again: the Tasks tab, on the same task.
    await press("q");
    expect(selectedRow(await screen())).toStartWith("◐ sentry-summary");
  });

  test("a click on a part switches to it", async () => {
    const { screen, setup: s } = await openSentry();
    const text = await screen();
    const y = text.split("\n").findIndex((l) => l.includes("Settings") && l.includes("Instructions"));
    await s.mockMouse.click(text.split("\n")[y]!.indexOf("Settings") + 1, y);
    expect(await screen()).toContain("Every setting a run gets");
  });

  test("an archived task opens read-only; its actions say why not", async () => {
    const { screen, press, calls } = await start();
    await press("G", "<CR>");
    let text = await screen();
    expect(text).toContain("Old digest · old-digest · archived");
    expect(text).toContain("The digest we used to send");
    await press("R");
    text = await screen();
    expect(text).toContain("old-digest is archived");
    expect(calls).toEqual([]);
  });
});
