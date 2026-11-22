import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { commands } from "../src/commands/index.ts";
import { createContext } from "../src/context.ts";
import { archiveTask, readTask, writeRun } from "../src/store.ts";
import { DEFAULT_FILTER, LOAD_AHEAD, loadRuns, needsMore, nextSince, nextStatus, PAGE_SIZE, type RunCache, type RunsFilter } from "../src/ui/views/runs/model.ts";
import { FIXTURE_NOW, FIXTURE_TZ, scheduledRun, writeFixture } from "./fixtures/views.ts";
import { makeTempHome, type TempHome } from "./helpers.ts";
import { selectedRow, settle, type Started, startApp } from "./ui-harness.ts";

// The Runs tab: the history read a page at a time with its filters (model),
// and the tab itself on the test renderer (keys, paging, actions, mouse).

const NOW = new Date(FIXTURE_NOW);
const sink = { write: () => {} };

let home: TempHome;
let app: Started | null = null;
beforeEach(() => {
  home = makeTempHome();
  home.writeConfig({ timezone: FIXTURE_TZ });
});
afterEach(() => {
  app?.stop();
  app = null;
  home.cleanup();
});

const ctx = () => createContext({ now: NOW, json: false, env: home.env, cwd: home.root, stdout: sink, stderr: sink, commands });
const filter = (f: Partial<RunsFilter>): RunsFilter => ({ ...DEFAULT_FILTER, ...f });

/** `count` hourly ok runs of `taskId`, the newest one hour before now. */
function writeHourly(taskId: string, count: number): void {
  for (let i = 1; i <= count; i++) writeRun(home.paths, scheduledRun(taskId, new Date(NOW.getTime() - i * 3_600_000).toISOString(), "succeeded", { summary: `run ${i}` }));
}

async function openRuns(opts: Parameters<typeof startApp>[2] = {}): Promise<Started> {
  app = await startApp(home, NOW, opts);
  app.handle.app.ui.setTab("runs");
  await app.screen();
  return app;
}

