import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { BUILTIN_DEFAULTS, formatSource, type LauncherConfig, localMachine, type Resolution } from "./config.ts";
import { launcherChecks, launcherName } from "./config-check.ts";
import type { Context } from "./context.ts";
import { AgentTasksError } from "./errors.ts";
import { attemptSessionInput } from "./execution.ts";
import { commandEnv, exec, handOverTerminal, LauncherError, type LauncherSpec, renderCommand, resolveLauncher, type SessionInput, shellOf } from "./launcher.ts";
import { homeDir, resolvePath, type Env } from "./paths.ts";
import { REMOTE_PROTOCOL } from "./ssh.ts";
import { type AgentSpec, Checker, checkAgent, isObject, TASK_ID_RE } from "./schema.ts";
import { localOps, type RemoteSessionPayload } from "./session-ops.ts";
import { isSlotId, runRef } from "./slot.ts";
import { loadPersonalInstructions } from "./task-context.ts";
import { displayPath } from "./task-flags.ts";

// The execution machine's side of `agent-tasks remote <op>`: the hub sends
// what it knows about an attempt, and this machine resolves the launcher,
// agent, profile, skill, env and instructions with its own config, then runs
// the launcher here. See doc/roadmap/runner.md, "Remote machines".

export class RemoteProtocolError extends AgentTasksError {
  constructor(message: string, details: string[] = []) {
    super("remote_protocol", message, details);
  }
}

/** Refuses a payload of another protocol version. */
export function checkProtocol(payload: Record<string, unknown>): void {
  if (payload.protocol !== REMOTE_PROTOCOL) {
    throw new RemoteProtocolError(`unsupported remote protocol ${JSON.stringify(payload.protocol ?? null)} (this agent-tasks speaks ${REMOTE_PROTOCOL}); update agent-tasks on both machines`);
  }
}

/** Validates a session payload (launch, status, read, close). */
export function parseSessionPayload(payload: Record<string, unknown>, { needsHandle }: { needsHandle: boolean }): RemoteSessionPayload {
  checkProtocol(payload);
  const c = new Checker();
  const task = payload.task;
  if (!isObject(task)) c.at("task").fail("must be an object");
  else {
    if (typeof task.id !== "string" || !TASK_ID_RE.test(task.id)) c.at("task.id").fail("must be a task id");
    if (typeof task.title !== "string") c.at("task.title").fail("must be a string");
    if (typeof task.cwd !== "string" || task.cwd === "") c.at("task.cwd").fail("must be a non-empty string");
    checkAgent(c.at("task.agent"), task.agent ?? null, { nullable: true });
  }
  if (typeof payload.machine !== "string") c.at("machine").fail("must be a string");
  if (typeof payload.slot !== "string") c.at("slot").fail("must be a string");
  if (typeof payload.slot_id !== "string" || !isSlotId(payload.slot_id)) c.at("slot_id").fail("must be a slot id");
  if (!Number.isInteger(payload.attempt) || (payload.attempt as number) < 1) c.at("attempt").fail("must be an integer >= 1");
  if (needsHandle && (typeof payload.handle !== "string" || payload.handle === "")) c.at("handle").fail("must be the session's handle");
  if (c.errors.length > 0) throw new RemoteProtocolError("invalid remote payload:", c.errors);
  const p = payload as unknown as RemoteSessionPayload;
  if (isObject(task) && p.run_ref !== runRef(p.task.id, p.slot_id)) throw new RemoteProtocolError(`invalid remote payload: run_ref does not match task.id and slot_id`);
  return p;
}

function resolveHere(ctx: Context, task: { cwd: string; agent?: AgentSpec | string | null }): Resolution {
  return ctx.resolveFor({ cwd: task.cwd, agent: task.agent ?? null });
}

/**
 * The environment of the launcher here. SSH runs commands in a non-interactive
 * shell: PATH is minimal (often without ~/.local/bin, which the agent needs to
 * call agent-tasks) and SHELL may be unset. PATH gets the folders the user's
 * login shell adds (its profile, e.g. Homebrew's), so the launcher's programs
 * (hc, tmux…) and the agent are found; then ~/.local/bin if missing. The
 * interactive shell the presets start adds what its rc files set.
 */
export function remoteEnv(env: Env): Env {
  const shell = shellOf(env);
  const path = mergePaths(loginShellPath(env, shell), env.PATH ?? "");
  const bin = join(homeDir(env), ".local", "bin");
  return { ...env, PATH: path.split(":").includes(bin) ? path : path ? `${bin}:${path}` : bin, SHELL: shell };
}

