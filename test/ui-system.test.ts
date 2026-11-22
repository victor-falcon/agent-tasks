import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check } from "../src/checks.ts";
import { commands } from "../src/commands/index.ts";
import { createContext } from "../src/context.ts";
import { runnerLogPath } from "../src/runner-lock.ts";
import type { CommandRunner } from "../src/tui/app.ts";
import { systemChecks } from "../src/ui/views/system/checks.ts";
import {
  filterEvents,
  highlight,
  machineRows,
  matchingKeys,
  nextEventFilter,
  parseChecksOutput,
  parseEvents,
  readRunnerInfo,
  runnerLines,
  stepMatch,
  systemBadge,
} from "../src/ui/views/system/model.ts";
import { FIXTURE_NOW, FIXTURE_TZ, writeFixture } from "./fixtures/views.ts";
import { makeTempHome, type TempHome } from "./helpers.ts";
import { settle, type Started, startApp } from "./ui-harness.ts";

// The System tab: the runner's facts, runner.log as events (level filter,
// search, follow), doctor and machine checks parsed from the CLI's --json,
// the badge (model), and the tab on the test renderer (panes, keys, mouse,
// background checks through the fake command runner).

const NOW = new Date(FIXTURE_NOW);
const sink = { write: () => {} };

const SENTRY_REF = "sentry-summary/20261117T080000Z";
const REVIEW_REF = "review-pr-123/20261117T083000Z";

/** runner.log as the runner writes it (times in the display zone). */
const LOG = [
  "08:30:00  agent-tasks runner · every 5m · launcher: herdr (claude) · data: ~/data",
  "08:30:00  tick  0 due · 0 running",
  `09:00:02  ▶ ${SENTRY_REF.padEnd(36)} launched in t-1`,
  `09:03:10  ✕ ${SENTRY_REF.padEnd(36)} failed (exit 1) in 3m · sentry-cli has no auth · agent-tasks log ${SENTRY_REF}`,
  "09:40:00  ⚠ the launcher took 40s to answer",
  `09:50:00  ! ${REVIEW_REF.padEnd(36)} blocked · agent-tasks attach ${REVIEW_REF}`,
  "09:55:00  tick  1 due · 2 running",
];

const check = (status: Check["status"], message: string, extra: Partial<Check> = {}): Check => ({ id: "x", status, message, ...extra });
const machineCheck = (name: string, status: Check["status"], message = "reachable, agent-tasks 0.1.0, launcher herdr"): Check => ({
  id: "machines.reachable",
  status,
  message: `machine ${name} (ssh ${name}-ssh)${status === "warn" ? " is unreachable" : `: ${message}`}`,
  ...(status === "ok" ? {} : { hint: `check ssh ${name}-ssh` }),
});
const DOCTOR: Check[] = [check("ok", "bun is on PATH"), check("warn", "no heartbeat yet", { hint: "start agent-tasks runner" }), check("error", "the launcher command hc is not on PATH", { hint: "install Herdr" })];
const json = (checks: Check[]) => JSON.stringify({ schema: 1, ok: !checks.some((c) => c.status === "error"), checks });

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

function writeLog(lines: readonly string[] = LOG): void {
  mkdirSync(home.paths.stateDir, { recursive: true });
  writeFileSync(runnerLogPath(home.paths), `${lines.join("\n")}\n`);
}

/** A fake CLI: doctor and machines check answer with `checks`, the rest says what it did. */
function fakeCli(answers: { doctor?: Check[]; machines?: Check[] } = {}): CommandRunner {
  return async (args) => {
    if (args[0] === "doctor") return { code: answers.doctor?.some((c) => c.status === "error") ? 1 : 0, output: json(answers.doctor ?? []) };
    if (args[0] === "machines") return { code: 0, output: json(answers.machines ?? []) };
    return { code: 0, output: `did ${args.join(" ")}\n` };
  };
}

async function openSystem(opts: Parameters<typeof startApp>[2] = {}): Promise<Started> {
  app = await startApp(home, NOW, { exec: fakeCli({ doctor: DOCTOR }), ...opts });
  app.handle.app.ui.setTab("system");
  await app.screen();
  await settle();
  return app;
}

/** The selected event line (inverse, so the only one without its colors split); here, the line with `text`. */
const lineWith = (screen: string, text: string) => screen.split("\n").find((l) => l.includes(text)) ?? "";

