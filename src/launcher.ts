import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { LauncherConfig, ResolvedAgent } from "./config.ts";
import { AgentTasksError } from "./errors.ts";
import { type Env, REPO_ROOT } from "./paths.ts";
import { withSigint } from "./sigint.ts";
import { readJson } from "./store.ts";
import { isObject } from "./schema.ts";
import { once, render, shellQuote, type Vars } from "./template.ts";

// A launcher is a set of commands with `{{…}}` variables (see
// doc/roadmap/launcher.md). This module knows nothing about any multiplexer:
// presets are plain JSON files in `presets/`.

export const PRESETS_DIR = join(REPO_ROOT, "presets");

/** An argument vector (no shell), or a string run with `/bin/sh -c`. */
export type CommandSpec = string[] | string;

/** States a launcher's `status` can report, after `status_map`. `gone`: the session no longer exists. */
export const SESSION_STATES = ["working", "idle", "blocked", "exited", "gone"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export interface LauncherSpec {
  /** The preset name, or `custom` when every command is written by hand. */
  name: string;
  launch: CommandSpec;
  /** Commands run after `launch`, with `{{handle}}` known (e.g. type the agent command into a shell). */
  then: CommandSpec[];
  /** Spawn `launch` as a child process with its output in the run's log; the handle is its pid. */
  background: boolean;
  /** How to get the handle from `launch`'s stdout: `json:.path` (`.a.0` indexes arrays), `regex:<pattern>` or null (trimmed stdout). */
  handle: string | null;
  close: CommandSpec | null;
  status: CommandSpec | null;
  /** `herdr`, or an object from `status`'s trimmed stdout to a state. Without it, exit 0 means `working`. */
  status_map: string | Record<string, SessionState> | null;
  read: CommandSpec | null;
  attach: CommandSpec | null;
  /** Where runs open when agent-tasks is not inside a session of the multiplexer, e.g. the herdr preset's space name. */
  space: string | null;
}

export class LauncherError extends AgentTasksError {
  constructor(message: string, details: string[] = []) {
    super("launcher", message, details);
  }
}

// ---------------------------------------------------------------------------
// Presets and validation
// ---------------------------------------------------------------------------

const LAUNCHER_FIELDS = ["preset", "description", "launch", "then", "background", "handle", "close", "status", "status_map", "read", "attach", "space"] as const;
const COMMAND_FIELDS = ["launch", "close", "status", "read", "attach"] as const;
const STATUS_MAPS = ["herdr"];

export function listPresets(dir = PRESETS_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

export function loadPreset(name: string, dir = PRESETS_DIR): Record<string, unknown> {
  const file = join(dir, `${name}.json`);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name) || !existsSync(file)) {
    throw new LauncherError(`unknown launcher preset "${name}" (available: ${listPresets(dir).join(", ") || "none"})`);
  }
  const preset = readJson(file);
  if (!isObject(preset)) throw new LauncherError(`preset ${file} must be a JSON object`);
  return preset;
}

function commandErrors(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? "must not be empty" : null;
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string")) return null;
  return "must be a non-empty array of strings (argv) or a shell command string";
}

/**
 * Resolves a launcher config into its commands: the preset (if any) with the
 * user's fields on top, field by field (`{ "preset": "herdr", "close": […] }`
 * replaces only `close`).
 */
