// A data folder with one task in every situation the views show, written
// with the store helpers. Used by test/views.test.ts (and handy for trying
// the views by hand: `bun test/fixtures/views.ts <data-dir> <config-file>`).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DataPaths } from "../../src/paths.ts";
import { dataPaths } from "../../src/paths.ts";
import type { Attempt, Run, RunStatus, Task } from "../../src/schema.ts";
import { appendTick, runLogRelativePath, writeRun, writeTask } from "../../src/store.ts";
import { slotId } from "../../src/slot.ts";

/** Tuesday morning in Madrid. */
export const FIXTURE_NOW = "2026-11-17T10:02:00+01:00";
export const FIXTURE_TZ = "Europe/Madrid";

const MIN = 60_000;

function task(id: string, title: string, schedule: Task["schedule"], extra: Partial<Task> = {}): Task {
  return {
    id,
    title,
    description: null,
    cwd: "~/Projects/foo",
    instructions: `Do ${title.toLowerCase()}.`,
    schedule,
    agent: null,
    catch_up: null,
    max_delay: null,
    timeout: null,
    retries: 0,
    keep_open: null,
    enabled: true,
    created_at: "2026-11-01T10:00:00+01:00",
    created_by: null,
    updated_at: "2026-11-01T10:00:00+01:00",
    ...extra,
  };
}

const cron = (expr: string): Task["schedule"] => ({ type: "cron", cron: expr, timezone: FIXTURE_TZ, starts_at: null, until: null });

function attempt(n: number, start: Date, minutes: number | null, status: RunStatus, summary: string | null, log: string | null): Attempt {
  return {
    n,
    started_at: start.toISOString(),
    finished_at: minutes === null ? null : new Date(start.getTime() + minutes * MIN).toISOString(),
    session: { launcher: "process", handle: `p${n}${start.getUTCHours()}`, name: `task-${n}`, pid: null, closed_at: null },
    agent: { command: "claude", shell: false, from: "default" },
    status,
    summary,
    log,
  };
}

/** A scheduled run: started `delayMin` after the slot, `minutes` long (null while in progress). */
export function scheduledRun(taskId: string, slot: string, status: RunStatus, opts: { reason?: string; summary?: string; attempts?: number; delayMin?: number; minutes?: number | null } = {}): Run {
  const at = new Date(slot);
  const slotFile = slotId(at);
  const launched = !["missed", "superseded", "cancelled"].includes(status);
  const attempts: Attempt[] = [];
  if (launched) {
    const count = opts.attempts ?? 1;
    let start = new Date(at.getTime() + (opts.delayMin ?? 1) * MIN);
    for (let n = 1; n <= count; n++) {
      const last = n === count;
      const minutes = last ? (opts.minutes === undefined ? 3 : opts.minutes) : 2;
      attempts.push(attempt(n, start, minutes, last ? status : "failed", last ? (opts.summary ?? null) : "first try failed", runLogRelativePath(taskId, slotFile)));
      start = new Date(start.getTime() + 5 * MIN);
    }
  }
  const events = launched
    ? [
        { at: new Date(at.getTime() + (opts.delayMin ?? 1) * MIN).toISOString(), event: "claimed", by: "tick" },
        { at: new Date(at.getTime() + (opts.delayMin ?? 1) * MIN + 1000).toISOString(), event: "launched", handle: attempts[0]!.session!.handle },
      ]
    : [{ at: new Date(at.getTime() + 20 * MIN).toISOString(), event: status, reason: opts.reason ?? null }];
  return { task_id: taskId, slot: at.toISOString(), trigger: "schedule", status, reason: opts.reason ?? null, attempts, events };
}

