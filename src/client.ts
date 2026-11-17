import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { parseCommandArgs } from "./args.ts";
import { ADD_OPTIONS } from "./commands/add.ts";
import { EDIT_OPTIONS } from "./commands/edit.ts";
import { FINISH_OPTIONS } from "./commands/finish.ts";
import { LIST_OPTIONS } from "./commands/list.ts";
import { localMachine } from "./config.ts";
import { type Context, output } from "./context.ts";
import { AgentTasksError, HubUnreachableError, NotFoundError, UsageError } from "./errors.ts";
import { parseJsonObject, readFileArg, readStdin, readStdinBytes } from "./input.ts";
import { resolvePath } from "./paths.ts";
import { attachHere } from "./remote.ts";
import { isObject } from "./schema.ts";
import {
  CLIENT_PROTOCOL_FLAG,
  COMMAND_NOT_FOUND_EXIT,
  REMOTE_CLI,
  REMOTE_PROTOCOL,
  remoteCliLine,
  runSshStreaming,
  SSH_UNREACHABLE_EXIT,
  SshSpawnError,
  sshArgv,
} from "./ssh.ts";
import { displayPath, isMachineIndependentPath, normalizeTaskCwd } from "./task-flags.ts";

// Client mode: a machine whose config has `hub` keeps no data. It forwards
// commands to the hub over SSH (`ssh <hub> ~/.local/bin/agent-tasks …`),
// after rewriting what only makes sense here (folders, files, stdin).

/**
 * Command groups (first word of the command) that always run on this
 * machine, client or not: they describe or set up this machine.
 */
export const LOCAL_ONLY_GROUPS: readonly string[] = ["help", "version", "init", "install", "doctor", "config", "remote"];

/**
 * Commands a client refuses: they drive the hub's scheduler, which only the
 * hub runs. Commands that only read its state (`runner status`, `due`) are
 * forwarded.
 */
export const HUB_ONLY_COMMANDS: readonly string[] = ["runner", "tick"];

/** Whether a command (by its full name, e.g. `config resolve`) always runs locally. */
export function runsLocally(name: string): boolean {
  return LOCAL_ONLY_GROUPS.includes(name.split(" ")[0]!);
}

/** What to run on the hub: the arguments after `agent-tasks`, and how. */
export interface Forward {
  args: string[];
  /** Sent as the remote command's stdin. */
  input?: string | Uint8Array;
  /** Hand this terminal's stdin over (interactive commands). */
  inheritStdin?: boolean;
  /** Force a terminal on the hub (interactive or never-ending commands). */
  tty?: boolean;
  /** Environment set for the remote command. */
  env?: Record<string, string>;
}

/** How long a forwarded command's first output is held back, to catch a hub too old for `--client-protocol`. */
const EARLY_OUTPUT_MS = 300;

/** The error for a hub whose agent-tasks predates the protocol check. */
export function oldHubError(hubAlias: string): AgentTasksError {
  return new AgentTasksError(
    "protocol_mismatch",
    `the hub "${hubAlias}" runs an older agent-tasks that does not know this client's protocol (${REMOTE_PROTOCOL}); update agent-tasks on the hub (git pull in its agent-tasks checkout)`,
  );
}

/** The CLI's exit code for usage errors (EXIT_USAGE in cli.ts). */
const EXIT_USAGE = 2;

/** Whether a command's failure is an old hub rejecting `--client-protocol` (a usage error naming it). */
function isOldHubRejection(code: number, output: string): boolean {
  return code === EXIT_USAGE && output.includes(CLIENT_PROTOCOL_FLAG);
}

/** The global flags of every forwarded command: the protocol first, so the hub checks it before anything else. */
function hubGlobals(globals: string[]): string[] {
  return [`${CLIENT_PROTOCOL_FLAG}=${REMOTE_PROTOCOL}`, ...globals];
}

/**
 * Runs a command on the hub and returns its exit code. `name` is the
 * command's full name and `args` its own arguments; `globals` are the global
 * flags to pass on (`--json`, `--now`).
 */
