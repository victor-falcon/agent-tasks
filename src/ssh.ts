import type { Writer } from "./context.ts";
import type { Env } from "./paths.ts";
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

/** `ssh` argv that runs `remoteLine` on `alias`; `tty` allocates a terminal (for interactive commands). */
export function sshArgv(alias: string, remoteLine: string, { tty = false } = {}): string[] {
  return ["ssh", ...SSH_OPTIONS, tty ? "-t" : "-T", "--", alias, remoteLine];
}

export interface SshStreamOptions {
  env: Env;
  stdout: Writer;
  stderr: Writer;
  /** Text sent as the remote command's stdin; `inherit` hands over this process's stdin; none by default. */
  stdin?: string | "inherit";
}

export interface SshResult {
  code: number;
  /** ssh's stderr when it failed to connect (exit 255); it was not passed through. */
  connectError: string | null;
}

/**
 * Runs an `ssh` argv, streaming the remote stdout and stderr to the writers,
 * and returns its exit code. When ssh itself fails (exit 255), its stderr is
 * returned instead of printed, so the caller can report it once. Remote stderr
 * is held back only until the first stdout output (or the end), which is
 * enough to tell the two apart: the remote CLI never exits with 255.
 */
export async function runSshStreaming(argv: string[], opts: SshStreamOptions): Promise<SshResult> {
  const stdin = opts.stdin === "inherit" ? "inherit" : opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin);
  const child = Bun.spawn({ cmd: argv, env: opts.env as Record<string, string>, stdin, stdout: "pipe", stderr: "pipe" });

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
  if (code === SSH_UNREACHABLE_EXIT && held !== null) return { code, connectError: held.trim() };
  flushStderr();
  return { code, connectError: null };
}
