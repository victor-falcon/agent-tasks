import { parseCommandArgs } from "../args.ts";
import { localMachine } from "../config.ts";
import { type Context, output } from "../context.ts";
import { NotFoundError, SessionGoneError } from "../errors.ts";
import { lastAttempt, requireTask, type Session, sessionFor } from "../execution.ts";
import { findRun } from "../find-run.ts";
import { commandEnv, handOverTerminal, LauncherError, renderCommand } from "../launcher.ts";
import { isInProgress } from "../run-info.ts";
import type { Run } from "../schema.ts";
import { machineTarget, remotePayload } from "../session-ops.ts";
import { MachineUnreachableError, REMOTE_PROTOCOL, type RemoteTarget, remoteCliLine, SSH_UNREACHABLE_EXIT, sshArgv } from "../ssh.ts";
import { runRef, runSlotId } from "../slot.ts";
import type { Command } from "./types.ts";

/** For a task id: its latest running or blocked run. */
function activeRun(taskId: string) {
  return (runs: Run[]): Run => {
    const active = runs.filter((r) => isInProgress(r.status)).at(-1);
    if (active) return active;
    const latest = runs.at(-1)!;
    const ref = runRef(latest.task_id, runSlotId(latest));
    throw new NotFoundError(`task "${taskId}" has no running or blocked run (latest: ${ref}, ${latest.status}); see its output with "agent-tasks log ${ref}"`);
  };
}

/** A live session to attach to: here (with its attach command), or on another machine. */
interface Live {
  session: Session;
  /** The machine that runs it. */
  machine: string;
  /** How to reach it, when it is not this machine. */
  target: RemoteTarget | null;
  /** This machine's attach command, for a session here. */
  argv: string[] | null;
}

/** The run's session, checked to be alive. */
function liveSession(ctx: Context, run: Run, ref: string): Live {
  const task = requireTask(ctx, run.task_id);
  const session = sessionFor(ctx, task, ctx.resolveFor(task), run);
  const seeLog = `see its output with "agent-tasks log ${ref}"`;
  if (!session) throw new SessionGoneError(`run ${ref} has no session (it was never launched); ${seeLog}`);
  if (session.record.closed_at) throw new SessionGoneError(`the session of ${ref} was closed (${run.status}); ${seeLog}`);
  const status = session.ops.status();
  if (status && (status.state === "gone" || status.state === "exited")) throw new SessionGoneError(`the session of ${ref} is ${status.state} (${run.status}); ${seeLog}`);
  const machine = session.ops.machine ?? localMachine(ctx.config.config);
  // Its machine checks that the launcher there has an attach command.
  if (!session.spec) return { session, machine, target: machineTarget(ctx, machine), argv: null };
  const { spec } = session;
  if (!spec.attach) {
    throw new LauncherError(`the ${spec.name} launcher has no attach command; read the session's screen with "agent-tasks session read ${ref}" or follow it with "agent-tasks log ${ref} --follow"`);
  }
  return { session, machine, target: null, argv: renderCommand(spec.attach, session.input, "launcher.attach") };
}

/** The payload `remote attach` gets: what the session's machine needs to find it. */
function attachPayload(live: Live): Record<string, unknown> {
  const { task, input } = live.session;
  return { protocol: REMOTE_PROTOCOL, ...remotePayload(task, input, live.machine) };
}

/** Attaches with the terminal handed over and returns the exit code and the command run. */
async function attachTo(ctx: Context, live: Live): Promise<{ code: number; argv: string[] }> {
  if (live.argv) return { argv: live.argv, code: await handOverTerminal(live.argv, { cwd: live.session.input.cwd, env: commandEnv(live.session.input) }) };
  const target = live.target!;
  // `remote attach` runs that machine's own launcher; -tt gives it a terminal.
  const argv = sshArgv(target.ssh, remoteCliLine(["remote", "attach", "--payload", JSON.stringify(attachPayload(live))]), { tty: true });
  const code = await handOverTerminal(argv, { cwd: ctx.cwd, env: ctx.env });
  if (code === SSH_UNREACHABLE_EXIT) throw new MachineUnreachableError(target.machine, `machine "${target.machine}" (ssh ${target.ssh}) is unreachable, or the connection was lost`);
  return { code, argv };
}

const attach: Command = {
  name: "attach",
  summary: "Open the terminal of a running or blocked run (the launcher's attach)",
  usage: `Usage: agent-tasks attach <task-id>/<slot> | <task-id>

If the run's session is still alive, hands this terminal over to the
launcher's \`attach\` command (in Herdr, \`hc attach\`), e.g. to answer what a
blocked agent is asking. Detaching (or the agent ending) brings you back,
and agent-tasks exits with the attach command's exit code.

With a task id instead of a run ref, attaches to the task's latest running
or blocked run.

When the session is gone, see what it did with "agent-tasks log <run>".
When the launcher has no attach command (e.g. the process preset), use
"agent-tasks session read <run>" or "agent-tasks log <run> --follow".

A session on another machine works the same from any machine: the hub
opens "ssh -t <machine> agent-tasks remote attach …", which runs that
machine's own launcher \`attach\`. A client attaching to a session that runs
on itself attaches here directly.

With --json, the attach command still gets the terminal; when it returns,
a JSON object with its exit code is printed.`,
  async run(ctx, args) {
    const { values, positionals } = parseCommandArgs(args, { resolve: { type: "boolean" } }, { minPositionals: 1, maxPositionals: 1 });
    const arg = positionals[0]!;
    const run = findRun(ctx, arg, activeRun(arg));
    const ref = runRef(run.task_id, runSlotId(run));
    const live = liveSession(ctx, run, ref);
    const about = { run_ref: ref, attempt: lastAttempt(run)?.n ?? null, machine: live.machine, launcher: live.session.ops.launcherName, handle: live.session.record.handle };
    // Hidden: a client asks where the session runs, to attach directly when it is the client itself.
    if (values.resolve) {
      output(ctx, { ...about, payload: attachPayload(live) }, () => `${ref} runs on machine "${live.machine}" (${about.launcher}, ${about.handle})`);
      return;
    }
    const { code, argv } = await attachTo(ctx, live);
    if (ctx.json) output(ctx, { ...about, command: argv, exit_code: code }, "");
    return code;
  },
};

export default attach;
