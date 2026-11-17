import type { Context } from "./context.ts";
import { AgentTasksError, EXIT_USAGE, HubUnreachableError } from "./errors.ts";
import { captureSsh, CLIENT_PROTOCOL_FLAG, COMMAND_NOT_FOUND_EXIT, jsonAnswer, REMOTE_CLI, REMOTE_PROTOCOL, remoteCliLine, SSH_UNREACHABLE_EXIT, sshArgv, sshFailure } from "./ssh.ts";

// A client talking to its hub: the protocol flag every forwarded command
// carries, the errors for a hub that can't run it, and `callHub` for the
// commands whose JSON answer the client uses itself (init --join, doctor,
// attach). Forwarding a command for the user is in client.ts.

const HUB_CALL_TIMEOUT_MS = 90_000;

/** The global flags of every forwarded command: the protocol first, so the hub checks it before anything else. */
export function hubGlobals(globals: readonly string[]): string[] {
  return [`${CLIENT_PROTOCOL_FLAG}=${REMOTE_PROTOCOL}`, ...globals];
}

/**
 * Whether a command's failure is a hub too old to know `--client-protocol`:
 * it rejects it as a usage error that names it (`unknown command
 * "--client-protocol=1"`).
 */
export function isOldHubRejection(code: number | null, output: string): boolean {
  return code === EXIT_USAGE && output.includes(CLIENT_PROTOCOL_FLAG);
}

/** The error for a hub whose agent-tasks predates the protocol check. */
export function oldHubError(hubAlias: string): AgentTasksError {
  return new AgentTasksError(
    "protocol_mismatch",
    `the hub "${hubAlias}" runs an older agent-tasks that does not know this client's protocol (${REMOTE_PROTOCOL}); update agent-tasks on the hub (git pull in its agent-tasks checkout)`,
  );
}

export function notInstalledOnHub(hubAlias: string): HubUnreachableError {
  return new HubUnreachableError(
    hubAlias,
    `could not run ${REMOTE_CLI} there: install agent-tasks on the hub ("agent-tasks install") and make sure bun is in the PATH of non-interactive SSH sessions`,
  );
}

/**
 * Runs `agent-tasks <args> --json` on the hub and returns its JSON answer
 * (not printed). Throws the hub's error as it reported it.
 */
export function callHub(ctx: Context, hubAlias: string, args: string[], globals: string[] = []): Record<string, unknown> {
  const argv = sshArgv(hubAlias, remoteCliLine([...hubGlobals(["--json", ...globals.filter((g) => g !== "--json")]), ...args]));
  const command = `"agent-tasks ${args.join(" ")}"`;
  const capture = captureSsh(argv, ctx.env, { timeoutMs: HUB_CALL_TIMEOUT_MS, what: `the hub "${hubAlias}"` });
  if (capture.code === SSH_UNREACHABLE_EXIT) throw new HubUnreachableError(hubAlias, sshFailure(capture));
  if (capture.code === null) throw new HubUnreachableError(hubAlias, `${command} did not answer within ${HUB_CALL_TIMEOUT_MS / 1000}s`);
  if (capture.code === COMMAND_NOT_FOUND_EXIT && !capture.stdout.trim()) throw notInstalledOnHub(hubAlias);
  if (isOldHubRejection(capture.code, capture.stdout + capture.stderr)) throw oldHubError(hubAlias);
  return jsonAnswer(capture, { command, where: `the hub "${hubAlias}"`, failedCode: "hub_failed", prefixErrors: false });
}
