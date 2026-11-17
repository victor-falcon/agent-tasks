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
  /**
   * Holds all output back for this long after the first byte. When the
   * command ends within it, `swallow(code, output)` decides whether that
   * output is dropped (e.g. an older agent-tasks rejecting a new flag) instead
   * of printed.
   */
  early?: { ms: number; swallow: (code: number, output: string) => boolean };
}

export interface SshResult {
  code: number;
  /**
   * Set when ssh itself failed (exit 255): its stderr, unless remote output
   * had already been passed through (the connection dropped midway).
   */
  connectError: string | null;
  /** The output was dropped by `early.swallow`. */
  swallowed: boolean;
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

  // Output held during the `early` window, in order; null once released.
  let queue: Array<[Writer, string]> | null = opts.early ? [] : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    for (const [writer, text] of queue ?? []) writer.write(text);
    queue = null;
  };
  const emit = (writer: Writer, text: string) => {
    if (!queue) return writer.write(text);
    queue.push([writer, text]);
    timer ??= setTimeout(release, opts.early!.ms);
  };

  let held: string | null = "";
  const flushStderr = () => {
    if (held) emit(opts.stderr, held);
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
      emit(opts.stdout, text);
    }),
    decode(child.stderr, (text) => {
      if (!text) return;
      if (held === null) emit(opts.stderr, text);
      else held += text;
    }),
  ]);
  const code = await child.exited;
  clearTimeout(timer);
  if (code !== SSH_UNREACHABLE_EXIT) {
    const output = [...(queue ?? []).map(([, text]) => text), held ?? ""].join("");
    if (queue && opts.early!.swallow(code, output)) return { code, connectError: null, swallowed: true };
    flushStderr();
    release();
    return { code, connectError: null, swallowed: false };
  }
  release();
  return { code, connectError: held === null ? "the connection was lost" : held.trim() || "ssh exited with 255", swallowed: false };
}

// ---------------------------------------------------------------------------
// `agent-tasks remote <op>`: the hub running sessions on another machine
// (see doc/roadmap/runner.md, "Remote machines"). The payload goes in as JSON
// on stdin and the answer comes back as JSON on stdout.
// ---------------------------------------------------------------------------

/**
 * Version of what machines say to each other: the `remote` payloads (both
 * sides put it in every message and check it) and the commands a client
 * forwards to the hub (`--client-protocol`, checked by the hub).
 */
export const REMOTE_PROTOCOL = 1;

/**
 * Hidden global flag a client adds to every command it forwards, so a hub
 * that speaks another protocol refuses it. A hub too old to know the flag
 * fails with a usage error that names it.
 */
export const CLIENT_PROTOCOL_FLAG = "--client-protocol";

const REMOTE_TIMEOUT_MS = 90_000;

/** The machine could not be reached over SSH. Never means the session is gone. */
export class MachineUnreachableError extends AgentTasksError {
  readonly machine: string;
  /** What ssh said, when known (also at the end of the message). */
  readonly detail: string | null;

  constructor(machine: string, message: string, detail: string | null = null) {
    super("machine_unreachable", detail ? `${message}: ${detail}` : message);
    this.machine = machine;
    this.detail = detail;
  }
}

export interface RemoteTarget {
  /** The machine's name, for messages. */
  machine: string;
  /** Its SSH host alias. */
  ssh: string;
}

/** What a non-interactive ssh call printed and how it ended (exit code null: timed out). */
export interface SshCapture {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs an `ssh` argv and captures its output. Throws `ssh_failed` when ssh can't be started. */
export function captureSsh(argv: string[], env: Env, opts: { input?: Uint8Array; timeoutMs: number; what: string }): SshCapture {
  try {
    const result = Bun.spawnSync({ cmd: argv, env: env as Record<string, string>, stdin: opts.input ?? "ignore", stdout: "pipe", stderr: "pipe", timeout: opts.timeoutMs });
    return { code: result.exitCode, stdout: result.stdout?.toString() ?? "", stderr: (result.stderr?.toString() ?? "").trim() };
  } catch (err) {
    throw new AgentTasksError("ssh_failed", `could not run ssh for ${opts.what}: ${(err as Error).message}`);
  }
}

/** The last line ssh printed about a failed connection. */
export function sshFailure(capture: SshCapture): string {
  return capture.stderr.split("\n").at(-1) || "ssh exited with 255";
}

/**
 * The JSON object an `agent-tasks … --json` command run on `where` printed,
 * or its error (same code and message, with `where` in front when
 * `prefixErrors`) thrown. `failedCode` is the code when it printed no JSON.
 */
export function jsonAnswer(capture: SshCapture, opts: { command: string; where: string; failedCode: string; prefixErrors: boolean }): Record<string, unknown> {
  const { stdout, stderr, code } = capture;
  let answer: unknown;
  try {
    answer = JSON.parse(stdout);
  } catch {
    const detail = (stderr || stdout.trim()).split("\n").slice(-3).join(" | ");
    throw new AgentTasksError(opts.failedCode, `${opts.command} on ${opts.where} failed (exit ${code})${detail ? `: ${detail}` : ""}`);
  }
  if (!isObject(answer)) throw new AgentTasksError(opts.failedCode, `${opts.command} on ${opts.where} did not print a JSON object`);
  if (isObject(answer.error)) {
    const { code: errorCode, message, details } = answer.error;
    const lines = Array.isArray(details) ? details.map(String) : [];
    const text = String(message ?? "error");
    throw new AgentTasksError(typeof errorCode === "string" ? errorCode : opts.failedCode, opts.prefixErrors ? `${opts.where}: ${text}` : text, lines);
  }
  if (code !== 0) throw new AgentTasksError(opts.failedCode, `${opts.command} on ${opts.where} failed (exit ${code})`);
  return answer;
}

/**
 * Whether an error from another machine's agent-tasks means it is older than
 * this one: it does not know a command or flag (a usage error), or speaks
 * another `remote` protocol.
 */
export function isOldPeerError(err: { code: string }): boolean {
  return err.code === "usage" || err.code === "remote_protocol";
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
  const input = new TextEncoder().encode(JSON.stringify({ protocol: REMOTE_PROTOCOL, ...payload }));
  const capture = captureSsh(argv, env, { input, timeoutMs, what: where });
  if (capture.code === SSH_UNREACHABLE_EXIT) throw new MachineUnreachableError(target.machine, `${where} is unreachable`, sshFailure(capture));
  if (capture.code === null) throw new AgentTasksError("remote_timeout", `remote ${op} on ${where} did not answer within ${Math.round(timeoutMs / 1000)}s`);
  if (capture.code === COMMAND_NOT_FOUND_EXIT && !capture.stdout.trim()) {
    throw new AgentTasksError("remote_failed", `agent-tasks is not installed at ${REMOTE_CLI} on ${where}; run "agent-tasks install" there`);
  }
  const answer = jsonAnswer(capture, { command: `remote ${op}`, where, failedCode: "remote_failed", prefixErrors: true });
  if (answer.protocol !== REMOTE_PROTOCOL) {
    throw new AgentTasksError("remote_protocol", `remote ${op} on ${where} answered with protocol ${JSON.stringify(answer.protocol ?? null)}, not ${REMOTE_PROTOCOL}; update agent-tasks on both machines`);
  }
  return answer;
}