export async function forwardToHub(ctx: Context, hubAlias: string, name: string, args: string[], globals: string[]): Promise<number> {
  if (HUB_ONLY_COMMANDS.includes(name)) {
    throw new AgentTasksError("hub_only", `"${name}" runs on the hub ("${hubAlias}"), not on a client; run it there`);
  }
  if (name === "attach") {
    const code = await attachOnThisClient(ctx, hubAlias, args, globals);
    if (code !== null) return code;
  }
  const forward = await prepareForward(ctx, name, args);
  const argv = sshArgv(hubAlias, remoteCliLine([...hubGlobals(globals), ...name.split(" "), ...forward.args], forward.env), { tty: forward.tty });
  let result;
  try {
    result = await runSshStreaming(argv, {
      env: ctx.env,
      stdout: ctx.stdout,
      stderr: ctx.stderr,
      input: forward.input,
      inheritStdin: forward.inheritStdin,
      early: { ms: EARLY_OUTPUT_MS, swallow: isOldHubRejection },
    });
  } catch (err) {
    if (err instanceof SshSpawnError) throw new HubUnreachableError(hubAlias, `could not run ssh: ${err.message}`);
    throw err;
  }
  if (result.connectError !== null) throw new HubUnreachableError(hubAlias, result.connectError);
  if (result.swallowed) throw oldHubError(hubAlias);
  if (result.code === COMMAND_NOT_FOUND_EXIT) throw notInstalledOnHub(hubAlias);
  return result.code;
}

function notInstalledOnHub(hubAlias: string): HubUnreachableError {
  return new HubUnreachableError(
    hubAlias,
    `could not run ${REMOTE_CLI} there: install agent-tasks on the hub ("agent-tasks install") and make sure bun is in the PATH of non-interactive SSH sessions`,
  );
}

/**
 * Runs a command on the hub with `--json` and returns its JSON answer (not
 * printed). Throws the hub's error as it reported it.
 */
export function callHub(ctx: Context, hubAlias: string, args: string[], globals: string[] = []): Record<string, unknown> {
  const argv = sshArgv(hubAlias, remoteCliLine([...hubGlobals(["--json", ...globals.filter((g) => g !== "--json")]), ...args]));
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync({ cmd: argv, env: ctx.env as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: HUB_CALL_TIMEOUT_MS });
  } catch (err) {
    throw new HubUnreachableError(hubAlias, `could not run ssh: ${(err as Error).message}`);
  }
  const stdout = result.stdout?.toString() ?? "";
  const stderr = (result.stderr?.toString() ?? "").trim();
  const code = result.exitCode;
  if (code === SSH_UNREACHABLE_EXIT) throw new HubUnreachableError(hubAlias, stderr.split("\n").at(-1) || "ssh exited with 255");
  if (code === null) throw new HubUnreachableError(hubAlias, `"agent-tasks ${args.join(" ")}" did not answer within ${HUB_CALL_TIMEOUT_MS / 1000}s`);
  if (code === COMMAND_NOT_FOUND_EXIT && !stdout.trim()) throw notInstalledOnHub(hubAlias);
  if (isOldHubRejection(code, stdout + stderr)) throw oldHubError(hubAlias);
  let answer: unknown;
  try {
    answer = JSON.parse(stdout);
  } catch {
    const detail = (stderr || stdout.trim()).split("\n").slice(-3).join(" | ");
    throw new AgentTasksError("hub_failed", `"agent-tasks ${args.join(" ")}" failed on the hub "${hubAlias}" (exit ${code})${detail ? `: ${detail}` : ""}`);
  }
  if (!isObject(answer)) throw new AgentTasksError("hub_failed", `"agent-tasks ${args.join(" ")}" on the hub "${hubAlias}" did not print a JSON object`);
  if (isObject(answer.error)) {
    const { code: errorCode, message, details } = answer.error;
    throw new AgentTasksError(typeof errorCode === "string" ? errorCode : "hub_failed", String(message ?? "error on the hub"), Array.isArray(details) ? details.map(String) : []);
  }
  return answer;
}

const HUB_CALL_TIMEOUT_MS = 90_000;

/**
 * `attach` from a client: when the session runs on this client, attach here
 * directly instead of through the hub and back (client → hub → client). The
 * hub says where the run's session is (`attach --resolve`). Returns null when
 * it runs elsewhere: then the hub attaches, over SSH to that machine if needed.
 */