function writeLog(paths: DataPaths, run: Run, text: string): void {
  const file = join(paths.dataDir, run.attempts.at(-1)!.log!);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** Heartbeat every 5 minutes in [from, to]. */
export function writeTicks(paths: DataPaths, from: string, to: string): void {
  for (let t = Date.parse(from); t <= Date.parse(to); t += 5 * MIN) appendTick(paths, { at: new Date(t).toISOString(), mode: "system", launched: 0, missed: 0, finished: 0, errors: [] });
}

/**
 * Writes the fixture tasks, runs and ticks. The runner stopped from 01:10 to
 * 08:30 and has ticked every 5 minutes since; the last tick is at 10:00.
 */
export function writeFixture(paths: DataPaths, { ticks = true } = {}): void {
  const now = Date.parse(FIXTURE_NOW);
  const day = (n: number, hhmm: string) => new Date(`2026-11-${String(n).padStart(2, "0")}T${hhmm}:00+01:00`).toISOString();

  // Healthy weekly task: nine ok and one missed in its last ten.
  writeTask(paths, task("weekly-deps-report", "Weekly deps report", cron("0 9 * * 1"), { cwd: "~/Projects/foo" }));
  const mondays = ["2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09", "2026-11-16"];
  mondays.forEach((d, i) =>
    writeRun(paths, scheduledRun("weekly-deps-report", `${d}T09:00:00+0${d < "2026-10-26" ? 2 : 1}:00`, i === 7 ? "missed" : "succeeded", i === 7 ? { reason: "runner_offline" } : { summary: "deps report in notes/deps.md", minutes: 6 })),
  );

  // Running now (started 4 minutes ago); failed once last week.
  writeTask(paths, task("worktree-cleanup", "Worktree cleanup", cron("0 8 * * *"), { cwd: "~/Projects/bar" }));
  for (let d = 11; d <= 16; d++) writeRun(paths, scheduledRun("worktree-cleanup", day(d, "08:00"), d === 13 ? "failed" : "succeeded", { summary: d === 13 ? "git worktree prune failed" : "removed 2 worktrees" }));
  writeRun(paths, scheduledRun("worktree-cleanup", day(17, "08:00"), "running", { delayMin: 118, minutes: null }));

  // Hourly task: missed overnight (runner stopped) but ok again at 08:00, failed at 09:00 after two attempts.
  writeTask(paths, task("sentry-summary", "Sentry summary", cron("0 * * * *"), { retries: 1 }));
  writeRun(paths, scheduledRun("sentry-summary", day(17, "00:00"), "succeeded", { summary: "no new issues" }));
  writeRun(paths, scheduledRun("sentry-summary", day(17, "01:00"), "succeeded", { summary: "1 new issue in notes/sentry.md" }));
  for (const h of ["02:00", "03:00", "04:00"]) writeRun(paths, scheduledRun("sentry-summary", day(17, h), "missed", { reason: "runner_offline" }));
  for (const h of ["05:00", "06:00", "07:00"]) writeRun(paths, scheduledRun("sentry-summary", day(17, h), "superseded", { reason: "catch_up_latest" }));
  writeRun(paths, scheduledRun("sentry-summary", day(17, "08:00"), "succeeded", { summary: "3 new issues in notes/sentry.md", delayMin: 31, minutes: 6 }));
  const failed = scheduledRun("sentry-summary", day(17, "09:00"), "failed", { summary: "sentry-cli has no auth", attempts: 2, delayMin: 2 });
  writeRun(paths, failed);
  writeLog(paths, failed, "$ sentry-cli issues list\nerror: Auth token is required for this request.\n");
  writeRun(paths, scheduledRun("sentry-summary", day(17, "10:00"), "running", { minutes: null }));

  // Daily task whose only slot today fell in the runner's gap: still missed (nothing ran since).
  writeTask(paths, task("inbox-triage", "Inbox triage", cron("0 6 * * *")));
  for (let d = 14; d <= 16; d++) writeRun(paths, scheduledRun("inbox-triage", day(d, "06:00"), "succeeded", { summary: "inbox at zero" }));
  writeRun(paths, scheduledRun("inbox-triage", day(17, "06:00"), "missed", { reason: "runner_offline" }));

  // Waiting for a person.
  writeTask(paths, task("review-pr-123", "Review PR 123", { type: "once", at: "2026-11-17T09:30:00+01:00" }));
  writeRun(paths, scheduledRun("review-pr-123", day(17, "09:30"), "blocked", { summary: "asks to confirm the merge", minutes: null, delayMin: 20 }));

  // One-off still to come.
  writeTask(paths, task("release-notes", "Release notes", { type: "once", at: "2026-11-20T09:00:00+01:00" }));

  // Paused.
  writeTask(paths, task("backup-notes", "Backup notes", cron("0 23 * * *"), { cwd: "~/notes", enabled: false }));
  for (let d = 10; d <= 13; d++) writeRun(paths, scheduledRun("backup-notes", day(d, "23:00"), "succeeded", { summary: "backed up" }));

  if (ticks) {
    writeTicks(paths, day(16, "20:00"), day(17, "01:10"));
    writeTicks(paths, day(17, "08:30"), new Date(now - 2 * MIN).toISOString());
  }
}

if (import.meta.main) {
  const [dataDir, configFile] = process.argv.slice(2) as [string, string];
  writeFixture(dataPaths(dataDir));
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify({ timezone: FIXTURE_TZ }));
}
