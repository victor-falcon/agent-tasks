import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Resolution } from "./config.ts";
import type { Context } from "./context.ts";
import { parseDuration } from "./duration.ts";
import { AgentTasksError } from "./errors.ts";
import {
  captureLog,
  commandEnv,
  endAttempt,
  type ExecEvent,
  type ExecEventType,
  findTask,
  lastAttempt,
  markSessionGone,
  newRun,
  readRunRef,
  sessionInput,
  sessionOf,
  settleSession,
  stamp,
  startAttempt,
  updateRun,
} from "./execution.ts";
import { resolveLauncher, sessionStatus } from "./launcher.ts";
import { isTaskFinished, planSlots } from "./schedule.ts";
import type { Run, RunStatus, Task } from "./schema.ts";
import { runRef, runSlotId } from "./slot.ts";
import { appendTick, claimRun, listRuns, listTasks, readTicks, recordedSlots, type StoredRun } from "./store.ts";
import { systemTimezone } from "./time.ts";

// One pass of the scheduler (doc/roadmap/phase-1-core.md, "`tick`, step by
// step"): watch what is in progress, record slots nobody will run, launch
// what is due, and append a heartbeat line. The runner (T4) calls `tick()`.

export interface TickOptions {
  /** Recorded in the heartbeat: `manual` for `agent-tasks tick`, `runner` for the loop. */
  mode?: string;
}

export interface TickResult {
  at: string;
  mode: string;
  events: ExecEvent[];
  /** Problems that did not stop the tick (corrupt files, broken launchers…). */
  errors: string[];
}

/** A finished session that is still open is closed by tick only after this, to let `finish` close it first. */
const CLOSE_GRACE_MS = 60_000;
/** An attempt with no session after this was interrupted while launching. */
const LAUNCH_GRACE_MS = 5 * 60_000;
const FINISHED_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "timed_out"];

class TickPass {
  readonly events: ExecEvent[] = [];
  readonly errors: string[] = [];
  /** Runs whose failure this pass reported: each failure is considered for a retry exactly once. */
  readonly failedNow = new Set<string>();

  constructor(readonly ctx: Context) {}

  get nowMs(): number {
    return this.ctx.now.getTime();
  }

  anomaly(message: string, ref: string | null = null, taskId: string | null = null): void {
    this.errors.push(message);
    this.events.push({ type: "anomaly", run_ref: ref, task_id: taskId, message });
  }

