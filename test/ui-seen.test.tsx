import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeRun } from "../src/store.ts";
import { type HeaderInput, headerSegments } from "../src/ui/components/header.tsx";
import { createSeen } from "../src/ui/seen.ts";
import { buildDashboard } from "../src/tui/snapshot.ts";
import { commands } from "../src/commands/index.ts";
import { createContext } from "../src/context.ts";
import { PAGE_SIZE } from "../src/ui/views/runs/model.ts";
import { FIXTURE_NOW, FIXTURE_TZ, scheduledRun, writeFixture } from "./fixtures/views.ts";
import { makeTempHome, type TempHome } from "./helpers.ts";
import { selectedRow, settle, type Started, startApp } from "./ui-harness.ts";

// T6b: the attention "seen" state kept in state/tui.json, the `/` filter of
// the Runs tab, and the header at narrow widths.

const NOW = new Date(FIXTURE_NOW);
const HOUR = 3_600_000;
const FAILED = "sentry-summary/20261117T080000Z";
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

const stateFile = () => join(home.paths.stateDir, "tui.json");
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
/** The Needs attention section's lines (up to the next section's title). */
function attention(screen: string): string {
  const lines = screen.split("\n");
  const start = lines.findIndex((l) => l.includes("Needs attention"));
  if (start === -1) return "";
  const end = lines.findIndex((l, i) => i > start && /Running/.test(l));
  return lines.slice(start, end).join("\n");
}

describe("seen state (state/tui.json)", () => {
  test("a missing file is an empty one; marks are written and read back by a new dashboard", () => {
    const seen = createSeen({ file: stateFile(), now: () => NOW });
    expect(seen.isSeen("a/1", at(HOUR))).toBe(false);
    seen.markSeen("a/1", at(HOUR));
    expect(seen.isSeen("a/1", at(HOUR))).toBe(true);
    expect(JSON.parse(readFileSync(stateFile(), "utf8"))).toEqual({ version: 1, seen: { "a/1": at(HOUR) } });
    expect(createSeen({ file: stateFile(), now: () => NOW }).isSeen("a/1", at(HOUR))).toBe(true);
    // Written through a temp file renamed into place: nothing left behind.
    expect(readdirSync(home.paths.stateDir)).toEqual(["tui.json"]);
  });

  test("a run that changed after it was seen (retried, failed again) is not seen", () => {
    const seen = createSeen({ file: stateFile(), now: () => NOW });
    seen.markSeen("a/1", at(2 * HOUR));
    expect(seen.isSeen("a/1", at(HOUR))).toBe(false);
  });

  test("a broken file is an empty one, and is replaced on the next mark", () => {
    mkdirSync(home.paths.stateDir, { recursive: true });
    for (const junk of ["{not json", "null", '{"seen": [1, 2]}', '{"seen": {"a/1": 3, "b/1": "never"}}']) {
      writeFileSync(stateFile(), junk);
      const seen = createSeen({ file: stateFile(), now: () => NOW });
      expect(seen.isSeen("a/1", at(HOUR))).toBe(false);
      seen.markSeen("c/1", at(HOUR));
      expect(Object.keys(JSON.parse(readFileSync(stateFile(), "utf8")).seen)).toEqual(["c/1"]);
    }
  });

  test("marks of runs older than the 24-hour window are pruned on write", () => {
    const seen = createSeen({ file: stateFile(), now: () => NOW });
    seen.markSeen("old/1", at(25 * HOUR));
    seen.markSeen("new/1", at(HOUR));
    expect(Object.keys(JSON.parse(readFileSync(stateFile(), "utf8")).seen)).toEqual(["new/1"]);
  });

  test("two dashboards share the file: each write merges, each reader sees the other's marks", () => {
    const one = createSeen({ file: stateFile(), now: () => NOW });
    const two = createSeen({ file: stateFile(), now: () => NOW });
    expect(two.isSeen("a/1", at(HOUR))).toBe(false); // read before the other writes
    one.markSeen("a/1", at(HOUR));
    two.markSeen("b/1", at(HOUR));
    expect(Object.keys(JSON.parse(readFileSync(stateFile(), "utf8")).seen).sort()).toEqual(["a/1", "b/1"]);
    expect(one.isSeen("b/1", at(HOUR))).toBe(true);
    expect(two.isSeen("a/1", at(HOUR))).toBe(true);
  });

  test("an unwritable folder keeps the marks in memory", () => {
    writeFileSync(join(home.dataDir, "state"), "a file where the folder should be");
    const seen = createSeen({ file: stateFile(), now: () => NOW });
    seen.markSeen("a/1", at(HOUR));
    expect(seen.isSeen("a/1", at(HOUR))).toBe(true);
  });
});

