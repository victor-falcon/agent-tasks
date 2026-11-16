import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatSource, type Resolution } from "./config.ts";
import type { Context } from "./context.ts";
import { AgentTasksError, NotFoundError } from "./errors.ts";
import { closeSession, launch, type LauncherSpec, readSession, resolveLauncher, sessionName, type SessionInput } from "./launcher.ts";
import { resolvePath } from "./paths.ts";
import type { Attempt, KeepOpen, Run, RunStatus, SessionRecord, Task, Trigger } from "./schema.ts";
import { parseRunRef, runRef, runSlotId } from "./slot.ts";
import { isArchived, readArchivedTask, readRun, readTask, runLogRelativePath, writeRun } from "./store.ts";
import { render } from "./template.ts";
import { formatInZone } from "./time.ts";

// Starting attempts, finishing them and closing their sessions. Shared by
// `tick`, `run`, `retry`, `finish` and `session …`.

/** What `tick`, `run`, `retry` and `finish` report. */
export const EXEC_EVENT_TYPES = ["launched", "succeeded", "failed", "timed_out", "missed", "superseded", "cancelled", "blocked", "anomaly"] as const;
export type ExecEventType = (typeof EXEC_EVENT_TYPES)[number];

export interface ExecEvent {
  type: ExecEventType;
  run_ref: string | null;
  task_id: string | null;
  attempt?: number;
  reason?: string | null;
  handle?: string | null;
  message?: string;
}

export const DEFAULT_PROMPT_TEMPLATE = "/{{skill}} {{run_ref}}";

/** After this many failed `close` commands, tick stops trying and leaves the session to the user. */
export const MAX_CLOSE_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Tasks and runs
// ---------------------------------------------------------------------------

/** A task by id, also when it was archived with `rm` (its runs may still be in progress). */
export function findTask(ctx: Context, id: string): { task: Task; archived: boolean } | null {
  try {
    return { task: readTask(ctx.paths, id), archived: false };
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
  }
  return isArchived(ctx.paths, id) ? { task: readArchivedTask(ctx.paths, id), archived: true } : null;
}

export function requireTask(ctx: Context, id: string): Task {
  const found = findTask(ctx, id);
  if (!found) throw new NotFoundError(`task "${id}" not found in ${ctx.paths.tasksDir}`);
  return found.task;
}

export function lastAttempt(run: Run): Attempt | undefined {
  return run.attempts.at(-1);
}

export function stamp(ctx: Context, timezone: string): string {
  return formatInZone(ctx.now, timezone);
}

/** A new occurrence, not written yet. */
export function newRun(taskId: string, at: Date, timezone: string, trigger: Trigger, status: RunStatus, reason: string | null, event: Record<string, unknown>, now: string): Run {
  return { task_id: taskId, slot: formatInZone(at, timezone), trigger, status, reason, attempts: [], events: [{ at: now, ...event, event: String(event.event) }] };
}

/**
 * Runs `fn` holding an exclusive lock file. Lock age uses the wall clock on
 * purpose (not `ctx.now`): it measures how long a real process has held it.
 */
function withLock<T>(path: string, what: string, fn: () => T): T {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      closeSync(openSync(path, "wx"));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        // A lock older than this belongs to a process that died while holding it.
        if (Date.now() - statSync(path).mtimeMs > 10_000) rmSync(path, { force: true });
      } catch {
        // Removed meanwhile: try again.
      }
      if (Date.now() > deadline) throw new AgentTasksError("locked", `${what} is locked by another process (${path})`);
      Bun.sleepSync(5);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(path, { force: true });
  }
}

/**
 * Read-modify-write of a run file under a lock, so `finish` (from the agent)
 * and `tick` (from the runner) never overwrite each other's changes.
 */
export function updateRun(ctx: Context, ref: string, change: (run: Run) => void): Run {
  const { taskId, slot } = parseRunRef(ref);
  const lock = join(ctx.paths.runsDir, taskId, `.${slot}.lock`);
  return withLock(lock, `run ${ref}`, () => {
    const run = readRun(ctx.paths, taskId, slot);
    change(run);
    writeRun(ctx.paths, run);
    return run;
  });
}

