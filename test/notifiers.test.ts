import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commands } from "../src/commands/index.ts";
import { configErrors } from "../src/config.ts";
import { createContext } from "../src/context.ts";
import { newRun } from "../src/execution.ts";
import { commandNotifyArgv } from "../src/notifiers/command.ts";
import { dispatchNotifications, groupNotification, notifierErrors, type NotifierDeps, type NotifyItem, SUMMARY_LIMIT } from "../src/notifiers/index.ts";
import { appleScriptString, systemNotifyArgv } from "../src/notifiers/system.ts";
import type { Task } from "../src/schema.ts";
import { claimRun, readRun } from "../src/store.ts";
import { makeTask, makeTempHome, type TempHome } from "./helpers.ts";

let home: TempHome;
/** A folder with fake `osascript` and `notify-send`, so tests never depend on (or call) the real ones. */
let fakeBin: string;
beforeEach(() => {
  home = makeTempHome();
  fakeBin = join(home.root, "fake-bin");
  mkdirSync(fakeBin);
  for (const name of ["osascript", "notify-send"]) {
    writeFileSync(join(fakeBin, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(fakeBin, name), 0o755);
  }
});
afterEach(() => home.cleanup());

const titles = (id: string) => ({ demo: "Demo task", other: "Other task" })[id] ?? id;

describe("config", () => {
  test("valid notifiers pass, and each problem has a path", () => {
    expect(notifierErrors(undefined)).toEqual([]);
    expect(notifierErrors([{ type: "system", events: ["failed"] }, { type: "command", events: ["blocked"], run: ["x", "{{title}}"] }])).toEqual([]);
    expect(notifierErrors({})).toEqual(["notifiers: must be an array"]);
    expect(notifierErrors([{ type: "slack", events: ["failed"] }])).toEqual(['notifiers[0].type: must be "system" or "command"']);
    expect(notifierErrors([{ type: "system", events: ["exploded"] }])[0]).toStartWith("notifiers[0].events: must be a non-empty array of: launched, succeeded");
    expect(notifierErrors([{ type: "command", events: ["failed"] }])[0]).toStartWith("notifiers[0].run: must be an argv array");
    expect(notifierErrors([{ type: "system", events: ["failed"], run: ["x"] }])[0]).toStartWith("notifiers[0].run: unknown field");
    expect(notifierErrors([{ type: "command", events: ["failed"], run: "n {{bogus}} {{title_quoted}}" }])).toEqual(["notifiers[0].run: unknown variable {{bogus}} (known: event, task_id, title, run_ref, message, count)"]);
  });
});

describe("grouping", () => {
  const failed = (task: string, slot: string, message?: string): NotifyItem => ({ type: "failed", run_ref: `${task}/${slot}`, task_id: task, reason: "exited_without_report", message });

  test("one event: the task's title and the reason", () => {
    expect(groupNotification("failed", [failed("demo", "20261117T080000Z", "the session ended without calling finish")], titles)).toEqual({
      event: "failed",
      title: "Demo task failed",
      message: "exited_without_report: the session ended without calling finish",
      run_refs: ["demo/20261117T080000Z"],
      task_ids: ["demo"],
    });
  });

  test("several events of the same kind: one summary", () => {
    const n = groupNotification("failed", [failed("demo", "20261117T080000Z"), failed("other", "20261117T080000Z"), failed("demo", "20261117T090000Z")], titles);
    expect(n.title).toBe("3 runs failed");
    expect(n.message).toBe("Demo task, Other task");
    expect(n.run_refs).toHaveLength(3);
    expect(n.task_ids).toEqual(["demo", "other"]);
  });

  test("a single succeeded or failed run carries the agent's summary, truncated, and its open session", () => {
    const run = newRun("demo", new Date("2026-11-17T08:00:00Z"), "UTC", "schedule", "succeeded", null, { event: "claimed" }, "2026-11-17T08:00:00Z");
    run.attempts.push({ n: 1, started_at: "2026-11-17T08:00:00Z", finished_at: "2026-11-17T08:10:00Z", session: null, agent: null, status: "succeeded", summary: "Report in docs/report.md", log: null });
    const item: NotifyItem = { type: "succeeded", run_ref: "demo/20261117T080000Z", task_id: "demo", attempt: 1, message: "Report in docs/report.md" };
    expect(groupNotification("succeeded", [item], titles, () => run)).toMatchObject({ title: "Demo task succeeded", message: "Report in docs/report.md" });

    run.attempts[0]!.summary = "x".repeat(500);
    run.attempts[0]!.session = { launcher: "herdr", handle: "t1", name: "n", pid: null, closed_at: null, kept_open: true };
    const long = groupNotification("succeeded", [item], titles, () => run).message;
    expect(long).toBe(`${"x".repeat(SUMMARY_LIMIT - 1)}…\nSession still open: agent-tasks attach demo/20261117T080000Z`);

    // A retry started: `attach` would reach the new attempt, so no hint.
    run.attempts.push({ ...run.attempts[0]!, n: 2, session: null });
    expect(groupNotification("succeeded", [item], titles, () => run).message).not.toContain("attach");
    run.attempts.pop();
    // Closed since (session close): no attach hint. No summary (tick ended it): the reason.
    run.attempts[0]!.session.closed_at = "2026-11-17T09:00:00Z";
    run.attempts[0]!.summary = null;
    const failedItem: NotifyItem = { ...item, type: "failed", reason: "exited_without_report", message: "the session ended without calling finish" };
    expect(groupNotification("failed", [failedItem], titles, () => run).message).toBe("exited_without_report: the session ended without calling finish");
    // Grouped: the short form.
    expect(groupNotification("succeeded", [item, { ...item, run_ref: "demo/20261117T090000Z" }], titles, () => run).message).toBe("Demo task");
  });

  test("anomalies and runner_recovered", () => {
    expect(groupNotification("anomaly", [{ type: "anomaly", run_ref: null, task_id: null, message: "bad file" }], titles)).toMatchObject({ title: "anomaly", message: "bad file" });
    expect(groupNotification("anomaly", [{ type: "anomaly", run_ref: null, task_id: "demo", message: "x" }, { type: "anomaly", run_ref: null, task_id: null, message: "y" }], titles).title).toBe("2 anomalies");
    expect(groupNotification("runner_recovered", [{ type: "runner_recovered", run_ref: null, task_id: null, message: "no ticks for 2h" }], titles)).toMatchObject({ title: "runner recovered", message: "no ticks for 2h" });
  });
});

describe("system notifier", () => {
  const n = { event: "failed" as const, title: 'Say "hi"', message: "back\\slash", run_refs: [], task_ids: [] };

  test("escapes AppleScript strings", () => {
    expect(appleScriptString('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
    expect(appleScriptString("line one\nline two")).toBe('"line one line two"');
  });

  test("osascript on macOS, notify-send on Linux, nothing elsewhere or when missing", () => {
    expect(systemNotifyArgv(n, { platform: "linux", env: { PATH: fakeBin } })).toEqual([join(fakeBin, "notify-send"), "--app-name=agent-tasks", 'agent-tasks: Say "hi"', "back\\slash"]);
    expect(systemNotifyArgv(n, { platform: "darwin", env: { PATH: fakeBin } })?.slice(1)).toEqual(["-e", 'display notification "back\\\\slash" with title "agent-tasks" subtitle "Say \\"hi\\""']);
    expect(systemNotifyArgv(n, { platform: "win32", env: { PATH: fakeBin } })).toBeNull();
    expect(systemNotifyArgv(n, { platform: "linux", env: { PATH: "/nonexistent" } })).toBeNull();
    expect(systemNotifyArgv(n, { platform: "darwin", env: { PATH: "/nonexistent" } })).toBeNull();
  });
});

describe("command notifier", () => {
  const n = { event: "blocked" as const, title: "Demo task blocked", message: "it's waiting", run_refs: ["demo/a", "demo/b"], task_ids: ["demo"] };

  test("renders every variable into the argv", () => {
    expect(commandNotifyArgv({ type: "command", events: ["blocked"], run: ["n", "{{event}}", "{{task_id}}", "{{title}}: {{message}}", "{{run_ref}}"] }, n)).toEqual(["n", "blocked", "demo", "Demo task blocked: it's waiting", "demo/a,demo/b"]);
  });

  test("a string runs with /bin/sh -c and can use _quoted", () => {
    expect(commandNotifyArgv({ type: "command", events: ["blocked"], run: "say {{message_quoted}}" }, n)).toEqual(["/bin/sh", "-c", "say 'it'\\''s waiting'"]);
  });

  test("an unknown variable is an error", () => {
    expect(() => commandNotifyArgv({ type: "command", events: ["blocked"], run: ["n", "{{nope}}"] }, n)).toThrow("unknown variable {{nope}}");
  });
});

describe("dispatch", () => {
  function setup(config: Record<string, unknown>, task: Partial<Task> = {}) {
    home.writeConfig({ timezone: "UTC", ...config });
    home.writeTask(makeTask({ id: "demo", title: "Demo task", ...task }));
    const run = newRun("demo", new Date("2026-11-17T08:00:00Z"), "UTC", "schedule", "failed", null, { event: "claimed" }, "2026-11-17T08:00:00Z");
    run.events.push({ at: "2026-11-17T08:01:00Z", event: "failed", attempt: 1 });
    claimRun(home.paths, run);
    const calls: string[][] = [];
    const deps: NotifierDeps = {
      env: { PATH: fakeBin },
      platform: "darwin",
      exec: (argv) => {
        calls.push(argv);
        return { argv, code: 0, stdout: "", stderr: "" };
      },
    };
    const ctx = createContext({ now: new Date("2026-11-17T08:05:00Z"), json: false, env: home.env, cwd: home.root, stdout: { write() {} }, stderr: { write() {} }, commands });
    return { ctx, calls, deps };
  }
  const item: NotifyItem = { type: "failed", run_ref: "demo/20261117T080000Z", task_id: "demo", attempt: 1 };

  test("marks the run event as notified and never sends it again", () => {
    const { ctx, calls, deps } = setup({ notifiers: [{ type: "command", events: ["failed"], run: ["n", "{{title}}"] }] });
    expect(dispatchNotifications(ctx, [item], deps).warnings).toEqual([]);
    expect(calls).toEqual([["n", "Demo task failed"]]);
    expect(readRun(home.paths, "demo", "20261117T080000Z").events.at(-1)).toMatchObject({ event: "failed", notified: "2026-11-17T08:05:00.000Z" });
    dispatchNotifications(ctx, [item], deps);
    expect(calls).toHaveLength(1);
  });

  test("each notifier gets only its events; the default is system for failed, timed_out, blocked", () => {
    const { ctx, calls, deps } = setup({});
    dispatchNotifications(ctx, [{ ...item, type: "launched" }], deps);
    expect(calls).toEqual([]);
    dispatchNotifications(ctx, [item], deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toEndWith("osascript");
  });

  test("a task's notify replaces every notifier's events for its run events", () => {
    const notifiers = [{ type: "command", events: ["failed"], run: ["a", "{{event}}"] }, { type: "command", events: ["blocked"], run: ["b", "{{event}}"] }];
    const succeeded = setup({ notifiers }, { notify: ["succeeded"] });
    // The run's events have no `succeeded` to mark; it is still sent.
    dispatchNotifications(succeeded.ctx, [{ ...item, type: "succeeded" }, item], succeeded.deps);
    expect(succeeded.calls).toEqual([
      ["a", "succeeded"],
      ["b", "succeeded"],
    ]);
  });

  test("notify: [] silences the task; anomalies stay with the notifiers' events", () => {
    const { ctx, calls, deps } = setup({ notifiers: [{ type: "command", events: ["failed", "anomaly"], run: ["n", "{{event}}"] }] }, { notify: [] });
    dispatchNotifications(ctx, [item, { type: "anomaly", run_ref: null, task_id: "demo", message: "odd" }], deps);
    expect(calls).toEqual([["n", "anomaly"]]);
    expect(readRun(home.paths, "demo", "20261117T080000Z").events.at(-1)?.notified).toBeUndefined();
  });

  test("notify from config defaults applies to tasks without their own", () => {
    const { ctx, calls, deps } = setup({ notifiers: [{ type: "command", events: ["failed"], run: ["n", "{{event}}"] }], defaults: { notify: ["launched"] } });
    dispatchNotifications(ctx, [item, { ...item, type: "launched" }], deps);
    expect(calls).toEqual([["n", "launched"]]);
  });

  test("an invalid notifiers section is rejected when the config loads", () => {
    expect(configErrors({ notifiers: [{ type: "pager", events: ["failed"] }] })).toEqual(['notifiers[0].type: must be "system" or "command"']);
    expect(configErrors({ notifiers: [{ type: "system", events: ["failed"] }] })).toEqual([]);
  });

  test("a notifier that throws is a warning, the others still run, and the event is marked", () => {
    const { ctx, calls, deps } = setup({ notifiers: [{ type: "command", events: ["failed"], run: ["bad"] }, { type: "command", events: ["failed"], run: ["good"] }] });
    deps.exec = (argv) => {
      calls.push(argv);
      if (argv[0] === "bad") throw new Error("spawn failed");
      return { argv, code: 0, stdout: "", stderr: "" };
    };
    const result = dispatchNotifications(ctx, [item], deps);
    expect(result.warnings).toEqual(["notifier 1 (command) failed for Demo task failed: Error: spawn failed"]);
    expect(calls.map((c) => c[0])).toEqual(["bad", "good"]);
    expect(readRun(home.paths, "demo", "20261117T080000Z").events.at(-1)?.notified).toBeTruthy();
  });
});