describe("Needs attention in the Overview", () => {
  test("x dismisses a failure: it leaves the list, the cursor stays in place, and it stays gone after a restart", async () => {
    writeFixture(home.paths);
    app = await startApp(home, NOW);
    expect(attention(await app.screen())).toContain("no auth");
    await app.press("j"); // the blocked run first, then the failure
    expect(selectedRow(await app.screen())).toContain("no auth");
    await app.press("x");
    const text = await app.screen();
    expect(attention(text)).not.toContain("no auth");
    expect(selectedRow(text)).toContain("inbox-triage"); // the row below took its place
    expect(JSON.parse(readFileSync(stateFile(), "utf8")).seen).toHaveProperty([FAILED]);
    app.stop();
    app = await startApp(home, NOW);
    expect(attention(await app.screen())).not.toContain("no auth");
  });

  test("x on a blocked run keeps it (and says why); outside Needs attention it does nothing", async () => {
    writeFixture(home.paths);
    app = await startApp(home, NOW);
    await app.press("x"); // the blocked run is first
    let text = await app.screen();
    expect(attention(text)).toContain("review-pr-123");
    expect(text).toContain("a blocked run stays here until it is answered");
    expect(existsSync(stateFile())).toBe(false);
    await app.press("<Tab>", "x");
    text = await app.screen();
    expect(text).toContain("only runs of Needs attention can be dismissed");
    expect(existsSync(stateFile())).toBe(false);
  });

  test("opening a failure (from anywhere) counts as seen; a retried run that fails again comes back", async () => {
    writeFixture(home.paths);
    app = await startApp(home, NOW);
    // Opened from the Runs tab, not from the attention list.
    app.handle.app.ui.setTab("runs");
    await app.screen();
    await app.press("f", "<CR>");
    expect(await app.screen()).toContain(`${FAILED}  ✕ failed`);
    await app.press("h", "1");
    expect(attention(await app.screen())).not.toContain("no auth");
    // It failed again after being seen: back in the list.
    writeRun(home.paths, scheduledRun("sentry-summary", "2026-11-17T09:00:00+01:00", "failed", { summary: "still no auth", attempts: 2, delayMin: 50 }));
    app.handle.app.store.reload();
    expect(attention(await app.screen())).toContain("still no auth");
  });

  test("a mark made in another dashboard shows here after a reload", async () => {
    writeFixture(home.paths);
    app = await startApp(home, NOW);
    expect(attention(await app.screen())).toContain("no auth");
    const dash = buildDashboard(createContext({ now: NOW, json: false, env: home.env, cwd: home.root, stdout: sink, stderr: sink, commands }));
    createSeen({ file: stateFile(), now: () => NOW }).markSeen(FAILED, dash.recent.find((r) => r.ref === FAILED)!.at);
    app.handle.app.store.reload();
    expect(attention(await app.screen())).not.toContain("no auth");
  });
});

