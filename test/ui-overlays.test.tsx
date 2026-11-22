import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { listTasks } from "../src/store.ts";
import { buildDashboard } from "../src/tui/snapshot.ts";
import { commands } from "../src/commands/index.ts";
import { createContext } from "../src/context.ts";
import { buildKeymap } from "../src/ui/keymap/config.ts";
import { helpSections } from "../src/ui/overlays/help.tsx";
import { fuzzyScore, type PaletteItem, paletteCatalog, rankItems, targetItems } from "../src/ui/overlays/palette-model.ts";
import { whichKeyRows, WHICH_KEY_DELAY_MS } from "../src/ui/overlays/which-key.tsx";
import { OVERVIEW_KEYS } from "../src/ui/views/overview/keys.ts";
import { RUN_KEYS } from "../src/ui/views/run/keys.ts";
import { FIXTURE_NOW, FIXTURE_TZ, writeFixture } from "./fixtures/views.ts";
import { makeTempHome, type TempHome } from "./helpers.ts";
import { selectedRow, settle, type Started, startApp } from "./ui-harness.ts";

// The overlays of the new dashboard that help find keys and actions: the
// command palette (`:`), which-key after a prefix, the scrolling help (`?`),
// and counts before a motion (`15j`) next to the digit keys of the tabs.

const NOW = new Date(FIXTURE_NOW);
const sink = { write: () => {} };

let home: TempHome;
let app: Started | null = null;
beforeEach(() => {
  home = makeTempHome();
  home.writeConfig({ timezone: FIXTURE_TZ });
  writeFixture(home.paths);
});
afterEach(() => {
  app?.stop();
  app = null;
  home.cleanup();
});

async function start(opts: Parameters<typeof startApp>[2] = {}): Promise<Started> {
  app = await startApp(home, NOW, opts);
  return app;
}

function dashboard() {
  return buildDashboard(createContext({ now: NOW, json: false, env: home.env, cwd: home.root, stdout: sink, stderr: sink, commands }));
}

/** The palette's rows (between its input line and its footnote), titles only. */
function paletteRows(screen: string): string[] {
  const lines = screen.split("\n");
  const input = lines.findIndex((l) => /│ [:›] /.test(l));
  // The box's left border on the input line: rows are read from that column to the next border.
  const left = lines[input]!.search(/│ [:›] /) + 1;
  const rows: string[] = [];
  for (const line of lines.slice(input + 1)) {
    const inside = line.slice(left).split("│")[0]!;
    if (inside.includes("⏎ choose")) break;
    rows.push(inside.trim());
  }
  return rows;
}

describe("counts and the digit keys", () => {
  // Overview rows: 0 the blocked review, 1-5 attention, 6-7 running, 8-13 next, 14+ recent.
  test("a count of two digits moves that many rows, though 1 is also a tab key", async () => {
    const { screen, press, handle } = await start({ height: 60 });
    await press("1", "2", "j");
    expect(selectedRow(await screen())).toContain("weekly-deps-report");
    expect(handle.app.ui.tab()).toBe("overview");
    await press("1", "0", "k"); // 0 continues a count
    expect(selectedRow(await screen())).toStartWith("□ 06:20 inbox-triage");
    await press("3", "<Down>"); // any key bound to down takes it
    expect(selectedRow(await screen())).toStartWith("□ 02:20 sentry-summary");
  });

  test("the count shows in the footer until its motion comes; Esc cancels it", async () => {
    const { screen, press } = await start();
    await press("1", "5");
    expect(await screen()).toContain("15…");
    await press("<Esc>");
    expect(await screen()).not.toContain("15…");
    await press("j");
    expect(selectedRow(await screen())).toStartWith("✕ 09:10 sentry-summary");
  });

  test("a lone tab digit switches after a moment, or at once when a non-motion key follows", async () => {
    const { press, handle } = await start();
    await press("2");
    expect(handle.app.ui.tab()).toBe("overview");
    await Bun.sleep(450);
    expect(handle.app.ui.tab()).toBe("tasks");
    await press("3", "?");
    expect(handle.app.ui.tab()).toBe("runs");
    expect(handle.app.ui.help()).toBe(true);
  });

  test("a longer count before a key that is not a motion is dropped, and the key runs", async () => {
    const { press, handle } = await start();
    await press("2", "5", "?");
    expect(handle.app.ui.tab()).toBe("overview");
    expect(handle.app.ui.help()).toBe(true);
  });

  test("digits mean nothing special inside an overlay or a sequence", async () => {
    const { press, handle } = await start();
    await press(":", "4");
    expect(handle.app.ui.tab()).toBe("overview");
    await press("<Esc>", "g", "2");
    await Bun.sleep(450);
    expect(handle.app.ui.tab()).toBe("overview");
  });

  test("a tab remapped to another key leaves its digit free for counts", async () => {
    const { screen, press, handle } = await start({ config: { keymap: buildKeymap({ tab_tasks: "T" }) } });
    await press("2", "j");
    expect(handle.app.ui.tab()).toBe("overview");
    expect(selectedRow(await screen())).toStartWith("□ 06:20 inbox-triage");
  });
});

