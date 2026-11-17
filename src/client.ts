import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { parseCommandArgs } from "./args.ts";
import { ADD_OPTIONS } from "./commands/add.ts";
import { EDIT_OPTIONS } from "./commands/edit.ts";
import { FINISH_OPTIONS } from "./commands/finish.ts";
import { LIST_OPTIONS } from "./commands/list.ts";
import { localMachine } from "./config.ts";
import type { Context } from "./context.ts";
import { AgentTasksError, HubUnreachableError, NotFoundError, UsageError } from "./errors.ts";
import { parseJsonObject, readFileArg, readStdin, readStdinBytes } from "./input.ts";
import { resolvePath } from "./paths.ts";
import { COMMAND_NOT_FOUND_EXIT, REMOTE_CLI, remoteCliLine, runSshStreaming, SshSpawnError, sshArgv } from "./ssh.ts";
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

/**
 * Runs a command on the hub and returns its exit code. `name` is the
 * command's full name and `args` its own arguments; `globals` are the global
 * flags to pass on (`--json`, `--now`).
 */
export async function forwardToHub(ctx: Context, hubAlias: string, name: string, args: string[], globals: string[]): Promise<number> {
  if (HUB_ONLY_COMMANDS.includes(name)) {
    throw new AgentTasksError("hub_only", `"${name}" runs on the hub ("${hubAlias}"), not on a client; run it there`);
  }
  const forward = await prepareForward(ctx, name, args);
  const argv = sshArgv(hubAlias, remoteCliLine([...globals, ...name.split(" "), ...forward.args], forward.env), { tty: forward.tty });
  let result;
  try {
    result = await runSshStreaming(argv, { env: ctx.env, stdout: ctx.stdout, stderr: ctx.stderr, input: forward.input, inheritStdin: forward.inheritStdin });
  } catch (err) {
    if (err instanceof SshSpawnError) throw new HubUnreachableError(hubAlias, `could not run ssh: ${err.message}`);
    throw err;
  }
  if (result.connectError !== null) throw new HubUnreachableError(hubAlias, result.connectError);
  if (result.code === COMMAND_NOT_FOUND_EXIT) {
    throw new HubUnreachableError(
      hubAlias,
      `could not run ${REMOTE_CLI} there: install agent-tasks on the hub ("agent-tasks install") and make sure bun is in the PATH of non-interactive SSH sessions`,
    );
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
