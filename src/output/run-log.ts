import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Context } from "../context.ts";
import { tildify } from "../paths.ts";
import { isInProgress, neverStarted } from "../run-info.ts";
import type { Attempt, Run, RunEvent, SessionRecord } from "../schema.ts";
import { runRef, runSlotId } from "../slot.ts";
import { runLogRelativePath } from "../store.ts";
import { displayTimezone } from "../task-info.ts";
import { slotLabel } from "./runs-table.ts";
import type { Style } from "./style.ts";
import { statusLabel } from "./symbols.ts";
import { renderTable } from "./table.ts";
import { absoluteTimeWithSeconds, clockTimeWithSeconds, formatSpan, sameDay, timeNear } from "./time.ts";

// What `log` prints for one occurrence (also the runner TUI's log view):
// events, attempts and the captured log.

export interface CapturedLog {
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
export function capturedLog(ctx: Context, run: Run, attempt: Attempt | undefined): CapturedLog | null {
  if (!attempt) return null;
  const path = logPath(ctx, run, attempt);
  const exists = existsSync(path);
  const shared_with = run.attempts.filter((a) => a.n !== attempt.n && logPath(ctx, run, a) === path).map((a) => a.n);
  return { attempt: attempt.n, shared_with, path, exists, content: exists ? readFileSync(path, "utf8") : null };
}

/** `key=value` pairs of an object, skipping empty values. */
export function pairs(record: Record<string, unknown>, skip: readonly string[] = []): string {
  return Object.entries(record)
    .filter(([k, v]) => !skip.includes(k) && v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}

export function eventTime(at: string, run: Run, tz: string, now: Date): string {
  const date = new Date(at);
  return sameDay(date, new Date(run.slot), tz) ? clockTimeWithSeconds(date, tz) : absoluteTimeWithSeconds(date, tz, now);
}

function renderEvents(run: Run, tz: string, now: Date): string {
  if (run.events.length === 0) return "Events: none";
  const rows = run.events.map((e: RunEvent) => [eventTime(e.at, run, tz, now), e.event, pairs(e, ["at", "event"])]);
  return `Events\n${renderTable(rows, { header: false, indent: "  " })}`;
}

/** The command line an attempt ran: `clc --flag`. */
export function agentCommand(agent: Record<string, unknown>): string {
  return [agent.command, ...(Array.isArray(agent.args) ? agent.args : [])].filter((x) => x !== undefined).join(" ");
}

export function agentText(agent: Record<string, unknown> | null): string {
  if (!agent) return "—";
  const command = agentCommand(agent);
  const shell = agent.shell === true ? " (shell)" : "";
  const from = typeof agent.from === "string" ? `  ← ${agent.from}` : "";
  const rest = pairs(agent, ["command", "args", "shell", "from"]);
  return `${command || "?"}${shell}${rest ? ` ${rest}` : ""}${from}`;
}

export function sessionText(session: SessionRecord | null): string {
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
