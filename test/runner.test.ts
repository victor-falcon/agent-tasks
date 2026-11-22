import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commands } from "../src/commands/index.ts";
import { type Context, createContext } from "../src/context.ts";
import { newRun } from "../src/execution.ts";
import { exec } from "../src/launcher.ts";
import type { NotifierDeps } from "../src/notifiers/index.ts";
import { acquireRunnerLock, readRunnerLock, RunnerLockedError, runnerLockPath, runnerLogPath } from "../src/runner-lock.ts";
import { contextRunnerHealth } from "../src/runner-health.ts";
import { oscAgentState, oscTitle } from "../src/runner-render.ts";
import { type RunnerDeps, runRunner } from "../src/runner.ts";
import type { RunStatus } from "../src/schema.ts";
import { appendTick, claimRun, readTicks, writeRun } from "../src/store.ts";
import { tick as realTick, type TickResult } from "../src/tick.ts";
import { at, DEMO_REF, execTask, FAKE_AGENT, makeExecHome, type ExecHome, settled, waitFor } from "./exec-helpers.ts";
import { makeTask, makeTempHome, runCli, type TempHome } from "./helpers.ts";

setDefaultTimeout(30_000);

const START = "2026-11-17T09:00:00Z";
const MIN = 60_000;

/** A pid that existed and is gone now. */
function deadPid(): number {
  const child = Bun.spawnSync(["/bin/sh", "-c", "echo $$"]);
  return Number(child.stdout.toString().trim());
}

interface Harness {
  output(): string;
  sleeps: number[];
  calls: string[][];
  deps: RunnerDeps;
  base: Context;
  /** Moves the fake clock (e.g. a slow tick). */
  advance(ms: number): void;
  run(opts?: { every?: string; once?: boolean; quiet?: boolean }): Promise<number>;
}

/**
 * Drives `runRunner` with a fake clock: `sleep` moves the clock forward
 * instead of waiting, and aborts after `stopAfter` sleeps.
 */
function harness(home: TempHome, opts: { tty?: boolean; env?: Record<string, string>; stopAfter?: number; tick?: (ctx: Context, i: number) => TickResult; exec?: NotifierDeps["exec"] } = {}): Harness {
  let clock = Date.parse(START);
  let text = "";
  const sleeps: number[] = [];
  const calls: string[][] = [];
  const controller = new AbortController();
  const env = { ...home.env, ...opts.env };
  const stdout = { write: (t: string) => void (text += t), isTTY: opts.tty ?? false };
  const makeCtx = (now: Date) => createContext({ now, json: false, env, cwd: home.root, stdout, stderr: stdout, commands });
  let i = 0;
  const deps: RunnerDeps = {
    now: () => new Date(clock),
    async sleep(ms) {
      sleeps.push(ms);
      clock += ms;
      if (sleeps.length >= (opts.stopAfter ?? 1)) controller.abort();
    },
    context: makeCtx,
    signal: controller.signal,
    stdout,
    pid: process.pid,
    tick: opts.tick ? (ctx) => opts.tick!(ctx, i++) : undefined,
    notifierDeps: {
      env,
      platform: "darwin",
      exec:
        opts.exec ??
        ((argv, o) => {
          calls.push(argv);
          return { argv, code: 0, stdout: "", stderr: "" };
        }),
    },
  };
  const base = makeCtx(new Date(clock));
  return {
    output: () => text,
    sleeps,
    calls,
    deps,
    base,
    advance: (ms) => void (clock += ms),
    run: (o = {}) => runRunner(base, { every: o.every ?? "5m", once: o.once ?? false, quiet: o.quiet ?? false }, deps),
  };
}

const emptyTick = (ctx: Context): TickResult => ({ at: ctx.now.toISOString(), mode: "runner", events: [], errors: [] });

