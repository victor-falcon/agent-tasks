import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatSource, knownMachines, type Resolution } from "./config.ts";
import type { Context } from "./context.ts";
import { AgentTasksError, NotFoundError } from "./errors.ts";
import { launchEnv, type LauncherSpec, resolveLauncher, sessionName, type SessionInput } from "./launcher.ts";
import { resolvePath } from "./paths.ts";
import { MachineUnreachableError } from "./ssh.ts";
import type { Attempt, KeepOpen, Run, RunStatus, SessionRecord, Task, Trigger } from "./schema.ts";
import { parseRunRef, runRef, runSlotId } from "./slot.ts";
import { isArchived, readArchivedTask, readRun, readTask, runLogRelativePath, writeRun } from "./store.ts";
import { loadTaskTemplate } from "./task-context.ts";
import { render } from "./template.ts";
import { formatInZone } from "./time.ts";
import { type LaunchOutcome, localOps, machineTarget, remoteOps, remotePayload, type SessionOps } from "./session-ops.ts";

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

/** Variables `templates/prompt.md` can use (checked by `config check`). */
export const PROMPT_TEMPLATE_VARIABLES = ["skill", "run_ref", "task_id", "title", "slot", "slot_id", "attempt", "cwd"] as const;

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

export function renderPrompt(ctx: Context, values: Record<(typeof PROMPT_TEMPLATE_VARIABLES)[number], string>): string {
  const file = join(ctx.paths.templatesDir, "prompt.md");
  const template = existsSync(file) ? readFileSync(file, "utf8") : DEFAULT_PROMPT_TEMPLATE;
  return render(template, { values }, existsSync(file) ? file : "the start prompt").trim();
}

/** One attempt as the launcher sees it, independent of where the run is stored. */
export interface AttemptInfo {
  taskId: string;
  title: string;
  /** The task's cwd as stored (may start with `~`). */
  cwd: string;
  slot: string;
  slotId: string;
  attempt: number;
  logPath: string;
  handle?: string;
}

/**
 * Everything the launcher needs for one attempt, resolved with this machine's
 * config and environment. Also used on an execution machine by `remote …`.
 */
export function attemptSessionInput(ctx: Context, info: AttemptInfo, resolution: Resolution, env = ctx.env): SessionInput {
  const ref = runRef(info.taskId, info.slotId);
  const cwd = resolvePath(info.cwd, env);
  const promptValues: Record<(typeof PROMPT_TEMPLATE_VARIABLES)[number], string> = {
    skill: resolution.skill,
    run_ref: ref,
    task_id: info.taskId,
    title: info.title,
    slot: info.slot,
    slot_id: info.slotId,
    attempt: String(info.attempt),
    cwd,
  };
  return {
    runRef: ref,
    taskId: info.taskId,
    title: info.title,
    cwd,
    slot: info.slot,
    slotId: info.slotId,
    attempt: info.attempt,
    skill: resolution.skill,
    prompt: () => renderPrompt(ctx, promptValues),
    agent: resolution.agent,
    logPath: info.logPath,
    env,
    agentEnv: {
      ...resolution.env,
      AGENT_TASKS_HOME: ctx.paths.dataDir,
      AGENT_TASKS_CONFIG: ctx.paths.configFile,
      AGENT_TASKS_RUN: ref,
      AGENT_TASKS_ATTEMPT: String(info.attempt),
    },
    handle: info.handle,
  };
}

/** Everything the launcher needs for one attempt of a run. */
export function sessionInput(ctx: Context, task: Task, resolution: Resolution, run: Run, attempt: Attempt): SessionInput {
  return attemptSessionInput(ctx, attemptInfo(ctx, task, run, attempt), resolution, launchEnv(ctx.env));
}

/** The launcher-independent facts of an attempt of a run stored here. */
export function attemptInfo(ctx: Context, task: Task, run: Run, attempt: Attempt): AttemptInfo {
  const slotId = runSlotId(run);
  return {
    taskId: task.id,
    title: task.title,
    cwd: task.cwd,
    slot: run.slot,
    slotId,
    attempt: attempt.n,
    logPath: dataFile(ctx, attempt.log ?? attemptLogRelative(task.id, slotId, attempt.n)),
    handle: attempt.session?.handle,
  };
}

export interface Session {
  task: Task;
  resolution: Resolution;
  /** The launcher, when the session runs on this machine; null when it runs on another one. */
  spec: LauncherSpec | null;
  /** The launcher's commands, run here or on the session's machine. */
  ops: SessionOps;
  run: Run;
  attempt: Attempt;
  record: SessionRecord;
  input: SessionInput;
}

