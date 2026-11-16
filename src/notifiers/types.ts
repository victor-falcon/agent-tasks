import type { Env } from "../paths.ts";
import type { exec } from "../launcher.ts";

/** Events a notifier can subscribe to (doc/roadmap/runner.md, "Notifications"). */
export const NOTIFY_EVENTS = ["launched", "succeeded", "failed", "timed_out", "missed", "blocked", "anomaly", "runner_recovered"] as const;
export type NotifyEventType = (typeof NOTIFY_EVENTS)[number];

/** What the runner hands to the notifiers: one event of a tick. */
export interface NotifyItem {
  type: NotifyEventType;
  run_ref: string | null;
  task_id: string | null;
  attempt?: number;
  reason?: string | null;
  message?: string;
}

/** One notification: every event of the same kind in a tick, grouped. */
export interface Notification {
  event: NotifyEventType;
  title: string;
  message: string;
  run_refs: string[];
  task_ids: string[];
}

export interface NotifierDeps {
  env: Env;
  platform: NodeJS.Platform;
  /** Runs a command; the launcher's `exec` by default (replaceable in tests). */
  exec: typeof exec;
}

export interface SystemNotifierConfig {
  type: "system";
  events: NotifyEventType[];
}

export interface CommandNotifierConfig {
  type: "command";
  events: NotifyEventType[];
  run: string[] | string;
}

export type NotifierConfig = SystemNotifierConfig | CommandNotifierConfig;