/** Writes a run of `demo` with a given status (no attempts), as tick would leave it. */
function putRun(home: TempHome, status: RunStatus, slot = "2026-11-17T08:00:00Z"): void {
  const run = newRun("demo", new Date(slot), "UTC", "schedule", status, null, { event: status }, slot);
  if (!claimRun(home.paths, run)) writeRun(home.paths, run);
}

let home: TempHome;
beforeEach(() => {
  home = makeTempHome();
  home.writeConfig({ timezone: "UTC", notifiers: [] });
});
afterEach(() => home.cleanup());

describe("the loop", () => {
  test("ticks every interval with a fresh now, and appends a heartbeat per tick", async () => {
    const h = harness(home, { stopAfter: 3 });
    expect(await h.run()).toBe(0);
    expect(h.sleeps).toEqual([5 * MIN, 5 * MIN, 5 * MIN]);
    const ticks = readTicks(home.paths).items;
    expect(ticks.map((t) => [t.at, t.mode])).toEqual([
      ["2026-11-17T09:00:00Z", "runner"],
      ["2026-11-17T09:05:00Z", "runner"],
      ["2026-11-17T09:10:00Z", "runner"],
    ]);
    const lines = h.output().trim().split("\n");
    expect(lines[0]).toBe("agent-tasks runner · every 5m · launcher: process (claude) · data: ~/data");
    expect(lines.filter((l) => l.includes("tick  0 due · 0 running"))).toHaveLength(3);
    expect(lines.at(-1)).toBe("● stopped · last tick 09:10:00 · running 0 · today ■0 ✕0 □0 !0");
    expect(existsSync(runnerLockPath(home.paths))).toBe(false);
  });

  test("waits only what is left of the interval when a tick takes time", async () => {
    const h: Harness = harness(home, {
      stopAfter: 1,
      tick: (ctx) => {
        h.advance(2 * MIN);
        return emptyTick(ctx);
      },
    });
    await h.run();
    expect(h.sleeps).toEqual([3 * MIN]);
  });

  test("a tick that throws is shown as ⚠ and the loop goes on", async () => {
    const h = harness(home, {
      stopAfter: 3,
      tick: (ctx, i) => {
        if (i === 1) throw new Error("boom");
        return emptyTick(ctx);
      },
    });
    expect(await h.run()).toBe(0);
    const out = h.output();
    expect(out).toContain("09:05:00  ⚠ tick failed: Error: boom");
    expect(out.match(/tick {2}0 due/g)).toHaveLength(2);
    expect(h.sleeps).toHaveLength(3);
  });

  test("a broken config in the middle shows ⚠ and the next tick picks up the fix", async () => {
    const h = harness(home, {
      stopAfter: 3,
      tick: (ctx, i) => {
        if (i !== 1) {
          const result = realTick(ctx, { mode: "runner" });
          if (i === 0) home.writeConfig("{ broken");
          return result;
        }
        try {
          return realTick(ctx, { mode: "runner" });
        } finally {
          home.writeConfig({ timezone: "UTC", notifiers: [] });
        }
      },
    });
    await h.run();
    // Tick 1 is fine (config already loaded); tick 2 reads the broken file; tick 3 the fixed one.
    expect(h.output()).toContain("09:05:00  ⚠ tick failed:");
    expect(h.output()).toContain("09:10:00  tick  0 due");
  });

  test("--once runs one tick, does not wait, and exits 1 when that tick fails", async () => {
    const ok = harness(home);
    expect(await ok.run({ once: true })).toBe(0);
    expect(ok.sleeps).toEqual([]);
    expect(readTicks(home.paths).items).toHaveLength(1);

    const failing = harness(home, { tick: () => { throw new Error("nope"); } });
    expect(await failing.run({ once: true })).toBe(1);
    expect(failing.output()).toContain("⚠ tick failed: Error: nope");
  });

  test("--quiet shows events only: no tick lines and no status line", async () => {
    const h = harness(home, {
      tty: true,
      env: { NO_COLOR: "1" },
      stopAfter: 1,
      tick: (ctx) => ({ ...emptyTick(ctx), events: [{ type: "missed", run_ref: "demo/20261117T080000Z", task_id: "demo", reason: "runner_offline" }] }),
    });
    await h.run({ quiet: true });
    expect(h.output()).not.toContain("tick  ");
    expect(h.output()).toContain("□ demo/20261117T080000Z");
    expect(h.output()).not.toContain("─────");
    expect(h.output()).not.toContain("●");
    // The log keeps the tick lines.
    expect(readFileSync(runnerLogPath(home.paths), "utf8")).toContain("tick  0 due");
  });

  test("an abort while waiting stops the runner cleanly", async () => {
    const h = harness(home, { stopAfter: 1 });
    expect(await h.run()).toBe(0);
    expect(readTicks(home.paths).items).toHaveLength(1);
    expect(h.output()).toContain("● stopped");
    expect(readRunnerLock(home.paths)).toBeNull();
  });

  test("the lock records pid, terminal, interval and the next tick while running", async () => {
    let seen = null as ReturnType<typeof readRunnerLock>;
    const h = harness(home, {
      env: { HC_TERMINAL_ID: "t17g" },
      stopAfter: 2,
      tick: (ctx, i) => {
        if (i === 1) seen = readRunnerLock(home.paths);
        return emptyTick(ctx);
      },
    });
    await h.run({ every: "10m" });
    expect(seen).toEqual({ pid: process.pid, terminal: "t17g", started_at: "2026-11-17T09:00:00Z", every: "10m", last_tick_at: "2026-11-17T09:00:00Z", next_tick_at: "2026-11-17T09:10:00Z" });
  });

  test("on start, a gap since the last tick shows runner_recovered (not with --once)", async () => {
    appendTick(home.paths, { at: "2026-11-17T07:00:00Z", mode: "runner" });
    const once = harness(home);
    await once.run({ once: true });
    expect(once.output()).not.toContain("recovered");

    writeFileSync(home.paths.ticksFile, `${JSON.stringify({ at: "2026-11-17T07:00:00Z", mode: "runner" })}\n`);
    const h = harness(home);
    await h.run();
    expect(h.output()).toContain("09:00:00  ↻ runner recovered after 2h without ticks (last tick 07:00:00)");

    // A recent tick is not a gap.
    const again = harness(home);
    await again.run();
    expect(again.output()).not.toContain("recovered");
  });
});