/**
 * The latest attempt of a run with its launcher, or null when it has no
 * session. A session recorded with a `machine` that is not this one is
 * reached over SSH; runs without `machine` (older ones) ran here.
 */
export function sessionFor(ctx: Context, task: Task, resolution: Resolution, run: Run): Session | null {
  const attempt = lastAttempt(run);
  const record = attempt?.session;
  if (!attempt || !record) return null;
  const input = sessionInput(ctx, task, resolution, run, attempt);
  const target = machineTarget(ctx, record.machine);
  if (target) {
    const ops = remoteOps(ctx, target, remotePayload(task, input, target.machine), record.launcher);
    return { task, resolution, spec: null, ops, run, attempt, record, input };
  }
  const spec = resolveLauncher(resolution.launcher);
  return { task, resolution, spec, ops: localOps(spec, input), run, attempt, record, input };
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
  /**
   * When the task's machine is unreachable, take the (first) attempt back and
   * leave the run waiting, so the next tick tries again (tick, for due slots).
   * Otherwise the attempt fails with reason `machine_unreachable`.
   */
  deferUnreachable?: boolean;
}

/** Recorded on a run that waits for its machine to be reachable (see `StartOptions.deferUnreachable`). */
export const MACHINE_UNREACHABLE = "machine_unreachable";

/**
 * Adds an attempt to an existing run and launches it. The attempt is written
 * before launching, so an agent that calls `task`/`finish` right away finds
 * it. A failure returned here is already marked as reported.
 */
