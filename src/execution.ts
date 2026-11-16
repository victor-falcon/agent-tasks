import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatSource, type Resolution } from "./config.ts";
import type { Context } from "./context.ts";
import { AgentTasksError, NotFoundError } from "./errors.ts";
import { closeSession, launch, type LauncherSpec, readSession, resolveLauncher, sessionName, type SessionInput } from "./launcher.ts";
import { resolvePath } from "./paths.ts";
import type { Attempt, KeepOpen, Run, RunStatus, Task, Trigger } from "./schema.ts";
import { parseRunRef, runRef, runSlotId } from "./slot.ts";
import { readRun, readTask, readTaskFile, runLogRelativePath, writeRun } from "./store.ts";
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

/** What the run file keeps about the session of an attempt (`attempt.session`). */
export interface SessionRecord {
  launcher: string;
  handle: string;
  name: string;
  pid: number | null;
  /** When `close` was run (or the session was found gone). */
  closed_at: string | null;
  close_error?: string | null;
  /** True when `keep_open` left the session open on purpose. */
  kept_open?: boolean;
}

export const DEFAULT_PROMPT_TEMPLATE = "/{{skill}} {{run_ref}}";

// ---------------------------------------------------------------------------
// Tasks and runs
// ---------------------------------------------------------------------------

/** A task by id, also when it was archived with `rm` (its runs may still be in progress). */
export function findTask(ctx: Context, id: string): Task | null {
  try {
    return readTask(ctx.paths, id);
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
  }
  const archived = join(ctx.paths.archiveDir, `${id}.json`);
  return existsSync(archived) ? readTaskFile(archived) : null;
}

export function requireTask(ctx: Context, id: string): Task {
  const task = findTask(ctx, id);
  if (!task) throw new NotFoundError(`task "${id}" not found in ${ctx.paths.tasksDir}`);
  return task;
}

export function lastAttempt(run: Run): Attempt | undefined {
  return run.attempts.at(-1);
}

export function sessionOf(attempt: Attempt | undefined): SessionRecord | null {
  return (attempt?.session as SessionRecord | null | undefined) ?? null;
}

export function stamp(ctx: Context, timezone: string): string {
  return formatInZone(ctx.now, timezone);
}

/** A new occurrence, not written yet. */
export function newRun(taskId: string, at: Date, timezone: string, trigger: Trigger, status: RunStatus, reason: string | null, event: Record<string, unknown>, now: string): Run {
  return { task_id: taskId, slot: formatInZone(at, timezone), trigger, status, reason, attempts: [], events: [{ at: now, ...event, event: String(event.event) }] };
}