describe("which-key", () => {
  test("rows: each key that can follow, with what it does", () => {
    const rows = whichKeyRows("g", [
      { display: "t", continues: false, commandAttrs: { desc: "Next tab" } },
      { display: "g", continues: false, commandAttrs: { desc: "Go to the first row / the top" } },
      { display: "w", continues: true },
    ]);
    expect(rows).toEqual([
      { keys: "gg", desc: "Go to the first row / the top" },
      { keys: "gt", desc: "Next tab" },
      { keys: "gw", desc: "more keys…" },
    ]);
  });

  test("after a prefix it lists what follows, holds the sequence while shown, and the next key runs", async () => {
    const { screen, press, handle } = await start();
    await press("g");
    expect(await screen()).not.toContain("Next tab"); // not before a moment: `gg` typed fast never flashes it
    await Bun.sleep(WHICH_KEY_DELAY_MS + 700); // past the 1 s sequence timeout
    const text = await screen();
    expect(text).toContain("╭─ g… ");
    expect(text).toMatch(/gg\s+Go to the first row \/ the top/);
    expect(text).toMatch(/gt\s+Next tab/);
    expect(text).toMatch(/gT\s+Previous tab/);
    await press("t");
    expect(handle.app.ui.tab()).toBe("tasks");
    expect(await screen()).not.toContain("╭─ g… ");
  });

  test("Esc cancels; remapped keys show as remapped", async () => {
    const { screen, press, handle } = await start({ config: { keymap: buildKeymap({ next_tab: "gn" }) } });
    await press("g");
    await Bun.sleep(WHICH_KEY_DELAY_MS + 50);
    const text = await screen();
    expect(text).toMatch(/gn\s+Next tab/);
    expect(text).not.toMatch(/gt\s+Next tab/);
    await press("<Esc>");
    expect(await screen()).not.toContain("╭─ g… ");
    expect(handle.app.keymap.hasPendingSequence()).toBe(false);
  });

  test("in the run view it lists the z folds", async () => {
    const { screen, press } = await start();
    await press("<CR>"); // the blocked run
    await press("z");
    await Bun.sleep(WHICH_KEY_DELAY_MS + 50);
    const text = await screen();
    expect(text).toMatch(/za\s+Fold or open/);
    expect(text).toMatch(/zR\s+Open every section/);
    expect(text).toMatch(/zM\s+Fold every section/);
  });
});

describe("help", () => {
  test("groups the view's keys: moving, this view, everywhere", () => {
    const sections = helpSections(OVERVIEW_KEYS, buildKeymap());
    expect(sections.map((s) => s.title)).toEqual(["Moving", "This view", "Everywhere"]);
    expect(sections[0]!.rows.map((r) => r.action)).toContain("down");
    expect(sections[1]!.rows.map((r) => r.action)).toEqual(["attach", "retry", "run_now", "toggle_pause"]);
    expect(sections[2]!.rows.find((r) => r.action === "palette")?.keys).toBe(": <C-p>");
    const run = helpSections(RUN_KEYS, buildKeymap({ copy_summary: "<C-y>" }));
    expect(run[1]!.rows.find((r) => r.action === "copy_summary")?.keys).toBe("<C-y>");
  });

  test("scrolls with j/k and <C-d> in a short terminal; another key closes it", async () => {
    const { screen, press } = await start({ height: 24 });
    await press("?");
    let text = await screen();
    expect(text).toContain("Moving");
    expect(text).toContain("15j moves 15 rows"); // the lines around the list keep their rows
    expect(text).toContain("any other key closes");
    expect(text).not.toContain("tab_system"); // below the fold
    await press("<C-d>", "<C-d>", "j", "j", "j");
    text = await screen();
    expect(text).toContain("tab_system");
    expect(text).not.toMatch(/│\s+Moving/);
    await press("k");
    expect(await screen()).toContain("Keys");
    await press("x");
    expect(await screen()).not.toContain("tab_system");
  });

  test("the wheel scrolls it too", async () => {
    const { screen, press, setup } = await start({ height: 24 });
    await press("?");
    for (let i = 0; i < 10; i++) await setup.mockMouse.scroll(80, 12, "down");
    expect(await screen()).toContain("tab_system");
  });
});

