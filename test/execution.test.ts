import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Run } from "../src/schema.ts";
import { appendTick } from "../src/store.ts";
import { at, DEMO_REF, type ExecHome, execTask, FAKE_AGENT, makeExecHome, pidAlive, REPO, T0, waitFor } from "./exec-helpers.ts";
import { makeTask } from "./helpers.ts";

// Full cycles with the `process` preset and a fake agent that calls
// `agent-tasks task` and `agent-tasks finish` like the real skill does.

setDefaultTimeout(30_000);

let home: ExecHome;
beforeEach(() => {
  home = makeExecHome();
  home.writeConfig({ timezone: "Europe/Madrid", agent: { command: "bun", args: [FAKE_AGENT] } });
});
afterEach(() => home.cleanup());

const finished = (ref = DEMO_REF, n = 1) => () => {
  const run = home.run(ref);
  return run.attempts[n - 1]?.finished_at ? run : null;
};
const pidOf = (run: Run, n = 1) => Number((run.attempts[n - 1]!.session as { pid: number }).pid);

describe("process preset: launch → finish", () => {
  test("a successful run records the result, copies the output and closes the session", async () => {
    execTask(home, "succeed");
    const first = await home.tick(1);
    expect(first.events).toEqual([expect.objectContaining({ type: "launched", run_ref: DEMO_REF, attempt: 1 })]);

    const run = await waitFor(finished(), "finish");
    const attempt = run.attempts[0]!;
    expect(run.status).toBe("succeeded");
    expect(attempt.summary).toBe("did it (attempt 1)");
    expect(attempt.agent).toEqual({ command: "bun", args: [FAKE_AGENT], shell: false, from: "config" });
    expect(attempt.session).toMatchObject({ launcher: "process", name: "task-demo-20261117t080000z" });
    expect(attempt.output).toBe("runs/demo/20261117T080000Z.output.md");
    expect(readFileSync(join(home.dataDir, attempt.output!), "utf8")).toBe(`# Report for ${DEMO_REF}\n`);
    await waitFor(() => home.run(DEMO_REF).attempts[0]!.session?.closed_at, "close");
    expect(readFileSync(join(home.dataDir, attempt.log!), "utf8")).toContain(`prompt: /run-agent-task ${DEMO_REF}`);

    // The next tick reports the outcome once; later ticks stay quiet.
    expect((await home.tick(6)).events).toEqual([expect.objectContaining({ type: "succeeded", run_ref: DEMO_REF, message: "did it (attempt 1)" })]);
    expect((await home.tick(11)).events).toEqual([]);
  });

  test("finish --status failed keeps the session open by default (keep_open: on_failure)", async () => {
    execTask(home, "fail");
    await home.tick(1);
    const run = await waitFor(finished(), "finish");
    expect(run.status).toBe("failed");
    expect(run.attempts[0]!.summary).toBe("could not do it");
    expect(run.attempts[0]!.session).toMatchObject({ kept_open: true, closed_at: null });
    expect((await home.tick(6)).events).toEqual([expect.objectContaining({ type: "failed", run_ref: DEMO_REF })]);
  });

  test("finish twice changes nothing", async () => {
    execTask(home, "succeed");
    await home.tick(1);
    await waitFor(finished(), "finish");
    const before = home.run(DEMO_REF);
    const again = await home.cli("finish", DEMO_REF, "--status", "failed", "--summary", "late", "--json");
    expect(again.code).toBe(0);
    expect(again.json()).toMatchObject({ already_finished: true, status: "succeeded" });
    expect(home.run(DEMO_REF)).toEqual(before);
  });

  test("a finish after tick ended the attempt keeps the late report without changing the status", async () => {
    execTask(home, "hang", { timeout: "30m" });
    await home.tick(1);
    await home.tick(32);
    const late = await home.cli("finish", DEMO_REF, "--status", "succeeded", "--summary", "done late", "--json");
    expect(late.code).toBe(0);
    expect(late.json()).toMatchObject({ late: true, status: "timed_out" });
    expect(late.stderr).toContain("had already ended as timed_out");
    expect(home.run(DEMO_REF).events.at(-1)).toMatchObject({ event: "late_finish", status: "succeeded", summary: "done late" });
  });

  test("an old attempt cannot finish a newer one", async () => {
    execTask(home, "hang", { timeout: "30m", retries: 1 });
    await home.tick(1);
    await home.tick(32); // timed out → attempt 2 launched
    expect(home.run(DEMO_REF).attempts).toHaveLength(2);
    home.env.AGENT_TASKS_RUN = DEMO_REF;
    home.env.AGENT_TASKS_ATTEMPT = "1";
    const stale = await home.cli("finish", DEMO_REF, "--status", "succeeded", "--summary", "x");
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("attempt 1 of demo/20261117T080000Z was replaced by attempt 2");
    delete home.env.AGENT_TASKS_ATTEMPT;
    await home.cli("session", "close", DEMO_REF);
  });

  test("an archived task's failed run is not retried", async () => {
    execTask(home, "exit", { retries: 2 });
    await home.tick(1);
    const pid = pidOf(home.run(DEMO_REF));
    await waitFor(() => !pidAlive(pid), "the agent to exit");
    mkdirSync(home.paths.archiveDir, { recursive: true });
    renameSync(join(home.paths.tasksDir, "demo.json"), join(home.paths.archiveDir, "demo.json"));
    expect((await home.tick(2)).events.map((e) => e.type)).toEqual(["failed"]);
    expect(home.run(DEMO_REF).attempts).toHaveLength(1);
  });

  test("an agent that exits without finish ends as failed / exited_without_report", async () => {
    execTask(home, "exit");
    await home.tick(1);
    const pid = pidOf(home.run(DEMO_REF));
    await waitFor(() => !pidAlive(pid), "the agent to exit");
    const { events } = await home.tick(2);
    expect(events).toEqual([expect.objectContaining({ type: "failed", reason: "exited_without_report" })]);
    const run = home.run(DEMO_REF);
    expect(run).toMatchObject({ status: "failed", reason: "exited_without_report" });
    expect(run.attempts[0]!.session).toMatchObject({ closed_at: expect.any(String) });
  });

  test("past its timeout a run is closed and marked timed_out", async () => {
    execTask(home, "hang", { timeout: "30m" });
    await home.tick(1);
    const pid = pidOf(home.run(DEMO_REF));
    expect((await home.tick(20)).events).toEqual([]);
    expect(pidAlive(pid)).toBe(true);

    const { events } = await home.tick(32);
    expect(events).toEqual([expect.objectContaining({ type: "timed_out", run_ref: DEMO_REF })]);
    expect(home.run(DEMO_REF).status).toBe("timed_out");
    await waitFor(() => !pidAlive(pid), "the agent to be killed");
  });

  test("retries launch a new attempt after a failure", async () => {
    execTask(home, "fail-first", { retries: 1 });
    await home.tick(1);
    await waitFor(finished(DEMO_REF, 1), "attempt 1");
    const { events } = await home.tick(2);
    expect(events.map((e) => [e.type, e.attempt])).toEqual([["failed", 1], ["launched", 2]]);
    const run = await waitFor(finished(DEMO_REF, 2), "attempt 2");
    expect(run.status).toBe("succeeded");
    expect(run.attempts.map((a) => a.status)).toEqual(["failed", "succeeded"]);
    expect(run.attempts[1]!.log).toBe("runs/demo/20261117T080000Z.2.log");
    // No retries left after the second attempt.
    expect((await home.tick(3)).events.map((e) => e.type)).toEqual(["succeeded"]);
  });

  test("a failure with no retries left is not retried", async () => {
    execTask(home, "fail", { retries: 1 });
    await home.tick(1);
    await waitFor(finished(DEMO_REF, 1), "attempt 1");
    await home.tick(2);
    await waitFor(finished(DEMO_REF, 2), "attempt 2");
    expect((await home.tick(3)).events.map((e) => e.type)).toEqual(["failed"]);
    expect(home.run(DEMO_REF).attempts).toHaveLength(2);
  });

  test("a broken agent command is a failed launch, not a crashed tick", async () => {
    home.writeConfig({ agent: { command: "/nonexistent/agent" } });
    execTask(home, "succeed");
    const { events } = await home.tick(1);
    expect(events).toEqual([expect.objectContaining({ type: "failed", reason: "launch_failed", message: expect.stringContaining("/nonexistent/agent") })]);
    expect(home.run(DEMO_REF)).toMatchObject({ status: "failed", reason: "launch_failed" });
  });
});

