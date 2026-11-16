import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseCommandArgs } from "../args.ts";
import { type Context, output } from "../context.ts";
import { NotFoundError, UsageError } from "../errors.ts";
import { parseCount } from "../input.ts";
import { slotLabel } from "../output/runs-table.ts";
import { stdoutStyle, type Style } from "../output/style.ts";
import { statusLabel } from "../output/symbols.ts";
import { renderTable } from "../output/table.ts";
import { absoluteTimeWithSeconds, clockTimeWithSeconds, formatSpan, sameDay, timeNear } from "../output/time.ts";
import { isInProgress, neverStarted } from "../run-info.ts";
import { tildify } from "../paths.ts";
import { type Attempt, type Run, type RunEvent, type SessionRecord } from "../schema.ts";
import { runRef, runSlotId } from "../slot.ts";
import { runLogRelativePath } from "../store.ts";
import { displayTimezone } from "../task-info.ts";
import { findRun } from "../find-run.ts";
import { EXIT_INTERRUPTED, followWithClock } from "../follow.ts";
import type { Command } from "./types.ts";

interface CapturedLog {
  attempt: number;
  /** Attempts that write to the same file (the default log is one per slot). */
  shared_with: number[];
  path: string;
  exists: boolean;
  content: string | null;
}

function logPath(ctx: Context, run: Run, attempt: Attempt): string {
  const relative = attempt.log ?? runLogRelativePath(run.task_id, runSlotId(run));
  return isAbsolute(relative) ? relative : join(ctx.paths.dataDir, relative);
}

/** The attempt's captured output; runs without a recorded path use the default `runs/<task>/<slot>.log`. */
function capturedLog(ctx: Context, run: Run, attempt: Attempt | undefined): CapturedLog | null {
  if (!attempt) return null;
  const path = logPath(ctx, run, attempt);
  const exists = existsSync(path);
  const shared_with = run.attempts.filter((a) => a.n !== attempt.n && logPath(ctx, run, a) === path).map((a) => a.n);
  return { attempt: attempt.n, shared_with, path, exists, content: exists ? readFileSync(path, "utf8") : null };
}

/** `key=value` pairs of an object, skipping empty values. */
function pairs(record: Record<string, unknown>, skip: readonly string[] = []): string {
  return Object.entries(record)
    .filter(([k, v]) => !skip.includes(k) && v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}

function eventTime(at: string, run: Run, tz: string, now: Date): string {
  const date = new Date(at);
  return sameDay(date, new Date(run.slot), tz) ? clockTimeWithSeconds(date, tz) : absoluteTimeWithSeconds(date, tz, now);
}

function renderEvents(run: Run, tz: string, now: Date): string {
  if (run.events.length === 0) return "Events: none";
  const rows = run.events.map((e: RunEvent) => [eventTime(e.at, run, tz, now), e.event, pairs(e, ["at", "event"])]);
  return `Events\n${renderTable(rows, { header: false, indent: "  " })}`;
}

function agentText(agent: Record<string, unknown> | null): string {
  if (!agent) return "—";
  const command = [agent.command, ...(Array.isArray(agent.args) ? agent.args : [])].filter((x) => x !== undefined).join(" ");
  const shell = agent.shell === true ? " (shell)" : "";
  const from = typeof agent.from === "string" ? `  ← ${agent.from}` : "";
  const rest = pairs(agent, ["command", "args", "shell", "from"]);
  return `${command || "?"}${shell}${rest ? ` ${rest}` : ""}${from}`;
}

function sessionText(session: SessionRecord | null): string {
  if (!session) return "—";
  const rest = pairs({ ...session }, ["launcher"]);
  const launcher = session.launcher || "?";
  return rest ? `${launcher} · ${rest}` : launcher;
}

function renderAttempt(ctx: Context, style: Style, run: Run, attempt: Attempt, log: CapturedLog | null, tz: string): string {
  const start = new Date(attempt.started_at);
  const end = attempt.finished_at ? new Date(attempt.finished_at) : null;
  const duration = formatSpan((end ?? ctx.now).getTime() - start.getTime());
  const when = `started ${timeNear(start, new Date(run.slot), tz, ctx.now)} · ${end ? duration : `${duration} so far`}`;
  const rows = [
    ["agent", agentText(attempt.agent)],
    ["launcher", sessionText(attempt.session)],
    ["summary", attempt.summary ?? "—"],
    ...(attempt.reason ? [["reason", attempt.reason]] : []),
    ...(attempt.output ? [["output", tildify(isAbsolute(attempt.output) ? attempt.output : join(ctx.paths.dataDir, attempt.output), ctx.env)]] : []),
    ...(log ? [["log", `${tildify(log.path, ctx.env)}${log.exists ? "" : " (not captured)"}`]] : []),
  ];
  return `Attempt ${attempt.n} · ${statusLabel(style, attempt.status)} · ${when}\n${renderTable(rows, { header: false, indent: "  " })}`;
}

function renderLog(ctx: Context, run: Run, log: CapturedLog | null): string {
  if (!log) return neverStarted(run.status) ? "Log: none (it never started)" : "Log: none (no attempt yet)";
  const where = tildify(log.path, ctx.env);
  if (log.content === null) return isInProgress(run.status) ? `Log: not captured yet (still in progress): ${where}` : `Log: none captured (${where})`;
  const label = log.shared_with.length === 0 ? `attempt ${log.attempt}` : `shared by attempts ${[log.attempt, ...log.shared_with].sort((a, b) => a - b).join(", ")}`;
  if (log.content === "") return `Log (${label}): empty (${where})`;
  return `Log (${label}): ${where}\n\n${log.content.trimEnd()}`;
}

export function renderRunLog(ctx: Context, style: Style, run: Run, attempts: readonly Attempt[], log: CapturedLog | null): string {
  const tz = displayTimezone(ctx);
  const ref = runRef(run.task_id, runSlotId(run));
  const head = `${statusLabel(style, run.status)}  ${style.paint("bold", ref)} · slot ${slotLabel(run, tz, ctx.now)}${run.reason ? ` · reason ${run.reason}` : ""}`;
  return [
    head,
    "",
    renderEvents(run, tz, ctx.now),
    "",
    ...(attempts.length === 0 ? ["Attempts: none"] : attempts.flatMap((a, i) => [...(i > 0 ? [""] : []), renderAttempt(ctx, style, run, a, a.n === log?.attempt ? log : null, tz)])),
    "",
    renderLog(ctx, run, log),
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

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
