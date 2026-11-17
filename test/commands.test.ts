import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configErrors } from "../src/config.ts";
import { type Run, type RunStatus, type Task, taskErrors } from "../src/schema.ts";
import { slotId } from "../src/slot.ts";
import { makeTask, makeTempHome, runCli, type TempHome } from "./helpers.ts";

const NOW = "--now=2026-11-16T15:00:00+01:00"; // a Monday
const BIN = resolve(import.meta.dir, "..", "bin", "agent-tasks");

let home: TempHome;
let project: string;
beforeEach(() => {
  home = makeTempHome();
  project = join(home.root, "Projects", "foo");
  mkdirSync(project, { recursive: true });
  // Timestamps the CLI writes use the config time zone; fix it so tests don't depend on the machine.
  home.writeConfig({ timezone: "Europe/Madrid" });
});
afterEach(() => home.cleanup());

/** Runs the real bin with `input` on stdin (the in-process runner has no stdin). */
async function runWithStdin(args: string[], input: string, cwd = project) {
  const proc = Bun.spawn([BIN, ...args], { cwd, env: { ...home.env }, stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

function readStoredTask(id: string, dir = home.paths.tasksDir): Task {
  return JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
}

function writeRun(taskId: string, slot: string, status: RunStatus, extra: Partial<Run> = {}): void {
  const run: Run = { task_id: taskId, slot, trigger: "schedule", status, reason: null, attempts: [], events: [], ...extra };
  const dir = join(home.paths.runsDir, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slotId(new Date(slot))}.json`), JSON.stringify(run));
}

/** Every file under the data folder with its content, to prove a command wrote nothing. */
function snapshot(dir = home.dataDir): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[p] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

const cronFlags = ["--cron", "0 9 * * 1", "--timezone", "Europe/Madrid", "--instructions", "Write the report."];

describe("add", () => {
  test("from flags: slug id, defaults filled in, next 3 runs", async () => {
    const r = await runCli(["add", "--title", "Weekly Déps report!", ...cronFlags, "--timeout", "30m", "--json", NOW], home, project);
    expect(r.code).toBe(0);
    const { task, next_runs } = r.json();
    expect(task.id).toBe("weekly-deps-report");
    expect(task).toMatchObject({
      cwd: "~/Projects/foo",
      enabled: true,
      timeout: "30m",
      schedule: { type: "cron", cron: "0 9 * * 1", timezone: "Europe/Madrid", starts_at: null, until: null },
      created_at: "2026-11-16T15:00:00+01:00",
      updated_at: "2026-11-16T15:00:00+01:00",
      created_by: { cwd: "~/Projects/foo", session: null },
      notify: null,
      schedule_since: null,
    });
    expect(next_runs).toEqual(["2026-11-23T09:00:00+01:00", "2026-11-30T09:00:00+01:00", "2026-12-07T09:00:00+01:00"]);
    expect(readStoredTask("weekly-deps-report")).toEqual(task);
    expect(taskErrors(task)).toEqual([]);
  });

  test("--notify on add", async () => {
    const r = await runCli(["add", "--title", "Notified", ...cronFlags, "--notify", "succeeded,failed", "--keep-open", "always", "--json", NOW], home, project);
    expect(r.code).toBe(0);
    expect(r.json().task).toMatchObject({ notify: ["succeeded", "failed"], keep_open: "always" });
  });

  test("records the creating terminal from $HC_TERMINAL_ID and accepts --cwd and --id", async () => {
    home.env.HC_TERMINAL_ID = "t42";
    const r = await runCli(["add", "--title", "X", "--id", "custom-id", "--cwd", "Projects/foo", ...cronFlags, "--json", NOW], home, home.root);
    expect(r.code).toBe(0);
    expect(r.json().task).toMatchObject({ id: "custom-id", cwd: "~/Projects/foo", created_by: { cwd: "~", session: "t42" } });
  });

  test("human output prints the id and next runs", async () => {
    const r = await runCli(["add", "--title", "Weekly", ...cronFlags, NOW], home, project);
    expect(r.stdout).toContain("Created task weekly");
    expect(r.stdout).toContain("2026-11-23T09:00:00+01:00");
  });

  test("a full task JSON on stdin, with --json-input or -", async () => {
    const json = JSON.stringify({ title: "Once thing", instructions: "Do it.", schedule: { type: "once", at: "2026-11-20T09:00:00+01:00" } });
    const a = await runWithStdin(["add", "--json-input", "--json", NOW], json);
    expect(a.code).toBe(0);
    expect(a.json().task).toMatchObject({ id: "once-thing", cwd: "~/Projects/foo", schedule: { type: "once", at: "2026-11-20T09:00:00+01:00" } });
    expect(a.json().next_runs).toEqual(["2026-11-20T09:00:00+01:00"]);
    const b = await runWithStdin(["add", "-", "--title", "Overridden", "--json", NOW], json);
    expect(b.json().task).toMatchObject({ id: "overridden", title: "Overridden" });
  });

  test("--instructions-file from a file and from stdin", async () => {
    writeFileSync(join(project, "prompt.md"), "From a file.\n");
    const a = await runCli(["add", "--title", "A", "--cron", "0 9 * * *", "--instructions-file", "prompt.md", "--json", NOW], home, project);
    expect(a.json().task.instructions).toBe("From a file.");
    const b = await runWithStdin(["add", "--title", "B", "--cron", "0 9 * * *", "--instructions-file", "-", "--json", NOW], "From stdin.\n");
    expect(b.json().task.instructions).toBe("From stdin.");
  });

  test("id collision adds a suffix; archived ids count as taken; an explicit taken id fails", async () => {
    const add = (extra: string[] = []) => runCli(["add", "--title", "Weekly report", ...cronFlags, "--json", ...extra, NOW], home, project);
    expect((await add()).json().task.id).toBe("weekly-report");
    expect((await add()).json().task.id).toBe("weekly-report-2");
    await runCli(["rm", "weekly-report-2", NOW], home);
    expect((await add()).json().task.id).toBe("weekly-report-3");
    const taken = await add(["--id", "weekly-report"]);
    expect(taken.code).toBe(1);
    expect(taken.json().error.code).toBe("conflict");
  });

  test("a cwd that does not exist is rejected and nothing is written", async () => {
    const r = await runCli(["add", "--title", "X", "--cwd", "/nope/missing", ...cronFlags, "--json", NOW], home, project);
    expect(r.code).toBe(1);
    expect(r.json().error).toMatchObject({ code: "invalid_cwd" });
    expect(existsSync(home.paths.tasksDir) ? readdirSync(home.paths.tasksDir) : []).toEqual([]);
  });

  test("a bad cron, a bad duration and a missing schedule are rejected", async () => {
    const bad = await runCli(["add", "--title", "X", "--cron", "0 9 * *", "--instructions", "x", "--timeout", "45", "--json", NOW], home, project);
    expect(bad.code).toBe(1);
    expect(bad.json().error.details).toEqual([
      "schedule.cron: must have 5 fields (minute hour day month weekday), got 4",
      'timeout: must be a duration such as 15m, 2h or 1d (got "45")',
    ]);
    const none = await runCli(["add", "--title", "X", "--instructions", "x", NOW], home, project);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("--at <iso> or --cron <expr>");
    const both = await runCli(["add", "--title", "X", "--at", "2026-11-20T09:00:00Z", "--cron", "0 9 * * *", "--instructions", "x", NOW], home, project);
    expect(both.code).toBe(2);
  });

  test("an id left with run history by a removed task is taken", async () => {
    writeRun("weekly-report", "2026-11-09T08:00:00Z", "succeeded");
    const r = await runCli(["add", "--title", "Weekly report", ...cronFlags, "--json", NOW], home, project);
    expect(r.json().task.id).toBe("weekly-report-2");
    expect((await runCli(["add", "--title", "X", "--id", "weekly-report", ...cronFlags, "--json", NOW], home, project)).json().error.code).toBe("conflict");
  });

  test("a cwd of the wrong type is a validation error, not a crash", async () => {
    const r = await runWithStdin(["add", "-", "--json", NOW], JSON.stringify({ title: "X", instructions: "x", cwd: 5, schedule: { type: "cron", cron: "0 9 * * *" } }));
    expect(r.code).toBe(1);
    expect(r.json().error.details).toEqual(["cwd: must be a non-empty string"]);
  });

  test("unknown fields in the stdin JSON are rejected", async () => {
    const r = await runWithStdin(["add", "-", "--json", NOW], JSON.stringify({ title: "X", instructions: "x", schedule: { type: "cron", cron: "0 9 * * *" }, color: "red" }));
    expect(r.code).toBe(1);
    expect(r.json().error.details[0]).toStartWith("color: unknown field");
  });
});

describe("list", () => {
  beforeEach(() => {
    home.writeTask(makeTask({ id: "active-one", cwd: "~/Projects/foo" }));
    home.writeTask(makeTask({ id: "paused-one", cwd: "~/Projects/bar", enabled: false }));
    home.writeTask(makeTask({ id: "done-once", cwd: "~/Projects/foo", schedule: { type: "once", at: "2026-11-10T09:00:00Z" } }));
    writeRun("done-once", "2026-11-10T09:00:00Z", "succeeded");
    writeRun("active-one", "2026-11-02T08:00:00Z", "failed"); // older than 7 days
    writeRun("active-one", "2026-11-09T15:00:00Z", "failed"); // just inside the 7 days
    writeRun("active-one", "2026-11-10T08:00:00Z", "timed_out");
    writeRun("active-one", "2026-11-11T08:00:00Z", "missed", { reason: "runner_offline" });
    writeRun("active-one", "2026-11-16T08:00:00Z", "succeeded");
  });

  test("shows next run, last status and 7-day failed/missed counts; finished tasks hidden by default", async () => {
    const r = await runCli(["list", "--json", NOW], home);
    expect(r.code).toBe(0);
    const tasks = r.json().tasks;
    expect(tasks.map((t: { id: string }) => t.id)).toEqual(["active-one", "paused-one"]);
    expect(tasks[0]).toMatchObject({ state: "active", next_run: "2026-11-23T09:00:00+01:00", last_status: "succeeded", failed_7d: 2, missed_7d: 1 });
    expect(tasks[1]).toMatchObject({ state: "paused", next_run: null });
    const human = await runCli(["list", NOW], home);
    expect(human.stdout.split("\n")[0]).toMatch(/^\s+ID\s+SCHEDULE\s+NEXT\s+LAST 10\s+FOLDER$/);
    expect(human.stdout).toContain("active-one");
  });

  test("--status, --cwd and --all filter", async () => {
    await runCli(["rm", "paused-one", NOW], home);
    const ids = async (...args: string[]) => (await runCli(["list", "--json", ...args, NOW], home)).json().tasks.map((t: { id: string }) => t.id);
    expect(await ids("--all")).toEqual(["active-one", "done-once", "paused-one"]);
    expect(await ids("--status", "finished,archived")).toEqual(["done-once", "paused-one"]);
    expect(await ids("--status", "active")).toEqual(["active-one"]);
    expect(await ids("--all", "--cwd", "~/Projects/foo")).toEqual(["active-one", "done-once"]);
    expect((await runCli(["list", "--status", "bogus", NOW], home)).code).toBe(2);
  });

  test("an empty data folder lists nothing", async () => {
    const empty = makeTempHome();
    try {
      const r = await runCli(["list", NOW], empty);
      expect(r.stdout).toStartWith("No tasks.");
    } finally {
      empty.cleanup();
    }
  });
});

describe("show", () => {
  test("definition, resolved settings with sources, next 3 runs and last 10 occurrences", async () => {
    home.writeConfig({ profiles: [{ match: "~/Projects/**", agent: { command: "clc", shell: true }, timeout: "1h" }] });
    home.writeTask(makeTask({ cwd: "~/Projects/foo" }));
    for (let d = 1; d <= 12; d++) writeRun("weekly-report", `2026-11-${String(d).padStart(2, "0")}T08:00:00Z`, "succeeded");
    const r = await runCli(["show", "weekly-report", "--json", NOW], home);
    expect(r.code).toBe(0);
    const out = r.json();
    expect(out.state).toBe("active");
    expect(out.resolved.agent).toEqual({ command: "clc", args: [], shell: true });
    expect(out.sources.agent).toEqual({ layer: "profile", detail: "~/Projects/**" });
    expect(out.sources.timeout).toEqual({ layer: "profile", detail: "~/Projects/**" });
    expect(out.next_runs).toHaveLength(3);
    expect(out.runs).toHaveLength(10);
    expect(out.runs[0].slot).toBe("2026-11-12T08:00:00Z");

    const human = await runCli(["show", "weekly-report", NOW], home);
    expect(human.stdout).toContain("Weekly report (weekly-report) · active");
    expect(human.stdout).toContain("← profile ~/Projects/**");
    expect(human.stdout).toContain("Last 10 occurrences");
  });

  test("an unknown id is not found; an archived task is shown as archived", async () => {
    expect((await runCli(["show", "nope", NOW], home)).code).toBe(1);
    home.writeTask(makeTask());
    await runCli(["rm", "weekly-report", NOW], home);
    const r = await runCli(["show", "weekly-report", "--json", NOW], home);
    expect(r.json()).toMatchObject({ state: "archived", next_runs: [] });
  });
});

describe("edit", () => {
  beforeEach(() => home.writeTask(makeTask({ cwd: "~/Projects/foo" })));

  test("changes fields from flags, sets updated_at and revalidates", async () => {
    const r = await runCli(["edit", "weekly-report", "--title", "New title", "--timeout", "1h", "--json", NOW], home);
    expect(r.code).toBe(0);
    expect(r.json().changed).toEqual(["title", "timeout"]);
    const task = readStoredTask("weekly-report");
    expect(task).toMatchObject({ title: "New title", timeout: "1h", updated_at: "2026-11-16T15:00:00+01:00", id: "weekly-report" });
    expect(task.schedule_since).toBeUndefined();

    const cleared = await runCli(["edit", "weekly-report", "--timeout", "", "--json", NOW], home);
    expect(cleared.json().task.timeout).toBeNull();

    const bad = await runCli(["edit", "weekly-report", "--catch-up", "first", "--json", NOW], home);
    expect(bad.code).toBe(1);
    expect(bad.json().error.details).toEqual(["catch_up: must be one of: latest, all, none"]);
    expect(readStoredTask("weekly-report").catch_up).toBeNull();
  });

  test("--notify sets a list, none sets [], an empty value resets to null", async () => {
    const set = await runCli(["edit", "weekly-report", "--notify", "succeeded, failed", "--json", NOW], home);
    expect(set.code).toBe(0);
    expect(readStoredTask("weekly-report").notify).toEqual(["succeeded", "failed"]);
    await runCli(["edit", "weekly-report", "--notify", "none", "--json", NOW], home);
    expect(readStoredTask("weekly-report").notify).toEqual([]);
    await runCli(["edit", "weekly-report", "--notify", "", "--json", NOW], home);
    expect(readStoredTask("weekly-report").notify).toBeNull();
    const bad = await runCli(["edit", "weekly-report", "--notify", "succeeded,anomaly", "--json", NOW], home);
    expect(bad.code).toBe(1);
    expect(bad.json().error.details).toEqual(["notify: anomaly is not about a task's runs; choose it in a notifier's `events` instead"]);
    const resolved = await runCli(["config", "resolve", "weekly-report", "--json", NOW], home);
    expect(resolved.json().values.notify).toBeNull();
  });

  test("a JSON patch from --file or stdin; schedule merges when the type stays", async () => {
    writeFileSync(join(home.root, "patch.json"), JSON.stringify({ schedule: { cron: "0 10 * * 1" }, retries: 2 }));
    const a = await runCli(["edit", "weekly-report", "--file", "patch.json", "--json", NOW], home);
    expect(a.code).toBe(0);
    expect(a.json().task.schedule).toEqual({ type: "cron", cron: "0 10 * * 1", timezone: "Europe/Madrid", starts_at: null, until: null });
    expect(a.json().task.retries).toBe(2);

    const b = await runWithStdin(["edit", "weekly-report", "-", "--json", NOW], JSON.stringify({ schedule: { type: "once", at: "2026-12-01T09:00:00Z" } }));
    expect(b.code).toBe(0);
    expect(b.json().task.schedule).toEqual({ type: "once", at: "2026-12-01T09:00:00Z" });

    writeFileSync(join(home.root, "id.json"), JSON.stringify({ id: "other" }));
    expect((await runCli(["edit", "weekly-report", "--file", "id.json", NOW], home)).code).toBe(2);
  });

  test("no options is a usage error; identical values are reported as no change", async () => {
    expect((await runCli(["edit", "weekly-report", NOW], home)).code).toBe(2);
    const same = await runCli(["edit", "weekly-report", "--title", "Weekly report", NOW], home);
    expect(same.stdout).toBe("No changes to weekly-report.\n");
    expect(readStoredTask("weekly-report").updated_at).toBe("2026-11-01T00:00:00Z");
  });

  test("a schedule change sets schedule_since so the old schedule does not produce a burst of missed", async () => {
    home.writeTask(makeTask({ id: "frequent", schedule: { type: "cron", cron: "*/15 * * * *", timezone: "UTC" } }));
    const control = makeTask({ id: "control", schedule: { type: "cron", cron: "0 * * * *", timezone: "UTC" } });
    home.writeTask(control);

    const r = await runCli(["edit", "frequent", "--cron", "0 * * * *", "--json", "--now=2026-11-16T10:00:00Z"], home);
    expect(r.code).toBe(0);
    expect(r.json().task.schedule_since).toBe("2026-11-16T11:00:00+01:00");

    const due = (await runCli(["due", "--json", "--now=2026-11-16T10:05:00Z"], home)).json();
    const byId = Object.fromEntries(due.tasks.map((t: { task_id: string }) => [t.task_id, t]));
    expect(byId.frequent.missed).toEqual([]);
    expect(byId.frequent.candidates.map((s: { id: string }) => s.id)).toEqual(["20261116T100000Z"]);
    // Same schedule without the edit: every hour since created_at is missed.
    expect(byId.control.missed.length).toBeGreaterThan(300);
  });

  test("moving a finished once task to a new time makes it active again", async () => {
    home.writeTask(makeTask({ id: "once", schedule: { type: "once", at: "2026-11-10T09:00:00Z" } }));
    writeRun("once", "2026-11-10T09:00:00Z", "missed", { reason: "runner_offline" });
    expect((await runCli(["show", "once", "--json", NOW], home)).json().state).toBe("finished");
    const r = await runCli(["edit", "once", "--at", "2026-11-20T09:00:00Z", "--json", NOW], home);
    expect(r.json().next_runs).toEqual(["2026-11-20T10:00:00+01:00"]);
    expect((await runCli(["show", "once", "--json", NOW], home)).json().state).toBe("active");
    const due = (await runCli(["due", "--json", "--now=2026-11-20T09:01:00Z"], home)).json();
    expect(due.tasks[0].candidates.map((s: { id: string }) => s.id)).toEqual(["20261120T090000Z"]);
  });

  test("a new cwd must exist", async () => {
    const r = await runCli(["edit", "weekly-report", "--cwd", "/nope/missing", "--json", NOW], home);
    expect(r.json().error.code).toBe("invalid_cwd");
  });
});

describe("pause / resume", () => {
  test("toggle enabled; resume sets schedule_since; paused slots are cancelled, none missed after resume", async () => {
    home.writeTask(makeTask({ schedule: { type: "cron", cron: "0 * * * *", timezone: "UTC" } }));
    const p = await runCli(["pause", "weekly-report", "--json", "--now=2026-11-16T08:00:00Z"], home);
    expect(p.json()).toMatchObject({ changed: true, state: "paused", next_runs: [] });
    expect(readStoredTask("weekly-report").enabled).toBe(false);

    const duePaused = (await runCli(["due", "--json", "--now=2026-11-16T09:30:00Z"], home)).json();
    expect(duePaused.tasks[0].cancelled.length).toBeGreaterThan(0);
    expect(duePaused.tasks[0].missed).toEqual([]);

    expect((await runCli(["pause", "weekly-report", "--json", "--now=2026-11-16T08:00:00Z"], home)).json().changed).toBe(false);

    const r = await runCli(["resume", "weekly-report", "--json", "--now=2026-11-16T12:30:00Z"], home);
    expect(r.json()).toMatchObject({ changed: true, state: "active", next_runs: ["2026-11-16T13:00:00Z", "2026-11-16T14:00:00Z", "2026-11-16T15:00:00Z"] });
    expect(readStoredTask("weekly-report")).toMatchObject({ enabled: true, schedule_since: "2026-11-16T13:30:00+01:00", updated_at: "2026-11-16T13:30:00+01:00" });

    const due = (await runCli(["due", "--json", "--now=2026-11-16T13:05:00Z"], home)).json();
    expect(due.tasks).toEqual([
      { task_id: "weekly-report", candidates: [{ slot: "2026-11-16T13:00:00Z", id: "20261116T130000Z" }], missed: [], superseded: [], cancelled: [] },
    ]);
  });

  test("unknown id", async () => {
    expect((await runCli(["pause", "nope", NOW], home)).code).toBe(1);
  });
});

describe("rm", () => {
  test("moves the task to the archive, paused, keeps runs and prints how to restore", async () => {
    home.writeTask(makeTask());
    writeRun("weekly-report", "2026-11-09T08:00:00Z", "succeeded");
    const r = await runCli(["rm", "weekly-report", NOW], home);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("To restore it:");
    expect(r.stdout).toContain("agent-tasks resume weekly-report");
    expect(existsSync(join(home.paths.tasksDir, "weekly-report.json"))).toBe(false);
    expect(readStoredTask("weekly-report", home.paths.archiveDir).enabled).toBe(false);
    expect(existsSync(join(home.paths.runsDir, "weekly-report", "20261109T080000Z.json"))).toBe(true);
    expect((await runCli(["runs", "weekly-report", "--json", NOW], home)).json().runs).toHaveLength(1);
    expect((await runCli(["rm", "weekly-report", NOW], home)).code).toBe(1);
  });

  test("warns about occurrences still in progress", async () => {
    home.writeTask(makeTask());
    writeRun("weekly-report", "2026-11-16T08:00:00Z", "running");
    const r = await runCli(["rm", "weekly-report", "--json", NOW], home);
    expect(r.json().unfinished_runs).toEqual(["weekly-report/20261116T080000Z"]);
  });
});

describe("runs", () => {
  beforeEach(() => {
    home.writeTask(makeTask({ id: "a" }));
    home.writeTask(makeTask({ id: "b" }));
    writeRun("a", "2026-11-01T08:00:00Z", "succeeded");
    writeRun("a", "2026-11-14T08:00:00Z", "failed");
    writeRun("b", "2026-11-15T08:00:00Z", "missed", { reason: "runner_offline" });
    writeRun("b", "2026-11-16T08:00:00Z", "succeeded");
  });

  const refs = async (...args: string[]) => (await runCli(["runs", "--json", ...args, NOW], home)).json().runs.map((r: { ref: string }) => r.ref);

  test("all tasks, newest first", async () => {
    expect(await refs()).toEqual(["b/20261116T080000Z", "b/20261115T080000Z", "a/20261114T080000Z", "a/20261101T080000Z"]);
  });

  test("filters by task, status, since and limit", async () => {
    expect(await refs("a")).toEqual(["a/20261114T080000Z", "a/20261101T080000Z"]);
    expect(await refs("--status", "failed,missed")).toEqual(["b/20261115T080000Z", "a/20261114T080000Z"]);
    expect(await refs("--since", "7d")).toEqual(["b/20261116T080000Z", "b/20261115T080000Z", "a/20261114T080000Z"]);
    expect(await refs("--since", "2026-11-15T00:00:00Z")).toEqual(["b/20261116T080000Z", "b/20261115T080000Z"]);
    expect(await refs("--limit", "1")).toEqual(["b/20261116T080000Z"]);
  });

  test("bad filters are usage errors; an unknown task is not found", async () => {
    expect((await runCli(["runs", "--status", "nope", NOW], home)).code).toBe(2);
    expect((await runCli(["runs", "--since", "soon", NOW], home)).code).toBe(2);
    expect((await runCli(["runs", "--limit", "0", NOW], home)).code).toBe(2);
    expect((await runCli(["runs", "nope", NOW], home)).code).toBe(1);
  });

  test("human output is a table", async () => {
    const r = await runCli(["runs", NOW], home);
    expect(r.stdout.split("\n")[0]).toMatch(/^RUN\s+SLOT\s+STATUS\s+START\s+DURATION\s+ATT\.\s+SUMMARY$/);
    expect(r.stdout).toContain("runner_offline");
  });
});

describe("due", () => {
  test("lists candidates, missed, superseded and cancelled without writing anything", async () => {
    home.writeConfig({ timezone: "Europe/Madrid", runner: { every: "5m" } });
    home.writeTask(makeTask({ id: "hourly", catch_up: "latest", max_delay: "3h", created_at: "2026-11-16T09:30:00Z", schedule: { type: "cron", cron: "0 * * * *", timezone: "UTC" } }));
    home.writeTask(makeTask({ id: "late", created_at: "2026-11-16T05:30:00Z", schedule: { type: "cron", cron: "0 6 * * *", timezone: "UTC" } }));
    home.writeTask(makeTask({ id: "paused", enabled: false, created_at: "2026-11-16T09:30:00Z", schedule: { type: "cron", cron: "0 * * * *", timezone: "UTC" } }));
    mkdirSync(home.paths.stateDir, { recursive: true });
    writeFileSync(home.paths.ticksFile, `${JSON.stringify({ at: "2026-11-16T06:05:00Z" })}\n`);
    const before = snapshot();

    const r = await runCli(["due", "--json", "--now=2026-11-16T12:10:00Z"], home);
    expect(r.code).toBe(0);
    const byId = Object.fromEntries(r.json().tasks.map((t: { task_id: string }) => [t.task_id, t]));
    expect(byId.hourly.candidates.map((s: { id: string }) => s.id)).toEqual(["20261116T120000Z"]);
    expect(byId.hourly.superseded.map((s: { id: string }) => s.id)).toEqual(["20261116T100000Z", "20261116T110000Z"]);
    expect(byId.late.missed).toEqual([{ slot: "2026-11-16T06:00:00Z", id: "20261116T060000Z", reason: "runner_skipped" }]);
    expect(byId.paused.cancelled.map((s: { reason: string }) => s.reason)).toEqual(["paused", "paused", "paused"]);
    expect(r.json().totals).toEqual({ candidates: 1, missed: 1, superseded: 2, cancelled: 3 });

    const human = await runCli(["due", "--now=2026-11-16T12:10:00Z"], home);
    expect(human.stdout).toContain("would launch");
    expect(snapshot()).toEqual(before);
  });

  test("nothing due", async () => {
    expect((await runCli(["due", NOW], home)).stdout).toBe("Nothing due.\n");
  });
});

describe("examples", () => {
  const root = resolve(import.meta.dir, "..", "examples");
  test("config.example.json is a valid config", () => {
    expect(configErrors(JSON.parse(readFileSync(join(root, "config.example.json"), "utf8")))).toEqual([]);
  });
  test("example tasks are valid, one once and one cron", () => {
    const tasks = readdirSync(join(root, "tasks")).map((f) => JSON.parse(readFileSync(join(root, "tasks", f), "utf8")));
    for (const t of tasks) expect(taskErrors(t)).toEqual([]);
    expect(tasks.map((t) => t.schedule.type).sort()).toEqual(["cron", "once"]);
  });
});