describe("single runner", () => {
  test("a second runner is refused and says where the live one is", async () => {
    mkdirSync(home.paths.stateDir, { recursive: true });
    writeFileSync(runnerLockPath(home.paths), JSON.stringify({ pid: process.ppid, terminal: "t17g", started_at: "2026-11-17T08:00:00Z", every: "5m" }));
    const h = harness(home);
    await expect(h.run({ once: true })).rejects.toBeInstanceOf(RunnerLockedError);
    expect(readTicks(home.paths).items).toHaveLength(0);

    const cli = await runCli(["runner", "--once"], home);
    expect(cli.code).toBe(1);
    expect(cli.stderr).toContain(`a runner is already running (pid ${process.ppid} in terminal t17g`);
    // The live runner's lock is left alone.
    expect(readRunnerLock(home.paths)?.pid).toBe(process.ppid);
  });

  test("a stale lock (its pid is gone) is taken over", async () => {
    const pid = deadPid();
    mkdirSync(home.paths.stateDir, { recursive: true });
    writeFileSync(runnerLockPath(home.paths), JSON.stringify({ pid, terminal: null, started_at: "2026-11-16T08:00:00Z", every: "5m" }));
    const h = harness(home);
    expect(await h.run({ once: true })).toBe(0);
    expect(h.output()).toContain(`⚠ took over a stale lock from pid ${pid}`);
    expect(readRunnerLock(home.paths)).toBeNull();
  });

  test("acquire refuses a live holder and takes an unreadable lock", () => {
    mkdirSync(home.paths.stateDir, { recursive: true });
    writeFileSync(runnerLockPath(home.paths), "garbage");
    const lock = { pid: process.pid, terminal: null, started_at: START, every: "5m" };
    expect(acquireRunnerLock(home.paths, lock).stale).toBeNull();
    expect(() => acquireRunnerLock(home.paths, { ...lock, pid: process.ppid }, () => true)).toThrow(RunnerLockedError);
  });
});

