import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { lastTick } from "../src/runner-health.ts";
import { describeCron } from "../src/output/schedule-text.ts";
import { agendaTime, formatSpan, relativeTime, whenTime } from "../src/output/time.ts";
import { appendTick, writeRun } from "../src/store.ts";
import { FIXTURE_NOW, FIXTURE_TZ, scheduledRun, writeFixture, writeTicks } from "./fixtures/views.ts";
import { makeTask, makeTempHome, type TempHome } from "./helpers.ts";

// Snapshot tests of every read-only view, with a fixed clock (--now), a temp
// home and fixture tasks, runs and ticks (test/fixtures/views.ts).

const NOW = `--now=${FIXTURE_NOW}`;
const ESC = "\u001b[";

let home: TempHome;
beforeEach(() => {
  home = makeTempHome();
  home.writeConfig({ timezone: FIXTURE_TZ });
});
afterEach(() => home.cleanup());

interface Result {
  code: number;
  stdout: string;
  stderr: string;
  json<T = any>(): T;
}

/** Runs the CLI in-process. `tty` makes both writers look like a terminal. */
async function cli(args: string[], { tty = false, env = {} }: { tty?: boolean; env?: Record<string, string> } = {}): Promise<Result> {
  let stdout = "";
  let stderr = "";
  const code = await main([...args, NOW], {
    env: { ...home.env, ...env },
    cwd: home.root,
    stdout: { isTTY: tty, write: (t: string) => void (stdout += t) } as { write(t: string): void },
    stderr: { isTTY: tty, write: (t: string) => void (stderr += t) } as { write(t: string): void },
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

describe("formatting helpers", () => {
  const now = new Date(FIXTURE_NOW);
  test("relative times near now, absolute far away", () => {
    expect(relativeTime(new Date(now.getTime() - 4 * 60_000), now)).toBe("4m ago");
    expect(relativeTime(new Date(now.getTime() + 30_000), now)).toBe("now");
    expect(relativeTime(new Date(now.getTime() + 110 * 60_000), now)).toBe("in 2h");
    expect(relativeTime(new Date("2026-11-23T09:00:00+01:00"), now)).toBe("in 6d");
    expect(whenTime(new Date("2026-12-20T09:00:00+01:00"), FIXTURE_TZ, now)).toBe("Dec 20 09:00");
    expect(whenTime(new Date("2025-12-20T09:00:00+01:00"), FIXTURE_TZ, now)).toBe("Dec 20 2025 09:00");
  });

  test("agenda times: clock today, weekday this week, date later", () => {
    expect(agendaTime(new Date("2026-11-17T11:00:00+01:00"), FIXTURE_TZ, now)).toBe("11:00");
    expect(agendaTime(new Date("2026-11-18T08:00:00+01:00"), FIXTURE_TZ, now)).toBe("Wed 08:00");
    expect(agendaTime(new Date("2026-11-30T08:00:00+01:00"), FIXTURE_TZ, now)).toBe("Nov 30 08:00");
    // Always in the display zone, whatever the machine's.
    expect(agendaTime(new Date("2026-11-17T11:00:00Z"), "America/New_York", now)).toBe("06:00");
  });

  test("spans and cron in words", () => {
    expect([formatSpan(45_000), formatSpan(4 * 60_000), formatSpan(125 * 60_000), formatSpan(26 * 3_600_000)]).toEqual(["45s", "4m", "2h05m", "1d2h"]);
    expect(describeCron("0 * * * *")).toBe("every hour");
    expect(describeCron("0 23 * * *")).toBe("every day 23:00");
    expect(describeCron("0 9 * * 1")).toBe("Mon 09:00");
    expect(describeCron("30 9 * * 1-5")).toBe("weekdays 09:30");
    expect(describeCron("*/10 * * * *")).toBe("every 10 min");
    expect(describeCron("0 9 1-7 * 1")).toBeNull();
  });
});

describe("empty state", () => {
  test("status says the runner never ran and there are no tasks, and exits 1", async () => {
    const r = await cli(["status"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatchSnapshot("stderr");
    expect(r.stdout).toMatchSnapshot("stdout");
  });

  test("list and runs", async () => {
    expect((await cli(["list"])).stdout).toMatchSnapshot();
    expect((await cli(["runs"])).stdout).toBe("No runs.\n");
  });

  test("log of a task without runs, and of an unknown task", async () => {
    home.writeTask(makeTask());
    const r = await cli(["log", "weekly-report"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('task "weekly-report" has no runs yet');
    expect((await cli(["log", "nope"])).stderr).toContain('task "nope" not found');
    expect((await cli(["log", "nope/20261117T080000Z"])).code).toBe(1);
    expect((await cli(["log", "Bad Ref"])).code).toBe(2);
  });
});

describe("with every status", () => {
  beforeEach(() => writeFixture(home.paths));

  test("status", async () => {
    const r = await cli(["status"]);
    expect(r.code).toBe(1); // there is something under Attention
    expect(r.stderr).toBe(""); // the runner is alive: no banner
    expect(r.stdout).toMatchSnapshot();
  });

  test("list, list --all and filters", async () => {
    expect((await cli(["list"])).stdout).toMatchSnapshot("list");
    expect((await cli(["list", "--status", "paused"])).stdout).toMatchSnapshot("paused");
    const ids = async (...args: string[]) => (await cli(["list", "--json", ...args])).json().tasks.map((t: { id: string }) => t.id);
    expect(await ids("--cwd", "~/Projects/bar")).toEqual(["worktree-cleanup"]);
    // Result filters: failed is about the latest result, even while a retry runs.
    expect(await ids("--status", "failed")).toEqual(["sentry-summary"]);
    expect(await ids("--status", "running,blocked")).toEqual(["review-pr-123", "sentry-summary", "worktree-cleanup"]);
    expect(await ids("--status", "paused,failed")).toEqual([]);
    expect((await cli(["list", "--status", "bogus"])).code).toBe(2);
  });

  test("runs, of every task and of one", async () => {
    expect((await cli(["runs", "--limit", "8"])).stdout).toMatchSnapshot("all");
    expect((await cli(["runs", "sentry-summary", "--since", "12h"])).stdout).toMatchSnapshot("one task");
    const ok = (await cli(["runs", "sentry-summary", "--status", "ok", "--json"])).json().runs.map((r: { status: string }) => r.status);
    expect(new Set(ok)).toEqual(new Set(["succeeded"]));
  });

  test("show", async () => {
    home.writeConfig({
      timezone: FIXTURE_TZ,
      agent: "claude",
      launcher: { preset: "herdr", launch: "hc run …" },
      instructions: { subagent: ["general.md"] },
      profiles: [{ match: "~/Projects/**", agent: { command: "clc", shell: true }, instructions: ["foo.md", "missing.md"], timeout: "1h" }],
    });
    expect((await cli(["show", "sentry-summary"])).stdout).toMatchSnapshot();
  });

  test("show --instructions prints the task's and the personal ones, in order", async () => {
    mkdirSync(join(home.configDir, "instructions"), { recursive: true });
    writeFileSync(join(home.configDir, "instructions", "general.md"), "Write in English.\n");
    writeFileSync(join(home.configDir, "instructions", "foo.md"), "Use pnpm in foo.\n");
    home.writeConfig({
      timezone: FIXTURE_TZ,
      instructions: { subagent: ["general.md"] },
      profiles: [{ match: "~/Projects/**", instructions: ["foo.md", "missing.md"] }],
    });
    const r = await cli(["show", "sentry-summary", "--instructions"]);
    expect(r.stdout.replaceAll(home.root, "$HOME")).toMatchSnapshot(); // the working directory is absolute
    expect(r.stderr).toContain("warning: instructions file not found:");
    expect(r.stderr).toContain("missing.md");
    const j = (await cli(["show", "sentry-summary", "--instructions", "--json"])).json();
    expect(j.personal.map((p: { source: string; content: string | null }) => [p.source, p.content])).toEqual([
      ["config", "Write in English.\n"],
      ["profile ~/Projects/**", "Use pnpm in foo.\n"],
      ["profile ~/Projects/**", null],
    ]);
  });

  test("log: events, attempts and the captured log", async () => {
    expect((await cli(["log", "sentry-summary/20261117T080000Z"])).stdout).toMatchSnapshot("failed run");
    expect((await cli(["log", "sentry-summary/20261117T080000Z", "--attempt", "1"])).stdout).toMatchSnapshot("attempt 1");
    expect((await cli(["log", "sentry-summary/20261117T010000Z"])).stdout).toMatchSnapshot("missed run");
    // A task id shows its latest occurrence.
    expect((await cli(["log", "sentry-summary"])).stdout).toContain("sentry-summary/20261117T090000Z");
    expect((await cli(["log", "sentry-summary/20261117T080000Z", "--attempt", "3"])).code).toBe(1);
    // Both attempts write the default per-slot log, and the view says so.
    expect((await cli(["log", "sentry-summary/20261117T080000Z", "--attempt", "1"])).stdout).toContain("Log (shared by attempts 1, 2):");
  });

  test("log --raw prints only the log, or fails when there is none", async () => {
    const r = await cli(["log", "sentry-summary/20261117T080000Z", "--raw"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("$ sentry-cli issues list\nerror: Auth token is required for this request.\n");
    const none = await cli(["log", "review-pr-123", "--raw"]);
    expect(none.code).toBe(1);
    expect(none.stdout).toBe("");
  });

  test("read commands write nothing", async () => {
    const before = await Bun.$`find ${home.dataDir} -type f -exec shasum {} +`.text();
    for (const args of [["status"], ["list", "--all"], ["runs"], ["show", "sentry-summary"], ["log", "sentry-summary"]]) await cli(args);
    expect(await Bun.$`find ${home.dataDir} -type f -exec shasum {} +`.text()).toBe(before);
  });
});

describe("colors", () => {
  beforeEach(() => writeFixture(home.paths));

  test("off when stdout is not a terminal", async () => {
    for (const args of [["status"], ["list"], ["runs"], ["show", "sentry-summary"], ["log", "sentry-summary"]]) {
      expect((await cli(args)).stdout).not.toContain(ESC);
    }
  });

  test("on in a terminal", async () => {
    const r = await cli(["list"], { tty: true });
    expect(r.stdout).toContain(`${ESC}31m✕${ESC}39m`); // failed run in red
    expect(r.stdout).toContain(`${ESC}32m■${ESC}39m`); // ok run in green
    expect(Bun.stripANSI(r.stdout)).toBe((await cli(["list"])).stdout); // same text, same alignment
    expect((await cli(["status"], { tty: true })).stdout).toContain(ESC);
  });

  test("off with NO_COLOR, even in a terminal", async () => {
    for (const args of [["status"], ["list"], ["runs"], ["show", "sentry-summary"]]) {
      expect((await cli(args, { tty: true, env: { NO_COLOR: "1" } })).stdout).not.toContain(ESC);
    }
  });
});

describe("--json", () => {
  beforeEach(() => writeFixture(home.paths));

  test('every view has "schema": 1 and no banner', async () => {
    appendTick(home.paths, { at: "2026-11-16T00:00:00Z" }); // stale heartbeat: the banner would show
    home.writeConfig({ timezone: FIXTURE_TZ, runner: { every: "1m" } });
    for (const args of [["status"], ["list"], ["runs"], ["show", "sentry-summary"], ["show", "sentry-summary", "--instructions"], ["log", "sentry-summary"], ["version"]]) {
      const r = await cli([...args, "--json"]);
      expect(r.json().schema).toBe(1);
      expect(r.stderr).toBe("");
    }
    expect((await cli(["show", "nope", "--json"])).json()).toMatchObject({ schema: 1, error: { code: "not_found" } });
  });

  test("status shape", async () => {
    const r = await cli(["status", "--json"]);
    expect(r.code).toBe(1);
    const s = r.json();
    expect(Object.keys(s)).toEqual(["schema", "ok", "runner", "tasks", "last_24h", "now", "attention", "next", "errors"]);
    expect(s.runner).toEqual({ state: "healthy", every: "5m", last_tick: "2026-11-17T09:00:00.000Z", next_tick: "2026-11-17T10:05:00+01:00" });
    expect(s.last_24h).toEqual({
      ok: 3,
      failed: 1,
      missed: 4,
      offline_gaps: [{ from: "2026-11-17T01:10:00+01:00", to: "2026-11-17T08:30:00+01:00" }],
    });
    expect(s.now).toEqual({ running: 2, blocked: 1 });
    // sentry-summary's overnight misses are gone from Attention: it succeeded at 08:00.
    expect(s.attention.map((a: { kind: string; task_id: string }) => `${a.kind} ${a.task_id}`)).toEqual([
      "failed sentry-summary",
      "blocked review-pr-123",
      "missed inbox-triage",
    ]);
    expect(s.next[0]).toEqual({ task_id: "sentry-summary", machine: "local", at: "2026-11-17T11:00:00+01:00", schedule: "every hour" });
  });

  test("list rows carry the history and the indicator", async () => {
    const rows = (await cli(["list", "--json"])).json().tasks;
    const byId = Object.fromEntries(rows.map((r: { id: string }) => [r.id, r]));
    expect(byId["weekly-deps-report"]).toMatchObject({ indicator: "ok", history: ["succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "missed", "succeeded", "succeeded"] });
    expect(byId["review-pr-123"]).toMatchObject({ indicator: "blocked" });
    expect(byId["backup-notes"]).toMatchObject({ indicator: "paused" });
    expect(byId["release-notes"]).toMatchObject({ indicator: "once_pending" });
  });
});

describe("status exit code and the runner banner", () => {
  function healthyTask() {
    home.writeTask(makeTask({ id: "daily", schedule: { type: "cron", cron: "0 8 * * *", timezone: FIXTURE_TZ } }));
    writeRun(home.paths, scheduledRun("daily", "2026-11-17T08:00:00+01:00", "succeeded", { summary: "done" }));
  }

  test("0 when the runner is alive and nothing needs attention", async () => {
    healthyTask();
    writeTicks(home.paths, "2026-11-17T09:00:00+01:00", "2026-11-17T10:00:00+01:00");
    const r = await cli(["status"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatchSnapshot();
  });

  test("1 with a stopped runner, which the first line says, plus the banner on stderr", async () => {
    healthyTask();
    writeTicks(home.paths, "2026-11-17T07:00:00+01:00", "2026-11-17T09:50:00+01:00"); // 12 minutes ago, every 5m
    const r = await cli(["status"]);
    expect(r.code).toBe(1);
    expect(r.stdout.split("\n")[0]).toBe("Runner    ✕ not running · last tick 12m ago, expected every 5m · start it with: agent-tasks runner");
    expect(r.stderr).toBe("! runner is not running (last tick 12m ago, expected every 5m); scheduled tasks won't start. Start it with: agent-tasks runner\n");
  });

  test("healthy means a tick newer than 2 × runner.every", async () => {
    healthyTask();
    appendTick(home.paths, { at: "2026-11-17T09:53:00+01:00" }); // 9 minutes ago
    expect((await cli(["status"])).code).toBe(0); // every 5m: 9m < 10m
    home.writeConfig({ timezone: FIXTURE_TZ, runner: { every: "4m" } });
    expect((await cli(["status"])).code).toBe(1); // every 4m: 9m > 8m
  });

  test("the banner shows on list, runs and show, only when the runner is down", async () => {
    healthyTask();
    for (const args of [["list"], ["runs"], ["show", "daily"]]) {
      const r = await cli(args);
      expect(r.stderr.split("\n")[0]).toStartWith("! runner is not running (no tick recorded yet)");
      expect(r.stdout).not.toContain("runner is not running");
    }
    appendTick(home.paths, { at: "2026-11-17T10:00:00+01:00" });
    for (const args of [["list"], ["runs"], ["show", "daily"], ["log", "daily"]]) expect((await cli(args)).stderr).toBe("");
  });

  test("a paused task's failure is not under Attention; a later success clears misses", async () => {
    home.writeTask(makeTask({ id: "daily", enabled: false, schedule: { type: "cron", cron: "0 8 * * *", timezone: FIXTURE_TZ } }));
    writeRun(home.paths, scheduledRun("daily", "2026-11-17T07:00:00+01:00", "missed", { reason: "runner_offline" }));
    writeRun(home.paths, scheduledRun("daily", "2026-11-17T08:00:00+01:00", "failed", { summary: "boom" }));
    appendTick(home.paths, { at: "2026-11-17T10:00:00+01:00" });
    const s = (await cli(["status", "--json"])).json();
    expect(s.attention.map((a: { kind: string }) => a.kind)).toEqual(["missed"]); // still missed: no success after it
    writeRun(home.paths, scheduledRun("daily", "2026-11-17T09:00:00+01:00", "succeeded"));
    expect((await cli(["status"])).code).toBe(0);
  });

  test("an unreadable run file makes status exit 1", async () => {
    healthyTask();
    appendTick(home.paths, { at: "2026-11-17T10:00:00+01:00" });
    writeFileSync(join(home.paths.runsDir, "daily", "20261117T080000Z.json"), "{ broken");
    const r = await cli(["status"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("warning:");
    expect(r.stdout).toContain("1 file could not be read");
  });

  test("the heartbeat is read from the end of ticks.jsonl; a broken last line is skipped", () => {
    writeTicks(home.paths, "2026-11-01T00:00:00Z", "2026-11-17T08:55:00Z"); // ~4,700 lines, more than the tail read
    appendFileSync(home.paths.ticksFile, '{"at": "2026-11-17T09:0');
    expect(lastTick(home.paths)?.at).toBe("2026-11-17T08:55:00.000Z");
  });
});