describe("reconcile", () => {
  test("tick writes missed and superseded slots and launches the newest", async () => {
    // Hourly from 00:00 local; at 09:01 with max_delay 3h: 00:00–06:00 missed, 07:00–08:00 superseded, 09:00 launched.
    execTask(home, "succeed", {
      schedule: { type: "cron", cron: "0 * * * *", timezone: "Europe/Madrid", starts_at: null, until: null },
      created_at: "2026-11-17T00:00:00+01:00",
      max_delay: "3h",
    });
    const { events } = await home.tick(1);
    const byType = (t: string) => events.filter((e) => e.type === t).map((e) => e.run_ref);
    expect(byType("missed")).toEqual(["20261116T230000Z", "20261117T000000Z", "20261117T010000Z", "20261117T020000Z", "20261117T030000Z", "20261117T040000Z", "20261117T050000Z"].map((s) => `demo/${s}`));
    expect(events.find((e) => e.type === "missed").reason).toBe("runner_offline");
    expect(byType("superseded")).toEqual(["demo/20261117T060000Z", "demo/20261117T070000Z"]);
    expect(byType("launched")).toEqual([DEMO_REF]);
    expect(home.run("demo/20261117T060000Z")).toMatchObject({ status: "superseded", attempts: [] });
    await waitFor(finished(), "finish");

    const ticks = readFileSync(home.paths.ticksFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(ticks).toEqual([expect.objectContaining({ mode: "manual", launched: 1, missed: 7, finished: 0, errors: [] })]);
  });

  test("a slot missed while the runner was ticking is an anomaly (runner_skipped)", async () => {
    execTask(home, "succeed", { max_delay: "15m" });
    appendTick(home.paths, { at: at(5) });
    const { events } = await home.tick(30);
    expect(events.map((e) => [e.type, e.reason ?? null])).toEqual([["missed", "runner_skipped"], ["anomaly", null]]);
  });

  test("slots before schedule_since are ignored (edit / resume)", async () => {
    execTask(home, "succeed", {
      schedule: { type: "cron", cron: "0 * * * *", timezone: "Europe/Madrid", starts_at: null, until: null },
      created_at: "2026-11-01T00:00:00+01:00",
      schedule_since: "2026-11-17T08:30:00+01:00",
    });
    const { events } = await home.tick(1);
    expect(events.map((e) => [e.type, e.run_ref])).toEqual([["launched", DEMO_REF]]);
    await waitFor(finished(), "finish");
  });

  test("a paused task's slots are cancelled", async () => {
    execTask(home, "succeed", { enabled: false });
    const { events } = await home.tick(1);
    expect(events).toEqual([expect.objectContaining({ type: "cancelled", reason: "paused" })]);
  });

  test("two concurrent ticks launch a slot once", async () => {
    execTask(home, "succeed");
    const spawnTick = () =>
      Bun.spawn([join(REPO, "bin", "agent-tasks"), "tick", "--json", "--now", at(1)], { env: home.env as Record<string, string>, cwd: home.project, stdout: "pipe", stderr: "pipe" });
    const procs = [spawnTick(), spawnTick()];
    const outputs = await Promise.all(procs.map(async (p) => JSON.parse(await new Response(p.stdout).text())));
    const launched = outputs.flatMap((o) => o.events).filter((e: { type: string }) => e.type === "launched");
    expect(launched).toHaveLength(1);
    expect(readdirSync(join(home.paths.runsDir, "demo")).filter((f) => f.endsWith(".json"))).toEqual(["20261117T080000Z.json"]);
    const run = await waitFor(finished(), "finish");
    expect(run.attempts).toHaveLength(1);
  });
});

describe("run and retry", () => {
  test("run <id> launches a manual occurrence now", async () => {
    execTask(home, "succeed", { schedule: { type: "once", at: "2026-12-01T09:00:00+01:00" } });
    const result = await home.cli("run", "demo", "--json", "--now", "2026-11-17T10:15:30+01:00");
    expect(result.code).toBe(0);
    const ref = "demo/manual-20261117T091530Z";
    expect(result.json()).toMatchObject({ run_ref: ref, events: [{ type: "launched", run_ref: ref }] });
    const run = await waitFor(finished(ref), "finish");
    expect(run).toMatchObject({ trigger: "manual", status: "succeeded", slot: "2026-11-17T10:15:30+01:00" });
  });

  test("retry gives a missed run its first attempt", async () => {
    execTask(home, "succeed", { max_delay: "15m" });
    await home.tick(60);
    expect(home.run(DEMO_REF).status).toBe("missed");
    const result = await home.cli("retry", DEMO_REF, "--json", "--now", at(61));
    expect(result.code).toBe(0);
    expect(result.json().events).toEqual([expect.objectContaining({ type: "launched", attempt: 1 })]);
    expect((await waitFor(finished(), "finish")).status).toBe("succeeded");
  });

  test("retry refuses runs that did not fail", async () => {
    execTask(home, "succeed");
    await home.tick(1);
    await waitFor(finished(), "finish");
    const result = await home.cli("retry", DEMO_REF);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("only failed, timed_out, missed runs can be retried");
  });
});

describe("task", () => {
  test("prints the task, the personal instructions and the finish command", async () => {
    mkdirSync(join(home.configDir, "instructions"), { recursive: true });
    writeFileSync(join(home.configDir, "instructions", "subagent.md"), "- Never use plain claude.\n");
    writeFileSync(join(home.configDir, "instructions", "work.md"), "- Work rules.\n");
    home.writeConfig({
      timezone: "Europe/Madrid",
      agent: { command: "bun", args: [FAKE_AGENT] },
      instructions: { subagent: ["subagent.md"] },
      profiles: [{ match: `${home.project}/**`, instructions: ["work.md"] }],
    });
    execTask(home, "hang");
    await home.tick(1);
    const result = await home.cli("task", DEMO_REF);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`Task "Demo task" (demo), slot ${T0}, attempt 1
Working directory: ${home.project}

Do the demo.
MODE: hang

User instructions (they take priority over the defaults above):

- Never use plain claude.

- Work rules.

When you are done, or if it fails, run:
  agent-tasks finish ${DEMO_REF} --status succeeded|failed --summary "<what you did, where the result is>" [--output-file <file>]
`);
    await home.cli("session", "close", DEMO_REF);
  });

  test("templates/task.md replaces the text and must keep {{finish_command}}", async () => {
    execTask(home, "hang");
    await home.tick(1);
    mkdirSync(join(home.configDir, "templates"), { recursive: true });
    writeFileSync(join(home.configDir, "templates", "task.md"), "Do {{title}} in {{cwd}}. Then: {{finish_command}}\n");
    const ok = await home.cli("task", DEMO_REF, "--json");
    expect(ok.json().text).toBe(`Do Demo task in ${home.project}. Then: agent-tasks finish ${DEMO_REF} --status succeeded|failed --summary "<what you did, where the result is>" [--output-file <file>]\n`);

    writeFileSync(join(home.configDir, "templates", "task.md"), "Do {{title}}.\n");
    const bad = await home.cli("task", DEMO_REF);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("does not use {{finish_command}}");
    await home.cli("session", "close", DEMO_REF);
  });
});