describe("terminal output", () => {
  /** Ticks that leave a run running on the second tick and finish it on the third. */
  const statusTicks = (ctx: Context, i: number): TickResult => {
    if (i === 1) putRun(home, "running");
    if (i === 2) putRun(home, "succeeded");
    return emptyTick(ctx);
  };

  test("on a TTY: title and agent state at start, state only on change, status line redrawn in place", async () => {
    const h = harness(home, { tty: true, stopAfter: 4, tick: statusTicks });
    await h.run();
    const out = h.output();
    expect(out.startsWith("\x1b[1magent-tasks runner\x1b[22m")).toBe(true);
    expect(out).toContain(oscTitle("agent-tasks runner"));
    const states = [...out.matchAll(/\x1b\]7501;state=(\w+):app=agent-tasks\x07/g)].map((m) => m[1]);
    expect(states).toEqual(["idle", "working", "idle"]);
    expect(out.indexOf(oscAgentState("idle"))).toBeLessThan(out.indexOf("tick  "));
    // The status block is cleared before each new line, and printed once more at the end.
    expect(out).toContain("\r\x1b[2K\x1b[1A\r\x1b[2K");
    expect(out).toContain("running 1");
    expect(out).toContain("\x1b[32m");
  });

  test("NO_COLOR on a TTY: no colors, but the Herdr escapes and the status line stay", async () => {
    const h = harness(home, { tty: true, env: { NO_COLOR: "1" }, stopAfter: 1 });
    await h.run();
    const out = h.output();
    expect(out).not.toMatch(/\x1b\[\d+m/);
    expect(out).toContain(oscAgentState("idle"));
    expect(out).toContain("● healthy · last tick 09:00:00 · next 09:05:00");
  });

  test("the rule under the events never wraps a narrow terminal", async () => {
    const h = harness(home, { tty: true, env: { NO_COLOR: "1" }, stopAfter: 1 });
    (h.deps.stdout as { columns?: number }).columns = 40;
    await h.run();
    expect(h.output()).toContain(`\n${"─".repeat(39)}\n●`);
    expect(h.output()).not.toContain("─".repeat(40));
  });

  test("not a TTY: no escapes at all, no status line until the final one", async () => {
    const h = harness(home, { stopAfter: 2, tick: statusTicks });
    await h.run();
    const out = h.output();
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("● healthy");
    expect(out.trim().split("\n").at(-1)).toStartWith("● stopped");
  });

  test("runner.log gets the same lines, without escapes", async () => {
    const h = harness(home, {
      tty: true,
      stopAfter: 1,
      tick: (ctx) => ({ ...emptyTick(ctx), events: [{ type: "launched", run_ref: "demo/20261117T080000Z", task_id: "demo", attempt: 1, handle: "4242" }] }),
    });
    await h.run();
    const log = readFileSync(runnerLogPath(home.paths), "utf8");
    expect(log).toBe(
      [
        "09:00:00  agent-tasks runner · every 5m · launcher: process (claude) · data: ~/data",
        "09:00:00  tick  1 due · 0 running",
        "09:00:00  ▶ demo/20261117T080000Z                launched in 4242",
        "09:05:00  ● stopped · last tick 09:00:00 · running 0 · today ■0 ✕0 □0 !0",
        "",
      ].join("\n"),
    );
  });

  test("while the dashboard has the screen, lines only go to runner.log; the final line is shown once it is gone", async () => {
    let shown = false;
    const started: string[] = [];
    const h = harness(home, {
      tty: true,
      stopAfter: 1,
      tick: (ctx) => ({ ...emptyTick(ctx), events: [{ type: "launched", run_ref: "demo/20261117T080000Z", task_id: "demo", attempt: 1, handle: "4242" }] }),
    });
    h.deps.onStarted = () => {
      started.push(readRunnerLock(home.paths) ? "locked" : "unlocked");
      shown = true;
    };
    h.deps.screenHidden = () => shown;
    const sleep = h.deps.sleep;
    h.deps.sleep = async (ms, signal) => {
      await sleep(ms, signal);
      shown = false; // the user quit the dashboard
    };
    await h.run();
    expect(started).toEqual(["locked"]);
    const visible = h.output().replace(/\x1b\][^\x07]*\x07/g, ""); // the Herdr escapes still go out
    expect(visible).not.toContain("launched");
    expect(visible).toContain("stopped · last tick 09:00:00");
    expect(readFileSync(runnerLogPath(home.paths), "utf8")).toContain("▶ demo/20261117T080000Z");
  });

  test("the final line waits until the dashboard has given the screen back", async () => {
    let shown = true;
    const h = harness(home, { tty: true, stopAfter: 1 });
    h.deps.screenHidden = () => shown;
    h.deps.screenBack = async () => {
      await Bun.sleep(5); // the renderer leaves the alternate screen asynchronously
      shown = false;
    };
    await h.run();
    const visible = h.output().replace(/\x1b\][^\x07]*\x07/g, "");
    expect(visible).not.toContain("agent-tasks runner ·"); // the header went to runner.log only
    expect(visible).toContain("stopped · last tick 09:00:00");
  });

  test("today's counters add up the events", async () => {
    const events = [
      { type: "succeeded" as const, run_ref: "a/20261117T080000Z", task_id: "a" },
      { type: "failed" as const, run_ref: "b/20261117T080000Z", task_id: "b" },
      { type: "timed_out" as const, run_ref: "c/20261117T080000Z", task_id: "c" },
      { type: "missed" as const, run_ref: "d/20261117T080000Z", task_id: "d" },
      { type: "blocked" as const, run_ref: "e/20261117T080000Z", task_id: "e" },
    ];
    const h = harness(home, { tick: (ctx) => ({ ...emptyTick(ctx), events }) });
    await h.run({ once: true });
    expect(h.output()).toContain("today ■1 ✕2 □1 !1");
  });
});

