import { describe, expect, test } from "bun:test";
import { formatDuration, parseDuration } from "../src/duration.ts";
import { defaultMaxDelay, isTaskFinished, nextRunTimes, type PlanInput, planSlots, slotsInWindow } from "../src/schedule.ts";
import type { CatchUp, Schedule } from "../src/schema.ts";
import { formatInZone } from "../src/time.ts";
import { makeTask } from "./helpers.ts";

const iso = (dates: { at: Date }[] | Date[]) => dates.map((d) => (d instanceof Date ? d : d.at).toISOString());
const d = (s: string) => new Date(s);

describe("durations", () => {
  test("parse and format", () => {
    expect(parseDuration("15m")).toBe(15 * 60_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("30s")).toBe(30_000);
    for (const bad of ["", "15", "m", "1.5h", "-5m", "0m", "15 m", "1w"]) expect(() => parseDuration(bad)).toThrow();
    expect(formatDuration(5_400_000)).toBe("1h30m");
    expect(formatDuration(15 * 60_000)).toBe("15m");
  });

  test("default max_delay is 3 × runner.every, at least 15m", () => {
    expect(defaultMaxDelay(parseDuration("5m"))).toBe(parseDuration("15m"));
    expect(defaultMaxDelay(parseDuration("1m"))).toBe(parseDuration("15m"));
    expect(defaultMaxDelay(parseDuration("10m"))).toBe(parseDuration("30m"));
  });
});

describe("slotsInWindow", () => {
  const madrid = "Europe/Madrid";

  test("cron in a time zone, both ends inclusive", () => {
    const s: Schedule = { type: "cron", cron: "0 9 * * *" };
    expect(iso(slotsInWindow(s, d("2026-11-16T08:00:00Z"), d("2026-11-18T08:00:00Z"), madrid))).toEqual([
      "2026-11-16T08:00:00.000Z",
      "2026-11-17T08:00:00.000Z",
      "2026-11-18T08:00:00.000Z",
    ]);
  });

  test("DST spring forward in Europe/Madrid: 09:00 local stays 09:00, the UTC hour moves", () => {
    const s: Schedule = { type: "cron", cron: "0 9 * * *" };
    expect(iso(slotsInWindow(s, d("2026-03-28T00:00:00Z"), d("2026-03-30T23:00:00Z"), madrid))).toEqual([
      "2026-03-28T08:00:00.000Z",
      "2026-03-29T07:00:00.000Z",
      "2026-03-30T07:00:00.000Z",
    ]);
  });

  test("DST: a slot in the skipped hour still runs once; one in the repeated hour runs once", () => {
    const s: Schedule = { type: "cron", cron: "30 2 * * *" };
    // 2026-03-29 02:30 does not exist in Madrid: it runs at 03:00 local.
    expect(iso(slotsInWindow(s, d("2026-03-28T00:00:00Z"), d("2026-03-30T12:00:00Z"), madrid))).toEqual([
      "2026-03-28T01:30:00.000Z",
      "2026-03-29T01:00:00.000Z",
      "2026-03-30T00:30:00.000Z",
    ]);
    // 2026-10-25 02:30 happens twice in Madrid: only the first one is a slot.
    expect(iso(slotsInWindow(s, d("2026-10-24T00:00:00Z"), d("2026-10-26T12:00:00Z"), madrid))).toEqual([
      "2026-10-24T00:30:00.000Z",
      "2026-10-25T00:30:00.000Z",
      "2026-10-26T01:30:00.000Z",
    ]);
  });

  test("starts_at and until narrow the window (both inclusive)", () => {
    const s: Schedule = { type: "cron", cron: "0 * * * *", starts_at: "2026-11-17T10:00:00Z", until: "2026-11-17T12:00:00Z" };
    expect(iso(slotsInWindow(s, d("2026-11-17T00:00:00Z"), d("2026-11-17T23:00:00Z"), "UTC"))).toEqual([
      "2026-11-17T10:00:00.000Z",
      "2026-11-17T11:00:00.000Z",
      "2026-11-17T12:00:00.000Z",
    ]);
    expect(slotsInWindow(s, d("2026-11-18T00:00:00Z"), d("2026-11-19T00:00:00Z"), "UTC")).toEqual([]);
  });

  test("once", () => {
    const s: Schedule = { type: "once", at: "2026-11-20T09:00:00+01:00" };
    expect(iso(slotsInWindow(s, d("2026-11-20T00:00:00Z"), d("2026-11-20T08:00:00Z"), madrid))).toEqual(["2026-11-20T08:00:00.000Z"]);
    expect(slotsInWindow(s, d("2026-11-20T08:00:01Z"), d("2026-11-21T00:00:00Z"), madrid)).toEqual([]);
  });
});