async function attachOnThisClient(ctx: Context, hubAlias: string, args: string[], globals: string[]): Promise<number | null> {
  const where = callHub(ctx, hubAlias, ["attach", ...args, "--resolve"], globals);
  if (where.machine !== localMachine(ctx.config.config) || !isObject(where.payload)) return null;
  const result = await attachHere(ctx, where.payload);
  if (ctx.json) {
    const { payload: _, ...about } = where;
    output(ctx, { ...about, launcher: result.launcher, command: result.argv, exit_code: result.code }, "");
  }
  return result.code;
}

type Prepare = (ctx: Context, args: string[]) => Forward | Promise<Forward>;

/**
 * How each command's arguments are rewritten so they mean on the hub what
 * they mean here (folders, files and stdin of this client). Commands not
 * listed are forwarded as they are; add one here when a command reads a
 * local file, folder or stdin.
 */
const PREPARE: Record<string, Prepare> = {
  add: prepareAdd,
  edit: prepareEdit,
  finish: prepareFinish,
  list: prepareList,
  attach: (_ctx, args) => ({ args, inheritStdin: true, tty: process.stdin.isTTY === true }),
  log: prepareLog,
};

export async function prepareForward(ctx: Context, name: string, args: string[]): Promise<Forward> {
  return (await PREPARE[name]?.(ctx, args)) ?? { args };
}

/**
 * `log --follow` never ends by itself: on a terminal it runs with one on the
 * hub too, so Ctrl-C (closing it) also stops the hub's side.
 */
function prepareLog(_ctx: Context, args: string[]): Forward {
  return { args, tty: args.includes("--follow") && process.stdout.isTTY === true };
}

type Values = Record<string, string | boolean | undefined>;

/** Parsed options and positionals back to an argv; values as `--name=value`, so one starting with `-` stays a value. */
function toArgv(values: Values, positionals: readonly string[]): string[] {
  const out = [...positionals];
  for (const [key, value] of Object.entries(values)) {
    if (value === true) out.push(`--${key}`);
    else if (typeof value === "string") out.push(`--${key}=${value}`);
  }
  return out;
}

/**
 * A task folder given on this client, for a task on `machine` (undefined when
 * not known). For this machine it is resolved, checked and stored with `~`
 * for this home; for another machine a path that is already absolute or
 * starts with `~` is kept as is, and a relative one resolves against this
 * folder (that machine checks it exists).
 */
export function clientTaskCwd(ctx: Context, cwd: string, machine: string | undefined): string {
  if (machine === localMachine(ctx.config.config)) return normalizeTaskCwd(ctx, cwd);
  if (isMachineIndependentPath(cwd)) return cwd;
  return displayPath(ctx, resolvePath(cwd, ctx.env, ctx.cwd));
}

/** `--instructions-file` names a file (or stdin) on this machine: send its text instead. */
async function inlineInstructions(ctx: Context, values: Values): Promise<void> {
  const file = values["instructions-file"];
  if (typeof file !== "string") return;
  if (values.instructions !== undefined) throw new UsageError("use either --instructions or --instructions-file, not both");
  values.instructions = (await readFileArg(ctx, file)).trim();
  delete values["instructions-file"];
}

/** Parses JSON from stdin or a file if it can; the hub reports what is wrong with it otherwise. */
function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    return parseJsonObject(text, "input");
  } catch {
    return null;
  }
}

/**
 * `add`: the task runs on this client unless it says otherwise, in this
 * folder unless it says otherwise, and was created here.
 */