describe("notifiers in the runner", () => {
  test("failures are notified by the default system notifier, grouped, once", async () => {
    home.writeConfig({ timezone: "UTC" });
    home.writeTask(makeTask({ id: "demo", title: "Demo task" }));
    putRun(home, "failed", "2026-11-17T08:00:00Z");
    putRun(home, "failed", "2026-11-17T08:30:00Z");
    const events = [
      { type: "failed" as const, run_ref: "demo/20261117T080000Z", task_id: "demo" },
      { type: "failed" as const, run_ref: "demo/20261117T083000Z", task_id: "demo" },
      { type: "launched" as const, run_ref: "demo/20261117T083000Z", task_id: "demo" },
    ];
    const h = harness(home, { stopAfter: 2, tick: (ctx) => ({ ...emptyTick(ctx), events }) });
    // No osascript on this PATH would skip silently; put a fake one first.
    const bin = join(home.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "osascript"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "osascript"), 0o755);
    h.deps.notifierDeps!.env.PATH = bin;
    await h.run();
    // Two ticks report the same events: only the first sends, as one notification.
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]![0]).toBe(join(bin, "osascript"));
    expect(h.calls[0]![2]).toBe('display notification "Demo task" with title "agent-tasks" subtitle "2 runs failed"');
  });

  test("a failing notifier is a ⚠ line and the runner carries on; the same anomaly is notified once", async () => {
    home.writeConfig({ timezone: "UTC", notifiers: [{ type: "command", events: ["anomaly"], run: ["notify", "{{title}}"] }] });
    const h = harness(home, {
      stopAfter: 2,
      tick: (ctx) => ({ ...emptyTick(ctx), events: [{ type: "anomaly", run_ref: null, task_id: null, message: "broken" }] }),
      exec: (argv) => ({ argv, code: 1, stdout: "", stderr: "no route" }),
    });
    expect(await h.run()).toBe(0);
    expect(h.output().match(/⚠ notifier 1 \(command\) failed for anomaly: notify anomaly exited with 1: no route/g)).toHaveLength(1);
    expect(h.output().match(/tick {2}0 due/g)).toHaveLength(2);
  });

  test("runner_recovered is sent to notifiers that want it", async () => {
    home.writeConfig({ timezone: "UTC", notifiers: [{ type: "command", events: ["runner_recovered"], run: ["notify", "{{event}}", "{{message}}"] }] });
    appendTick(home.paths, { at: "2026-11-17T07:00:00Z", mode: "runner" });
    const h = harness(home);
    await h.run();
    expect(h.calls).toEqual([["notify", "runner_recovered", "no ticks for 2h (last tick 2026-11-17T07:00:00Z)"]]);
  });
});

