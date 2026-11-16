import { isDecisive, isFailure } from "../run-info.ts";
import type { RunStatus } from "../schema.ts";
import type { TaskState } from "../task-info.ts";
import type { Color, Style } from "./style.ts";

// One-character marks for occurrences and tasks (see doc/roadmap/phase-2-cli-ui.md).

export interface Mark {
  symbol: string;
  color?: Color;
}

export const RUN_MARKS: Record<RunStatus, Mark> = {
  succeeded: { symbol: "■", color: "green" },
  failed: { symbol: "✕", color: "red" },
  timed_out: { symbol: "✕", color: "red" },
  missed: { symbol: "□", color: "yellow" },
  running: { symbol: "◐", color: "cyan" },
  blocked: { symbol: "!", color: "magenta" },
  superseded: { symbol: "-", color: "dim" },
  cancelled: { symbol: "-", color: "dim" },
};

/** An occurrence that has not happened yet (a one-off task waiting for its time). */
export const PENDING_MARK: Mark = { symbol: "·", color: "dim" };

/** What a task row looks like at a glance. */
export type TaskMarkKind = "ok" | "running" | "blocked" | "failing" | "paused" | "once_pending" | "finished" | "archived";

export const TASK_MARKS: Record<TaskMarkKind, Mark> = {
  ok: { symbol: "●", color: "green" },
  running: { symbol: "◐", color: "cyan" },
  blocked: { symbol: "!", color: "magenta" },
  failing: { symbol: "✕", color: "red" },
  paused: { symbol: "⏸", color: "dim" },
  once_pending: { symbol: "○" },
  finished: { symbol: "■", color: "dim" },
  archived: { symbol: "-", color: "dim" },
};

export function paintMark(style: Style, mark: Mark): string {
  return style.paint(mark.color, mark.symbol);
}

/** `✕ failed`, `■ ok`… */
export function statusLabel(style: Style, status: RunStatus): string {
  const mark = RUN_MARKS[status];
  return style.paint(mark.color, `${mark.symbol} ${status === "succeeded" ? "ok" : status}`);
}

/**
 * The mark for a task: blocked or running first, then whether its latest
 * decisive occurrence (ok / failed / timed out) failed.
 */
export function taskMarkKind(state: TaskState, isOnce: boolean, statuses: readonly RunStatus[]): TaskMarkKind {
  if (state === "archived") return "archived";
  if (state === "finished") return "finished";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("running")) return "running";
  if (state === "paused") return "paused";
  const decisive = statuses.filter(isDecisive).at(-1);
  if (decisive !== undefined && isFailure(decisive)) return "failing";
  if (isOnce) return "once_pending";
  return "ok";
}