describe("history (model)", () => {
  test("newest slot first, archived tasks included, superseded and cancelled left out", () => {
    writeFixture(home.paths);
    archiveTask(home.paths, readTask(home.paths, "backup-notes"));
    const { runs, more } = loadRuns(ctx(), DEFAULT_FILTER, 1000);
    expect(more).toBe(false);
    expect(runs[0]!.ref).toBe("sentry-summary/20261117T090000Z");
    expect(runs.map((r) => Date.parse(r.slot))).toEqual(runs.map((r) => Date.parse(r.slot)).sort((a, b) => b - a));
    expect(runs.some((r) => r.task_id === "backup-notes")).toBe(true);
    expect(runs.some((r) => r.status === "superseded" || r.status === "cancelled")).toBe(false);
    // Attempts allowed come from the task (archived ones too): retries + 1.
    expect(runs.find((r) => r.task_id === "sentry-summary")!.max_attempts).toBe(2);
    expect(runs.find((r) => r.task_id === "backup-notes")!.max_attempts).toBe(1);
  });

  test("status and since filters, and the text filter over task id and summary", () => {
    writeFixture(home.paths);
    const statuses = (f: Partial<RunsFilter>) => [...new Set(loadRuns(ctx(), filter(f), 1000).runs.map((r) => r.status))].sort();
    expect(statuses({ status: "failures" })).toEqual(["failed"]);
    expect(statuses({ status: "blocked" })).toEqual(["blocked"]);
    expect(statuses({ status: "ok" })).toEqual(["succeeded"]);
    expect(statuses({ status: "missed" })).toEqual(["missed"]);
    const since24h = loadRuns(ctx(), filter({ since: "24h" }), 1000).runs;
    expect(since24h.every((r) => NOW.getTime() - Date.parse(r.slot) <= 86_400_000)).toBe(true);
    expect(since24h.length).toBeLessThan(loadRuns(ctx(), filter({ since: "30d" }), 1000).runs.length);
    expect(loadRuns(ctx(), filter({ text: "AUTH" }), 1000).runs.map((r) => r.ref)).toEqual(["sentry-summary/20261117T080000Z"]);
    expect(new Set(loadRuns(ctx(), filter({ text: "inbox" }), 1000).runs.map((r) => r.task_id))).toEqual(new Set(["inbox-triage"]));
  });

  test("a page at a time: `more` says there is another page", () => {
    writeHourly("hourly", 30);
    expect(loadRuns(ctx(), DEFAULT_FILTER, 10)).toMatchObject({ more: true });
    expect(loadRuns(ctx(), DEFAULT_FILTER, 10).runs.map((r) => r.summary)).toEqual(Array.from({ length: 10 }, (_, i) => `run ${i + 1}`));
    expect(loadRuns(ctx(), DEFAULT_FILTER, 30)).toMatchObject({ more: false });
    const page = loadRuns(ctx(), DEFAULT_FILTER, 10);
    expect(needsMore(Math.max(0, 10 - LOAD_AHEAD), page)).toBe(true);
    expect(needsMore(-1, page)).toBe(false);
    expect(needsMore(29, loadRuns(ctx(), DEFAULT_FILTER, 30))).toBe(false);
  });

  test("a run file is read again only when it changes", () => {
    writeHourly("hourly", 3);
    const cache: RunCache = new Map();
    const first = loadRuns(ctx(), DEFAULT_FILTER, 10, cache).runs;
    expect(cache.size).toBe(3);
    const cached = [...cache.values()].map((c) => c.run);
    loadRuns(ctx(), DEFAULT_FILTER, 10, cache);
    expect([...cache.values()].map((c) => c.run)).toEqual(cached);
    expect([...cache.values()].every((c, i) => c.run === cached[i])).toBe(true);
    writeRun(home.paths, scheduledRun("hourly", first[0]!.slot, "failed", { summary: "changed its mind" }));
    expect(loadRuns(ctx(), DEFAULT_FILTER, 10, cache).runs[0]!.summary).toBe("changed its mind");
  });

  test("the filter chips cycle in order", () => {
    expect([1, 2, 3, 4, 5].reduce((acc) => [...acc, nextStatus(acc.at(-1)!)], ["all" as ReturnType<typeof nextStatus>])).toEqual(["all", "failures", "blocked", "ok", "missed", "all"]);
    expect(nextSince("all")).toBe("24h");
    expect(nextSince("24h")).toBe("7d");
    expect(nextSince("7d")).toBe("30d");
    expect(nextSince("30d")).toBe("all");
  });
});