describe("runner (model)", () => {
  test("no lock: not running, the interval from the config, the last tick from the heartbeat", () => {
    writeFixture(home.paths);
    const info = readRunnerInfo(ctx());
    expect(info).toMatchObject({ alive: false, pid: null, every: "5m", staleLockPid: null, launcher: expect.stringContaining("(") });
    expect(info.lastTick?.toISOString()).toBe("2026-11-17T09:00:00.000Z");
    const text = runnerLines(info, FIXTURE_TZ, NOW).map((l) => l.map((s) => s.text).join(""));
    expect(text[0]).toBe("✕ not running");
    expect(text.join("\n")).toContain("last tick 10:00 (2m ago) · system");
  });

  test("a live lock: pid, terminal, since, next tick; a dead pid is a stale lock", () => {
    mkdirSync(home.paths.stateDir, { recursive: true });
    const lock = { pid: process.pid, terminal: "t-42", started_at: "2026-11-17T08:30:00+01:00", every: "2m", next_tick_at: "2026-11-17T10:04:00+01:00" };
    writeFileSync(join(home.paths.stateDir, "runner.lock"), JSON.stringify(lock));
    const info = readRunnerInfo(ctx());
    expect(info).toMatchObject({ alive: true, pid: process.pid, terminal: "t-42", every: "2m" });
    const text = runnerLines(info, FIXTURE_TZ, NOW).map((l) => l.map((s) => s.text).join("")).join("\n");
    expect(text).toContain(`● running · pid ${process.pid}`);
    expect(text).toContain("terminal t-42");
    expect(text).toContain("next tick 10:04 (in 2m)");
    writeFileSync(join(home.paths.stateDir, "runner.lock"), JSON.stringify({ ...lock, pid: 2 ** 22 + 1 }));
    expect(readRunnerInfo(ctx())).toMatchObject({ alive: false, staleLockPid: 2 ** 22 + 1, every: "5m" });
  });
});