export interface EndOptions {
  summary?: string | null;
  message?: string;
  /** Who ended it, e.g. `finish`. */
  by?: string;
  /** Also mark the outcome as reported, when the caller reports it itself. */
  reported?: boolean;
}

/** Ends attempt `n` with a final status. Only the latest attempt sets the run's status. */
export function endAttempt(run: Run, n: number, status: RunStatus, reason: string | null, at: string, opts: EndOptions = {}): void {
  const attempt = run.attempts[n - 1]!;
  attempt.status = status;
  attempt.reason = reason;
  attempt.finished_at = at;
  if (opts.summary !== undefined) attempt.summary = opts.summary;
  if (n === run.attempts.length) {
    run.status = status;
    run.reason = reason;
  }
  run.events.push({ at, event: status, attempt: n, ...(reason ? { reason } : {}), ...(opts.message ? { message: opts.message } : {}), ...(opts.by ? { by: opts.by } : {}) });
  if (opts.reported) run.events.push({ at, event: "reported", attempt: n });
}

export function isReported(run: Run, n: number): boolean {
  return run.events.some((e) => e.event === "reported" && e.attempt === n);
}

// ---------------------------------------------------------------------------
// Launcher input
// ---------------------------------------------------------------------------

function attemptLogRelative(taskId: string, slot: string, n: number): string {
  return n === 1 ? runLogRelativePath(taskId, slot) : `runs/${taskId}/${slot}.${n}.log`;
}

/** Absolute path of a path stored relative to the data folder (`attempt.log`, `attempt.output`). */
export function dataFile(ctx: Context, relative: string): string {
  return join(ctx.paths.dataDir, relative);
}

export function renderPrompt(ctx: Context, values: Record<string, string>): string {
  const file = join(ctx.paths.templatesDir, "prompt.md");
  const template = existsSync(file) ? readFileSync(file, "utf8") : DEFAULT_PROMPT_TEMPLATE;
  return render(template, { values }, existsSync(file) ? file : "the start prompt").trim();
}

/** Everything the launcher needs for one attempt of a run. */
export function sessionInput(ctx: Context, task: Task, resolution: Resolution, run: Run, attempt: Attempt): SessionInput {
  const slotId = runSlotId(run);
  const ref = runRef(task.id, slotId);
  const cwd = resolvePath(task.cwd, ctx.env);
  const promptValues = { skill: resolution.skill, run_ref: ref, task_id: task.id, title: task.title, slot: run.slot, slot_id: slotId, attempt: String(attempt.n), cwd };
  return {
    runRef: ref,
    taskId: task.id,
    title: task.title,
    cwd,
    slot: run.slot,
    slotId,
    attempt: attempt.n,
    skill: resolution.skill,
    prompt: () => renderPrompt(ctx, promptValues),
    agent: resolution.agent,
    logPath: dataFile(ctx, attempt.log ?? attemptLogRelative(task.id, slotId, attempt.n)),
    env: ctx.env,
    agentEnv: {
      ...resolution.env,
      AGENT_TASKS_HOME: ctx.paths.dataDir,
      AGENT_TASKS_CONFIG: ctx.paths.configFile,
      AGENT_TASKS_RUN: ref,
      AGENT_TASKS_ATTEMPT: String(attempt.n),
    },
    handle: attempt.session?.handle,
  };
}

export interface Session {
  task: Task;
  resolution: Resolution;
  spec: LauncherSpec;
  run: Run;
  attempt: Attempt;
  record: SessionRecord;
  input: SessionInput;
}