describe("nextRunTimes", () => {
  test("next N cron runs strictly after now, respecting until", () => {
    const task = makeTask({ schedule: { type: "cron", cron: "0 9 * * *", until: "2026-11-19T08:00:00Z" } });
    expect(iso(nextRunTimes(task, d("2026-11-17T08:00:00Z"), 3, "Europe/Madrid"))).toEqual(["2026-11-18T08:00:00.000Z", "2026-11-19T08:00:00.000Z"]);
  });

  test("starts_at in the future", () => {
    const task = makeTask({ schedule: { type: "cron", cron: "0 9 * * *", starts_at: "2026-12-01T00:00:00Z" } });
    expect(iso(nextRunTimes(task, d("2026-11-17T08:00:00Z"), 1, "Europe/Madrid"))).toEqual(["2026-12-01T08:00:00.000Z"]);
  });

  test("once: only while in the future and not finished", () => {
    const task = makeTask({ schedule: { type: "once", at: "2026-11-20T09:00:00+01:00" } });
    expect(iso(nextRunTimes(task, d("2026-11-17T00:00:00Z"), 3, "UTC"))).toEqual(["2026-11-20T08:00:00.000Z"]);
    expect(nextRunTimes(task, d("2026-11-21T00:00:00Z"), 3, "UTC")).toEqual([]);
    expect(nextRunTimes(task, d("2026-11-17T00:00:00Z"), 3, "UTC", { finished: true })).toEqual([]);
  });
});

