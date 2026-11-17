import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Resolution } from "./config.ts";
import type { Context } from "./context.ts";
import { parseDuration } from "./duration.ts";
import { AgentTasksError } from "./errors.ts";
import {
  endAttempt,
  type ExecEvent,
  type ExecEventType,
  findTask,
  isReported,
  lastAttempt,
  markSessionGone,
  MAX_CLOSE_ATTEMPTS,
  newRun,
  readRunRef,
  sessionFor,
  type SettleOptions,
  settleSession,
  stamp,
  startAttempt,
  updateRun,
} from "./execution.ts";
import { sessionStatus } from "./launcher.ts";
import type { Run, RunStatus, Task } from "./schema.ts";
import { runRef, runSlotId } from "./slot.ts";
import { appendTick, claimRun, listRuns, listTasks, readTicks } from "./store.ts";
import { planTask } from "./task-info.ts";
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

/** One run being watched, with its task and resolved settings. */
interface Watched {
  task: Task;
  resolution: Resolution;
  ref: string;
  /** The task was removed with `rm`: its runs are still watched, but not retried. */
  archived: boolean;
}

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

  watchTask(task: Task, archived: boolean): void {
    const runs = listRuns(this.ctx.paths, task.id);
    for (const err of runs.errors) this.anomaly(err.message, null, task.id);
    const resolution = this.ctx.resolveFor(task);
    for (const stored of runs.items) {
      const w: Watched = { task, resolution, ref: stored.ref, archived };
      this.guard(`watching ${stored.ref}`, task.id, () => this.watchRun(w, stored.run));
    }
  }

  at(w: Watched): string {
    return stamp(this.ctx, w.resolution.timezone);
  }

  watchRun(w: Watched, run: Run): void {
    const attempt = lastAttempt(run);
    if (!attempt) {
      const claimedAt = Date.parse(run.events[0]?.at ?? "");
      if (run.status === "running" && this.nowMs - claimedAt > LAUNCH_GRACE_MS) {
        let failed = false;
        updateRun(this.ctx, w.ref, (r) => {
          if (r.attempts.length > 0 || r.status !== "running") return;
          r.status = "failed";
          r.reason = "launch_interrupted";
          r.events.push({ at: this.at(w), event: "failed", reason: "launch_interrupted" });
          failed = true;
        });
        if (failed) this.events.push({ type: "failed", run_ref: w.ref, task_id: w.task.id, reason: "launch_interrupted" });
      }
      return;
    }
    if (attempt.finished_at) this.followUpFinished(w, run);
    else if (run.status === "running" || run.status === "blocked") this.watchActive(w, run);
    if (this.failedNow.has(w.ref)) this.maybeRetry(w);
  }

  report(w: Watched, n: number, status: RunStatus, reason: string | null, message?: string | null): void {
    this.events.push({ type: status as ExecEventType, run_ref: w.ref, task_id: w.task.id, attempt: n, reason, ...(message ? { message } : {}) });
    if (status === "failed" || status === "timed_out") this.failedNow.add(w.ref);
  }

  /** Ends attempt `n` with `status` unless something else ended it meanwhile, and reports it. */
  end(w: Watched, n: number, status: RunStatus, reason: string | null, message?: string): boolean {
    let ended = false;
    updateRun(this.ctx, w.ref, (r) => {
      const a = r.attempts[n - 1];
      if (!a || a.finished_at) return;
      endAttempt(r, n, status, reason, this.at(w), { message, reported: true });
      ended = true;
    });
    if (ended) this.report(w, n, status, reason, message);
    return ended;
  }

  /** Closes a session and turns a failed close into an anomaly. */
  settle(w: Watched, opts: SettleOptions): void {
    const result = settleSession(this.ctx, w.task, w.ref, opts);
    if (result.action !== "close_failed") return;
    const attempts = lastAttempt(readRunRef(this.ctx, w.ref))?.session?.close_attempts ?? 0;
    const tail = attempts >= MAX_CLOSE_ATTEMPTS ? ` (giving up after ${attempts} attempts; close it with "agent-tasks session close ${w.ref}")` : "";
    this.anomaly(`could not close the session of ${w.ref}: ${result.error}${tail}`, w.ref, w.task.id);
  }

  watchActive(w: Watched, run: Run): void {
    const attempt = lastAttempt(run)!;
    const n = attempt.n;
    const session = sessionFor(this.ctx, w.task, w.resolution, run);
    if (!session) {
      // Launch in progress in another process, or interrupted before recording the session.
      if (this.nowMs - Date.parse(attempt.started_at) > LAUNCH_GRACE_MS) {
        this.end(w, n, "failed", "launch_interrupted", "the launch never recorded a session");
      }
      return;
    }

    const timedOut = this.nowMs - Date.parse(attempt.started_at) > parseDuration(w.resolution.timeout);
    // Throws when the state is unknown (status timed out or could not run): an anomaly, not a
    // failure. Past the timeout an unknown state still times the run out.
    let status: ReturnType<typeof sessionStatus>;
    try {
      status = sessionStatus(session.spec, session.input);
    } catch (err) {
      if (!timedOut) throw err;
      status = null;
    }
    const gone = status?.state === "gone" || status?.state === "exited";
    if (timedOut && !gone) {
      if (this.end(w, n, "timed_out", null, `ran longer than the ${w.resolution.timeout} timeout`)) this.settle(w, { force: true, capture: true });
      return;
    }
    if (!status) return;
    switch (status.state) {
      case "gone":
      case "exited":
        if (this.end(w, n, "failed", "exited_without_report", "the session ended without calling finish")) {
          if (status.state === "gone") markSessionGone(this.ctx, w.ref, this.at(w));
          else this.settle(w, { capture: true });
        }
        return;
      case "blocked":
        if (run.status !== "blocked") this.setBlocked(w, n, true);
        return;
      default:
        if (run.status === "blocked") this.setBlocked(w, n, false);
    }
  }

  setBlocked(w: Watched, n: number, blocked: boolean): void {
    let changed = false;
    updateRun(this.ctx, w.ref, (r) => {
      const a = r.attempts[n - 1];
      if (!a || a.finished_at || n !== r.attempts.length) return;
      const status = blocked ? "blocked" : "running";
      if (r.status === status) return;
      r.status = status;
      a.status = status;
      r.events.push({ at: this.at(w), event: blocked ? "blocked" : "unblocked", attempt: n });
      changed = true;
    });
    if (changed && blocked) this.events.push({ type: "blocked", run_ref: w.ref, task_id: w.task.id, attempt: n });
  }

  /** An ended attempt: report it once (if `finish` ended it), and close its session if nobody could. */
  followUpFinished(w: Watched, run: Run): void {
    const attempt = lastAttempt(run)!;
    const n = attempt.n;
    const record = attempt.session;
    // `finish` ends the attempt, then decides `keep_open`: wait for that (briefly), so the
    // notification knows whether the session was kept open.
    const settling = !!record && !record.closed_at && !record.kept_open && !record.close_attempts && this.nowMs - Date.parse(attempt.finished_at!) < CLOSE_GRACE_MS;
    if (!settling && !isReported(run, n) && FINISHED_STATUSES.includes(attempt.status)) {
      let claimed = false;
      updateRun(this.ctx, w.ref, (r) => {
        if (isReported(r, n)) return;
        r.events.push({ at: this.at(w), event: "reported", attempt: n });
        claimed = true;
      });
      if (claimed) this.report(w, n, attempt.status, attempt.reason ?? null, attempt.summary);
    }
    if (!record || record.closed_at || record.kept_open || (record.close_attempts ?? 0) >= MAX_CLOSE_ATTEMPTS) return;
    if (this.nowMs - Date.parse(attempt.finished_at!) < CLOSE_GRACE_MS) return;
    const session = sessionFor(this.ctx, w.task, w.resolution, run);
    if (session && sessionStatus(session.spec, session.input)?.state === "gone") markSessionGone(this.ctx, w.ref, this.at(w));
    else this.settle(w, { capture: true });
  }

  /** A run whose failure was just reported gets a new attempt while it has retries left (not for paused or archived tasks). */
  maybeRetry(w: Watched): void {
    if (w.archived || !w.task.enabled) return;
    const run = readRunRef(this.ctx, w.ref);
    if (run.status !== "failed" && run.status !== "timed_out") return;
    if (run.attempts.length > w.resolution.retries) return;
    this.events.push(...startAttempt(this.ctx, w.task, w.ref, { by: "retry" }));
  }

  // -------------------------------------------------------------------------
  // Reconcile and launch
  // -------------------------------------------------------------------------

  reconcileTask(task: Task): void {
    const { ctx } = this;
    const resolution = ctx.resolveFor(task);
    // Same plan as `due` (schedule_since, one-off tasks moved to a new `at`). Reads the
    // ticks before this tick's heartbeat line is appended.
    const plan = planTask(ctx.paths, task, resolution, ctx.now);
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
      this.events.push(...startAttempt(ctx, task, runRef(task.id, slot.id), { by: "tick" }));
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

  const tasks = listTasks(ctx.paths);
  for (const err of tasks.errors) pass.anomaly(err.message);
  const byId = new Map(tasks.items.map((t) => [t.id, t]));

  // 1. Watch everything in progress, including runs of archived tasks.
  for (const id of new Set([...byId.keys(), ...taskIdsWithRuns(ctx.paths.runsDir)])) {
    pass.guard(`watching task ${id}`, id, () => {
      const current = byId.get(id);
      const found = current ? { task: current, archived: false } : findTask(ctx, id);
      if (found) pass.watchTask(found.task, found.archived);
    });
  }
  // 2–3. Reconcile slots and launch candidates.
  for (const task of tasks.items) pass.guard(`scheduling task ${task.id}`, task.id, () => pass.reconcileTask(task));

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
