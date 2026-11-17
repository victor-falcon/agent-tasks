import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { parseCommandArgs } from "../args.ts";
import { type Context, output } from "../context.ts";
import { AgentTasksError, NotFoundError, UsageError } from "../errors.ts";
import { dataFile, endAttempt, lastAttempt, readRunRef, requireTask, settleSession, stamp, updateRun } from "../execution.ts";
import { readStdinBytes } from "../input.ts";
import { resolvePath } from "../paths.ts";
import { parseRunRef } from "../slot.ts";
import type { Command } from "./types.ts";

const STATUSES = ["succeeded", "failed"] as const;

export const FINISH_OPTIONS = {
  status: { type: "string" },
  summary: { type: "string" },
  "output-file": { type: "string" },
  // Hidden: the extension of an output file read from stdin.
  "output-ext": { type: "string" },
} as const;

/** The run's long output: its file extension and how to save it at a path. */
interface OutputSource {
  ext: string;
  save(dest: string): void;
}

/** `--output-file <file>`, or `-` for stdin (how a client forwards its file, with the hidden `--output-ext`). */
async function readOutputSource(ctx: Context, file: string, ext: string | undefined): Promise<OutputSource> {
  if (file === "-") {
    if (ext !== undefined && !/^(\.[A-Za-z0-9]{1,16})?$/.test(ext)) throw new UsageError(`--output-ext must be like .md (got "${ext}")`);
    const bytes = await readStdinBytes();
    return { ext: ext ?? "", save: (dest) => writeFileSync(dest, bytes) };
  }
  const source = resolvePath(file, ctx.env, ctx.cwd);
  if (!existsSync(source) || !statSync(source).isFile()) throw new NotFoundError(`output file not found: ${source}`);
  return { ext: extname(source), save: (dest) => copyFileSync(source, dest) };
}

const finish: Command = {
  name: "finish",
  summary: "Record the result of a run and close its session (called by the subagent)",
  usage: `Usage: agent-tasks finish <run_ref> --status succeeded|failed --summary "<text>" [--output-file <file|->]

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
  --output-file <file>  Long output, copied next to the run's log ("-" for stdin)`,
  async run(ctx, args) {
    const { positionals, values } = parseCommandArgs(
      args,
      FINISH_OPTIONS,
      { minPositionals: 1, maxPositionals: 1 },
    );
    const ref = positionals[0]!;
    const status = values.status as (typeof STATUSES)[number] | undefined;
    if (!status || !STATUSES.includes(status)) throw new UsageError("--status must be succeeded or failed");
    const summary = values.summary?.trim();
    if (!summary) throw new UsageError("--summary is required: say what was done and where the result is");
    const source = values["output-file"] !== undefined ? await readOutputSource(ctx, values["output-file"], values["output-ext"]) : null;

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
        // Already ended: by an earlier finish (nothing to do) or by tick (keep the late report, once).
        const fromFinish = r.events.some((e) => e.event === a.status && e.attempt === n && e.by === "finish");
        outcome = fromFinish ? "duplicate" : "late";
        const known = r.events.some((e) => e.event === "late_finish" && e.attempt === n && e.status === status && e.summary === summary);
        if (outcome === "late" && !known) r.events.push({ at, event: "late_finish", attempt: n, status, summary });
        return;
      }
      if (source) {
        const { taskId, slot } = parseRunRef(ref);
        a.output = `runs/${taskId}/${slot}${n > 1 ? `.${n}` : ""}.output${source.ext}`;
        mkdirSync(dirname(dataFile(ctx, a.output)), { recursive: true });
        source.save(dataFile(ctx, a.output));
      }
      endAttempt(r, n, status, null, at, { summary, by: "finish" });
    });
    const settled = settleSession(ctx, task, ref, { capture: true });

    const final = readRunRef(ctx, ref).attempts[n - 1]!;
    const ended = `${final.status}${final.reason ? ` (${final.reason})` : ""}`;
    if (outcome === "late") ctx.stderr.write(`agent-tasks: warning: ${ref} attempt ${n} had already ended as ${ended}; your report was kept in the run's events\n`);
    if (outcome === "duplicate" && (final.status !== status || final.summary !== summary)) {
      ctx.stderr.write(`agent-tasks: warning: ${ref} attempt ${n} was already finished as ${final.status}; this report (${status}) was not recorded\n`);
    }
    output(
      ctx,
      { run_ref: ref, attempt: n, status: final.status, summary: final.summary, output: final.output ?? null, already_finished: outcome !== "recorded", late: outcome === "late", session: final.session },
      () => {
        const head =
          outcome === "recorded"
            ? `Recorded ${ref} as ${final.status}.`
            : outcome === "late"
              ? `${ref} had already ended as ${ended} before this report; the report was kept but the status stays.`
              : `${ref} was already finished as ${final.status}.`;
        const tail =
          settled.action === "kept"
            ? ` Session kept open (keep_open: ${resolution.keep_open}).`
            : settled.action === "close_failed"
              ? ` Could not close the session: ${settled.error}`
              : settled.action === "unreachable"
                ? ` Could not reach the session's machine to close it; the runner closes it once it is back (${settled.error}).`
                : settled.action === "closed"
                  ? " Session closed."
                  : "";
        return head + tail;
      },
    );
  },
};

export default finish;