describe("agent-tasks runner status", () => {
  test("no runner: exit 1, and says how to start one", async () => {
    const r = await runCli(["runner", "status"], home);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("No runner is running");
    expect(r.stdout).toContain("agent-tasks runner");
    const json = await runCli(["runner", "status", "--json"], home);
    expect(json.code).toBe(1);
    expect(json.json()).toMatchObject({ running: false, stale_lock: false, pid: null });
  });

  test("a live runner: exit 0 with where, since when, last and next tick", async () => {
    mkdirSync(home.paths.stateDir, { recursive: true });
    writeFileSync(
      runnerLockPath(home.paths),
      JSON.stringify({ pid: process.pid, terminal: "t17g", started_at: "2026-11-17T08:00:00Z", every: "5m", last_tick_at: "2026-11-17T09:00:00Z", next_tick_at: "2026-11-17T09:05:00Z" }),
    );
    appendTick(home.paths, { at: "2026-11-17T09:00:00Z", mode: "runner" });
    const r = await runCli(["runner", "status", "--now", "2026-11-17T09:02:00Z"], home);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      "● Runner running: pid " + process.pid + " in terminal t17g, since 2026-11-17T08:00:00Z, every 5m\n  last tick 2026-11-17T09:00:00Z (2m ago, runner) · next tick 2026-11-17T09:05:00Z\n",
    );
    const json = await runCli(["runner", "status", "--json", "--now", "2026-11-17T09:02:00Z"], home);
    expect(json.json()).toMatchObject({ running: true, stalled: false, terminal: "t17g", next_tick_at: "2026-11-17T09:05:00Z" });

    const late = await runCli(["runner", "status", "--json", "--now", "2026-11-17T10:00:00Z"], home);
    expect(late.code).toBe(0);
    expect(late.json()).toMatchObject({ running: true, stalled: true });
  });

  test("a stale lock: exit 1, flagged as stale", async () => {
    mkdirSync(home.paths.stateDir, { recursive: true });
    writeFileSync(runnerLockPath(home.paths), JSON.stringify({ pid: deadPid(), terminal: null, started_at: "2026-11-17T08:00:00Z", every: "5m" }));
    const r = await runCli(["runner", "status", "--json"], home);
    expect(r.code).toBe(1);
    expect(r.json()).toMatchObject({ running: false, stale_lock: true, next_tick_at: null });
  });
});