  /** Runs `fn`, turning an error into an anomaly so one broken task does not stop the tick. */
  guard(what: string, taskId: string | null, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      const message = err instanceof AgentTasksError ? err.message : String((err as Error)?.stack ?? err);
      this.anomaly(`${what}: ${message}`, null, taskId);
    }
  }

  // -------------------------------------------------------------------------
  // Watch
  // -------------------------------------------------------------------------

  watchTask(task: Task): void {
    const runs = listRuns(this.ctx.paths, task.id);
    for (const err of runs.errors) this.anomaly(err.message, null, task.id);
    const resolution = this.ctx.resolveFor(task);
    for (const stored of runs.items) {
      this.guard(`watching ${stored.ref}`, task.id, () => this.watchRun(task, resolution, stored));
    }
  }

  watchRun(task: Task, resolution: Resolution, { ref, run }: StoredRun): void {
    const attempt = lastAttempt(run);
    if (!attempt) {
      const claimedAt = Date.parse(run.events[0]?.at ?? "");
      if (run.status === "running" && this.nowMs - claimedAt > LAUNCH_GRACE_MS) {
        updateRun(this.ctx, ref, (r) => {
          if (r.attempts.length > 0 || r.status !== "running") return;
          r.status = "failed";
          r.reason = "launch_interrupted";
          r.events.push({ at: stamp(this.ctx, resolution.timezone), event: "failed", reason: "launch_interrupted" });
        });
        this.events.push({ type: "failed", run_ref: ref, task_id: task.id, reason: "launch_interrupted" });
      }
      return;
    }
    if (attempt.finished_at) this.followUpFinished(task, resolution, ref, run);
    else if (run.status === "running" || run.status === "blocked") this.watchActive(task, resolution, ref, run);
    if (this.failedNow.has(ref)) this.maybeRetry(task, resolution, ref);
  }

  report(task: Task, ref: string, n: number, status: RunStatus, reason: string | null, message?: string | null): void {
    this.events.push({ type: status as ExecEventType, run_ref: ref, task_id: task.id, attempt: n, reason, ...(message ? { message } : {}) });
    if (status === "failed" || status === "timed_out") this.failedNow.add(ref);
  }

  /** Ends the latest attempt with `status` unless something else ended it meanwhile, and reports it. */
  end(task: Task, resolution: Resolution, ref: string, n: number, status: RunStatus, reason: string | null, message?: string): boolean {
    let ended = false;
    const at = stamp(this.ctx, resolution.timezone);
    updateRun(this.ctx, ref, (r) => {
      const a = r.attempts[n - 1];
      if (!a || a.finished_at) return;
      endAttempt(r, n, status, reason, at, message ? { message } : {});
      r.events.push({ at, event: "reported", attempt: n });
      ended = true;
    });
    if (ended) this.report(task, ref, n, status, reason, message);
    return ended;
  }

  watchActive(task: Task, resolution: Resolution, ref: string, run: Run): void {
    const attempt = lastAttempt(run)!;
    const n = attempt.n;
    const record = sessionOf(attempt);
    if (!record) {
      // Launch in progress in another process, or interrupted before recording the session.
      if (this.nowMs - Date.parse(attempt.started_at) > LAUNCH_GRACE_MS) {
        this.end(task, resolution, ref, n, "failed", "launch_interrupted", "the launch never recorded a session");
      }
      return;
    }
    const spec = resolveLauncher(resolution.launcher);
    const input = sessionInput(this.ctx, task, resolution, run, attempt);

    const timeoutMs = parseDuration(resolution.timeout);
    if (this.nowMs - Date.parse(attempt.started_at) > timeoutMs) {
      captureLog(spec, input);
      if (this.end(task, resolution, ref, n, "timed_out", null, `ran longer than the ${resolution.timeout} timeout`)) {
        settleSession(this.ctx, task, ref, { force: true });
      }
      return;
    }

    const status = sessionStatus(spec, input, commandEnv(input));
    if (!status) return;
    switch (status.state) {
      case "gone":
      case "exited":
        if (this.end(task, resolution, ref, n, "failed", "exited_without_report", "the session ended without calling finish")) {
          if (status.state === "gone") markSessionGone(this.ctx, ref, stamp(this.ctx, resolution.timezone));
          else settleSession(this.ctx, task, ref, { capture: true });
        }
        return;
      case "blocked":
        if (run.status !== "blocked") this.setBlocked(task, resolution, ref, n, true);
        return;
      default:
        if (run.status === "blocked") this.setBlocked(task, resolution, ref, n, false);
    }
  }

  setBlocked(task: Task, resolution: Resolution, ref: string, n: number, blocked: boolean): void {
    const at = stamp(this.ctx, resolution.timezone);
    let changed = false;
    updateRun(this.ctx, ref, (r) => {
      const a = r.attempts[n - 1];
      if (!a || a.finished_at || n !== r.attempts.length) return;
      const status = blocked ? "blocked" : "running";
      if (r.status === status) return;
      r.status = status;
      a.status = status;
      r.events.push({ at, event: blocked ? "blocked" : "unblocked", attempt: n });
      changed = true;
    });
    if (changed && blocked) this.events.push({ type: "blocked", run_ref: ref, task_id: task.id, attempt: n });
  }

  /** An attempt ended by `finish`: report it once, and close its session if `finish` could not. */
  followUpFinished(task: Task, resolution: Resolution, ref: string, run: Run): void {
    const attempt = lastAttempt(run)!;
    const n = attempt.n;
    const finishedMs = Date.parse(attempt.finished_at!);
    const reported = run.events.some((e) => e.event === "reported" && e.attempt === n);
    if (!reported && FINISHED_STATUSES.includes(attempt.status)) {
      updateRun(this.ctx, ref, (r) => void r.events.push({ at: stamp(this.ctx, resolution.timezone), event: "reported", attempt: n }));
      this.report(task, ref, n, attempt.status, attempt.reason ?? null, attempt.summary);
    }
    const record = sessionOf(attempt);
    if (!record || record.closed_at || record.kept_open || this.nowMs - finishedMs < CLOSE_GRACE_MS) return;
    const spec = resolveLauncher(resolution.launcher);
    const input = sessionInput(this.ctx, task, resolution, run, attempt);
    if (sessionStatus(spec, input, commandEnv(input))?.state === "gone") markSessionGone(this.ctx, ref, stamp(this.ctx, resolution.timezone));
    else settleSession(this.ctx, task, ref, { capture: true });
  }

  /** A run whose failure was just reported gets a new attempt while it has retries left. */
  maybeRetry(task: Task, resolution: Resolution, ref: string): void {
    const run = readRunRef(this.ctx, ref);
    if (run.status !== "failed" && run.status !== "timed_out") return;
    if (run.attempts.length > resolution.retries) return;
    this.events.push(...startAttempt(this.ctx, task, ref, "retry"));
  }

  // -------------------------------------------------------------------------
  // Reconcile and launch
  // -------------------------------------------------------------------------

  reconcileTask(task: Task, pastTicks: Date[]): void {
    const { ctx } = this;
    const resolution = ctx.resolveFor(task);
    const runs = listRuns(ctx.paths, task.id);
    const plan = planSlots({
      task,
      now: ctx.now,
      recorded: recordedSlots(ctx.paths, task.id),
      ticks: pastTicks,
      settings: resolution,
      finished: isTaskFinished(task, runs.items.map((r) => r.run)),
    });
    const at = stamp(ctx, resolution.timezone);
    const record = (slot: Date, status: RunStatus, reason: string | null, extra: Record<string, unknown> = {}): string | null => {
      const run = newRun(task.id, slot, resolution.timezone, "schedule", status, reason, { event: status, by: "tick", ...(reason ? { reason } : {}), ...extra }, at);
      return claimRun(ctx.paths, run) ? runRef(task.id, runSlotId(run)) : null;
    };

    for (const slot of plan.missed) {
      const ref = record(slot.at, "missed", slot.reason);
      if (!ref) continue;
      this.events.push({ type: "missed", run_ref: ref, task_id: task.id, reason: slot.reason });
      if (slot.reason === "runner_skipped") this.anomaly(`${ref} was missed while the runner was ticking (runner_skipped)`, ref, task.id);
    }
    const newest = plan.candidates.at(-1);
    for (const slot of plan.superseded) {
      const ref = record(slot.at, "superseded", null, newest ? { by_slot: newest.id } : {});
      if (ref) this.events.push({ type: "superseded", run_ref: ref, task_id: task.id });
    }
    for (const slot of plan.cancelled) {
      const ref = record(slot.at, "cancelled", slot.reason);
      if (ref) this.events.push({ type: "cancelled", run_ref: ref, task_id: task.id, reason: slot.reason });
    }
    for (const slot of plan.candidates) {
      const run = newRun(task.id, slot.at, resolution.timezone, "schedule", "running", null, { event: "claimed", by: "tick" }, at);
      if (!claimRun(ctx.paths, run)) continue; // another tick took it
      this.events.push(...startAttempt(ctx, task, runRef(task.id, slot.id), "tick"));
    }
  }
}