function withLock<T>(path: string, what: string, fn: () => T): T {
  const deadline = Date.now() + 5_000;
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

/** Ends attempt `n` with a final status. Only the latest attempt sets the run's status. */
export function endAttempt(run: Run, n: number, status: RunStatus, reason: string | null, at: string, extra: { summary?: string | null; message?: string } = {}): void {
  const attempt = run.attempts[n - 1]!;
  attempt.status = status;
  attempt.reason = reason;
  attempt.finished_at = at;
  if (extra.summary !== undefined) attempt.summary = extra.summary;
  if (n === run.attempts.length) {
    run.status = status;
    run.reason = reason;
  }
  run.events.push({ at, event: status, attempt: n, ...(reason ? { reason } : {}), ...(extra.message ? { message: extra.message } : {}) });
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
  const session = sessionOf(attempt);
  const base = { skill: resolution.skill, run_ref: ref, task_id: task.id, title: task.title, slot: run.slot, slot_id: slotId, attempt: String(attempt.n), cwd };
  return {
    runRef: ref,
    taskId: task.id,
    title: task.title,
    cwd,
    slot: run.slot,
    slotId,
    attempt: attempt.n,
    skill: resolution.skill,
    prompt: () => renderPrompt(ctx, base),
    agent: resolution.agent,
    logPath: dataFile(ctx, attempt.log ?? attemptLogRelative(task.id, slotId, attempt.n)),
    env: ctx.env,
    agentEnv: {
      ...resolution.env,
      AGENT_TASKS_HOME: ctx.paths.dataDir,
      AGENT_TASKS_CONFIG: ctx.paths.configFile,
      AGENT_TASKS_RUN: ref,
    },
    handle: session?.handle,
  };
}

/** Environment for launcher commands: the runner's, plus what the agent needs. */
export function commandEnv(input: SessionInput): Record<string, string | undefined> {
  return { ...input.env, ...input.agentEnv };
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

/** The session of the latest attempt of a run, with its launcher. Throws when it has none. */
export function loadSession(ctx: Context, ref: string): Session {
  const { taskId, slot } = parseRunRef(ref);
  const run = readRun(ctx.paths, taskId, slot);
  const attempt = lastAttempt(run);
  const record = sessionOf(attempt);
  if (!attempt || !record) throw new NotFoundError(`run ${ref} has no session (it was never launched)`);
  const task = requireTask(ctx, taskId);
  const resolution = ctx.resolveFor(task);
  const spec = resolveLauncher(resolution.launcher);
  return { task, resolution, spec, run, attempt, record, input: sessionInput(ctx, task, resolution, run, attempt) };
}

// ---------------------------------------------------------------------------
// Starting an attempt
// ---------------------------------------------------------------------------

function appendLog(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
}

/**
 * Adds an attempt to an existing run and launches it. The attempt is written
 * before launching, so an agent that calls `task`/`finish` right away finds it.
 */
export function startAttempt(ctx: Context, task: Task, ref: string, by: string): ExecEvent[] {
  const resolution = ctx.resolveFor(task);
  const at = stamp(ctx, resolution.timezone);
  const { slot } = parseRunRef(ref);
  let n = 0;
  const run = updateRun(ctx, ref, (r) => {
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
    r.events.push({ at, event: "attempt_started", attempt: n, by });
  });
  const input = sessionInput(ctx, task, resolution, run, run.attempts[n - 1]!);
  const base = { run_ref: ref, task_id: task.id, attempt: n };

  let spec: LauncherSpec;
  let result: ReturnType<typeof launch>;
  try {
    spec = resolveLauncher(resolution.launcher);
    result = launch(spec, input, commandEnv(input));
  } catch (err) {
    const message = err instanceof AgentTasksError ? err.message : String(err);
    appendLog(input.logPath, `agent-tasks: ${message}`);
    updateRun(ctx, ref, (r) => endAttempt(r, n, "failed", "launch_failed", at, { message }));
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
    appendLog(input.logPath, `agent-tasks: ${message}`);
    updateRun(ctx, ref, (r) => {
      if (!r.attempts[n - 1]!.finished_at) endAttempt(r, n, "failed", "prompt_not_delivered", at, { message });
    });
    settleSession(ctx, task, ref, { capture: true });
    events.push({ type: "failed", ...base, handle: result.handle, reason: "prompt_not_delivered", message });
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

/** Saves the launcher's `read` into the attempt's log. Background launchers already write there. */
export function captureLog(spec: LauncherSpec, input: SessionInput): void {
  if (spec.background) return;
  try {
    const text = readSession(spec, input, commandEnv(input));
    if (text !== null) {
      mkdirSync(dirname(input.logPath), { recursive: true });
      writeFileSync(input.logPath, text);
    }
  } catch {
    // The output is a convenience; a failed read must not stop the close.
  }
}

export interface SettleOptions {
  /** Close even if `keep_open` says keep (timeouts). */
  force?: boolean;
  /** Save the session's output into the log first. */
  capture?: boolean;
  /** On a failed close, leave `closed_at` empty so the next tick tries again. */
  retryable?: boolean;
}

/**
 * Closes the latest attempt's session according to `keep_open`, once.
 * `closed_at` is written before running `close`: closing may kill the very
 * process that called it (an agent calling `finish` from its own terminal).
 */
export function settleSession(ctx: Context, task: Task, ref: string, opts: SettleOptions): void {
  const { taskId, slot } = parseRunRef(ref);
  const run = readRun(ctx.paths, taskId, slot);
  const attempt = lastAttempt(run);
  const record = sessionOf(attempt);
  if (!attempt || !record || record.closed_at || record.kept_open) return;
  const resolution = ctx.resolveFor(task);
  const at = stamp(ctx, resolution.timezone);
  const n = attempt.n;
  const patch = (change: (s: SessionRecord) => void, event?: Record<string, unknown>) =>
    updateRun(ctx, ref, (r) => {
      const s = r.attempts[n - 1]!.session as unknown as SessionRecord;
      change(s);
      if (event) r.events.push({ at, event: String(event.event), attempt: n, ...event });
    });

  if (!opts.force && keepsOpen(resolution.keep_open, attempt.status)) {
    patch((s) => void (s.kept_open = true), { event: "kept_open", keep_open: resolution.keep_open });
    return;
  }
  let spec: LauncherSpec;
  try {
    spec = resolveLauncher(resolution.launcher);
  } catch (err) {
    patch((s) => void (s.close_error = (err as Error).message));
    return;
  }
  const input = sessionInput(ctx, task, resolution, run, attempt);
  if (opts.capture) captureLog(spec, input);
  patch((s) => {
    s.closed_at = at;
    s.close_error = null;
  }, { event: "closed" });
  const result = closeSession(spec, input, commandEnv(input));
  if (result && !result.ok) {
    patch((s) => {
      s.close_error = result.error;
      if (opts.retryable) s.closed_at = null;
    });
  }
}

/** Marks the latest attempt's session as closed without running `close` (it is already gone). */
export function markSessionGone(ctx: Context, ref: string, at: string): void {
  updateRun(ctx, ref, (r) => {
    const s = sessionOf(lastAttempt(r));
    if (s && !s.closed_at) {
      s.closed_at = at;
      r.events.push({ at, event: "session_gone", attempt: r.attempts.length });
    }
  });
}

/** Reads the run of a ref, or throws NotFoundError. */
export function readRunRef(ctx: Context, ref: string): Run {
  const { taskId, slot } = parseRunRef(ref);
  return readRun(ctx.paths, taskId, slot);
}