/** The latest attempt of a run with its launcher, or null when it has no session. */
export function sessionFor(ctx: Context, task: Task, resolution: Resolution, run: Run): Session | null {
  const attempt = lastAttempt(run);
  const record = attempt?.session;
  if (!attempt || !record) return null;
  const spec = resolveLauncher(resolution.launcher);
  return { task, resolution, spec, run, attempt, record, input: sessionInput(ctx, task, resolution, run, attempt) };
}

/** The session of the latest attempt of a run. Throws when it has none. */
export function loadSession(ctx: Context, ref: string): Session {
  const run = readRunRef(ctx, ref);
  const task = requireTask(ctx, run.task_id);
  const session = sessionFor(ctx, task, ctx.resolveFor(task), run);
  if (!session) throw new NotFoundError(`run ${ref} has no session (it was never launched)`);
  return session;
}

export function readRunRef(ctx: Context, ref: string): Run {
  const { taskId, slot } = parseRunRef(ref);
  return readRun(ctx.paths, taskId, slot);
}

// ---------------------------------------------------------------------------
// Starting an attempt
// ---------------------------------------------------------------------------

export function appendLog(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
}

export interface StartOptions {
  /** Who starts it: `tick`, `run`, `retry`. */
  by: string;
  /** Checked under the run's lock before adding the attempt; throw to refuse. */
  precheck?: (run: Run) => void;
}

/**
 * Adds an attempt to an existing run and launches it. The attempt is written
 * before launching, so an agent that calls `task`/`finish` right away finds
 * it. A failure returned here is already marked as reported.
 */
export function startAttempt(ctx: Context, task: Task, ref: string, opts: StartOptions): ExecEvent[] {
  const resolution = ctx.resolveFor(task);
  const at = stamp(ctx, resolution.timezone);
  const { slot } = parseRunRef(ref);
  let n = 0;
  const run = updateRun(ctx, ref, (r) => {
    opts.precheck?.(r);
    n = r.attempts.length + 1;
    r.attempts.push({
      n,
      started_at: at,
      finished_at: null,
      session: null,
      agent: { command: resolution.agent.command, args: resolution.agent.args, shell: resolution.agent.shell, from: formatSource(resolution.sources.agent) },
      status: "running",
      summary: null,
      log: attemptLogRelative(task.id, slot, n),
      reason: null,
      output: null,
    });
    r.status = "running";
    r.reason = null;
    r.events.push({ at, event: "attempt_started", attempt: n, by: opts.by });
  });
  const input = sessionInput(ctx, task, resolution, run, run.attempts[n - 1]!);
  const base = { run_ref: ref, task_id: task.id, attempt: n };

  let spec: LauncherSpec;
  let result: ReturnType<typeof launch>;
  try {
    spec = resolveLauncher(resolution.launcher);
    result = launch(spec, input);
  } catch (err) {
    const message = err instanceof AgentTasksError ? err.message : String(err);
    appendLog(input.logPath, `agent-tasks: ${message}`);
    updateRun(ctx, ref, (r) => endAttempt(r, n, "failed", "launch_failed", at, { message, reported: true }));
    return [{ type: "failed", ...base, reason: "launch_failed", message }];
  }

  const record: SessionRecord = { launcher: spec.name, handle: result.handle, name: sessionName(task.id, input.slotId, n), pid: result.pid, closed_at: null };
  const updated = updateRun(ctx, ref, (r) => {
    r.attempts[n - 1]!.session = { ...record };
    r.events.push({ at, event: "launched", attempt: n, handle: result.handle });
  });
  const events: ExecEvent[] = [{ type: "launched", ...base, handle: result.handle }];
  if (!result.delivered) {
    const message = result.error ?? "the prompt was not delivered";
    let ended = false;
    updateRun(ctx, ref, (r) => {
      if (r.attempts[n - 1]!.finished_at) return;
      endAttempt(r, n, "failed", "prompt_not_delivered", at, { message, reported: true });
      ended = true;
    });
    if (ended) {
      settleSession(ctx, task, ref, { capture: true });
      appendLog(input.logPath, `agent-tasks: ${message}`);
      events.push({ type: "failed", ...base, handle: result.handle, reason: "prompt_not_delivered", message });
    }
  } else if (updated.attempts[n - 1]!.finished_at) {
    // The agent called `finish` before its session was recorded, so it could not close it.
    settleSession(ctx, task, ref, {});
  }
  return events;
}

