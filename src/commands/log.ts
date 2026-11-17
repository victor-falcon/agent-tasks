import { parseCommandArgs } from "../args.ts";
import { output } from "../context.ts";
import { NotFoundError, UsageError } from "../errors.ts";
import { parseCount } from "../input.ts";
import { capturedLog, renderRunLog } from "../output/run-log.ts";
import { stdoutStyle } from "../output/style.ts";
import { isInProgress } from "../run-info.ts";
import { runRef, runSlotId } from "../slot.ts";
import { findRun } from "../find-run.ts";
import { EXIT_INTERRUPTED, followWithClock } from "../follow.ts";
import type { Command } from "./types.ts";

const log: Command = {
  name: "log",
  summary: "Show what happened in a run: events, attempts and the captured log",
  usage: `Usage: agent-tasks log <task-id>/<slot> | <task-id> [--attempt <n>] [--raw] [--follow]

Shows one occurrence: its events (claimed, launched, state changes,
warnings), each attempt with its agent, launcher, handle, status and
summary, and then the log captured from the agent. With a task id instead
of a run ref, shows the task's latest occurrence. Run refs are listed by
"agent-tasks runs".

Options:
  --attempt <n>  Only attempt n (and its log); by default every attempt and the latest log
  --raw          Only the captured log, to pipe into less or another agent
                 (with --json, the log content is in the JSON anyway)
  --follow       If the run is still running or blocked, keep printing its new
                 output (the launcher's read, every few seconds) until it ends,
                 then print its final status. Ctrl+C stops following (exit
                 130); otherwise the exit code is 0 whatever the run's result.
                 With --json, waits for the end and prints the final JSON.
                 For a finished run it is the same as without --follow`,
  async run(ctx, args) {
    const { values, positionals } = parseCommandArgs(args, { attempt: { type: "string" }, raw: { type: "boolean" }, follow: { type: "boolean" } }, { minPositionals: 1, maxPositionals: 1 });
    let run = findRun(ctx, positionals[0]!);
    const ref = runRef(run.task_id, runSlotId(run));
    const follow = values.follow === true && isInProgress(run.status);
    if (follow && values.attempt !== undefined) throw new UsageError("--follow always follows the latest attempt; it can't be combined with --attempt");

    if (follow && ctx.json) {
      // JSON is one document: wait for the end, then print the final state.
      ctx.stderr.write(`agent-tasks: waiting for ${ref} to finish (Ctrl+C to stop)…\n`);
      const result = await followWithClock(ctx, ref, { shown: "", quiet: true });
      if (!result.finished) return EXIT_INTERRUPTED;
      run = result.run;
    }
    let attempts = run.attempts;
    if (values.attempt !== undefined) {
      const n = parseCount("--attempt", values.attempt, 1);
      attempts = run.attempts.filter((a) => a.n === n);
      if (attempts.length === 0) throw new NotFoundError(`run "${ref}" has no attempt ${n} (it has ${run.attempts.length})`);
    }
    const captured = capturedLog(ctx, run, attempts.at(-1));

    if (values.raw && !ctx.json) {
      if (captured?.content == null && !follow) throw new NotFoundError(`no captured log for ${ref}${captured ? ` (expected at ${captured.path})` : " (it has no attempt)"}`);
      ctx.stdout.write(captured?.content ?? "");
    } else {
      output(ctx, { ref, run, attempt: captured?.attempt ?? null, log: captured }, () => renderRunLog(ctx, stdoutStyle(ctx), run, attempts, captured));
    }
    if (!follow || ctx.json) return;
    const result = await followWithClock(ctx, ref, { shown: captured?.content ?? "", raw: values.raw === true });
    return result.finished ? undefined : EXIT_INTERRUPTED;
  },
};

export default log;