/** PATH as the user's login shell sets it, or "" when it can't be read. */
function loginShellPath(env: Env, shell: string): string {
  const result = exec([shell, "-lc", "/usr/bin/env"], { env, cwd: homeDir(env), timeoutMs: 10_000 });
  if (result.code !== 0) return "";
  const line = result.stdout.split("\n").findLast((l) => l.startsWith("PATH="));
  return line ? line.slice("PATH=".length) : "";
}

/** `first`'s folders, then those of `second` that are not in it. */
function mergePaths(first: string, second: string): string {
  const seen = new Set<string>();
  return [...first.split(":"), ...second.split(":")].filter((p) => p !== "" && !seen.has(p) && seen.add(p)).join(":");
}

/** Where a background launcher's output goes on this machine (the hub keeps its own log). */
export function remoteLogPath(ctx: Context, taskId: string, slotId: string, attempt: number): string {
  return join(ctx.paths.dataDir, "remote", taskId, `${slotId}${attempt > 1 ? `.${attempt}` : ""}.log`);
}

interface Local {
  resolution: Resolution;
  spec: LauncherSpec;
  input: SessionInput;
}

function localSession(ctx: Context, p: RemoteSessionPayload): Local {
  const resolution = resolveHere(ctx, p.task);
  const spec = resolveLauncher(resolution.launcher);
  const input = attemptSessionInput(
    ctx,
    {
      taskId: p.task.id,
      title: p.task.title,
      cwd: p.task.cwd,
      slot: p.slot,
      slotId: p.slot_id,
      attempt: p.attempt,
      logPath: remoteLogPath(ctx, p.task.id, p.slot_id, p.attempt),
      handle: p.handle,
    },
    resolution,
    remoteEnv(ctx.env),
  );
  return { resolution, spec, input };
}

const answer = (data: Record<string, unknown>) => ({ protocol: REMOTE_PROTOCOL, ...data });

/**
 * Starts the attempt's session here. Idempotent per attempt: when the SSH
 * connection breaks after the launch, the hub sees ssh exit 255 and launches
 * again on a later tick; if the session started then is still alive, its
 * answer is returned again (with `reused: true`) instead of a second agent.
 */
export function remoteLaunch(ctx: Context, payload: Record<string, unknown>): Record<string, unknown> {
  const { resolution, spec, input } = localSession(ctx, parseSessionPayload(payload, { needsHandle: false }));
  const recordFile = input.logPath.replace(/\.log$/, ".launch.json");
  const previous = readLaunchRecord(recordFile);
  if (previous && stillAlive(spec, { ...input, handle: previous.handle as string })) return answer({ ...previous, reused: true });

  const agent = { command: resolution.agent.command, args: resolution.agent.args, shell: resolution.agent.shell, from: formatSource(resolution.sources.agent) };
  const result = localOps(spec, input).launch();
  const launched = { launcher: spec.name, handle: result.handle, pid: result.pid, delivered: result.delivered, error: result.error, agent, cwd: input.cwd };
  mkdirSync(dirname(recordFile), { recursive: true });
  writeFileSync(recordFile, `${JSON.stringify(launched, null, 2)}\n`);
  return answer(launched);
}

function readLaunchRecord(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isObject(value) && typeof value.handle === "string" ? value : null;
  } catch {
    return null;
  }
}

/** Whether a session started earlier still runs. Without a `status` command (or when unknown), assume it does. */
function stillAlive(spec: LauncherSpec, input: SessionInput): boolean {
  try {
    const state = localOps(spec, input).status()?.state;
    return state !== "gone" && state !== "exited";
  } catch {
    return true;
  }
}

export function remoteStatus(ctx: Context, payload: Record<string, unknown>): Record<string, unknown> {
  const { spec, input } = localSession(ctx, parseSessionPayload(payload, { needsHandle: true }));
  const status = localOps(spec, input).status();
  return answer(status ? { state: status.state, raw: status.raw } : { state: null });
}

/**
 * `mode: "screen"` is the launcher's `read`; `mode: "capture"` is what the
 * hub appends to the run's log when the session ends: the whole log of a
 * background launcher (it only exists here), otherwise the screen.
 */
