import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CorruptFileError, NotFoundError, UsageError } from "../src/errors.ts";
import type { Run } from "../src/schema.ts";
import {
  appendTick,
  claimRun,
  latestRuns,
  listRuns,
  listTasks,
  manualSlotId,
  parseRunRef,
  readRun,
  readTask,
  readTicks,
  recordedSlots,
  runPath,
  runRef,
  slotId,
  slotIdToDate,
  writeJsonAtomic,
  writeRun,
  writeTask,
} from "../src/store.ts";
import { makeTask, makeTempHome, type TempHome } from "./helpers.ts";

let home: TempHome;
beforeEach(() => {
  home = makeTempHome();
});
afterEach(() => home.cleanup());

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    task_id: "weekly-report",
    slot: "2026-11-17T09:00:00+01:00",
    trigger: "schedule",
    status: "running",
    reason: null,
    attempts: [],
    events: [{ at: "2026-11-17T09:00:01+01:00", event: "claimed", by: "tick" }],
    ...overrides,
  };
}

describe("slot ids and run refs", () => {
  test("slot ids are UTC and file-safe", () => {
    const at = new Date("2026-11-17T09:00:00+01:00");
    expect(slotId(at)).toBe("20261117T080000Z");
    expect(manualSlotId(new Date("2026-11-17T10:15:30.250Z"))).toBe("manual-20261117T101530Z");
    expect(slotIdToDate("20261117T080000Z").toISOString()).toBe("2026-11-17T08:00:00.000Z");
    expect(slotIdToDate("manual-20261117T101530Z").toISOString()).toBe("2026-11-17T10:15:30.000Z");
  });

  test("run refs round-trip and reject garbage", () => {
    expect(runRef("weekly-report", "20261117T080000Z")).toBe("weekly-report/20261117T080000Z");
    expect(parseRunRef("weekly-report/manual-20261117T080000Z")).toEqual({ taskId: "weekly-report", slot: "manual-20261117T080000Z" });
    expect(() => parseRunRef("weekly-report")).toThrow(UsageError);
    expect(() => parseRunRef("../etc/20261117T080000Z")).toThrow(UsageError);
    expect(() => parseRunRef("weekly-report/2026-11-17")).toThrow(UsageError);
  });
});

describe("atomic writes", () => {
  test("writeJsonAtomic replaces the file and leaves no temp files", () => {
    const file = join(home.dataDir, "nested", "a.json");
    writeJsonAtomic(file, { v: 1 });
    writeJsonAtomic(file, { v: 2 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 2 });
    expect(readdirSync(join(home.dataDir, "nested"))).toEqual(["a.json"]);
  });

  test("a failed write keeps the previous content", () => {
    const file = join(home.dataDir, "a.json");
    writeJsonAtomic(file, { v: 1 });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => writeJsonAtomic(file, circular)).toThrow();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1 });
    expect(readdirSync(home.dataDir)).toEqual(["a.json"]);
  });
});

describe("tasks", () => {
  test("write, read and list", () => {
    writeTask(home.paths, makeTask());
    writeTask(home.paths, makeTask({ id: "another" }));
    expect(readTask(home.paths, "weekly-report").title).toBe("Weekly report");
    const { items, errors } = listTasks(home.paths);
    expect(items.map((t) => t.id)).toEqual(["another", "weekly-report"]);
    expect(errors).toEqual([]);
  });

  test("corrupt or invalid task files are reported, not skipped silently", () => {
    writeTask(home.paths, makeTask());
    writeFileSync(join(home.paths.tasksDir, "broken.json"), "{ not json");
    writeFileSync(join(home.paths.tasksDir, "invalid.json"), JSON.stringify({ ...makeTask({ id: "invalid" }), enabled: "yes" }));
    const { items, errors } = listTasks(home.paths);
    expect(items.map((t) => t.id)).toEqual(["weekly-report"]);
    expect(errors.map((e) => e.file).sort()).toEqual([join(home.paths.tasksDir, "broken.json"), join(home.paths.tasksDir, "invalid.json")]);
    expect(errors.find((e) => e.file.endsWith("invalid.json"))!.message).toMatch(/enabled: must be a boolean/);
    expect(() => readTask(home.paths, "broken")).toThrow(CorruptFileError);
    expect(() => readTask(home.paths, "missing")).toThrow(NotFoundError);
  });
});

