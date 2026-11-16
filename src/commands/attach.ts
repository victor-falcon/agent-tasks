import { parseCommandArgs } from "../args.ts";
import { type Context, output } from "../context.ts";
import { AgentTasksError, NotFoundError, UsageError } from "../errors.ts";
import { lastAttempt, readRunRef, requireTask, type Session, sessionFor } from "../execution.ts";
import { commandEnv, LauncherError, renderCommand, sessionStatus, shellLine } from "../launcher.ts";
import { isInProgress } from "../run-info.ts";
import { type Run, TASK_ID_RE } from "../schema.ts";
import { runRef, runSlotId } from "../slot.ts";
import { isArchived, listRuns, taskExists } from "../store.ts";
import { warnCorrupt } from "../task-info.ts";
import type { Command } from "./types.ts";

class SessionGoneError extends AgentTasksError {
  constructor(message: string) {
    super("session_gone", message);
  }
}

/** A run ref, or the task's latest running or blocked run. */
function findRun(ctx: Context, arg: string): Run {
  if (arg.includes("/")) return readRunRef(ctx, arg);
  if (!TASK_ID_RE.test(arg)) throw new UsageError(`invalid run ref or task id "${arg}" (expected <task-id> or <task-id>/<slot>)`);
  const { items, errors } = listRuns(ctx.paths, arg);
  warnCorrupt(ctx, errors);
  const active = items.filter((i) => isInProgress(i.run.status)).at(-1);
  if (active) return active.run;
  const latest = items.at(-1)?.run;
  if (latest) {
    const ref = runRef(latest.task_id, runSlotId(latest));
    throw new NotFoundError(`task "${arg}" has no running or blocked run (latest: ${ref}, ${latest.status}); see its output with "agent-tasks log ${ref}"`);
  }
  if (taskExists(ctx.paths, arg) || isArchived(ctx.paths, arg)) throw new NotFoundError(`task "${arg}" has no runs yet`);
  throw new NotFoundError(`task "${arg}" not found (run "agent-tasks list --all" to see every task)`);
}

/** The run's session, checked to be alive. */
function liveSession(ctx: Context, run: Run, ref: string): Session {
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
  return session;
}

/** Runs the launcher's `attach` with the terminal handed over, and returns its exit code. */
async function handOver(argv: string[], session: Session): Promise<number> {
  // Ctrl+C belongs to the attached program; don't let it kill us before it returns.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  try {
    const child = Bun.spawn({ cmd: argv, cwd: session.input.cwd, env: commandEnv(session.input) as Record<string, string>, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await child.exited;
  } catch (err) {
    throw new LauncherError(`attach failed: could not run ${shellLine(argv)}: ${(err as Error).message}`);
  } finally {
    process.off("SIGINT", ignore);
  }
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
    const run = findRun(ctx, positionals[0]!);
    const ref = runRef(run.task_id, runSlotId(run));
    const session = liveSession(ctx, run, ref);
    const argv = renderCommand(session.spec.attach!, session.input, "launcher.attach");
    const code = await handOver(argv, session);
    if (ctx.json) output(ctx, { run_ref: ref, attempt: lastAttempt(run)?.n ?? null, launcher: session.spec.name, handle: session.record.handle, command: argv, exit_code: code }, "");
    return code;
  },
};

export default attach;
