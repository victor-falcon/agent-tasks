import { describe, expect, test } from "bun:test";
import type { ExecEventType } from "../src/execution.ts";
import {
  formatHeader,
  formatLine,
  formatStatus,
  formatStatusBlock,
  oscAgentState,
  oscTitle,
  type RunnerEvent,
  type RunnerLine,
  type StatusInfo,
  useColor,
} from "../src/runner-render.ts";

const TZ = "Europe/Madrid";
const AT = new Date("2026-11-17T09:05:01Z");
const plain = { color: false };
const color = { color: true };

const EVENTS: Record<ExecEventType, RunnerEvent> = {
  launched: { type: "launched", run_ref: "sentry-summary/20261117T090000Z", task_id: "sentry-summary", attempt: 1, handle: "t45" },
  succeeded: { type: "succeeded", run_ref: "sentry-summary/20261117T090000Z", task_id: "sentry-summary", attempt: 1, reason: null, message: "3 new issues in notes/sentry.md", duration_ms: 6 * 60_000 },
  failed: { type: "failed", run_ref: "backup-notes/20261117T091500Z", task_id: "backup-notes", attempt: 2, reason: "exited_without_report", message: "the session ended without calling finish", duration_ms: 90_000 },
  timed_out: { type: "timed_out", run_ref: "backup-notes/20261117T091500Z", task_id: "backup-notes", attempt: 1, reason: null, message: "ran longer than the 45m timeout" },
  missed: { type: "missed", run_ref: "weekly-deps/20261117T080000Z", task_id: "weekly-deps", reason: "runner_offline" },
  superseded: { type: "superseded", run_ref: "weekly-deps/20261117T070000Z", task_id: "weekly-deps" },
  cancelled: { type: "cancelled", run_ref: "weekly-deps/20261117T060000Z", task_id: "weekly-deps", reason: "until_passed" },
  blocked: { type: "blocked", run_ref: "review-pr-123/20261117T100000Z", task_id: "review-pr-123", attempt: 1 },
  anomaly: { type: "anomaly", run_ref: null, task_id: "broken", message: "watching task broken: invalid JSON" },
};

const STATUS: StatusInfo = {
  health: "healthy",
  last_tick: new Date("2026-11-17T09:25:01Z"),
  next_tick: new Date("2026-11-17T09:30:01Z"),
  running: 1,
  today: { succeeded: 4, failed: 1, missed: 1, blocked: 1 },
};

describe("event lines", () => {
  for (const [type, event] of Object.entries(EVENTS)) {
    test(`${type}, plain and colored`, () => {
      const line: RunnerLine = { kind: "event", at: AT, event };
      expect(formatLine(line, TZ, plain)).toMatchSnapshot();
      expect(formatLine(line, TZ, color)).toMatchSnapshot();
    });
  }

  test("error lines say which command shows more", () => {
    expect(formatLine({ kind: "event", at: AT, event: EVENTS.failed }, TZ, plain)).toContain("agent-tasks log backup-notes/20261117T091500Z");
    expect(formatLine({ kind: "event", at: AT, event: EVENTS.timed_out }, TZ, plain)).toContain("agent-tasks log backup-notes/20261117T091500Z");
    expect(formatLine({ kind: "event", at: AT, event: EVENTS.blocked }, TZ, plain)).toContain("agent-tasks attach review-pr-123/20261117T100000Z");
  });

  test("tick, recovered and warning lines", () => {
    expect(formatLine({ kind: "tick", at: AT, due: 1, running: 0 }, TZ, plain)).toBe("10:05:01  tick  1 due · 0 running");
    expect(formatLine({ kind: "recovered", at: AT, last_tick: new Date("2026-11-17T07:00:00Z"), gap_ms: 2 * 3_600_000 + 5 * 60_000 + 1000 }, TZ, plain)).toBe(
      "10:05:01  ↻ runner recovered after 2h5m1s without ticks (last tick 08:00:00)",
    );
    expect(formatLine({ kind: "warning", at: AT, message: "tick failed: boom" }, TZ, plain)).toBe("10:05:01  ⚠ tick failed: boom");
    expect(formatLine({ kind: "warning", at: AT, message: "tick failed: boom" }, TZ, color)).toMatchSnapshot();
  });
});

describe("header and status line", () => {
  test("header", () => {
    const info = { every: "5m", launcher: "herdr", agent: "clc", dataDir: "~/.local/share/agent-tasks" };
    expect(formatHeader(info, plain)).toBe("agent-tasks runner · every 5m · launcher: herdr (clc) · data: ~/.local/share/agent-tasks");
    expect(formatHeader(info, color)).toMatchSnapshot();
  });

  test("status line in every health", () => {
    expect(formatStatus(STATUS, TZ, plain)).toBe("● healthy · last tick 10:25:01 · next 10:30:01 · running 1 · today ✓4 ✕1 □1 !1");
    expect(formatStatus({ ...STATUS, health: "degraded" }, TZ, plain)).toStartWith("● degraded");
    expect(formatStatus({ ...STATUS, health: "tick_failed" }, TZ, plain)).toStartWith("● last tick failed");
    expect(formatStatus({ ...STATUS, health: "stopped", next_tick: null }, TZ, plain)).toBe("● stopped · last tick 10:25:01 · running 1 · today ✓4 ✕1 □1 !1");
    expect(formatStatus({ ...STATUS, last_tick: null }, TZ, plain)).toContain("last tick never");
    expect(formatStatusBlock(STATUS, TZ, color)).toMatchSnapshot();
  });

  test("colors only on a terminal and without NO_COLOR", () => {
    expect(useColor(true, {})).toBe(true);
    expect(useColor(false, {})).toBe(false);
    expect(useColor(true, { NO_COLOR: "1" })).toBe(false);
    expect(useColor(true, { NO_COLOR: "" })).toBe(true);
  });
});

describe("Herdr escapes", () => {
  test("OSC 2 title, exact bytes", () => {
    expect(Buffer.from(oscTitle("agent-tasks runner"))).toEqual(Buffer.from([0x1b, 0x5d, 0x32, 0x3b, ...Buffer.from("agent-tasks runner"), 0x07]));
  });

  test("OSC 7501 agent state, exact bytes with a colon between fields", () => {
    expect(oscAgentState("idle")).toBe("\x1b]7501;state=idle:app=agent-tasks\x07");
    expect(Buffer.from(oscAgentState("working"))).toEqual(Buffer.from([0x1b, 0x5d, ...Buffer.from("7501;state=working:app=agent-tasks"), 0x07]));
  });
});
