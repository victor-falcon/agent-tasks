import { describe, expect, test } from "bun:test";
import { ValidationError } from "../src/errors.ts";
import { runErrors, taskErrors, validateRun, validateTask } from "../src/schema.ts";
import { makeTask } from "./helpers.ts";

describe("task validation", () => {
  test("the example from the design doc is valid", () => {
    expect(
      taskErrors({
        id: "weekly-deps-report",
        title: "Weekly dependencies report",
        description: "Why the task exists; read by a person.",
        cwd: "~/Projects/foo",
        machine: "local",
        instructions: "Full prompt for the subagent.",
        schedule: { type: "cron", cron: "0 9 * * 1", timezone: "Europe/Madrid", starts_at: null, until: null },
        agent: null,
        catch_up: "latest",
        max_delay: "2h",
        timeout: "45m",
        retries: 0,
        keep_open: "on_failure",
        enabled: true,
        created_at: "2026-11-16T15:00:00+01:00",
        created_by: { cwd: "~/Projects/foo", session: "t12" },
        updated_at: "2026-11-16T15:00:00+01:00",
      }),
    ).toEqual([]);
    expect(taskErrors(makeTask({ schedule: { type: "once", at: "2026-11-20T09:00:00+01:00" } }))).toEqual([]);
    expect(taskErrors(makeTask({ agent: { command: "clc", args: ["-p"], shell: true } }))).toEqual([]);
  });

  test("machine is required and must be a machine name", () => {
    expect(taskErrors(makeTask({ machine: "mac-mini-2" }))).toEqual([]);
    const { machine: _, ...withoutMachine } = makeTask();
    const invalid = "machine: must be a machine name: lowercase letters, digits and dashes, starting with a letter";
    expect(taskErrors(withoutMachine)).toEqual([invalid]);
    for (const bad of ["", "Mac", "2mac", "mac-", "mac mini", 5]) {
      expect(taskErrors({ ...makeTask(), machine: bad })).toEqual([`${invalid} (got ${JSON.stringify(bad)})`]);
    }
  });

  test("notify: run events, [] for never, null for the notifiers' own events", () => {
    expect(taskErrors(makeTask({ notify: ["succeeded", "failed"] }))).toEqual([]);
    expect(taskErrors(makeTask({ notify: [] }))).toEqual([]);
    expect(taskErrors(makeTask({ notify: null }))).toEqual([]);
    expect(taskErrors({ ...makeTask(), notify: "failed" })[0]).toStartWith("notify: must be an array of events (launched, succeeded, failed, timed_out, missed, blocked)");
    expect(taskErrors({ ...makeTask(), notify: ["failed", "anomaly"] })).toEqual(["notify: anomaly is not about a task's runs; choose it in a notifier's `events` instead"]);
    expect(taskErrors({ ...makeTask(), notify: ["anomaly", "runner_recovered"] })).toEqual(["notify: anomaly, runner_recovered are not about a task's runs; choose them in a notifier's `events` instead"]);
    expect(taskErrors({ ...makeTask(), notify: ["done"] })).toEqual(['notify: unknown event "done" (allowed: launched, succeeded, failed, timed_out, missed, blocked)']);
    expect(taskErrors({ ...makeTask(), notify: ["failed", "failed"] })).toEqual(["notify: lists an event twice"]);
  });

  test("reports every problem with its path", () => {
    const errors = taskErrors({
      ...makeTask(),
      id: "Bad Id",
      title: "",
      schedule: { type: "cron", cron: "0 9 * * 1", timezone: "Nowhere/City", until: "tomorrow" },
      catch_up: "first",
      timeout: "45",
      retries: -1,
      enabled: "yes",
      extra: 1,
    });
    expect(errors).toEqual([
      "extra: unknown field (allowed: id, title, description, cwd, machine, instructions, schedule, agent, catch_up, max_delay, timeout, retries, keep_open, notify, enabled, created_at, created_by, updated_at, schedule_since)",
      "id: must be a slug: lowercase letters, digits and dashes (max 64 chars)",
      "title: must be a non-empty string",
      'schedule.timezone: must be an IANA time zone such as Europe/Madrid (got "Nowhere/City")',
      'schedule.until: must be an ISO 8601 timestamp with offset (got "tomorrow")',
      "catch_up: must be one of: latest, all, none",
      'timeout: must be a duration such as 15m, 2h or 1d (got "45")',
      "retries: must be an integer >= 0",
      "enabled: must be a boolean",
    ]);
  });

  test("schedules", () => {
    expect(taskErrors(makeTask({ schedule: { type: "once", at: "2026-11-20 09:00" } }))).toEqual([
      'schedule.at: must be an ISO 8601 timestamp with offset (got "2026-11-20 09:00")',
    ]);
    expect(taskErrors(makeTask({ schedule: { type: "cron", cron: "61 * * * *" } }))[0]).toMatch(/^schedule\.cron: /);
    expect(taskErrors(makeTask({ schedule: { type: "cron", cron: "0 0 9 * * 1" } }))).toEqual(["schedule.cron: must have 5 fields (minute hour day month weekday), got 6"]);
    expect(taskErrors(makeTask({ schedule: { type: "cron", cron: "0 9 * * *", starts_at: "2026-12-01T00:00:00Z", until: "2026-11-01T00:00:00Z" } }))).toEqual([
      "schedule.until: must be later than starts_at",
    ]);
    expect(taskErrors(makeTask({ schedule: { type: "weekly" } as never }))).toEqual(['schedule.type: must be "once" or "cron"']);
  });

  test("impossible dates are rejected instead of rolling over", () => {
    for (const at of ["2026-02-31T09:00:00Z", "2026-11-17T24:00:00Z", "2026-13-01T09:00:00Z", "2026-11-17T09:60:00+01:00"]) {
      expect(taskErrors(makeTask({ schedule: { type: "once", at } }))).toEqual([`schedule.at: must be an ISO 8601 timestamp with offset (got "${at}")`]);
    }
    expect(taskErrors(makeTask({ schedule: { type: "once", at: "2028-02-29T09:00:00.250+01:00" } }))).toEqual([]);
  });

  test("cron nicknames and expressions that never fire are rejected", () => {
    expect(taskErrors(makeTask({ schedule: { type: "cron", cron: "@daily" } }))).toEqual(["schedule.cron: nicknames such as @daily are not supported; use 5 fields, e.g. 0 9 * * *"]);
    expect(taskErrors(makeTask({ schedule: { type: "cron", cron: "0 0 31 2 *" } }))).toEqual(["schedule.cron: never fires"]);
  });

  test("durations are capped", () => {
    expect(taskErrors(makeTask({ timeout: "99999999d" }))).toEqual(['timeout: must be a duration such as 15m, 2h or 1d (got "99999999d")']);
  });

  test("validateTask throws a ValidationError", () => {
    expect(() => validateTask({})).toThrow(ValidationError);
  });
});

