import { knownMachines } from "./config.ts";
import type { Context } from "./context.ts";
import { AgentTasksError } from "./errors.ts";
import {
  closeSession,
  launch,
  type LaunchResult,
  type LauncherSpec,
  readSession,
  type SessionInput,
  SESSION_STATES,
  type SessionState,
  sessionStatus,
  type StatusResult,
} from "./launcher.ts";
import { callRemote, MachineUnreachableError, type RemoteTarget } from "./ssh.ts";
import type { AgentSpec, Task } from "./schema.ts";

// "Session ops for this task": the launcher's commands run here when the
// session's machine is this one, or through `agent-tasks remote <op>` over
// SSH on the machine that runs it. Execution code (tick, finish, session …)
// only talks to this interface.

export interface LaunchOutcome extends LaunchResult {
  /** The launcher preset name, or `custom`. */
  launcher: string;
  /** The agent that was started, as resolved where it runs. */
  agent: Record<string, unknown> | null;
}

export interface SessionOps {
  /** The machine that runs the session, or null for this machine. */
  readonly machine: string | null;
  /** The launcher's name, for messages (remote: as recorded at launch). */
  readonly launcherName: string;
  /** False only when the launcher is known to have no `close`. */
  readonly canClose: boolean;
  /** Starts the session (a new attempt). Throws when no session was started. */
  launch(): LaunchOutcome;
  /** The session's state, or null without a `status` command. Throws when unknown (or unreachable). */
  status(): StatusResult | null;
  /** The session's screen (`read`), or null without one. */
  read(): string | null;
  /** What to append to the run's log when the session ends, or null when there is nothing to add. */
  capture(): string | null;
  /** Runs `close`; null when the launcher has none. */
  close(): { ok: boolean; error: string | null } | null;
}

/** Runs the launcher on this machine: the behaviour of a single-machine setup. */
export function localOps(spec: LauncherSpec, input: SessionInput, agent: Record<string, unknown> | null = null): SessionOps {
  return {
    machine: null,
    launcherName: spec.name,
    canClose: Boolean(spec.close),
    launch: () => ({ ...launch(spec, input), launcher: spec.name, agent }),
    status: () => sessionStatus(spec, input),
    read: () => readSession(spec, input),
    // Background launchers already write their output to the log.
    capture: () => (spec.background ? null : readSession(spec, input)),
    close: () => closeSession(spec, input),
  };
}

/**
 * How to reach a machine: null when it is this one, its SSH alias otherwise.
 * Throws when the machine is no longer in the config.
 */
export function machineTarget(ctx: Context, machine: string | undefined | null): RemoteTarget | null {
  if (!machine) return null;
  const entry = knownMachines(ctx.config.config)[machine];
  if (!entry) throw new AgentTasksError("unknown_machine", `machine "${machine}" is not in the config's \`machines\``);
  return entry.ssh ? { machine, ssh: entry.ssh } : null;
}

/** What an execution machine needs to resolve and run one attempt with its own config (protocol 1). */
export interface RemoteSessionPayload {
  /** The name the hub gives the machine. */
  machine: string;
  task: { id: string; title: string; cwd: string; agent: AgentSpec | string | null };
  run_ref: string;
  slot: string;
  slot_id: string;
  attempt: number;
  /** Known after launch: for status, read and close. */
  handle?: string;
}

export function remotePayload(task: Task, input: SessionInput, machine: string): RemoteSessionPayload {
  return {
    machine,
    task: { id: task.id, title: task.title, cwd: task.cwd, agent: task.agent ?? null },
    run_ref: input.runRef,
    slot: input.slot,
    slot_id: input.slotId,
    attempt: input.attempt,
    ...(input.handle ? { handle: input.handle } : {}),
  };
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * Machines found unreachable during one command (one tick: each tick gets a
 * fresh context), so a tick with several runs on a machine that is down waits
 * for the SSH connect timeout once, not once per run.
 */
const unreachableByContext = new WeakMap<Context, Map<string, MachineUnreachableError>>();

/** `callRemote`, remembering per context which machines could not be reached. */
export function callMachine(ctx: Context, target: RemoteTarget, op: string, payload: Record<string, unknown>): Record<string, unknown> {
  let known = unreachableByContext.get(ctx);
  const before = known?.get(target.machine);
  if (before) throw before;
  try {
    return callRemote(target, op, payload, ctx.env);
  } catch (err) {
    if (err instanceof MachineUnreachableError) {
      if (!known) unreachableByContext.set(ctx, (known = new Map()));
      known.set(target.machine, err);
    }
    throw err;
  }
}

function badAnswer(target: RemoteTarget, op: string, what: string): AgentTasksError {
  return new AgentTasksError("remote_failed", `remote ${op} on machine "${target.machine}" answered without ${what}`);
}

/** Runs the launcher on `target` with `agent-tasks remote <op>`. `launcher` is the name recorded at launch. */
export function remoteOps(ctx: Context, target: RemoteTarget, payload: RemoteSessionPayload, launcher: string): SessionOps {
  const call = (op: string, extra: Record<string, unknown> = {}) => callMachine(ctx, target, op, { ...payload, ...extra });
  return {
    machine: target.machine,
    launcherName: launcher,
    canClose: true,
    launch() {
      const r = call("launch");
      const handle = str(r.handle);
      if (!handle) throw badAnswer(target, "launch", "a handle");
      return {
        handle,
        pid: typeof r.pid === "number" ? r.pid : null,
        delivered: r.delivered !== false,
        error: str(r.error),
        launcher: str(r.launcher) ?? "custom",
        agent: r.agent && typeof r.agent === "object" ? (r.agent as Record<string, unknown>) : null,
      };
    },
    status() {
      const r = call("status");
      if (r.state === null) return null;
      if (!SESSION_STATES.includes(r.state as SessionState)) throw badAnswer(target, "status", "a known state");
      return { state: r.state as SessionState, raw: str(r.raw) ?? "" };
    },
    read: () => str(call("read", { mode: "screen" }).output),
    capture: () => str(call("read", { mode: "capture" }).output),
    close() {
      const r = call("close");
      if (r.closed === null) return null;
      if (typeof r.closed !== "boolean") throw badAnswer(target, "close", "closed");
      return { ok: r.closed, error: str(r.error) };
    },
  };
}