/** Task ids with a runs folder (their task may have been archived). */
function taskIdsWithRuns(runsDir: string): string[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir).filter((name) => !name.startsWith(".") && statSync(join(runsDir, name)).isDirectory());
}

/** One scheduler pass. Never throws for a single broken task or run: those become anomalies. */
export function tick(ctx: Context, opts: TickOptions = {}): TickResult {
  const mode = opts.mode ?? "manual";
  const pass = new TickPass(ctx);
  const at = stamp(ctx, ctx.config.config.timezone ?? systemTimezone());

  const ticks = readTicks(ctx.paths);
  for (const err of ticks.errors) pass.errors.push(err.message);
  const pastTicks = ticks.items.map((t) => new Date(t.at));

  const tasks = listTasks(ctx.paths);
  for (const err of tasks.errors) pass.anomaly(err.message);
  const byId = new Map(tasks.items.map((t) => [t.id, t]));

  // 1. Watch everything in progress, including runs of archived tasks.
  for (const id of new Set([...byId.keys(), ...taskIdsWithRuns(ctx.paths.runsDir)])) {
    pass.guard(`watching task ${id}`, id, () => {
      const task = byId.get(id) ?? findTask(ctx, id);
      if (task) pass.watchTask(task);
    });
  }
  // 2–3. Reconcile slots and launch candidates.
  for (const task of tasks.items) pass.guard(`scheduling task ${task.id}`, task.id, () => pass.reconcileTask(task, pastTicks));

  const count = (...types: ExecEventType[]) => pass.events.filter((e) => types.includes(e.type)).length;
  appendTick(ctx.paths, {
    at,
    mode,
    launched: count("launched"),
    missed: count("missed"),
    finished: count("succeeded", "failed", "timed_out"),
    errors: pass.errors,
  });
  return { at, mode, events: pass.events, errors: pass.errors };
}

const LABELS: Record<ExecEventType, string> = {
  launched: "▶ launched",
  succeeded: "✓ succeeded",
  failed: "✕ failed",
  timed_out: "⏱ timed out",
  missed: "· missed",
  superseded: "· superseded",
  cancelled: "· cancelled",
  blocked: "! blocked",
  anomaly: "? anomaly",
};

/** One line per event, for people. */
export function formatEvent(e: ExecEvent): string {
  const details = [e.attempt && e.attempt > 1 ? `attempt ${e.attempt}` : null, e.handle ? `session ${e.handle}` : null, e.reason ?? null].filter(Boolean);
  let line = [LABELS[e.type], e.run_ref ?? e.task_id].filter(Boolean).join(" ");
  if (details.length > 0) line += ` (${details.join(", ")})`;
  if (e.message) line += `: ${e.message}`;
  return line;
}
