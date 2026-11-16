import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, extname } from "node:path";
import { parseCommandArgs } from "../args.ts";
import { output } from "../context.ts";
import { AgentTasksError, NotFoundError, UsageError } from "../errors.ts";
import { dataFile, endAttempt, lastAttempt, readRunRef, requireTask, settleSession, stamp, updateRun } from "../execution.ts";
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
changes nothing. If tick already ended the attempt (timeout, exited), the
late report is kept in the run's events and the status stays.

The attempt is taken from $AGENT_TASKS_ATTEMPT when set (the launcher sets
it), so an old attempt cannot finish a newer one.

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
    const latest = lastAttempt(before);
    if (!latest) throw new UsageError(`run ${ref} has no attempt to finish (status: ${before.status})`);
    const fromEnv = ctx.env.AGENT_TASKS_RUN === ref ? Number(ctx.env.AGENT_TASKS_ATTEMPT) : NaN;
    const n = Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : latest.n;
    if (n !== latest.n) {
      throw new AgentTasksError("stale_attempt", `attempt ${n} of ${ref} was replaced by attempt ${latest.n}; this report was not recorded`);
    }
    const task = requireTask(ctx, before.task_id);
    const resolution = ctx.resolveFor(task);
    const at = stamp(ctx, resolution.timezone);

    let outcome = "recorded" as "recorded" | "duplicate" | "late";
    updateRun(ctx, ref, (r) => {
      const a = r.attempts[n - 1]!;
      if (a.finished_at) {
        // Already ended: by an earlier finish (nothing to do) or by tick (keep the late report).
        const fromFinish = r.events.some((e) => e.event === a.status && e.attempt === n && e.by === "finish");
        outcome = fromFinish ? "duplicate" : "late";
        if (outcome === "late") r.events.push({ at, event: "late_finish", attempt: n, status, summary });
        return;
      }
      if (source) {
        const { taskId, slot } = parseRunRef(ref);
        a.output = `runs/${taskId}/${slot}${n > 1 ? `.${n}` : ""}.output${extname(source)}`;
        mkdirSync(dirname(dataFile(ctx, a.output)), { recursive: true });
        copyFileSync(source, dataFile(ctx, a.output));
      }
      endAttempt(r, n, status, null, at, { summary, by: "finish" });
    });
    const settled = settleSession(ctx, task, ref, { capture: true });

    const final = readRunRef(ctx, ref).attempts[n - 1]!;
    if (outcome === "late") ctx.stderr.write(`agent-tasks: warning: ${ref} attempt ${n} had already ended as ${final.status} (${final.reason ?? "no reason"}); your report was kept in its events\n`);
    output(
      ctx,
      { run_ref: ref, attempt: n, status: final.status, summary: final.summary, output: final.output ?? null, already_finished: outcome !== "recorded", late: outcome === "late", session: final.session },
      () => {
        const head = outcome === "recorded" ? `Recorded ${ref} as ${final.status}.` : `${ref} was already finished as ${final.status}.`;
        const tail =
          settled.action === "kept"
            ? ` Session kept open (keep_open: ${resolution.keep_open}).`
            : settled.action === "close_failed"
              ? ` Could not close the session: ${settled.error}`
              : settled.action === "closed"
                ? " Session closed."
                : "";
        return head + tail;
      },
    );
  },
};

export default finish;
