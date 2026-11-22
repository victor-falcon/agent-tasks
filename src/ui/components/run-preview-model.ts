import { capturedLog } from "../../commands/log.ts";
import type { Context } from "../../context.ts";
import { isFailure } from "../../run-info.ts";
import { readRunByRef } from "../../store.ts";
import { type DashRun, tailLines } from "../../tui/snapshot.ts";
import { sanitize } from "../../tui/text.ts";

// What the preview of one run shows, as plain data (tested without a
// renderer); components/run-preview.tsx draws it.

/** Lines of a failed run's captured log shown in the preview. */
export const PREVIEW_LOG_LINES = 40;

export interface RunPreviewData {
  run: DashRun;
  blocked: boolean;
  summary: string | null;
  reason: string | null;
  log: { path: string; lines: string[] } | null;
}

export function buildRunPreview(ctx: Context, run: DashRun): RunPreviewData {
  let log: { path: string; lines: string[] } | null = null;
  // A failure says why in its log, more than in its summary.
  if (isFailure(run.status) || (run.status === "missed" && run.attempt > 0)) {
    try {
      const stored = readRunByRef(ctx.paths, run.ref);
      const captured = capturedLog(ctx, stored, stored.attempts.at(-1));
      if (captured?.exists) log = { path: captured.path, lines: sanitize(tailLines(captured.path, PREVIEW_LOG_LINES).join("\n")).split("\n") };
    } catch {
      // The run file is being rewritten: the summary is enough for now.
    }
  }
  return { run, blocked: run.status === "blocked", summary: run.summary, reason: run.reason, log };
}
