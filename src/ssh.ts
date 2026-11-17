import type { Writer } from "./context.ts";
import { AgentTasksError } from "./errors.ts";
import type { Env } from "./paths.ts";
import { isObject } from "./schema.ts";
import { shellQuote } from "./template.ts";

// Running agent-tasks on another machine over SSH. Non-interactive SSH never
// prompts (BatchMode) and gives up on a dead host after ConnectTimeout.

/**
 * The agent-tasks CLI on another machine. Non-interactive SSH shells don't
 * have ~/.local/bin in PATH, so it is called by path (`install` links it
 * there); the remote shell expands `~`.
 */
export const REMOTE_CLI = "~/.local/bin/agent-tasks";

export const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"] as const;

/** ssh's own exit code for connection failures (the remote command's code otherwise). */
export const SSH_UNREACHABLE_EXIT = 255;

/** The exit code of a shell that could not find the command. */
export const COMMAND_NOT_FOUND_EXIT = 127;

/**
 * The remote command line that runs `agent-tasks <args>` on another machine,
 * each argument quoted for the remote shell. `env` is set for the command.
 */
export function remoteCliLine(args: readonly string[], env: Record<string, string> = {}): string {
  const assignments = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  return [...assignments, REMOTE_CLI, ...args.map(shellQuote)].join(" ");
}

/**
 * `ssh` argv that runs `remoteLine` on `alias`. `tty` forces a terminal on the
 * remote side (`-tt`): for interactive commands, and so that Ctrl-C (which
 * closes the terminal) also stops a remote command that never ends by itself.
 */
export function sshArgv(alias: string, remoteLine: string, { tty = false } = {}): string[] {
  return ["ssh", ...SSH_OPTIONS, tty ? "-tt" : "-T", "--", alias, remoteLine];
}

export interface SshStreamOptions {
  env: Env;
  stdout: Writer;
  stderr: Writer;
  /** Sent as the remote command's stdin (none by default). */
  input?: string | Uint8Array;
  /** Hands this process's stdin over to the remote command (interactive commands). */
  inheritStdin?: boolean;
}

export interface SshResult {
  code: number;
  /**
   * Set when ssh itself failed (exit 255): its stderr, unless remote output
   * had already been passed through (the connection dropped midway).
   */
  connectError: string | null;
}

/** `ssh` could not be started at all (not installed, not on PATH). */
export class SshSpawnError extends Error {}

/**
 * Runs an `ssh` argv, streaming the remote stdout and stderr to the writers,
 * and returns its exit code. When ssh itself fails (exit 255), its stderr is
 * returned instead of printed, so the caller can report it once. Remote stderr
 * is held back only until the first stdout output (or the end), which is
 * enough to tell the two apart: the remote CLI never exits with 255.
 */
export async function runSshStreaming(argv: string[], opts: SshStreamOptions): Promise<SshResult> {
  const input = typeof opts.input === "string" ? new TextEncoder().encode(opts.input) : opts.input;
  const stdin = opts.inheritStdin ? "inherit" : (input ?? "ignore");
  let child;
  try {
    child = Bun.spawn({ cmd: argv, env: opts.env as Record<string, string>, stdin, stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    throw new SshSpawnError((err as Error).message);
  }

  let held: string | null = "";
  const flushStderr = () => {
    if (held) opts.stderr.write(held);
    held = null;
  };
  const decode = async (stream: ReadableStream<Uint8Array>, onText: (text: string) => void) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) onText(decoder.decode(chunk, { stream: true }));
    onText(decoder.decode());
  };
  await Promise.all([
    decode(child.stdout, (text) => {
      if (!text) return;
      flushStderr();
      opts.stdout.write(text);
    }),
    decode(child.stderr, (text) => {
      if (!text) return;
      if (held === null) opts.stderr.write(text);
      else held += text;
    }),
  ]);
  const code = await child.exited;
  if (code !== SSH_UNREACHABLE_EXIT) {
    flushStderr();
    return { code, connectError: null };
  }
  return { code, connectError: held === null ? "the connection was lost" : held.trim() || "ssh exited with 255" };
}