describe("events (model)", () => {
  test("ticks left out, run refs found, a stop then a start is one restart", () => {
    const rows = parseEvents([...LOG, "10:00:00  ● stopped · last tick 09:55", "10:00:05  agent-tasks runner · every 5m · launcher: herdr (claude)"]);
    expect(rows.map((r) => r.mark)).toEqual(["●", "▶", "✕", "⚠", "!", "●"]);
    expect(rows[2]).toMatchObject({ task: "sentry-summary", ref: SENTRY_REF, what: "failed (exit 1) in 3m", note: "sentry-cli has no auth" });
    expect(rows[3]!.ref).toBeNull();
    expect(rows.at(-1)!.what).toStartWith("runner restarted");
  });

  test("repeated lines keep distinct keys", () => {
    const rows = parseEvents(["09:00:00  ⚠ same", "09:00:00  ⚠ same"]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });

  test("level filter: all · warnings and errors · runs", () => {
    const rows = parseEvents(LOG);
    expect(nextEventFilter("all")).toBe("problems");
    expect(nextEventFilter("runs")).toBe("all");
    expect(filterEvents(rows, "problems").map((r) => r.mark)).toEqual(["✕", "⚠", "!"]);
    expect(filterEvents(rows, "runs").map((r) => r.task)).toEqual(["sentry-summary", "sentry-summary", "review-pr-123"]);
  });

  test("search: matches case ignored, n/N wrap around, highlight splits segments", () => {
    const rows = parseEvents(LOG);
    const matches = matchingKeys(rows, "SENTRY");
    expect(matches).toEqual([rows[1]!.key, rows[2]!.key]);
    expect(stepMatch(rows, matches, null, 1)).toBe(rows[1]!.key);
    expect(stepMatch(rows, matches, rows[2]!.key, 1)).toBe(rows[1]!.key);
    expect(stepMatch(rows, matches, rows[1]!.key, -1)).toBe(rows[2]!.key);
    expect(stepMatch(rows, [], null, 1)).toBeNull();
    expect(highlight([{ text: "a sentry b" }], "Sentry")).toEqual([{ text: "a ", color: undefined }, { text: "sentry", color: "yellow" }, { text: " b", color: undefined }]);
  });
});

describe("checks and machines (model)", () => {
  test("doctor's JSON, a JSON error, or the first line of whatever came out", () => {
    expect(parseChecksOutput(json(DOCTOR))).toEqual({ checks: DOCTOR });
    expect(parseChecksOutput(JSON.stringify({ error: { code: "hub_only", message: "the machine registry is on the hub" } }))).toEqual({ error: "the machine registry is on the hub" });
    expect(parseChecksOutput("\nagent-tasks: boom\n")).toEqual({ error: "agent-tasks: boom" });
  });

  test("each machine takes its newest check, from doctor or machines check", () => {
    const config = { machines: { mac: { ssh: "mac-ssh" }, pi: { ssh: "pi-ssh" } } };
    const older = { checks: [machineCheck("mac", "warn"), machineCheck("pi", "ok")], at: new Date(NOW.getTime() - 60_000) };
    const newer = { checks: [machineCheck("mac", "ok")], at: NOW };
    const rows = machineRows(config, [newer, older]);
    expect(rows.map((r) => [r.name, r.check?.status, r.at?.getTime()])).toEqual([
      ["mac", "ok", NOW.getTime()],
      ["pi", "ok", older.at.getTime()],
    ]);
    expect(machineRows(config, [null, null]).every((r) => r.check === null)).toBe(true);
  });

  test("the badge: a failing check (not a warning), a failing machine by its newest check, or problems", () => {
    const config = { machines: { mac: { ssh: "mac-ssh" } } };
    const doctor = (checks: Check[]) => ({ checks, at: new Date(NOW.getTime() - 60_000) });
    expect(systemBadge(null, [], 0)).toBeNull();
    expect(systemBadge(doctor([check("warn", "w")]), [], 0)).toBeNull();
    expect(systemBadge(doctor([check("error", "e")]), [], 0)).toBe("!");
    expect(systemBadge(null, [], 2)).toBe("!");
    const failing = doctor([machineCheck("mac", "error", "its launcher is not ready")]);
    expect(systemBadge(failing, machineRows(config, [failing]), 0)).toBe("!");
    const fixed = { checks: [machineCheck("mac", "ok")], at: NOW };
    expect(systemBadge(failing, machineRows(config, [failing, fixed]), 0)).toBeNull();
  });
});

describe("the tab", () => {
  test("panes in two columns; doctor runs once in the background on the first open; the badge shows its error", async () => {
    writeFixture(home.paths);
    writeLog();
    const { screen, calls, press } = await openSystem();
    const text = await screen();
    expect(text).toContain("╭─ Runner");
    expect(text).toContain("✕ not running");
    expect(text).toContain("╭─ Events · 5");
    expect(text).toContain("╭─ Checks");
    expect(text).toContain("1 error, 1 warning");
    expect(text).toContain("fix: install Herdr");
    expect(text).not.toContain("Machines");
    // Runner and Checks side by side.
    expect(lineWith(text, "╭─ Runner")).toContain("╭─ Checks");
    expect(text.split("\n")[1]).toContain("4 System !");
    expect(calls.filter((c) => c.args[0] === "doctor")).toEqual([{ args: ["doctor", "--json"], interactive: false }]);
    // Leaving and coming back does not run it again; `c` does.
    await press("1", "4");
    await Bun.sleep(450);
    await settle();
    expect(calls.filter((c) => c.args[0] === "doctor").length).toBe(1);
    await press("c");
    await settle();
    expect(calls.filter((c) => c.args[0] === "doctor").length).toBe(2);
  });

  test("stacked under 120 columns", async () => {
    writeFixture(home.paths);
    writeLog();
    const { screen } = await openSystem({ width: 100, height: 50 });
    const text = await screen();
    expect(lineWith(text, "╭─ Runner")).not.toContain("Checks");
    expect(text.indexOf("╭─ Events")).toBeLessThan(text.indexOf("╭─ Checks"));
  });

  test("follow is on: the cursor is on the last event; k stops following, F follows again; Enter opens the run a line names", async () => {
    writeFixture(home.paths);
    writeLog();
    const s = await openSystem();
    expect(await s.screen()).toContain("● following");
    expect(s.handle.app.ui.selection("system")).toContain(REVIEW_REF);
    await s.press("k");
    expect(await s.screen()).toContain("○ not following");
    expect(s.handle.app.ui.selection("system")).toContain("⚠ the launcher");
    await s.press("<CR>");
    expect(await s.screen()).toContain("this line names no run");
    await s.press("k", "<CR>");
    expect(s.handle.app.ui.route()).toEqual({ view: "run", params: { ref: SENTRY_REF } });
    await s.press("<Esc>");
    await s.press("F");
    expect(await s.screen()).toContain("● following");
    expect(s.handle.app.ui.selection("system")).toContain(REVIEW_REF);
  });

  test("a new line arrives while following: the cursor moves to it", async () => {
    writeFixture(home.paths);
    writeLog();
    const s = await openSystem();
    writeLog([...LOG, `10:01:00  ■ ${SENTRY_REF.padEnd(36)} succeeded in 1m`]);
    s.handle.app.store.reload();
    await s.screen();
    expect(s.handle.app.ui.selection("system")).toContain("succeeded in 1m");
  });

  test("f cycles the level; / searches (typed keys go to the search), ⏎ keeps it and jumps, n/N move, Esc clears", async () => {
    writeFixture(home.paths);
    writeLog();
    const s = await openSystem();
    await s.press("f");
    let text = await s.screen();
    expect(text).toContain("level: warnings and errors");
    expect(text).toContain("Events · 3 of 5");
    await s.press("f", "f");
    await s.press("/", "s", "e", "n", "t", "r", "y");
    text = await s.screen();
    expect(text).toContain("/sentry▏");
    // The typed `f` and `n` did not reach the keymap.
    expect(text).toContain("level: all");
    await s.press("<CR>");
    text = await s.screen();
    expect(text).toContain("/sentry  2 matches · n/N");
    expect(s.handle.app.ui.selection("system")).toContain("launched in t-1");
    await s.press("n");
    expect(s.handle.app.ui.selection("system")).toContain("failed (exit 1)");
    await s.press("n");
    expect(s.handle.app.ui.selection("system")).toContain("launched in t-1");
    await s.press("N");
    expect(s.handle.app.ui.selection("system")).toContain("failed (exit 1)");
    await s.press("/", "<Esc>");
    expect(await s.screen()).not.toContain("/sentry");
  });

  test("T asks before ticking, then runs agent-tasks tick in the background", async () => {
    writeFixture(home.paths);
    const s = await openSystem();
    await s.press("T");
    expect(await s.screen()).toContain("It may launch the runs that are due.");
    await s.press("n");
    expect(s.calls.some((c) => c.args[0] === "tick")).toBe(false);
    await s.press("T", "y");
    await settle();
    expect(s.calls.filter((c) => c.args[0] === "tick")).toEqual([{ args: ["tick"], interactive: false }]);
    expect(await s.screen()).toContain("did tick");
  });

  test("on a hub with machines: the Machines pane fills from doctor; c there runs machines check", async () => {
    writeFixture(home.paths);
    home.writeConfig({ timezone: FIXTURE_TZ, machines: { mac: { ssh: "mac-ssh" }, pi: { ssh: "pi-ssh" } } });
    const s = await openSystem({ exec: fakeCli({ doctor: [check("ok", "bun"), machineCheck("mac", "warn")], machines: [machineCheck("mac", "ok"), machineCheck("pi", "ok")] }) });
    let text = await s.screen();
    expect(text).toContain("╭─ Machines · 2");
    expect(text).toContain("unreachable");
    expect(text).toContain("not checked yet");
    expect(text.split("\n")[1]).not.toContain("System !");
    // Tab from the events (focused first) goes to Machines; Shift-Tab back would go to the events.
    await s.press("<Tab>");
    await s.press("c");
    await settle();
    expect(s.calls.filter((c) => c.args[0] === "machines")).toEqual([{ args: ["machines", "check", "--json"], interactive: false }]);
    text = await s.screen();
    expect(text).toContain("reachable · launcher ready");
    expect(lineWith(text, "mac  ssh mac-ssh")).toContain("✓ mac");
    expect(s.calls.filter((c) => c.args[0] === "doctor").length).toBe(1);
  });

  test("Problems: unreadable files the data layer reports, with the badge", async () => {
    writeFixture(home.paths);
    mkdirSync(home.paths.tasksDir, { recursive: true });
    writeFileSync(join(home.paths.tasksDir, "broken.json"), "{ not json");
    const s = await openSystem({ exec: fakeCli({ doctor: [check("ok", "bun")] }) });
    const text = await s.screen();
    expect(text).toContain("╭─ Problems · 1");
    expect(text).toContain("broken.json");
    expect(text.split("\n")[1]).toContain("System !");
  });

  test("mouse: a click focuses a pane, a click on an event selects it, a double click opens its run", async () => {
    writeFixture(home.paths);
    writeLog();
    const s = await openSystem();
    let text = await s.screen();
    const rowOf = (needle: string) => text.split("\n").findIndex((l) => l.includes(needle));
    const y = rowOf("failed (exit 1)");
    await s.setup.mockMouse.click(20, y);
    await s.screen();
    expect(s.handle.app.ui.selection("system")).toContain("failed (exit 1)");
    expect(await s.screen()).toContain("○ not following");
    await s.setup.mockMouse.doubleClick(20, y);
    expect(s.handle.app.ui.route()).toEqual({ view: "run", params: { ref: SENTRY_REF } });
    await s.press("<Esc>");
    text = await s.screen();
    // A click in Checks focuses it: j then scrolls it rather than moving the cursor.
    const checksX = lineWith(text, "╭─ Checks").indexOf("╭─ Checks") + 4;
    await s.setup.mockMouse.click(checksX, rowOf("╭─ Checks") + 2);
    const before = s.handle.app.ui.selection("system");
    await s.press("j");
    expect(s.handle.app.ui.selection("system")).toBe(before);
  });

  test("the doctor's state is kept per dashboard: the badge reads it from any tab", async () => {
    writeFixture(home.paths);
    const s = await openSystem();
    s.handle.app.ui.setTab("overview");
    await s.screen();
    expect(systemChecks(s.handle.app).doctor.result()?.checks).toEqual(DOCTOR);
    expect((await s.screen()).split("\n")[1]).toContain("System !");
  });
});