export function resolveLauncher(config: LauncherConfig, presetsDir = PRESETS_DIR): LauncherSpec {
  const { preset, ...overrides } = config;
  const merged: Record<string, unknown> = { ...(preset ? loadPreset(preset, presetsDir) : {}), ...overrides };
  const where = preset ? `launcher (preset "${preset}")` : "launcher";
  const errors: string[] = [];
  for (const key of Object.keys(merged)) {
    if (!(LAUNCHER_FIELDS as readonly string[]).includes(key)) errors.push(`${key}: unknown field (allowed: ${LAUNCHER_FIELDS.join(", ")})`);
  }
  if (merged.launch === undefined) errors.push("launch: is required");
  for (const key of COMMAND_FIELDS) {
    if (merged[key] === undefined || merged[key] === null) continue;
    const problem = commandErrors(merged[key]);
    if (problem) errors.push(`${key}: ${problem}`);
  }
  if (merged.then !== undefined && !(Array.isArray(merged.then) && merged.then.every((c) => commandErrors(c) === null))) {
    errors.push("then: must be an array of commands (argv arrays or shell strings)");
  }
  if (merged.background !== undefined && typeof merged.background !== "boolean") errors.push("background: must be a boolean");
  const handle = merged.handle;
  if (handle !== undefined && handle !== null && !(typeof handle === "string" && /^(json:\.|regex:)./.test(handle))) {
    errors.push('handle: must be "json:.<path>" or "regex:<pattern>"');
  }
  if (typeof handle === "string" && handle.startsWith("regex:")) {
    try {
      new RegExp(handle.slice("regex:".length));
    } catch (err) {
      errors.push(`handle: ${(err as Error).message}`);
    }
  }
  const map = merged.status_map;
  if (map !== undefined && map !== null) {
    const validObject = isObject(map) && Object.values(map).every((v) => (SESSION_STATES as readonly unknown[]).includes(v));
    if (!(typeof map === "string" && STATUS_MAPS.includes(map)) && !validObject) {
      errors.push(`status_map: must be ${STATUS_MAPS.map((m) => `"${m}"`).join(", ")} or an object from output to one of: ${SESSION_STATES.join(", ")}`);
    }
  }
  if (merged.space !== undefined && merged.space !== null && !(typeof merged.space === "string" && merged.space.trim() !== "")) errors.push("space: must be a non-empty string");
  if (errors.length > 0) throw new LauncherError(`Invalid ${where}:`, errors);
  return {
    name: preset ?? "custom",
    launch: merged.launch as CommandSpec,
    then: (merged.then as CommandSpec[] | undefined) ?? [],
    background: (merged.background as boolean | undefined) ?? false,
    handle: (handle as string | null | undefined) ?? null,
    close: (merged.close as CommandSpec | null | undefined) ?? null,
    status: (merged.status as CommandSpec | null | undefined) ?? null,
    status_map: (map as LauncherSpec["status_map"] | undefined) ?? null,
    read: (merged.read as CommandSpec | null | undefined) ?? null,
    attach: (merged.attach as CommandSpec | null | undefined) ?? null,
    space: (merged.space as string | null | undefined) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

/** What the launcher needs to know about one attempt of a run. */
export interface SessionInput {
  runRef: string;
  taskId: string;
  title: string;
  /** Absolute working directory of the task. */
  cwd: string;
  slot: string;
  slotId: string;
  attempt: number;
  skill: string;
  /** Lazy: rendered from `templates/prompt.md` only when a command uses it. */
  prompt: () => string;
  agent: ResolvedAgent;
  /** Absolute path of the attempt's log file. */
  logPath: string;
  /** The runner's environment (PATH, SHELL, HC_TERMINAL_ID…). */
  env: Env;
  /** Variables passed to the agent's environment (profile `env`, agent-tasks locations). */
  agentEnv: Record<string, string>;
  /** Known once `launch` ran. */
  handle?: string;
}

/** `task-<id>-<slot>`, kept within the 32 characters (a-z 0-9 - _) that terminal names allow. */
export function sessionName(taskId: string, slotId: string, attempt: number): string {
  const full = `task-${taskId}-${slotId.toLowerCase()}${attempt > 1 ? `-a${attempt}` : ""}`;
  if (full.length <= 32) return full;
  const hash = new Bun.CryptoHasher("sha1").update(full).digest("hex").slice(0, 8);
  return `${full.slice(0, 23).replace(/-+$/, "")}-${hash}`;
}

/** The agent command line as a shell would read it: `clc`, `claude --model 'x y'`. */
export function agentCommandLine(agent: ResolvedAgent): string {
  return [agent.command, ...agent.args.map(shellQuote)].join(" ");
}

/** `$SHELL`, else the user's login shell (SSH commands may run without `$SHELL`), else `/bin/sh`. */
export function shellOf(env: Env): string {
  if (env.SHELL) return env.SHELL;
  try {
    return userInfo().shell || "/bin/sh";
  } catch {
    return "/bin/sh";
  }
}

/** The agent with its prompt, as an argv: through `<shell> -ic` when `agent.shell` is set (aliases). */
export function agentArgv(input: SessionInput): string[] {
  const prompt = input.prompt();
  if (input.agent.shell) return [shellOf(input.env), "-ic", `${agentCommandLine(input.agent)} ${shellQuote(prompt)}`];
  return [input.agent.command, ...input.agent.args, prompt];
}

function runnerSpace(env: Env, terminal: string): string {
  const result = exec(["hc", "get", terminal, "--json"], { env });
  if (result.code !== 0) throw new LauncherError(`could not read the runner's terminal ${terminal} with "hc get": ${result.stderr.trim() || `exit ${result.code}`}`);
  let space: unknown;
  try {
    space = (JSON.parse(result.stdout) as { labels?: Record<string, unknown> }).labels?.["herdr.space"];
  } catch {
    throw new LauncherError(`"hc get ${terminal} --json" did not print JSON`);
  }
  if (typeof space !== "string" || space === "") throw new LauncherError(`the runner's terminal ${terminal} has no herdr.space label`);
  return space;
}

/** A space id derived from its name, so every run outside a Herdr terminal opens in the same space. */
export function herdrSpaceId(name: string): string {
  return `sp${createHash("sha1").update(`agent-tasks/${name}`).digest("hex").slice(0, 32)}`;
}

/** This machine's Herdr space for runs, and whether the window shows it. */
export interface HerdrSpace {
  id: string;
  /** `found`: the window shows it; `missing`: it does not (the launch creates it); `unknown`: no window or no `herdr-app`. */
  state: "found" | "missing" | "unknown";
}

/**
 * This machine's Herdr space called `name`, as the window shows it
 * (`herdr-app ls`): by name, else the one an earlier run made from the name
 * (even if renamed since). When there is none, the id derived from the name:
 * Herdr creates a space for an id it does not know when a terminal labeled
 * with it starts, and the herdr preset names it.
 */
export function namedHerdrSpace(env: Env, name: string): HerdrSpace {
  const derived = herdrSpaceId(name);
  const result = exec(["herdr-app", "ls"], { env, timeoutMs: 10_000 });
  let spaces: unknown;
  try {
    spaces = result.code === 0 ? (JSON.parse(result.stdout) as { spaces?: unknown }).spaces : undefined;
  } catch {
    spaces = undefined;
  }
  if (!Array.isArray(spaces)) return { id: derived, state: "unknown" };
  const local = spaces.filter((s): s is { id: string; name?: unknown } => isObject(s) && typeof s.id === "string" && (s.machine ?? null) === null);
  const found = local.find((s) => s.name === name) ?? local.find((s) => s.id === derived);
  return found ? { id: found.id, state: "found" } : { id: derived, state: "missing" };
}

/** Launcher settings that variables read (the launcher's `space`). */
export type LauncherVarsSpec = Pick<LauncherSpec, "space">;

/**
 * What the commands of one launch share: `launch` and its `then` steps
 * render separately, but must agree on the space.
 */
export interface LaunchShared {
  herdrSpace?: HerdrSpace;
}

export function sessionVars(input: SessionInput, spec: LauncherVarsSpec, shared: LaunchShared = {}): Vars {
  const { env } = input;
  const terminal = env.HC_TERMINAL_ID || undefined;
  const space = spec.space ?? undefined;
  const runnerSpaceId = terminal ? once(() => runnerSpace(env, terminal)) : undefined;
  const named = space === undefined ? undefined : () => (shared.herdrSpace ??= namedHerdrSpace(env, space));
  return {
    values: {
      run_ref: input.runRef,
      task_id: input.taskId,
      title: input.title,
      cwd: input.cwd,
      slot: input.slot,
      slot_id: input.slotId,
      attempt: String(input.attempt),
      session_name: sessionName(input.taskId, input.slotId, input.attempt),
      skill: input.skill,
      prompt: once(input.prompt),
      agent: agentCommandLine(input.agent),
      handle: input.handle,
      log: input.logPath,
      shell: shellOf(env),
      path: env.PATH || undefined,
      runner_terminal: terminal,
      runner_space: runnerSpaceId,
      space,
      herdr_space: runnerSpaceId ?? (named && (() => named().id)),
      herdr_new_space_name: terminal ? "" : named && (() => (named().state === "missing" ? space! : "")),
      new_tab_id: once(() => `tb${randomBytes(16).toString("hex")}`),
    },
    env,
    missing: {
      handle: "the session has no handle yet (only known after launch)",
      path: "$PATH is not set",
      runner_terminal: "$HC_TERMINAL_ID is not set; run agent-tasks inside a Herdr terminal to use this launcher",
      runner_space: "$HC_TERMINAL_ID is not set; run agent-tasks inside a Herdr terminal to use this launcher",
      space: 'the launcher has no "space"',
      herdr_space: '$HC_TERMINAL_ID is not set and the launcher has no "space" to open runs in',
      herdr_new_space_name: '$HC_TERMINAL_ID is not set and the launcher has no "space" to open runs in',
    },
  };
}

/** Environment for launcher commands: the runner's, plus what the agent needs. */
export function commandEnv(input: SessionInput): Env {
  return { ...input.env, ...input.agentEnv };
}

/**
 * Renders a command into an argv. A string command runs through `/bin/sh -c`.
 * An argv element that is exactly `{{agent_argv}}`, `{{env_argv}}` or
 * `{{herdr_parent_argv}}` expands into several elements (the agent with its
 * prompt; `KEY=value` pairs; `--label herdr.parent=<runner's terminal>`, or
 * nothing outside a Herdr terminal).
 */
export function renderCommand(cmd: CommandSpec, input: SessionInput, where: string, spec: LauncherVarsSpec, shared?: LaunchShared): string[] {
  const vars = sessionVars(input, spec, shared);
  if (typeof cmd === "string") return ["/bin/sh", "-c", render(cmd, vars, where)];
  return cmd.flatMap((arg) => {
    const splat = /^\{\{\s*([a-z_]+)\s*\}\}$/.exec(arg)?.[1];
    if (splat === "agent_argv") return agentArgv(input);
    if (splat === "env_argv") return Object.entries(input.agentEnv).map(([k, v]) => `${k}=${v}`);
    if (splat === "herdr_parent_argv") return input.env.HC_TERMINAL_ID ? ["--label", `herdr.parent=${input.env.HC_TERMINAL_ID}`] : [];
    return [render(arg, vars, where)];
  });
}

// ---------------------------------------------------------------------------
// Running commands
// ---------------------------------------------------------------------------

export interface ExecResult {
  argv: string[];
  /** Exit code; 127 when the program could not be started, -1 when killed. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  env: Env;
  cwd?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export function exec(argv: string[], opts: ExecOptions): ExecResult {
  try {
    const result = Bun.spawnSync({
      cmd: argv,
      cwd: opts.cwd,
      env: opts.env as Record<string, string>,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    return { argv, code: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } catch (err) {
    return { argv, code: 127, stdout: "", stderr: `could not run ${argv[0]}: ${(err as Error).message}` };
  }
}

/**
 * Runs an interactive command (an attach) with this terminal handed over,
 * and returns its exit code. Ctrl+C belongs to it: it does not stop us
 * before the command returns.
 */
export function handOverTerminal(argv: string[], opts: { cwd?: string; env: Env }): Promise<number> {
  return withSigint(
    () => {},
    async () => {
      let child: Bun.Subprocess;
      try {
        child = Bun.spawn({ cmd: argv, cwd: opts.cwd, env: opts.env as Record<string, string>, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      } catch (err) {
        throw new LauncherError(`attach failed: could not run ${shellLine(argv)}: ${(err as Error).message}`);
      }
      return await child.exited;
    },
  );
}

function describeFailure(what: string, result: ExecResult): string {
  const detail = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-5).join(" | ");
  return `${what} failed (exit ${result.code}): ${shellLine(result.argv)}${detail ? ` → ${detail}` : ""}`;
}

/** An argv as a copy-pasteable shell line, for messages. */
export function shellLine(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

export function extractHandle(rule: string | null, stdout: string): string {
  if (rule === null) {
    const line = stdout.trim().split("\n")[0]?.trim() ?? "";
    if (!line) throw new LauncherError("launch printed nothing, so there is no session handle");
    return line;
  }
  if (rule.startsWith("json:")) {
    let value: unknown;
    try {
      value = JSON.parse(stdout);
    } catch {
      throw new LauncherError(`launch did not print JSON (handle is "${rule}"): ${stdout.trim().slice(0, 200)}`);
    }
    for (const key of rule.slice("json:.".length).split(".")) {
      value = Array.isArray(value) && /^\d+$/.test(key) ? value[Number(key)] : isObject(value) ? value[key] : undefined;
    }
    if (typeof value !== "string" && typeof value !== "number") throw new LauncherError(`launch output has no "${rule.slice(5)}" for the handle`);
    return String(value);
  }
  const m = new RegExp(rule.slice("regex:".length), "m").exec(stdout);
  if (!m) throw new LauncherError(`launch output does not match the handle ${rule}: ${stdout.trim().slice(0, 200)}`);
  return m[1] ?? m[0];
}

export interface LaunchResult {
  handle: string;
  pid: number | null;
  /** False when a `then` step failed: the session exists but the agent never got its prompt. */
  delivered: boolean;
  /** Why it was not delivered. */
  error: string | null;
}

/** Runs `launch` (and the `then` steps). Throws LauncherError when no session was started. */
export function launch(spec: LauncherSpec, input: SessionInput): LaunchResult {
  const env = commandEnv(input);
  const shared: LaunchShared = {};
  const argv = renderCommand(spec.launch, input, "launcher.launch", spec, shared);
  let handle: string;
  let pid: number | null = null;
  if (spec.background) {
    mkdirSync(dirname(input.logPath), { recursive: true });
    const fd = openSync(input.logPath, "a");
    try {
      const child = Bun.spawn({ cmd: argv, cwd: input.cwd, env: env as Record<string, string>, stdin: "ignore", stdout: fd, stderr: fd });
      child.unref();
      pid = child.pid;
      handle = String(pid);
    } catch (err) {
      throw new LauncherError(`launch failed: could not run ${shellLine(argv)}: ${(err as Error).message}`);
    } finally {
      closeSync(fd);
    }
  } else {
    const result = exec(argv, { env, cwd: input.cwd });
    if (result.code !== 0) throw new LauncherError(describeFailure("launch", result));
    handle = extractHandle(spec.handle, result.stdout);
  }
  const withHandle = { ...input, handle };
  for (const [i, step] of spec.then.entries()) {
    let result: ExecResult;
    try {
      result = exec(renderCommand(step, withHandle, `launcher.then[${i}]`, spec, shared), { env, cwd: input.cwd });
    } catch (err) {
      return { handle, pid, delivered: false, error: (err as Error).message };
    }
    if (result.code !== 0) return { handle, pid, delivered: false, error: describeFailure(`then[${i}]`, result) };
  }
  return { handle, pid, delivered: true, error: null };
}

function herdrState(stdout: string): SessionState {
  let info: { state?: unknown; status?: { state?: unknown } | null };
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new LauncherError(`status did not print JSON: ${stdout.trim().slice(0, 200)}`);
  }
  if (info.state === "finished") return "exited";
  switch (info.status?.state) {
    case "blocked":
      return "blocked";
    case "idle":
    case "done":
    case "error":
      return "idle";
    default:
      return "working";
  }
}

export interface StatusResult {
  state: SessionState;
  raw: string;
}

/**
 * The session's state, or null when the launcher has no `status` command.
 * A non-zero exit means the session is gone. A status command that could not
 * run or timed out throws instead: the state is unknown, not gone.
 */
export function sessionStatus(spec: LauncherSpec, input: SessionInput): StatusResult | null {
  if (!spec.status) return null;
  const result = exec(renderCommand(spec.status, input, "launcher.status", spec), { env: commandEnv(input) });
  const raw = result.stdout.trim();
  if (result.code === 127 || result.code === -1) throw new LauncherError(`the session's state is unknown: ${describeFailure("status", result)}`);
  if (result.code !== 0) return { state: "gone", raw: raw || result.stderr.trim() };
  if (spec.status_map === "herdr") return { state: herdrState(result.stdout), raw };
  if (isObject(spec.status_map)) return { state: spec.status_map[raw] ?? "working", raw };
  return { state: "working", raw };
}

/** Runs `close`. Returns null when the launcher has none. */
export function closeSession(spec: LauncherSpec, input: SessionInput): { ok: boolean; error: string | null } | null {
  if (!spec.close) return null;
  const result = exec(renderCommand(spec.close, input, "launcher.close", spec), { env: commandEnv(input) });
  return result.code === 0 ? { ok: true, error: null } : { ok: false, error: describeFailure("close", result) };
}

/** Runs `read` and returns its output, or null when the launcher has none. Throws when it fails. */
export function readSession(spec: LauncherSpec, input: SessionInput): string | null {
  if (!spec.read) return null;
  const result = exec(renderCommand(spec.read, input, "launcher.read", spec), { env: commandEnv(input) });
  if (result.code !== 0) throw new LauncherError(describeFailure("read", result));
  return result.stdout;
}