async function prepareAdd(ctx: Context, args: string[]): Promise<Forward> {
  const { values, positionals } = parseCommandArgs(args, ADD_OPTIONS, { maxPositionals: 1 });
  const fromStdin = values["json-input"] === true || positionals[0] === "-";
  if (fromStdin && values["instructions-file"] === "-") throw new UsageError("stdin can hold the task JSON or the instructions, not both");
  const stdin = fromStdin ? await readStdin() : undefined;
  const fromJson = (stdin !== undefined ? tryParseObject(stdin) : null) ?? {};
  await inlineInstructions(ctx, values);

  const machine = values.machine ?? (typeof fromJson.machine === "string" ? fromJson.machine : localMachine(ctx.config.config));
  values.machine = machine;
  // A cwd of the wrong type in the JSON is left for the hub to report.
  const ownMachine = machine === localMachine(ctx.config.config);
  if (values.cwd === undefined && fromJson.cwd === undefined && !ownMachine) {
    throw new UsageError(`a task on machine "${machine}" needs --cwd: this folder is on this machine ("${localMachine(ctx.config.config)}")`);
  }
  const cwd = values.cwd ?? (fromJson.cwd === undefined ? ctx.cwd : typeof fromJson.cwd === "string" ? fromJson.cwd : undefined);
  if (cwd !== undefined) values.cwd = clientTaskCwd(ctx, cwd, machine);
  values["created-cwd"] = displayPath(ctx, ctx.cwd);
  if (ctx.env.HC_TERMINAL_ID) values["created-session"] = ctx.env.HC_TERMINAL_ID;
  return { args: toArgv(values, positionals), input: stdin };
}

/** `edit`: a patch file and `--cwd` are this client's; the patch goes over stdin. */
async function prepareEdit(ctx: Context, args: string[]): Promise<Forward> {
  const { values, positionals } = parseCommandArgs(args, EDIT_OPTIONS, { minPositionals: 1, maxPositionals: 2 });
  if (positionals[1] !== undefined && positionals[1] !== "-") throw new UsageError(`unexpected argument "${positionals[1]}"`);
  if (positionals[1] === "-" && values.file !== undefined) throw new UsageError('use either --file or "-", not both');
  const patchFile = values.file ?? positionals[1];
  if (patchFile === "-" && values["instructions-file"] === "-") throw new UsageError("stdin can hold the patch or the instructions, not both");

  let stdin: string | undefined;
  const id = positionals[0]!;
  const rest: string[] = [];
  const patch = patchFile !== undefined ? await readFileArg(ctx, patchFile) : undefined;
  await inlineInstructions(ctx, values);
  if (patch !== undefined) {
    const parsed = tryParseObject(patch);
    if (parsed && typeof parsed.cwd === "string") {
      const machine = values.machine ?? (typeof parsed.machine === "string" ? parsed.machine : undefined);
      parsed.cwd = clientTaskCwd(ctx, parsed.cwd, machine);
      stdin = JSON.stringify(parsed);
    } else stdin = patch;
    delete values.file;
    rest.push("-");
  }
  // `--cwd ""` is an error the hub reports.
  if (values.cwd !== undefined && values.cwd.trim() !== "") values.cwd = clientTaskCwd(ctx, values.cwd, values.machine);
  return { args: toArgv(values, [id, ...rest]), input: stdin };
}

/**
 * `finish`: the output file is on this client, so its text goes over stdin;
 * the attempt the launcher gave this subagent goes with it.
 */
async function prepareFinish(ctx: Context, args: string[]): Promise<Forward> {
  const { values, positionals } = parseCommandArgs(args, FINISH_OPTIONS, { minPositionals: 1, maxPositionals: 1 });
  let input: Uint8Array | undefined;
  const file = values["output-file"];
  if (file === "-") input = await readStdinBytes();
  else if (file !== undefined) {
    const source = resolvePath(file, ctx.env, ctx.cwd);
    if (!existsSync(source) || !statSync(source).isFile()) throw new NotFoundError(`output file not found: ${source}`);
    input = readFileSync(source);
    values["output-file"] = "-";
    values["output-ext"] = extname(source);
  }
  const env: Record<string, string> = {};
  for (const key of ["AGENT_TASKS_RUN", "AGENT_TASKS_ATTEMPT"]) {
    const value = ctx.env[key];
    if (value) env[key] = value;
  }
  return { args: toArgv(values, positionals), input, env };
}

/** `list --cwd`: a folder on this client, written with `~` so the hub reads it against its own home. */
function prepareList(ctx: Context, args: string[]): Forward {
  const { values, positionals } = parseCommandArgs(args, LIST_OPTIONS, { maxPositionals: 0 });
  if (values.cwd !== undefined) values.cwd = displayPath(ctx, resolvePath(values.cwd, ctx.env, ctx.cwd));
  return { args: toArgv(values, positionals) };
}