describe("planSlots", () => {
  // Every 15 min, runner every 5m → max_delay 15m by default.
  const every15 = makeTask({ schedule: { type: "cron", cron: "*/15 * * * *", timezone: "UTC" }, created_at: "2026-11-17T00:00:00Z" });
  const settings = (catch_up: CatchUp, max_delay = "15m") => ({ catch_up, max_delay, runner_every: "5m", timezone: "UTC" });
  const plan = (overrides: Partial<PlanInput>) =>
    planSlots({ task: every15, now: d("2026-11-17T10:07:00Z"), recorded: new Set(), ticks: [], settings: settings("latest"), ...overrides });

  test("runner offline for an hour: old slots missed (runner_offline), latest launched, in-margin ones superseded", () => {
    const recorded = new Set(["20261117T090000Z"]);
    const p = plan({ recorded, now: d("2026-11-17T10:07:00Z"), task: { ...every15, created_at: "2026-11-17T09:00:00Z" } });
    expect(iso(p.missed)).toEqual(["2026-11-17T09:15:00.000Z", "2026-11-17T09:30:00.000Z", "2026-11-17T09:45:00.000Z"]);
    expect(p.missed.every((m) => m.reason === "runner_offline")).toBe(true);
    expect(iso(p.superseded)).toEqual([]);
    expect(p.candidates.map((c) => c.id)).toEqual(["20261117T100000Z"]);
  });

  test("missed vs superseded with a wider max_delay", () => {
    const p = plan({ task: { ...every15, created_at: "2026-11-17T09:00:00Z" }, now: d("2026-11-17T10:07:00Z"), settings: settings("latest", "40m") });
    expect(iso(p.missed)).toEqual(["2026-11-17T09:00:00.000Z", "2026-11-17T09:15:00.000Z"]);
    expect(iso(p.superseded)).toEqual(["2026-11-17T09:30:00.000Z", "2026-11-17T09:45:00.000Z"]);
    expect(iso(p.candidates)).toEqual(["2026-11-17T10:00:00.000Z"]);
  });

  test("catch_up all launches every slot inside max_delay, oldest first", () => {
    const p = plan({ task: { ...every15, created_at: "2026-11-17T09:00:00Z" }, settings: settings("all", "40m") });
    expect(iso(p.candidates)).toEqual(["2026-11-17T09:30:00.000Z", "2026-11-17T09:45:00.000Z", "2026-11-17T10:00:00.000Z"]);
    expect(p.superseded).toEqual([]);
    expect(p.missed).toHaveLength(2);
  });

  test("catch_up none launches only a slot due within one runner interval", () => {
    const task = { ...every15, created_at: "2026-11-17T09:00:00Z" };
    const onTime = plan({ task, settings: settings("none", "40m"), now: d("2026-11-17T10:03:00Z") });
    expect(iso(onTime.candidates)).toEqual(["2026-11-17T10:00:00.000Z"]);
    expect(iso(onTime.missed)).toEqual(["2026-11-17T09:00:00.000Z", "2026-11-17T09:15:00.000Z", "2026-11-17T09:30:00.000Z", "2026-11-17T09:45:00.000Z"]);

    const late = plan({ task, settings: settings("none", "40m"), now: d("2026-11-17T10:07:00Z") });
    expect(late.candidates).toEqual([]);
    expect(iso(late.missed).at(-1)).toBe("2026-11-17T10:00:00.000Z");
  });

  test("missed reason: runner_skipped when a tick ran inside the slot's margin", () => {
    const task = { ...every15, created_at: "2026-11-17T09:00:00Z" };
    const ticks = [d("2026-11-17T09:12:00Z"), d("2026-11-17T09:20:00Z")];
    const p = plan({ task, ticks, now: d("2026-11-17T10:07:00Z") });
    const reasons = Object.fromEntries(p.missed.map((m) => [m.at.toISOString().slice(11, 16), m.reason]));
    // 09:00 and 09:15 had a tick before their deadline; 09:30 and 09:45 did not.
    expect(reasons).toEqual({ "09:00": "runner_skipped", "09:15": "runner_skipped", "09:30": "runner_offline", "09:45": "runner_offline" });
  });

  test("recorded slots are left alone", () => {
    const p = plan({ recorded: new Set(["20261117T100000Z"]), task: { ...every15, created_at: "2026-11-17T09:55:00Z" } });
    expect(p).toEqual({ candidates: [], missed: [], superseded: [], cancelled: [] });
  });

  test("paused task: unrecorded slots are cancelled", () => {
    const p = plan({ task: { ...every15, enabled: false, created_at: "2026-11-17T09:40:00Z" } });
    expect(p.cancelled.map((c) => [c.id, c.reason])).toEqual([
      ["20261117T094500Z", "paused"],
      ["20261117T100000Z", "paused"],
    ]);
    expect(p.candidates).toEqual([]);
  });

  test("lookback is capped at 30 days", () => {
    const daily = makeTask({ schedule: { type: "cron", cron: "0 9 * * *", timezone: "UTC" }, created_at: "2026-01-01T00:00:00Z" });
    const p = planSlots({ task: daily, now: d("2026-11-17T09:05:00Z"), recorded: new Set(), ticks: [], settings: settings("latest") });
    expect(p.missed).toHaveLength(29);
    expect(p.missed[0]!.at.toISOString()).toBe("2026-10-19T09:00:00.000Z");
    expect(iso(p.candidates)).toEqual(["2026-11-17T09:00:00.000Z"]);
  });

  test("starts_at and until", () => {
    const task = makeTask({
      schedule: { type: "cron", cron: "0 * * * *", timezone: "UTC", starts_at: "2026-11-17T08:00:00Z", until: "2026-11-17T09:00:00Z" },
      created_at: "2026-11-16T00:00:00Z",
    });
    const before = planSlots({ task, now: d("2026-11-17T07:30:00Z"), recorded: new Set(), ticks: [], settings: settings("all", "2h") });
    expect(before.candidates).toEqual([]);
    const after = planSlots({ task, now: d("2026-11-17T10:30:00Z"), recorded: new Set(), ticks: [], settings: settings("all", "2h") });
    expect(iso(after.candidates)).toEqual(["2026-11-17T09:00:00.000Z"]);
    expect(iso(after.missed)).toEqual(["2026-11-17T08:00:00.000Z"]);
  });

  test("once: launched when due, missed when late, nothing more after a final state", () => {
    const task = makeTask({ schedule: { type: "once", at: "2026-11-20T09:00:00+01:00" }, created_at: "2026-11-17T00:00:00Z" });
    const base = { task, recorded: new Set<string>(), ticks: [], settings: settings("latest") };
    expect(planSlots({ ...base, now: d("2026-11-20T07:59:00Z") }).candidates).toEqual([]);
    expect(iso(planSlots({ ...base, now: d("2026-11-20T08:05:00Z") }).candidates)).toEqual(["2026-11-20T08:00:00.000Z"]);
    expect(iso(planSlots({ ...base, now: d("2026-11-20T09:00:00Z") }).missed)).toEqual(["2026-11-20T08:00:00.000Z"]);

    expect(isTaskFinished(task, [{ trigger: "schedule", status: "running" }])).toBe(false);
    expect(isTaskFinished(task, [{ trigger: "manual", status: "succeeded" }])).toBe(false);
    const finished = isTaskFinished(task, [{ trigger: "schedule", status: "failed" }]);
    expect(finished).toBe(true);
    expect(planSlots({ ...base, now: d("2026-11-20T08:05:00Z"), finished })).toEqual({ candidates: [], missed: [], superseded: [], cancelled: [] });
    expect(isTaskFinished(every15, [{ trigger: "schedule", status: "succeeded" }])).toBe(false);
  });
});

describe("formatInZone", () => {
  test("ISO with the zone's offset, across DST", () => {
    expect(formatInZone(d("2026-11-17T08:00:00Z"), "Europe/Madrid")).toBe("2026-11-17T09:00:00+01:00");
    expect(formatInZone(d("2026-07-17T07:00:00Z"), "Europe/Madrid")).toBe("2026-07-17T09:00:00+02:00");
    expect(formatInZone(d("2026-11-17T08:00:00Z"), "UTC")).toBe("2026-11-17T08:00:00Z");
    expect(formatInZone(d("2026-11-17T08:00:00Z"), "America/New_York")).toBe("2026-11-17T03:00:00-05:00");
  });
});
