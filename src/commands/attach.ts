import { parseCommandArgs } from "../args.ts";
import { type Context, output } from "../context.ts";
import { NotFoundError, SessionGoneError } from "../errors.ts";
import { lastAttempt, requireTask, type Session, sessionFor } from "../execution.ts";
import { findRun } from "../find-run.ts";
import { commandEnv, LauncherError, renderCommand, sessionStatus, shellLine } from "../launcher.ts";
import { isInProgress } from "../run-info.ts";
import type { Run } from "../schema.ts";
import { withSigint } from "../sigint.ts";
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

/** The run's session, checked to be alive, with its rendered attach command. */
function liveSession(ctx: Context, run: Run, ref: string): { session: Session; argv: string[] } {
  const task = requireTask(ctx, run.task_id);
  const session = sessionFor(ctx, task, ctx.resolveFor(task), run);
  const seeLog = `see its output with "agent-tasks log ${ref}"`;
  if (!session) throw new SessionGoneError(`run ${ref} has no session (it was never launched); ${seeLog}`);
  if (session.record.closed_at) throw new SessionGoneError(`the session of ${ref} was closed (${run.status}); ${seeLog}`);
  const status = sessionStatus(session.spec, session.input);
  if (status && (status.state === "gone" || status.state === "exited")) throw new SessionGoneError(`the session of ${ref} is ${status.state} (${run.status}); ${seeLog}`);
  if (!session.spec.attach) {
    throw new LauncherError(`the ${session.spec.name} launcher has no attach command; read the session's screen with "agent-tasks session read ${ref}" or follow it with "agent-tasks log ${ref} --follow"`);
  }
  return { session, argv: renderCommand(session.spec.attach, session.input, "launcher.attach") };
}

/** Runs the launcher's `attach` with the terminal handed over, and returns its exit code. */
async function handOver(argv: string[], session: Session): Promise<number> {
  // Ctrl+C belongs to the attached program; don't let it kill us before it returns.
  return withSigint(
    () => {},
    async () => {
      let child: Bun.Subprocess;
      try {
        child = Bun.spawn({ cmd: argv, cwd: session.input.cwd, env: commandEnv(session.input) as Record<string, string>, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      } catch (err) {
        throw new LauncherError(`attach failed: could not run ${shellLine(argv)}: ${(err as Error).message}`);
      }
      return await child.exited;
    },
  );
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

With --json, the attach command still gets the terminal; when it returns,
a JSON object with its exit code is printed.`,
  async run(ctx, args) {
    const { positionals } = parseCommandArgs(args, {}, { minPositionals: 1, maxPositionals: 1 });
    const arg = positionals[0]!;
    const run = findRun(ctx, arg, activeRun(arg));
    const ref = runRef(run.task_id, runSlotId(run));
    const { session, argv } = liveSession(ctx, run, ref);
    const code = await handOver(argv, session);
    if (ctx.json) output(ctx, { run_ref: ref, attempt: lastAttempt(run)?.n ?? null, launcher: session.spec.name, handle: session.record.handle, command: argv, exit_code: code }, "");
    return code;
  },
};

export default attach;