describe("runs", () => {
  test("claim is exclusive", () => {
    expect(claimRun(home.paths, "20261117T080000Z", makeRun())).toBe(true);
    expect(claimRun(home.paths, "20261117T080000Z", makeRun({ status: "failed" }))).toBe(false);
    expect(readRun(home.paths, "weekly-report", "20261117T080000Z").status).toBe("running");
    expect(readdirSync(join(home.paths.runsDir, "weekly-report"))).toEqual(["20261117T080000Z.json"]);
  });

  test("concurrent claims from separate processes: exactly one wins", async () => {
    const script = join(import.meta.dir, "fixtures", "claim.ts");
    const procs = Array.from({ length: 8 }, (_, i) =>
      Bun.spawn(["bun", script, home.dataDir, "20261117T080000Z", `p${i}`], { stdout: "pipe", stderr: "inherit" }),
    );
    const results = await Promise.all(procs.map(async (p) => {
      await p.exited;
      return new Response(p.stdout).text();
    }));
    expect(results.filter((r) => r === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r === "lost")).toHaveLength(7);
    const run = readRun(home.paths, "weekly-report", "20261117T080000Z");
    expect(run.events).toHaveLength(1);
    expect(readdirSync(join(home.paths.runsDir, "weekly-report"))).toEqual(["20261117T080000Z.json"]);
  });

  test("list, latest and recorded slots", () => {
    claimRun(home.paths, "20261124T080000Z", makeRun({ slot: "2026-11-24T09:00:00+01:00" }));
    claimRun(home.paths, "20261117T080000Z", makeRun());
    claimRun(home.paths, "manual-20261120T100000Z", makeRun({ trigger: "manual", slot: "2026-11-20T10:00:00Z" }));
    writeRun(home.paths, "20261117T080000Z", makeRun({ status: "succeeded" }));

    const all = listRuns(home.paths, "weekly-report");
    expect(all.items.map((r) => r.slot)).toEqual(["20261117T080000Z", "manual-20261120T100000Z", "20261124T080000Z"]);
    expect(all.items[0]!.run.status).toBe("succeeded");
    expect(all.items[0]!.ref).toBe("weekly-report/20261117T080000Z");
    expect(latestRuns(home.paths, "weekly-report", 2).items.map((r) => r.slot)).toEqual(["20261124T080000Z", "manual-20261120T100000Z"]);
    expect([...recordedSlots(home.paths, "weekly-report")].sort()).toEqual(["20261117T080000Z", "20261124T080000Z"]);
    expect(listRuns(home.paths, "nobody").items).toEqual([]);
  });

  test("corrupt run files are reported but still count as recorded", () => {
    const file = runPath(home.paths, "weekly-report", "20261117T080000Z");
    mkdirSync(join(home.paths.runsDir, "weekly-report"), { recursive: true });
    writeFileSync(file, "{");
    const { items, errors } = listRuns(home.paths, "weekly-report");
    expect(items).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(CorruptFileError);
    expect(recordedSlots(home.paths, "weekly-report").has("20261117T080000Z")).toBe(true);
    expect(() => readRun(home.paths, "weekly-report", "20261117T080000Z")).toThrow(CorruptFileError);
  });
});

describe("ticks", () => {
  test("append-only heartbeat, corrupt lines reported", () => {
    expect(readTicks(home.paths)).toEqual({ items: [], errors: [] });
    appendTick(home.paths, { at: "2026-11-17T09:00:00+01:00", mode: "system", launched: 1, missed: 0, finished: 0, errors: [] });
    appendTick(home.paths, { at: "2026-11-17T09:05:00+01:00", launched: 0 });
    expect(existsSync(home.paths.ticksFile)).toBe(true);
    writeFileSync(home.paths.ticksFile, `${readFileSync(home.paths.ticksFile, "utf8")}garbage\n`);
    const { items, errors } = readTicks(home.paths);
    expect(items.map((t) => t.at)).toEqual(["2026-11-17T09:00:00+01:00", "2026-11-17T09:05:00+01:00"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.file).toBe(`${home.paths.ticksFile}:3`);
  });
});