describe("prompt and quoting", () => {
  test("templates/prompt.md with quotes and spaces reaches an agent run through a shell intact", async () => {
    mkdirSync(join(home.configDir, "templates"), { recursive: true });
    const prompt = `Run "agent-tasks task {{run_ref}}" and follow it; it's $HOME \`now\``;
    writeFileSync(join(home.configDir, "templates", "prompt.md"), `${prompt}\n`);
    home.writeConfig({ agent: { command: "bun", args: [FAKE_AGENT], shell: true } });
    execTask(home, "succeed");
    await home.tick(1);
    const run = await waitFor(finished(), "finish");
    const log = readFileSync(join(home.dataDir, run.attempts[0]!.log!), "utf8");
    expect(log).toContain(`prompt: ${prompt.replace("{{run_ref}}", DEMO_REF)}\n`);
  });
});

describe("session commands", () => {
  test("status, read and close go through the launcher", async () => {
    execTask(home, "hang");
    await home.tick(1);
    const pid = pidOf(home.run(DEMO_REF));
    await waitFor(() => existsSync(join(home.dataDir, "runs/demo/20261117T080000Z.log")) && readFileSync(join(home.dataDir, "runs/demo/20261117T080000Z.log"), "utf8").includes("prompt:"), "output");

    const status = await home.cli("session", "status", DEMO_REF, "--json");
    expect(status.json()).toMatchObject({ state: "working", launcher: "process", handle: String(pid) });
    const read = await home.cli("session", "read", DEMO_REF);
    expect(read.stdout).toContain(`prompt: /run-agent-task ${DEMO_REF}`);
    const close = await home.cli("session", "close", DEMO_REF);
    expect(close.code).toBe(0);
    await waitFor(() => !pidAlive(pid), "the agent to be killed");
    expect(home.run(DEMO_REF).attempts[0]!.session).toMatchObject({ closed_at: expect.any(String) });
    expect((await home.cli("session", "status", DEMO_REF, "--json")).json().state).toBe("gone");
  });

  test("a run that was never launched has no session", async () => {
    home.writeTask(makeTask({ id: "demo", cwd: home.project, schedule: { type: "once", at: T0 }, max_delay: "15m" }));
    await home.tick(60);
    const result = await home.cli("session", "status", DEMO_REF);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("has no session");
  });
});