describe("run validation", () => {
  const run = {
    task_id: "weekly-deps-report",
    slot: "2026-11-17T09:00:00+01:00",
    trigger: "schedule",
    status: "running",
    reason: null,
    attempts: [
      {
        n: 1,
        started_at: "2026-11-17T09:12:03+01:00",
        finished_at: null,
        session: { launcher: "herdr", handle: "t45", name: "task-weekly-deps-report-20261117t0800" },
        agent: { command: "clc", shell: true, from: "profile ~/Projects/**" },
        status: "running",
        summary: null,
        log: "runs/weekly-deps-report/20261117T080000Z.log",
      },
    ],
    events: [
      { at: "2026-11-17T09:12:03+01:00", event: "claimed", by: "tick" },
      { at: "2026-11-17T09:12:04+01:00", event: "launched", handle: "t45" },
    ],
  };

  test("the example from the design doc is valid", () => {
    expect(runErrors(run)).toEqual([]);
    expect(validateRun(run)).toBe(run as never);
  });

  test("reports problems", () => {
    expect(runErrors({ ...run, status: "done", trigger: "cron", attempts: [{ ...run.attempts[0], n: 0 }], events: [{ event: "x" }] })).toEqual([
      "trigger: must be one of: schedule, manual",
      "status: must be one of: running, succeeded, failed, timed_out, blocked, missed, superseded, cancelled",
      "attempts[0].n: must be an integer >= 1",
      "events[0].at: must be an ISO 8601 timestamp with offset (got undefined)",
    ]);
  });
});
