import { parseCommandArgs } from "../args.ts";
import { type Context, output } from "../context.ts";
import { parseJsonObject, readStdin } from "../input.ts";
import { REMOTE_PROTOCOL } from "../ssh.ts";
import { attachHere, remoteCheckCwd, remoteClose, remoteInstructions, remoteLaunch, remotePing, remoteRead, remoteStatus } from "../remote.ts";
import type { Command } from "./types.ts";

// `agent-tasks remote <op>`: run by the hub over SSH on the machine that
// executes a task (see doc/roadmap/runner.md, "Remote machines"). JSON in on
// stdin, JSON out on stdout. Always runs on this machine: a client never
// forwards it to the hub. Hidden from the main help: people do not call it.

type Handler = (ctx: Context, payload: Record<string, unknown>) => Record<string, unknown>;

function remoteCommand(op: string, summary: string, handler: Handler): Command {
  return {
    name: `remote ${op}`,
    summary,
    hidden: true,
    usage: `Usage: agent-tasks remote ${op} --json < payload.json

Called by the hub over SSH; reads a JSON payload (with "protocol": ${REMOTE_PROTOCOL}) on
stdin and prints a JSON answer. Not meant to be run by hand.`,
    async run(ctx, args) {
      parseCommandArgs(args, {}, { maxPositionals: 0 });
      const payload = parseJsonObject(await readStdin(), `the remote ${op} payload on stdin`);
      const result = handler(ctx, payload);
      output(ctx, result, () => JSON.stringify(result, null, 2));
    },
  };
}

/**
 * `remote attach`: interactive, so the payload comes as an argument (stdin is
 * the terminal) and the exit code is the launcher's attach's.
 */
const remoteAttach: Command = {
  name: "remote attach",
  summary: "Attach to a session on this machine with its own launcher",
  hidden: true,
  usage: `Usage: agent-tasks remote attach --payload <json>

Called by the hub over "ssh -t"; runs this machine's launcher \`attach\` for
the session in the payload (with "protocol": ${REMOTE_PROTOCOL}) with the terminal handed
over, and exits with its exit code. Not meant to be run by hand.`,
  async run(ctx, args) {
    const { values } = parseCommandArgs(args, { payload: { type: "string" } }, { maxPositionals: 0 });
    const payload = parseJsonObject(values.payload ?? "", "the remote attach --payload");
    const result = await attachHere(ctx, payload);
    if (ctx.json) output(ctx, { exit_code: result.code, command: result.argv, launcher: result.launcher }, "");
    return result.code;
  },
};

export const remoteCommands: Command[] = [
  remoteAttach,
  remoteCommand("check-cwd", "Check that a task folder exists on this machine", remoteCheckCwd),
  remoteCommand("close", "Close a session on this machine", remoteClose),
  remoteCommand("instructions", "Personal instructions a task gets on this machine", remoteInstructions),
  remoteCommand("launch", "Launch an attempt on this machine with its own launcher", remoteLaunch),
  remoteCommand("ping", "Who this machine is: protocol, version, machine name and launcher", remotePing),
  remoteCommand("read", "Read a session's output on this machine", remoteRead),
  remoteCommand("status", "State of a session on this machine", remoteStatus),
];