export function remoteRead(ctx: Context, payload: Record<string, unknown>): Record<string, unknown> {
  const { spec, input } = localSession(ctx, parseSessionPayload(payload, { needsHandle: true }));
  if (payload.mode === "capture" && spec.background) {
    return answer({ output: existsSync(input.logPath) ? readFileSync(input.logPath, "utf8") : null, source: "log" });
  }
  const output = localOps(spec, input).read();
  return answer({ output, source: output === null ? null : "launcher" });
}

export function remoteClose(ctx: Context, payload: Record<string, unknown>): Record<string, unknown> {
  const { spec, input } = localSession(ctx, parseSessionPayload(payload, { needsHandle: true }));
  const result = localOps(spec, input).close();
  return answer(result ? { closed: result.ok, error: result.error } : { closed: null, error: null });
}

/** Whether a task folder exists here. `cwd` must be absolute or start with `~`. */
export function remoteCheckCwd(ctx: Context, payload: Record<string, unknown>): Record<string, unknown> {
  checkProtocol(payload);
  const cwd = payload.cwd;
  if (typeof cwd !== "string" || cwd.trim() === "") throw new RemoteProtocolError("invalid remote payload: cwd must be a non-empty string");
  const path = resolvePath(cwd, ctx.env, homeDir(ctx.env));
  const exists = existsSync(path) && statSync(path).isDirectory();
  return answer({ exists, path, cwd: exists ? displayPath(ctx, path) : cwd });
}

/** The personal instructions a task gets here (the subagent's `task` output), with the task folder resolved here. */
export function remoteInstructions(ctx: Context, payload: Record<string, unknown>): Record<string, unknown> {
  checkProtocol(payload);
  const task = payload.task;
  if (!isObject(task) || typeof task.cwd !== "string" || task.cwd === "") throw new RemoteProtocolError("invalid remote payload: task.cwd must be a non-empty string");
  const c = new Checker();
  checkAgent(c.at("task.agent"), task.agent ?? null, { nullable: true });
  if (c.errors.length > 0) throw new RemoteProtocolError("invalid remote payload:", c.errors);
  const resolution = resolveHere(ctx, { cwd: task.cwd, agent: task.agent as AgentSpec | string | null });
  const { personal, missing } = loadPersonalInstructions(resolution.instructions);
  return answer({ cwd: resolvePath(task.cwd, ctx.env), personal_instructions: personal, missing_instructions: missing });
}

/**
 * Who this machine is and whether its launcher is ready: what the hub checks
 * when a machine joins and in `doctor`, and a client checks of its hub.
 */
export function remotePing(ctx: Context, payload: Record<string, unknown>): Record<string, unknown> {
  checkProtocol(payload);
  const config = ctx.config.config;
  const problems = launcherChecks(ctx.config)
    .filter((c) => c.status === "error")
    .map((c) => c.message);
  return answer({
    name: pkg.name,
    version: pkg.version,
    machine: localMachine(config),
    hub: config.hub?.ssh ?? null,
    launcher: rootLauncherName(config.launcher ?? BUILTIN_DEFAULTS.launcher),
    launcher_problems: problems,
  });
}

/** The root launcher's name (the preset's, or `custom`); described as configured when it does not resolve. */
function rootLauncherName(launcher: LauncherConfig): string {
  try {
    return resolveLauncher(launcher).name;
  } catch {
    return launcherName(launcher);
  }
}

export interface AttachResult {
  code: number;
  /** The launcher's attach command, as run. */
  argv: string[];
  launcher: string;
}

/**
 * Runs the launcher's `attach` for a session of this machine, resolved with
 * this machine's own config, with the terminal handed over. Used by
 * `remote attach` (the hub attaching over `ssh -t`) and by a client
 * attaching to a session that runs on itself.
 */
export async function attachHere(ctx: Context, payload: Record<string, unknown>): Promise<AttachResult> {
  const p = parseSessionPayload(payload, { needsHandle: true });
  const { spec, input } = localSession(ctx, p);
  if (!spec.attach) {
    throw new LauncherError(
      `the ${spec.name} launcher on machine "${localMachine(ctx.config.config)}" has no attach command; read the session's screen with "agent-tasks session read ${p.run_ref}" or follow it with "agent-tasks log ${p.run_ref} --follow"`,
    );
  }
  const argv = renderCommand(spec.attach, input, "launcher.attach", spec);
  const code = await handOverTerminal(argv, { cwd: input.cwd, env: commandEnv(input) });
  return { code, argv, launcher: spec.name };
}