describe("palette model", () => {
  test("fuzzy: characters in order, better for runs and word starts", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("rtn", "Run task now…")).not.toBeNull();
    expect(fuzzyScore("xyz", "Run task now…")).toBeNull();
    expect(fuzzyScore("run", "Run task now…")!).toBeGreaterThan(fuzzyScore("run", "Previous tab, return")!);
  });

  test("the catalog: the view's commands with their keys, asking actions in their place, tasks and runs", () => {
    const keymap = buildKeymap({ refresh: "<C-r>" });
    const items = paletteCatalog({
      viewId: "overview",
      commands: ["overview.down", "overview.open", "overview.retry", "overview.refresh", "overview.tab_system", "overview.palette", "confirm.yes"],
      keymap,
      dash: dashboard(),
      tasks: listTasks(home.paths).items,
    });
    const titles = items.map((i) => i.title);
    expect(titles).toContain("Reload everything now");
    expect(items.find((i) => i.title === "Reload everything now")?.keys).toBe("<C-r>");
    expect(titles).toContain("Go to the System tab");
    expect(titles).not.toContain("Move down / scroll down");
    expect(titles).not.toContain("Open the command palette: actions, tasks and runs");
    expect(titles).not.toContain("Retry the run (failed, timed out or missed)");
    expect(items.find((i) => i.title === "Retry…")?.keys).toBe("r"); // the view binds it: its key acts on the selection
    expect(items.find((i) => i.title === "Archive…")?.keys).toBe(""); // not bound in the Overview
    expect(items.find((i) => i.id === "task:release-notes")?.pick).toEqual({ type: "open_task", id: "release-notes" });
    expect(items.find((i) => i.id === "run:review-pr-123/20261117T083000Z")?.detail).toBe("blocked · asks to confirm the merge");
    // Nothing typed: acting first, then the view's own, then everywhere, then tasks and runs.
    expect(items[0]!.title).toBe("Run task now…");
    expect(titles.indexOf("Open the selected run or task")).toBeLessThan(titles.indexOf("Reload everything now"));
    expect(titles.indexOf("Reload everything now")).toBeLessThan(titles.indexOf("release-notes"));
  });

  test("targets: only runs the action takes, the one the view is open on first", () => {
    const dash = dashboard();
    const tasks = listTasks(home.paths).items;
    const retry = targetItems("retry", dash, tasks);
    expect(retry.length).toBeGreaterThan(0);
    expect(retry.every((i) => /failed|timed out|missed/.test(i.detail))).toBe(true);
    const attach = targetItems("attach", dash, tasks, { ref: "sentry-summary/20261117T090000Z" });
    expect(attach.every((i) => /running|blocked/.test(i.detail))).toBe(true);
    expect(attach[0]!.title).toBe("sentry-summary/20261117T090000Z");
    const pause = targetItems("toggle_pause", dash, tasks, { taskId: "release-notes" });
    expect(pause[0]!.pick).toEqual({ type: "apply", action: "toggle_pause", target: { kind: "task", taskId: "release-notes" } });
    // Every saved task, even one with no upcoming slot (review-pr-123 ran once, and is blocked).
    expect(pause.map((i) => i.title)).toContain("review-pr-123");
    expect(pause.find((i) => i.title === "review-pr-123")!.detail).toEndWith("no upcoming run");
    expect(pause.find((i) => i.title === "backup-notes")!.detail).toEndWith("paused");
  });

  test("ranking puts the best match first and keeps the order on ties", () => {
    const item = (title: string): PaletteItem => ({ id: title, kind: "action", title, detail: "", keys: "", pick: { type: "command", command: title } });
    const items = [item("Previous tab"), item("Retry…"), item("Reload everything now")];
    expect(rankItems(items, "retry").map((i) => i.title)[0]).toBe("Retry…");
    expect(rankItems(items, "").map((i) => i.title)).toEqual(["Previous tab", "Retry…", "Reload everything now"]);
    expect(rankItems(items, "zzz")).toEqual([]);
  });
});

