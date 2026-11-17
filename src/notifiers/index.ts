import type { Context } from "../context.ts";
import { AgentTasksError } from "../errors.ts";
import { findTask, readRunRef, updateRun } from "../execution.ts";
import { exec } from "../launcher.ts";
import type { Run, RunEvent } from "../schema.ts";
import { sendCommand } from "./command.ts";
import { notifiersOf } from "./config.ts";
import { sendSystem } from "./system.ts";
import { isTaskNotifyEvent, type NotifierConfig, type NotifierDeps, type Notification, type NotifyEventType, type NotifyItem, type TaskNotifyEvent } from "./types.ts";

export * from "./config.ts";
export * from "./types.ts";

// Notifiers: alerts outside the runner's screen. Events of one tick are
// grouped (one notification per notifier and kind of event), and each run
// event that was notified is marked (`notified` on the run's event), so it is
// never notified twice. Only the runner notifies (one at a time, through its
// lock), so the check and the mark need no lock of their own.

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

const VERBS: Record<NotifyEventType, string> = {
  launched: "launched",
  succeeded: "succeeded",
  failed: "failed",
  timed_out: "timed out",
  missed: "missed",
  blocked: "blocked",
  anomaly: "anomaly",
  runner_recovered: "runner recovered",
};

function uniq(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

function detailOf(item: NotifyItem): string {
  return [item.reason, item.message].filter(Boolean).join(": ") || item.run_ref || "";
}

/** How much of the agent's `finish --summary` a notification carries. */
export const SUMMARY_LIMIT = 300;

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * The message of a single succeeded or failed run: the agent's summary
 * (truncated), and how to reach its session when `keep_open` left it open.
 * Null when the run cannot be read.
 */
function finishedRunMessage(item: NotifyItem, run: Run | undefined): string | null {
  if (!run || !item.run_ref) return null;
  const attempt = item.attempt !== undefined ? run.attempts[item.attempt - 1] : run.attempts.at(-1);
  if (!attempt) return null;
  const text = attempt.summary ? truncate(attempt.summary, SUMMARY_LIMIT) : detailOf(item);
  const open = attempt.session?.kept_open && !attempt.session.closed_at;
  const tail = open ? `Session still open: agent-tasks attach ${item.run_ref}` : "";
  return [text, tail].filter(Boolean).join("\n") || null;
}

/**
 * One notification for events of the same kind. `titleOf` gives a task's
 * title from its id; `runOf`, a run from its ref, so a single succeeded or
 * failed run can carry the agent's summary.
 */
export function groupNotification(event: NotifyEventType, items: NotifyItem[], titleOf: (taskId: string) => string, runOf?: (ref: string) => Run | undefined): Notification {
  const run_refs = uniq(items.map((i) => i.run_ref));
  const task_ids = uniq(items.map((i) => i.task_id));
  const verb = VERBS[event];
  if (items.length === 1) {
    const item = items[0]!;
    const subject = item.task_id ? titleOf(item.task_id) : null;
    const title = event === "anomaly" ? `anomaly${subject ? ` in ${subject}` : ""}` : event === "runner_recovered" ? verb : `${subject ?? item.run_ref ?? "a run"} ${verb}`;
    const finished = (event === "succeeded" || event === "failed") && item.run_ref && runOf ? finishedRunMessage(item, runOf(item.run_ref)) : null;
    return { event, title, message: finished ?? (detailOf(item) || title), run_refs, task_ids };
  }
  const title = event === "anomaly" ? `${items.length} anomalies` : `${items.length} runs ${verb}`;
  const names = task_ids.length > 0 ? task_ids.map(titleOf) : items.map(detailOf);
  return { event, title, message: names.join(", "), run_refs, task_ids };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** The run event a tick event came from: the latest one with the same name (and attempt). */
export function matchingRunEvent(run: Run, item: NotifyItem): RunEvent | undefined {
  for (let i = run.events.length - 1; i >= 0; i--) {
    const e = run.events[i]!;
    if (e.event !== item.type) continue;
    if (item.attempt !== undefined && e.attempt !== undefined && e.attempt !== item.attempt) continue;
    return e;
  }
  return undefined;
}

export interface DispatchResult {
  /** Notifications sent (or attempted). */
  notifications: { notifier: number; type: NotifierConfig["type"]; notification: Notification; error: string | null }[];
  /** Problems to show as ⚠; they never stop the runner. */
  warnings: string[];
}

export function defaultNotifierDeps(env: NotifierDeps["env"]): NotifierDeps {
  return { env, platform: process.platform, exec };
}

function send(config: NotifierConfig, n: Notification, deps: NotifierDeps): void {
  if (config.type === "system") sendSystem(n, deps);
  else sendCommand(config, n, deps);
}

/**
 * Sends a tick's events to the configured notifiers, grouped by kind, then
 * marks each notified run event so it is never sent again.
 */
export function dispatchNotifications(ctx: Context, items: NotifyItem[], deps: NotifierDeps = defaultNotifierDeps(ctx.env)): DispatchResult {
  const result: DispatchResult = { notifications: [], warnings: [] };
  // Validated when the config is loaded.
  const notifiers = notifiersOf(ctx.config.config);

  // A task's `notify` (resolved: task > profile > config defaults) replaces
  // every notifier's `events` for that task's run events.
  const taskNotify = new Map<string, TaskNotifyEvent[] | null>();
  const notifyOf = (item: NotifyItem): TaskNotifyEvent[] | null => {
    if (!item.task_id || !isTaskNotifyEvent(item.type)) return null;
    if (!taskNotify.has(item.task_id)) {
      let notify: TaskNotifyEvent[] | null = null;
      try {
        const found = findTask(ctx, item.task_id);
        if (found) notify = ctx.resolveFor(found.task).notify;
      } catch {
        // A broken task file: the notifiers' own events.
      }
      taskNotify.set(item.task_id, notify);
    }
    return taskNotify.get(item.task_id)!;
  };
  const wants = (config: NotifierConfig, item: NotifyItem): boolean => {
    const notify = notifyOf(item);
    return notify ? (notify as NotifyEventType[]).includes(item.type) : config.events.includes(item.type);
  };

  // Drop what was already notified (a run event carries `notified` once sent).
  const fresh = items.filter((item) => {
    if (!notifiers.some((n) => wants(n, item))) return false;
    if (!item.run_ref) return true;
    try {
      return !matchingRunEvent(readRunRef(ctx, item.run_ref), item)?.notified;
    } catch {
      return true;
    }
  });
  if (fresh.length === 0) return result;

  const titles = new Map<string, string>();
  const titleOf = (id: string) => {
    if (!titles.has(id)) {
      let title = id;
      try {
        title = findTask(ctx, id)?.task.title ?? id;
      } catch {
        // A broken task file: use its id.
      }
      titles.set(id, title);
    }
    return titles.get(id)!;
  };

  const runs = new Map<string, Run | undefined>();
  const runOf = (ref: string) => {
    if (!runs.has(ref)) {
      let run: Run | undefined;
      try {
        run = readRunRef(ctx, ref);
      } catch {
        // Unreadable: the notification keeps its short form.
      }
      runs.set(ref, run);
    }
    return runs.get(ref);
  };

  notifiers.forEach((config, index) => {
    const byType = new Map<NotifyEventType, NotifyItem[]>();
    for (const item of fresh) {
      if (!wants(config, item)) continue;
      byType.set(item.type, [...(byType.get(item.type) ?? []), item]);
    }
    for (const [type, group] of byType) {
      const notification = groupNotification(type, group, titleOf, runOf);
      let error: string | null = null;
      try {
        send(config, notification, deps);
      } catch (err) {
        error = err instanceof AgentTasksError ? err.message : String(err);
        result.warnings.push(`notifier ${index + 1} (${config.type}) failed for ${notification.title}: ${error}`);
      }
      result.notifications.push({ notifier: index, type: config.type, notification, error });
    }
  });

  // Mark, even when a notifier failed: a broken notifier must not resend the same events every tick.
  const at = ctx.now.toISOString();
  const byRun = new Map<string, NotifyItem[]>();
  for (const item of fresh) if (item.run_ref) byRun.set(item.run_ref, [...(byRun.get(item.run_ref) ?? []), item]);
  for (const [ref, group] of byRun) {
    try {
      updateRun(ctx, ref, (run) => {
        for (const item of group) {
          const e = matchingRunEvent(run, item);
          if (e && !e.notified) e.notified = at;
        }
      });
    } catch (err) {
      result.warnings.push(`could not mark ${ref} as notified: ${(err as Error).message}`);
    }
  }
  return result;
}