export function startAttempt(ctx: Context, task: Task, ref: string, opts: StartOptions): ExecEvent[] {
  const resolution = ctx.resolveFor(task);
  const at = stamp(ctx, resolution.timezone);
  const { slot } = parseRunRef(ref);
  // A machine reached over SSH resolves its own agent: it is recorded after the launch.
  // (An unknown machine fails the launch below.)
  const remote = Boolean(knownMachines(ctx.config.config)[task.machine]?.ssh);
  const localAgent = { command: resolution.agent.command, args: resolution.agent.args, shell: resolution.agent.shell, from: formatSource(resolution.sources.agent) };
  let n = 0;
  const run = updateRun(ctx, ref, (r) => {
    opts.precheck?.(r);
    n = r.attempts.length + 1;
    r.attempts.push({
      n,
      started_at: at,
      finished_at: null,
      session: null,
      agent: remote ? null : localAgent,
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

  let result: LaunchOutcome;
  try {
    const target = machineTarget(ctx, task.machine);
    // The launcher's real name comes back with the launch.
    const ops = target ? remoteOps(ctx, target, remotePayload(task, input, target.machine), "remote") : localOps(resolveLauncher(resolution.launcher), input, localAgent);
    loadTaskTemplate(ctx); // a broken templates/task.md would only fail inside the agent
    result = ops.launch();
  } catch (err) {
    const message = err instanceof AgentTasksError ? err.message : String(err);
    if (err instanceof MachineUnreachableError && opts.deferUnreachable && n === 1) {
      deferLaunch(ctx, ref, n, at, err);
      return [];
    }
    const reason = err instanceof MachineUnreachableError ? MACHINE_UNREACHABLE : "launch_failed";
    appendLog(input.logPath, `agent-tasks: ${message}`);
    updateRun(ctx, ref, (r) => endAttempt(r, n, "failed", reason, at, { message, reported: true }));
    return [{ type: "failed", ...base, reason, message }];
  }

  const record: SessionRecord = {
    launcher: result.launcher,
    handle: result.handle,
    name: sessionName(task.id, input.slotId, n),
    pid: result.pid,
    closed_at: null,
    ...(remote ? { machine: task.machine } : {}),
  };
  const updated = updateRun(ctx, ref, (r) => {
    r.attempts[n - 1]!.session = { ...record };
    if (remote) r.attempts[n - 1]!.agent = result.agent;
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

/**
 * Takes back attempt `n` of a run whose machine could not be reached and
 * leaves the run waiting (status `running`, reason `machine_unreachable`, no
 * attempt), so tick launches it again. One event marks the first failure.
 */
function deferLaunch(ctx: Context, ref: string, n: number, at: string, err: MachineUnreachableError): void {
  updateRun(ctx, ref, (r) => {
    if (r.attempts.length !== n || r.attempts[n - 1]!.session) return;
    r.attempts.pop();
    const started = r.events.findLastIndex((e) => e.event === "attempt_started" && e.attempt === n);
    if (started >= 0) r.events.splice(started, 1);
    r.status = "running";
    r.reason = MACHINE_UNREACHABLE;
    if (r.events.at(-1)?.event !== MACHINE_UNREACHABLE) r.events.push({ at, event: MACHINE_UNREACHABLE, machine: err.machine, message: err.message });
  });
}

/** Whether a run is waiting for its machine to be reachable before its first launch. */
export function isWaitingForMachine(run: Run): boolean {
  return run.status === "running" && run.attempts.length === 0 && run.reason === MACHINE_UNREACHABLE;
}

// ---------------------------------------------------------------------------
// Closing a session
// ---------------------------------------------------------------------------

export function keepsOpen(keepOpen: KeepOpen, status: RunStatus): boolean {
  return keepOpen === "always" || (keepOpen === "on_failure" && status !== "succeeded");
}

/**
 * Appends the session's output to the attempt's log: the launcher's `read`
 * (local background launchers already write there), or for a remote session
 * what its machine has (its log for background launchers).
 */
export function captureLog(ops: SessionOps, logPath: string, at: string): void {
  try {
    const text = ops.capture();
    if (text) appendLog(logPath, `--- session output (${at}) ---\n${text}`);
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
  | { action: "close_failed"; error: string }
  /** The session's machine could not be reached: nothing was closed, and tick tries again. */
  | { action: "unreachable"; error: string };

/**
 * Closes the latest attempt's session according to `keep_open`. The session
 * is claimed and recorded as closed (`closed_at` and the `closed` event)
 * under the run's lock before `close` runs, so two processes never close it
 * twice, and because closing may kill the very process that called it (an
 * agent calling `finish` from its terminal: `hc kill` ends the whole
 * terminal, `finish` included). A failed close takes the `closed` event back
 * and clears `closed_at`, so a later tick retries it.
 */
export function settleSession(ctx: Context, task: Task, ref: string, opts: SettleOptions): SettleResult {
  const resolution = ctx.resolveFor(task);
  const at = stamp(ctx, resolution.timezone);
  let decision = "none" as "none" | "kept" | "close";
  const hasClose = (s: SessionRecord): boolean => {
    try {
      // A remote launcher's commands are only known on its machine.
      return machineTarget(ctx, s.machine) !== null || Boolean(resolveLauncher(resolution.launcher).close);
    } catch {
      return true; // reported by sessionFor below, which takes the claim back
    }
  };
  const run = updateRun(ctx, ref, (r) => {
    const attempt = lastAttempt(r);
    const s = attempt?.session;
    if (!attempt || !s) return;
    const force = opts.force || s.close_pending === true;
    if (!force && (s.closed_at || s.kept_open)) return;
    if (!force && keepsOpen(resolution.keep_open, attempt.status)) {
      s.kept_open = true;
      r.events.push({ at, event: "kept_open", attempt: attempt.n, keep_open: resolution.keep_open });
      decision = "kept";
      return;
    }
    s.closed_at = at;
    s.kept_open = false;
    s.close_error = null;
    delete s.close_pending;
    r.events.push({ at, event: "closed", attempt: attempt.n, ...(hasClose(s) ? {} : { note: "the launcher has no close command" }) });
    decision = "close";
  });
  if (decision !== "close") return { action: decision };

  const n = run.attempts.length;
  // Takes the claim back. An unreachable machine is not a failed close: it does not count
  // towards MAX_CLOSE_ATTEMPTS and adds no event, so tick keeps trying quietly.
  const fail = (error: string, unreachable = false): SettleResult => {
    updateRun(ctx, ref, (r) => {
      const s = r.attempts[n - 1]!.session!;
      const claim = r.events.findLastIndex((e) => e.event === "closed" && e.attempt === n && e.at === at);
      if (claim >= 0) r.events.splice(claim, 1);
      s.closed_at = null;
      s.close_error = error;
      if (unreachable) {
        s.close_pending = true;
        return;
      }
      s.close_attempts = (s.close_attempts ?? 0) + 1;
      r.events.push({ at, event: "close_failed", attempt: n, message: error });
    });
    return unreachable ? { action: "unreachable", error } : { action: "close_failed", error };
  };
  let session: Session | null;
  try {
    session = sessionFor(ctx, task, resolution, run);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (!session) return { action: "none" };
  if (opts.capture) captureLog(session.ops, session.input.logPath, at);
  let result: ReturnType<SessionOps["close"]>;
  try {
    result = session.ops.close();
  } catch (err) {
    return fail((err as Error).message, err instanceof MachineUnreachableError);
  }
  if (result && !result.ok) {
    // A session that is already gone counts as closed (e.g. `kill` of a process that exited).
    let gone = false;
    try {
      gone = session.ops.status()?.state === "gone";
    } catch {
      // Unknown state: keep the failure.
    }
    if (!gone) return fail(result.error ?? "close failed");
  }
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