// ---------------------------------------------------------------------------
// Closing a session
// ---------------------------------------------------------------------------

export function keepsOpen(keepOpen: KeepOpen, status: RunStatus): boolean {
  return keepOpen === "always" || (keepOpen === "on_failure" && status !== "succeeded");
}

/** Appends the launcher's `read` to the attempt's log. Background launchers already write there. */
export function captureLog(spec: LauncherSpec, input: SessionInput, at: string): void {
  if (spec.background) return;
  try {
    const text = readSession(spec, input);
    if (text) appendLog(input.logPath, `--- session output (${at}) ---\n${text}`);
  } catch {
    // The output is a convenience; a failed read must not stop the close.
  }
}

export interface SettleOptions {
  /** Close even if `keep_open` says keep, or it was kept or closed before (timeouts, `session close`). */
  force?: boolean;
  /** Append the session's output to the log first. */
  capture?: boolean;
}

export type SettleResult =
  | { action: "none" }
  | { action: "kept" }
  | { action: "closed" }
  | { action: "close_failed"; error: string };

/**
 * Closes the latest attempt's session according to `keep_open`. The session
 * is claimed under the run's lock (`closed_at` is set) before `close` runs,
 * so two processes never close it twice, and because closing may kill the
 * very process that called it (an agent calling `finish` from its terminal).
 * A failed close clears `closed_at` again so a later tick retries it.
 */
export function settleSession(ctx: Context, task: Task, ref: string, opts: SettleOptions): SettleResult {
  const resolution = ctx.resolveFor(task);
  const at = stamp(ctx, resolution.timezone);
  let decision = "none" as "none" | "kept" | "close";
  const run = updateRun(ctx, ref, (r) => {
    const attempt = lastAttempt(r);
    const s = attempt?.session;
    if (!attempt || !s) return;
    if (!opts.force && (s.closed_at || s.kept_open)) return;
    if (!opts.force && keepsOpen(resolution.keep_open, attempt.status)) {
      s.kept_open = true;
      r.events.push({ at, event: "kept_open", attempt: attempt.n, keep_open: resolution.keep_open });
      decision = "kept";
      return;
    }
    s.closed_at = at;
    s.kept_open = false;
    decision = "close";
  });
  if (decision !== "close") return { action: decision };

  const n = run.attempts.length;
  const fail = (error: string): SettleResult => {
    updateRun(ctx, ref, (r) => {
      const s = r.attempts[n - 1]!.session!;
      s.closed_at = null;
      s.close_error = error;
      s.close_attempts = (s.close_attempts ?? 0) + 1;
      r.events.push({ at, event: "close_failed", attempt: n, message: error });
    });
    return { action: "close_failed", error };
  };
  let session: Session | null;
  try {
    session = sessionFor(ctx, task, resolution, run);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (!session) return { action: "none" };
  if (opts.capture) captureLog(session.spec, session.input, at);
  const result = closeSession(session.spec, session.input);
  if (result && !result.ok) return fail(result.error ?? "close failed");
  updateRun(ctx, ref, (r) => {
    const s = r.attempts[n - 1]!.session!;
    s.close_error = null;
    r.events.push({ at, event: "closed", attempt: n, ...(result ? {} : { note: "the launcher has no close command" }) });
  });
  return { action: "closed" };
}

/** Marks the latest attempt's session as closed without running `close` (it is already gone). */
export function markSessionGone(ctx: Context, ref: string, at: string): void {
  updateRun(ctx, ref, (r) => {
    const s = lastAttempt(r)?.session;
    if (s && !s.closed_at) {
      s.closed_at = at;
      r.events.push({ at, event: "session_gone", attempt: r.attempts.length });
    }
  });
}