describe("Runs tab", () => {
  test("columns, chips and the preview (160 columns)", async () => {
    writeFixture(home.paths);
    const { screen } = await openRuns();
    const text = await screen();
    expect(text).toMatchSnapshot();
    expect(selectedRow(text)).toStartWith("◐ 10:00 sentry-summary local 1m 1/2");
    expect(text).toContain("✕  09:00         sentry-summary      local  3m   2/2  sentry-cli has no auth");
  });

  test("f and S cycle the filters; the preview shows a failure's log", async () => {
    writeFixture(home.paths);
    const { screen, press } = await openRuns();
    await press("f");
    let text = await screen();
    expect(text).toContain("status  failures");
    expect(selectedRow(text)).toStartWith("✕ 09:00 sentry-summary");
    expect(text).toContain("✕ failed · sentry-summary");
    expect(text).toContain("error: Auth token is required for this request.");
    await press("f", "f", "f", "f"); // blocked, ok, missed, all
    expect(await screen()).toContain("status  all");
    await press("S");
    text = await screen();
    expect(text).toContain("since  24h");
    expect(text).not.toContain("Mon 09:00");
    await press("f", "f", "f", "f"); // missed, since 24h
    expect(await screen()).toContain("runner_offline");
  });

  test("below 120 columns the preview hides", async () => {
    writeFixture(home.paths);
    const { screen } = await openRuns({ width: 100, height: 20 });
    expect(await screen()).not.toContain("│ ◐ running");
  });

  test("the next page is read as the cursor nears the end", async () => {
    writeHourly("hourly", PAGE_SIZE + 30);
    const { screen, press } = await openRuns({ height: 30 });
    expect(await screen()).toContain(`${PAGE_SIZE} loaded, more as you scroll`);
    await press("G");
    await settle();
    const text = await screen();
    expect(text).not.toContain("more as you scroll");
    expect(selectedRow(text)).toMatch(new RegExp(`run ${PAGE_SIZE}$`)); // still in view after the page grew
    await press("G");
    expect(selectedRow(await screen())).toMatch(new RegExp(`run ${PAGE_SIZE + 30}$`));
  });

  test("the wheel reads the next page too, once it shows the last rows", async () => {
    writeHourly("hourly", PAGE_SIZE + 30);
    const { screen, setup, handle } = await openRuns({ height: 30 });
    const first = handle.app.ui.selection("runs");
    for (let i = 0; i < 300 && (await screen()).includes("more as you scroll"); i++) await setup.mockMouse.scroll(10, 10, "down");
    expect(await screen()).not.toContain("more as you scroll");
    expect(handle.app.ui.selection("runs")).toBe(first); // the cursor did not move
  });

  test("a new filter starts at its first row", async () => {
    writeFixture(home.paths);
    const { screen, press } = await openRuns();
    await press("G", "S"); // at the bottom, then since 24h
    await settle();
    expect(selectedRow(await screen())).toStartWith("◐ 10:00 sentry-summary");
  });

  test("the selection stays on the same run across a reload", async () => {
    writeFixture(home.paths);
    const { screen, press, handle } = await openRuns();
    await press("j", "j");
    const before = selectedRow(await screen());
    writeRun(home.paths, scheduledRun("inbox-triage", "2026-11-17T09:58:00+01:00", "succeeded", { summary: "a new one", minutes: 1, delayMin: 0 }));
    handle.app.store.reload();
    const text = await screen();
    expect(text).toContain("a new one");
    expect(selectedRow(text)).toBe(before);
  });

  test("Enter opens the run, t its task, back returns to the same row and filters", async () => {
    writeFixture(home.paths);
    const { screen, press } = await openRuns();
    await press("f", "<CR>");
    expect(await screen()).toContain("Run sentry-summary/20261117T080000Z");
    await press("h");
    let text = await screen();
    expect(text).toContain("status  failures");
    expect(selectedRow(text)).toStartWith("✕ 09:00 sentry-summary");
    await press("j", "t");
    expect(await screen()).toContain("worktree-cleanup");
    expect(await screen()).toContain("is not in the new dashboard yet.");
    await press("h");
    text = await screen();
    expect(selectedRow(text)).toStartWith("✕ Fri 08:00 worktree-cleanup");
  });

  test("r retries a failure (after confirming), refuses other runs; a attaches to a blocked one", async () => {
    writeFixture(home.paths);
    const { screen, press, calls } = await openRuns();
    await press("r");
    expect(await screen()).toContain("only failed, timed-out or missed runs can be retried");
    await press("<Esc>", "j", "a");
    await settle();
    expect(calls).toEqual([{ args: ["attach", "review-pr-123/20261117T083000Z"], interactive: true }]);
    await press("j", "r");
    expect(await screen()).toContain("Retry sentry-summary/20261117T080000Z?");
    await press("y");
    await settle();
    expect(calls.at(-1)).toEqual({ args: ["retry", "sentry-summary/20261117T080000Z"], interactive: false });
  });

  test("y copies the ref (or says the terminal can't)", async () => {
    writeFixture(home.paths);
    const { screen, press, setup } = await openRuns();
    const copied: string[] = [];
    setup.renderer.copyToClipboardOSC52 = (text: string) => (copied.push(text), true);
    await press("y");
    expect(copied).toEqual(["sentry-summary/20261117T090000Z"]);
    expect(await screen()).toContain("copied sentry-summary/20261117T090000Z");
  });

  test("mouse: a click selects, a double click opens", async () => {
    writeFixture(home.paths);
    const { screen, setup } = await openRuns();
    const y = (await screen()).split("\n").findIndex((l) => l.includes("git worktree prune failed"));
    await setup.mockMouse.click(10, y);
    expect(selectedRow(await screen())).toContain("worktree-cleanup");
    await setup.mockMouse.doubleClick(10, y);
    expect(await screen()).toContain("Run worktree-cleanup/20261113T070000Z");
  });
});