describe("palette", () => {
  test(": opens it; typing narrows; Enter runs the view's action as its key would", async () => {
    const { screen, press, handle } = await start();
    await press(":");
    let text = await screen();
    expect(text).toContain("Actions, tasks and runs");
    expect(paletteRows(text)[0]).toStartWith("Run task now…");
    await press(..."system".split(""));
    text = await screen();
    expect(paletteRows(text)[0]).toMatch(/^Go to the System tab\s+tab_system\s+4$/);
    await press("<CR>");
    expect(handle.app.ui.palette()).toBe(false);
    expect(handle.app.ui.tab()).toBe("system");
  });

  test("<C-p> opens it too; Up/Down and <C-n>/<C-p> move; Esc closes", async () => {
    const { screen, press, handle } = await start();
    await press("<C-p>");
    expect(handle.app.ui.palette()).toBe(true);
    const position = async () => /(\d+)\/(\d+) ·/.exec(await screen())!.slice(1).map(Number);
    await press("<Down>", "<C-n>");
    expect((await position())[0]).toBe(3);
    await press("<C-p>", "<Up>");
    expect((await position())[0]).toBe(1);
    await press("<Up>"); // wraps to the last row
    const [at, of] = await position();
    expect(at).toBe(of!);
    await press("<Esc>");
    expect(handle.app.ui.palette()).toBe(false);
    // The views' keys are back.
    await press("j");
    expect(selectedRow(await screen())).toStartWith("✕ 09:10 sentry-summary");
  });

  test("an action on a run asks for the run in the same palette, then confirms", async () => {
    const { screen, press, calls } = await start();
    await press(":", ..."retry".split(""), "<CR>");
    let text = await screen();
    expect(text).toContain("Retry which run?");
    const rows = paletteRows(text);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => /failed|missed|timed out/.test(r))).toBe(true);
    await press(..."inbox".split(""), "<CR>");
    text = await screen();
    expect(text).toContain("Retry inbox-triage/20261117T050000Z?");
    await press("y");
    await settle();
    expect(calls).toEqual([{ args: ["retry", "inbox-triage/20261117T050000Z"], interactive: false }]);
  });

  test("Esc in the second step goes back to the first", async () => {
    const { screen, press, handle } = await start();
    await press(":", ..."pause".split(""), "<CR>");
    expect(await screen()).toContain("Pause or resume which task?");
    await press("<Esc>");
    expect(await screen()).toContain("Actions, tasks and runs");
    expect(handle.app.ui.palette()).toBe(true);
    await press("<Esc>");
    expect(handle.app.ui.palette()).toBe(false);
  });

  test("pausing from the palette is instant, like its key", async () => {
    const { press, calls } = await start();
    await press(":", ..."pause".split(""), "<CR>", ..."release".split(""), "<CR>");
    await settle();
    expect(calls.map((c) => c.args)).toEqual([["pause", "release-notes"]]);
  });

  test("a task opens its detail; a run opens the run", async () => {
    const { screen, press, handle } = await start();
    await press(":", ..."release-notes".split(""), "<CR>");
    expect(handle.app.ui.route()).toEqual({ view: "task", params: { id: "release-notes" } });
    await press("<Esc>");
    await press(":", ..."review-pr-123/2026".split(""), "<CR>");
    expect(handle.app.ui.route()).toEqual({ view: "run", params: { ref: "review-pr-123/20261117T083000Z" } });
    expect(await screen()).toContain("review-pr-123/20261117T083000Z");
  });

  test("in a detail it offers that view's actions, and the run it is open on comes first", async () => {
    const { screen, press } = await start();
    await press("<CR>"); // the blocked run
    await press(":");
    const text = await screen();
    expect(text).toContain("Close the run's session");
    expect(text).toContain("Close the view (back to where you were)");
    await press(..."attach".split(""), "<CR>");
    expect(paletteRows(await screen())[0]).toStartWith("review-pr-123/20261117T083000Z");
  });

  test("a click outside it closes it, and does not reach the view behind", async () => {
    const { screen, press, setup, handle } = await start();
    await press(":");
    const tabs = (await screen()).split("\n")[1]!;
    await setup.mockMouse.click(tabs.indexOf("3 Runs"), 1);
    await setup.renderOnce();
    expect(handle.app.ui.palette()).toBe(false);
    expect(handle.app.ui.tab()).toBe("overview");
  });

  test("a click on a row chooses it", async () => {
    const { screen, press, setup, handle } = await start();
    await press(":", ..."system".split(""));
    const lines = (await screen()).split("\n");
    const y = lines.findIndex((l) => l.includes("Go to the System tab"));
    await setup.mockMouse.click(lines[y]!.indexOf("Go to"), y);
    await setup.renderOnce();
    expect(handle.app.ui.tab()).toBe("system");
  });
});