// ---------------------------------------------------------------------------
// `agent-tasks remote <op>`: the hub running sessions on another machine
// (see doc/roadmap/runner.md, "Remote machines"). The payload goes in as JSON
// on stdin and the answer comes back as JSON on stdout.
// ---------------------------------------------------------------------------

/** Version of the `remote` payloads. Both sides put it in every message and check it. */
export const REMOTE_PROTOCOL = 1;

const REMOTE_TIMEOUT_MS = 90_000;

/** The machine could not be reached over SSH. Never means the session is gone. */
export class MachineUnreachableError extends AgentTasksError {
  readonly machine: string;

  constructor(machine: string, message: string) {
    super("machine_unreachable", message);
    this.machine = machine;
  }
}

export interface RemoteTarget {
  /** The machine's name, for messages. */
  machine: string;
  /** Its SSH host alias. */
  ssh: string;
}

/**
 * Runs `agent-tasks remote <op> --json` on `target` with `payload` on stdin
 * and returns its JSON answer. Throws MachineUnreachableError when SSH could
 * not connect, and the remote error (same code and message) when the remote
 * command failed.
 */
export function callRemote(target: RemoteTarget, op: string, payload: Record<string, unknown>, env: Env, timeoutMs = REMOTE_TIMEOUT_MS): Record<string, unknown> {
  const argv = sshArgv(target.ssh, remoteCliLine(["remote", op, "--json"]));
  const where = `machine "${target.machine}" (ssh ${target.ssh})`;
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync({
      cmd: argv,
      env: env as Record<string, string>,
      stdin: new TextEncoder().encode(JSON.stringify({ protocol: REMOTE_PROTOCOL, ...payload })),
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    });
  } catch (err) {
    throw new AgentTasksError("ssh_failed", `could not run ssh for ${where}: ${(err as Error).message}`);
  }
  const stdout = result.stdout?.toString() ?? "";
  const stderr = (result.stderr?.toString() ?? "").trim();
  const code = result.exitCode;
  if (code === SSH_UNREACHABLE_EXIT) throw new MachineUnreachableError(target.machine, `${where} is unreachable${stderr ? `: ${stderr.split("\n").at(-1)}` : ""}`);
  if (code === null) throw new AgentTasksError("remote_timeout", `remote ${op} on ${where} did not answer within ${Math.round(timeoutMs / 1000)}s`);
  if (code === COMMAND_NOT_FOUND_EXIT && !stdout.trim()) {
    throw new AgentTasksError("remote_failed", `agent-tasks is not installed at ${REMOTE_CLI} on ${where}; run "agent-tasks install" there`);
  }

  let answer: unknown;
  try {
    answer = JSON.parse(stdout);
  } catch {
    const detail = (stderr || stdout.trim()).split("\n").slice(-3).join(" | ");
    throw new AgentTasksError("remote_failed", `remote ${op} on ${where} failed (exit ${code})${detail ? `: ${detail}` : ""}`);
  }
  if (!isObject(answer)) throw new AgentTasksError("remote_failed", `remote ${op} on ${where} did not print a JSON object`);
  if (isObject(answer.error)) {
    const { code: errorCode, message, details } = answer.error;
    const lines = Array.isArray(details) ? details.map(String) : [];
    throw new AgentTasksError(typeof errorCode === "string" ? errorCode : "remote_failed", `${where}: ${String(message ?? "remote error")}`, lines);
  }
  if (code !== 0) throw new AgentTasksError("remote_failed", `remote ${op} on ${where} failed (exit ${code})`);
  if (answer.protocol !== REMOTE_PROTOCOL) {
    throw new AgentTasksError("remote_protocol", `remote ${op} on ${where} answered with protocol ${JSON.stringify(answer.protocol ?? null)}, not ${REMOTE_PROTOCOL}; update agent-tasks on both machines`);
  }
  return answer;
}
