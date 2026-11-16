import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, extname } from "node:path";
import { parseCommandArgs } from "../args.ts";
import { output } from "../context.ts";
import { NotFoundError, UsageError } from "../errors.ts";
import { dataFile, endAttempt, lastAttempt, readRunRef, requireTask, sessionOf, settleSession, stamp, updateRun } from "../execution.ts";
import { resolvePath } from "../paths.ts";
import { parseRunRef } from "../slot.ts";
import type { Command } from "./types.ts";

const STATUSES = ["succeeded", "failed"] as const;

const finish: Command = {
  name: "finish",
  summary: "Record the result of a run and close its session (called by the subagent)",
  usage: `Usage: agent-tasks finish <run_ref> --status succeeded|failed --summary "<text>" [--output-file <file>]

Saves the result of the run's latest attempt and then closes its session with
the launcher's \`close\`, unless \`keep_open\` says to keep it (\`always\`, or
\`on_failure\` for a failed run). Calling it again for the same attempt
changes nothing.

Arguments:
  <run_ref>             <task-id>/<slot>, e.g. weekly-report/20261117T080000Z

Options:
  --status <status>     succeeded or failed
  --summary <text>      What was done and where the result is
  --output-file <file>  Long output, copied next to the run's log`,
  run(ctx, args) {
    const { positionals, values } = parseCommandArgs(
      args,
      { status: { type: "string" }, summary: { type: "string" }, "output-file": { type: "string" } },
      { minPositionals: 1, maxPositionals: 1 },
    );
    const ref = positionals[0]!;
    const status = values.status as (typeof STATUSES)[number] | undefined;
    if (!status || !STATUSES.includes(status)) throw new UsageError("--status must be succeeded or failed");
    const summary = values.summary?.trim();
    if (!summary) throw new UsageError("--summary is required: say what was done and where the result is");
    let source: string | null = null;
    if (values["output-file"] !== undefined) {
      source = resolvePath(values["output-file"], ctx.env, ctx.cwd);
      if (!existsSync(source) || !statSync(source).isFile()) throw new NotFoundError(`output file not found: ${source}`);
    }

    const before = readRunRef(ctx, ref);
    const attempt = lastAttempt(before);
    if (!attempt) throw new UsageError(`run ${ref} has no attempt to finish (status: ${before.status})`);
    const task = requireTask(ctx, before.task_id);
    const resolution = ctx.resolveFor(task);
    const at = stamp(ctx, resolution.timezone);
    const n = attempt.n;

    let already = attempt.finished_at !== null;
    let outputRel: string | null = null;
    if (!already) {
      if (source) {
        const { taskId, slot } = parseRunRef(ref);
        outputRel = `runs/${taskId}/${slot}${n > 1 ? `.${n}` : ""}.output${extname(source)}`;
        mkdirSync(dirname(dataFile(ctx, outputRel)), { recursive: true });
        copyFileSync(source, dataFile(ctx, outputRel));
      }
      updateRun(ctx, ref, (r) => {
        const a = r.attempts[n - 1]!;
        if (a.finished_at) {
          already = true;
          return;
        }
        a.output = outputRel;
        endAttempt(r, n, status, null, at, { summary });
        r.events.at(-1)!.by = "finish";
      });
    }
    settleSession(ctx, task, ref, { capture: true, retryable: true });

    const after = readRunRef(ctx, ref);
    const final = after.attempts[n - 1]!;
    const session = sessionOf(final);
    output(
      ctx,
      { run_ref: ref, attempt: n, status: final.status, summary: final.summary, output: final.output ?? null, already_finished: already, session },
      () => {
        const head = already ? `${ref} was already finished as ${final.status}.` : `Recorded ${ref} as ${final.status}.`;
        const tail = !session
          ? ""
          : session.kept_open
            ? ` Session kept open (keep_open: ${resolution.keep_open}).`
            : session.close_error
              ? ` Could not close the session: ${session.close_error}`
              : session.closed_at
                ? " Session closed."
                : "";
        return head + tail;
      },
    );
  },
};

export default finish;