describe("runner health (the banner of other commands)", () => {
  test("uses the live runner's --every from the lock, else runner.every from the config", () => {
    home.writeConfig({ timezone: "UTC", notifiers: [], runner: { every: "5m" } });
    appendTick(home.paths, { at: "2026-11-17T09:00:00Z", mode: "runner" });
    const ctx = createContext({ now: new Date("2026-11-17T09:20:00Z"), json: false, env: home.env, cwd: home.root, stdout: { write() {} }, stderr: { write() {} }, commands });
    expect(contextRunnerHealth(ctx)).toMatchObject({ state: "stale", every: "5m" });
    mkdirSync(home.paths.stateDir, { recursive: true });
    writeFileSync(runnerLockPath(home.paths), JSON.stringify({ pid: process.pid, terminal: null, started_at: "2026-11-17T08:00:00Z", every: "15m" }));
    expect(contextRunnerHealth(ctx)).toMatchObject({ state: "healthy", every: "15m", next_tick: "2026-11-17T09:15:00Z" });
  });
});

describe("runner command", () => {
  test("rejects a bad --every", async () => {
    const r = await runCli(["runner", "--every", "soon", "--once"], home);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--every: invalid duration "soon"');
  });

  test("--json --quiet still prints every tick with its events", async () => {
    const r = await runCli(["runner", "--once", "--json", "--quiet", "--now", START], home);
    expect(r.stdout.trim().split("\n").map((l) => JSON.parse(l).type)).toEqual(["runner_started", "tick", "runner_stopped"]);
  });

  test("--json prints one object per line", async () => {
    const r = await runCli(["runner", "--once", "--json", "--now", START], home);
    expect(r.code).toBe(0);
    const types = r.stdout.trim().split("\n").map((l) => JSON.parse(l).type);
    expect(types).toEqual(["runner_started", "tick", "runner_stopped"]);
  });
});

describe("integration: runner --once with the process preset", () => {
  let ex: ExecHome;
  beforeEach(() => {
    ex = makeExecHome();
    ex.writeConfig({ timezone: "Europe/Madrid", agent: { command: "bun", args: [FAKE_AGENT] }, notifiers: [] });
  });
  afterEach(() => ex.cleanup());

  test("launches a due task, and the next --once shows it succeeded", async () => {
    execTask(ex, "succeed");
    const first = await ex.cli("runner", "--once", "--now", at(1));
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("tick  1 due · 1 running");
    expect(first.stdout).toMatch(new RegExp(`▶ ${DEMO_REF} +launched in \\d+`));

    await waitFor(settled(ex), "finish");
    const second = await ex.cli("runner", "--once", "--now", at(6));
    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(new RegExp(`■ ${DEMO_REF} +succeeded in \\S+ · "did it \\(attempt 1\\)"`));
    expect(second.stdout).toContain("today ■1 ✕0 □0 !0");
    expect(readFileSync(runnerLogPath(ex.paths), "utf8")).toContain(`■ ${DEMO_REF}`);
  });
});

// A real `exec` of a fake command on PATH, end to end through the template.
describe("command notifier through a real command", () => {
  test("renders the template into argv and runs it", async () => {
    const bin = join(home.root, "bin");
    const out = join(home.root, "notified.txt");
    mkdirSync(bin);
    writeFileSync(join(bin, "notify"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${out}"; done\n`);
    chmodSync(join(bin, "notify"), 0o755);
    home.writeConfig({ timezone: "UTC", notifiers: [{ type: "command", events: ["blocked"], run: ["notify", "{{event}}", "{{task_id}}", "{{title}}", "{{run_ref}}", "{{message}}"] }] });
    home.writeTask(makeTask({ id: "demo", title: "Demo task" }));
    putRun(home, "blocked");
    const h = harness(home, {
      exec,
      tick: (ctx) => ({ ...emptyTick(ctx), events: [{ type: "blocked", run_ref: "demo/20261117T080000Z", task_id: "demo", attempt: 1 }] }),
    });
    h.deps.notifierDeps!.env.PATH = `${bin}:${process.env.PATH}`;
    await h.run({ once: true });
    expect(readFileSync(out, "utf8").split("\n")).toEqual(["blocked", "demo", "Demo task blocked", "demo/20261117T080000Z", "demo/20261117T080000Z", ""]);
  });
});