describe("Runs: the / filter", () => {
  async function openRuns(opts: Parameters<typeof startApp>[2] = {}): Promise<Started> {
    app = await startApp(home, NOW, opts);
    app.handle.app.ui.setTab("runs");
    await app.screen();
    return app;
  }
  const rows = (screen: string) => screen.split("\n").filter((l) => /^[› ] [✓✕◐!○·⊘■□]/.test(l));

  test("typing filters over task id and summary or reason, with the status chip; Enter keeps it, Esc clears it", async () => {
    writeFixture(home.paths);
    const { screen, press } = await openRuns();
    await press("/", "s", "e", "n", "t", "r", "y");
    let text = await screen();
    expect(text).toContain("/ sentry");
    expect(rows(text).length).toBeGreaterThan(0);
    expect(rows(text).every((l) => l.includes("sentry-summary"))).toBe(true);
    await press(" ", "o", "f", "f", "l", "i", "n", "e"); // every word, in any field: the reason of the missed runs
    text = await screen();
    expect(rows(text).length).toBe(3);
    await press("<CR>");
    text = await screen();
    expect(text).toContain(" / sentry offline ");
    // The keys are back: f cycles the status on top of the text.
    await press("f");
    text = await screen();
    expect(text).toContain("no runs match these filters");
    await press("f", "f", "f"); // failures → blocked → ok → missed
    expect(rows(await screen()).length).toBe(3);
    await press("<Esc>");
    text = await screen();
    expect(text).not.toContain("/ sentry");
    expect(rows(text).some((l) => l.includes("inbox-triage"))).toBe(true);
  });

  test("the filter starts again at its first row, pages still load, and it survives opening a run", async () => {
    for (let i = 1; i <= PAGE_SIZE + 30; i++) writeRun(home.paths, scheduledRun("hourly", at(i * HOUR), "succeeded", { summary: `run ${i}` }));
    writeRun(home.paths, scheduledRun("other", at(30 * 60_000), "succeeded", { summary: "elsewhere" }));
    const { screen, press } = await openRuns({ height: 30 });
    await press("G", "/", "h", "o", "u", "r", "l", "y", "<CR>");
    await settle();
    let text = await screen();
    expect(selectedRow(text)).toMatch(/run 1$/);
    expect(text).toContain(`${PAGE_SIZE} loaded, more as you scroll`);
    await press("G");
    await settle();
    await press("G");
    text = await screen();
    expect(selectedRow(text)).toMatch(new RegExp(`run ${PAGE_SIZE + 30}$`));
    await press("<CR>", "h");
    text = await screen();
    expect(text).toContain(" / hourly ");
    expect(selectedRow(text)).toMatch(new RegExp(`run ${PAGE_SIZE + 30}$`));
  });
});

describe("header at narrow widths", () => {
  const input = (): HeaderInput => {
    writeFixture(home.paths);
    const ctx = createContext({ now: NOW, json: false, env: home.env, cwd: home.root, stdout: sink, stderr: sink, commands });
    return { title: "agent-tasks top", dash: buildDashboard(ctx), now: NOW, timezone: FIXTURE_TZ, machine: "wsl" };
  };
  const text = (segments: { text: string }[]) => segments.map((s) => s.text).join("");

  test("drops the machine, then the tick details, then the title; the dot and the counts stay", () => {
    const i = input();
    const at = (width: number) => {
      const { left, right } = headerSegments(i, width);
      return `${text(left)} | ${text(right)}`;
    };
    expect(at(120)).toBe("agent-tasks top · ● runner every 5m · ticked 10:00 · next 10:05 | today ■3 ✕1 □4 !1   hub: wsl");
    expect(at(90)).toBe("agent-tasks top · ● runner every 5m · ticked 10:00 · next 10:05 | today ■3 ✕1 □4 !1");
    expect(at(80)).toBe("agent-tasks top · ● runner every 5m · next 10:05 | today ■3 ✕1 □4 !1");
    expect(at(60)).toBe("agent-tasks top · ● runner every 5m | today ■3 ✕1 □4 !1");
    expect(at(50)).toBe("agent-tasks top · ● runner | today ■3 ✕1 □4 !1");
    expect(at(40)).toBe("● runner | today ■3 ✕1 □4 !1");
    expect(at(28)).toBe("● runner | ■3 ✕1 □4 !1");
    expect(at(20)).toBe("● | ■3 ✕1 □4 !1");
    expect(at(10)).toBe(" | ■3 ✕1 □4 !1");
  });

  for (const width of [60, 80, 120]) {
    test(`fits on one line at ${width} columns`, async () => {
      writeFixture(home.paths);
      app = await startApp(home, NOW, { width, height: 24 });
      const first = (await app.screen()).split("\n")[0]!;
      expect(Bun.stringWidth(first)).toBeLessThanOrEqual(width);
      expect(first).toContain("●");
      expect(first).toMatch(/■\d+ ✕\d+ □\d+ !\d+( {3}hub: \S+)?$/);
      expect(first).toMatchSnapshot();
    });
  }
});
