import { Cron } from "croner";
import { isDuration } from "./duration.ts";
import { ValidationError } from "./errors.ts";
import { isIsoTimestamp, isValidTimezone } from "./time.ts";
import { NOTIFY_EVENTS, TASK_NOTIFY_EVENTS, type TaskNotifyEvent } from "./notifiers/types.ts";

// ---------------------------------------------------------------------------
// Types (see doc/roadmap/phase-1-core.md, "Data model")
// ---------------------------------------------------------------------------

export const CATCH_UP_VALUES = ["latest", "all", "none"] as const;
export type CatchUp = (typeof CATCH_UP_VALUES)[number];

export const KEEP_OPEN_VALUES = ["always", "on_failure", "never"] as const;
export type KeepOpen = (typeof KEEP_OPEN_VALUES)[number];

export const RUN_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "blocked",
  "missed",
  "superseded",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Statuses after which an occurrence never changes again on its own. */
export const FINAL_STATUSES: readonly RunStatus[] = [
  "succeeded",
  "failed",
  "timed_out",
  "missed",
  "superseded",
  "cancelled",
];

export const TRIGGERS = ["schedule", "manual"] as const;
export type Trigger = (typeof TRIGGERS)[number];

export interface OnceSchedule {
  type: "once";
  at: string;
}

export interface CronSchedule {
  type: "cron";
  cron: string;
  timezone?: string | null;
  starts_at?: string | null;
  until?: string | null;
}

export type Schedule = OnceSchedule | CronSchedule;

export interface AgentSpec {
  command: string;
  args?: string[];
  shell?: boolean;
}

export interface Task {
  id: string;
  title: string;
  description?: string | null;
  cwd: string;
  /** The machine the task runs on (its `cwd` may only exist there). */
  machine: string;
  instructions: string;
  schedule: Schedule;
  /** Normally null: resolved from the user config. A string is shorthand for `{ command }`. */
  agent?: AgentSpec | string | null;
  catch_up?: CatchUp | null;
  max_delay?: string | null;
  timeout?: string | null;
  retries?: number;
  keep_open?: KeepOpen | null;
  /**
   * Which of this task's run events every notifier sends, instead of each
   * notifier's own `events`. Null: the notifiers' `events` decide. `[]`: never.
   */
  notify?: TaskNotifyEvent[] | null;
  enabled: boolean;
  created_at: string;
  created_by?: { cwd?: string; session?: string | null } | null;
  updated_at: string;
  /**
   * When the schedule last changed or the task was resumed. Cron slots before
   * it are ignored (see `planSlots`' `since`), so an edit or a resume does not
   * report a burst of `missed` slots.
   */
  schedule_since?: string | null;
}

/** What a run keeps about the session of an attempt (`attempt.session`), written by the launcher code. */
export interface SessionRecord {
  /** The launcher preset name, or `custom`. */
  launcher: string;
  handle: string;
  name: string;
  pid: number | null;
  /** When `close` was run, or the session was found gone. */
  closed_at: string | null;
  close_error?: string | null;
  /** Failed `close` attempts; tick stops trying after a few. */
  close_attempts?: number;
  /** True when `keep_open` left the session open on purpose. */
  kept_open?: boolean;
  /** The machine that runs the session, when it is not the hub itself (reached over SSH). Absent: this machine. */
  machine?: string;
  /** A close that could not reach the session's machine: tick runs it once the machine is back, whatever `keep_open` says. */
  close_pending?: boolean;
}

export interface Attempt {
  n: number;
  started_at: string;
  finished_at: string | null;
  session: SessionRecord | null;
  agent: Record<string, unknown> | null;
  status: RunStatus;
  summary: string | null;
  log: string | null;
  /** Why the attempt ended as it did, e.g. `exited_without_report` or `prompt_not_delivered`. */
  reason?: string | null;
  /** The file passed to `finish --output-file`, copied next to the log (relative to the data folder). */
  output?: string | null;
}

export interface RunEvent {
  at: string;
  event: string;
  /** When the runner sent this event to the notifiers; set once so it is never notified twice. */
  notified?: string;
  [key: string]: unknown;
}

/** One occurrence of a task: `<data_dir>/runs/<task-id>/<slot>.json`. */
export interface Run {
  task_id: string;
  slot: string;
  trigger: Trigger;
  status: RunStatus;
  reason: string | null;
  attempts: Attempt[];
  events: RunEvent[];
}

/** One line of `state/ticks.jsonl`. */
export interface Tick {
  at: string;
  mode?: string;
  launched?: number;
  missed?: number;
  finished?: number;
  errors?: unknown[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const TASK_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** A machine name: lowercase letters, digits and dashes, starting with a letter (max 64 chars). */
export const MACHINE_NAME_RE = /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

type Obj = Record<string, unknown>;

/** Collects validation errors with a path prefix, e.g. `schedule.cron: …`. */
export class Checker {
  constructor(
    private readonly prefix = "",
    readonly errors: string[] = [],
  ) {}

  /** A checker for a nested field; it shares this checker's error list. */
  at(key: string): Checker {
    return new Checker(this.prefix ? `${this.prefix}.${key}` : key, this.errors);
  }

  fail(message: string): void {
    this.errors.push(this.prefix ? `${this.prefix}: ${message}` : message);
  }
}

export function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function checkUnknownKeys(c: Checker, value: Obj, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) c.at(key).fail(`unknown field (allowed: ${allowed.join(", ")})`);
  }
}

export function checkString(c: Checker, value: unknown, { optional = false, nullable = false } = {}): void {
  if (value === undefined && optional) return;
  if (value === null && nullable) return;
  if (typeof value !== "string" || value.trim() === "") c.fail("must be a non-empty string");
}

export function checkEnum(c: Checker, value: unknown, allowed: readonly string[], { nullable = false } = {}): void {
  if (value === undefined || (value === null && nullable)) return;
  if (typeof value !== "string" || !allowed.includes(value)) c.fail(`must be one of: ${allowed.join(", ")}`);
}

export function checkDuration(c: Checker, value: unknown, { nullable = false } = {}): void {
  if (value === undefined || (value === null && nullable)) return;
  if (!isDuration(value)) c.fail(`must be a duration such as 15m, 2h or 1d (got ${JSON.stringify(value)})`);
}

export function checkTimestamp(c: Checker, value: unknown, { optional = false, nullable = false } = {}): void {
  if (value === undefined && optional) return;
  if (value === null && nullable) return;
  if (!isIsoTimestamp(value)) c.fail(`must be an ISO 8601 timestamp with offset (got ${JSON.stringify(value)})`);
}

export function checkTimezone(c: Checker, value: unknown, { nullable = false } = {}): void {
  if (value === undefined || (value === null && nullable)) return;
  if (typeof value !== "string" || !isValidTimezone(value)) c.fail(`must be an IANA time zone such as Europe/Madrid (got ${JSON.stringify(value)})`);
}

/** A machine name (a task's `machine`, the config's `machine` or a key of `machines`). */
export function checkMachineName(c: Checker, value: unknown): void {
  if (typeof value !== "string" || !MACHINE_NAME_RE.test(value)) {
    const got = value === undefined ? "" : ` (got ${JSON.stringify(value)})`;
    c.fail(`must be a machine name: lowercase letters, digits and dashes, starting with a letter${got}`);
  }
}

/** A task's (or profile's, or default) `notify`: a list of run events, possibly empty. */
export function checkNotify(c: Checker, value: unknown, { nullable = false } = {}): void {
  if (value === undefined || (value === null && nullable)) return;
  if (!Array.isArray(value)) {
    c.fail(`must be an array of events (${TASK_NOTIFY_EVENTS.join(", ")}), [] for never${nullable ? ", or null for the notifiers' own events" : ""}`);
    return;
  }
  const global = value.filter((e) => (NOTIFY_EVENTS as readonly unknown[]).includes(e) && !(TASK_NOTIFY_EVENTS as readonly unknown[]).includes(e));
  if (global.length > 0) {
    c.fail(`${global.join(", ")} ${global.length > 1 ? "are" : "is"} not about a task's runs; choose ${global.length > 1 ? "them" : "it"} in a notifier's \`events\` instead`);
    return;
  }
  const unknown = value.filter((e) => !(TASK_NOTIFY_EVENTS as readonly unknown[]).includes(e));
  if (unknown.length > 0) c.fail(`unknown event${unknown.length > 1 ? "s" : ""} ${unknown.map((e) => JSON.stringify(e)).join(", ")} (allowed: ${TASK_NOTIFY_EVENTS.join(", ")})`);
  else if (new Set(value).size !== value.length) c.fail("lists an event twice");
}

export function checkAgent(c: Checker, value: unknown, { nullable = false } = {}): void {
  if (value === undefined || (value === null && nullable)) return;
  if (typeof value === "string") {
    checkString(c, value);
    return;
  }
  if (!isObject(value)) {
    c.fail("must be a command string or { command, args, shell }");
    return;
  }
  checkUnknownKeys(c, value, ["command", "args", "shell"]);
  checkString(c.at("command"), value.command);
  if (value.args !== undefined && !(Array.isArray(value.args) && value.args.every((a) => typeof a === "string"))) {
    c.at("args").fail("must be an array of strings");
  }
  if (value.shell !== undefined && typeof value.shell !== "boolean") c.at("shell").fail("must be a boolean");
}

function checkSchedule(c: Checker, value: unknown): void {
  if (!isObject(value)) {
    c.fail('must be { "type": "once", "at": … } or { "type": "cron", "cron": … }');
    return;
  }
  if (value.type === "once") {
    checkUnknownKeys(c, value, ["type", "at"]);
    checkTimestamp(c.at("at"), value.at);
    return;
  }
  if (value.type === "cron") {
    checkUnknownKeys(c, value, ["type", "cron", "timezone", "starts_at", "until"]);
    if (typeof value.cron !== "string" || value.cron.trim() === "") {
      c.at("cron").fail("must be a non-empty cron expression");
    } else {
      const parts = value.cron.trim().split(/\s+/).length;
      if (value.cron.trim().startsWith("@")) c.at("cron").fail("nicknames such as @daily are not supported; use 5 fields, e.g. 0 9 * * *");
      else if (parts !== 5) c.at("cron").fail(`must have 5 fields (minute hour day month weekday), got ${parts}`);
      else {
        try {
          // Checks the expression can ever fire (e.g. rejects "0 0 31 2 *").
          if (!new Cron(value.cron, { paused: true }).nextRun(new Date(0))) c.at("cron").fail("never fires");
        } catch (err) {
          c.at("cron").fail((err as Error).message);
        }
      }
    }
    checkTimezone(c.at("timezone"), value.timezone, { nullable: true });
    checkTimestamp(c.at("starts_at"), value.starts_at, { optional: true, nullable: true });
    checkTimestamp(c.at("until"), value.until, { optional: true, nullable: true });
    if (isIsoTimestamp(value.starts_at) && isIsoTimestamp(value.until) && Date.parse(value.until) <= Date.parse(value.starts_at)) {
      c.at("until").fail("must be later than starts_at");
    }
    return;
  }
  c.at("type").fail('must be "once" or "cron"');
}

/** Every task field, in the order they are written to disk. */
export const TASK_FIELDS = [
  "id",
  "title",
  "description",
  "cwd",
  "machine",
  "instructions",
  "schedule",
  "agent",
  "catch_up",
  "max_delay",
  "timeout",
  "retries",
  "keep_open",
  "notify",
  "enabled",
  "created_at",
  "created_by",
  "updated_at",
  "schedule_since",
] as const;

/** Same object with the task fields first, in `TASK_FIELDS` order. */
export function orderTaskKeys(task: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of TASK_FIELDS) if (key in task) ordered[key] = task[key];
  for (const [key, value] of Object.entries(task)) if (!(key in ordered)) ordered[key] = value;
  return ordered;
}

/** Returns the list of problems with a task; empty when valid. */
export function taskErrors(value: unknown): string[] {
  const c = new Checker();
  if (!isObject(value)) {
    c.fail("a task must be a JSON object");
    return c.errors;
  }
  checkUnknownKeys(c, value, TASK_FIELDS);
  if (typeof value.id !== "string" || !TASK_ID_RE.test(value.id)) {
    c.at("id").fail("must be a slug: lowercase letters, digits and dashes (max 64 chars)");
  }
  checkString(c.at("title"), value.title);
  if (value.description !== undefined && value.description !== null && typeof value.description !== "string") {
    c.at("description").fail("must be a string or null");
  }
  checkString(c.at("cwd"), value.cwd);
  checkMachineName(c.at("machine"), value.machine);
  checkString(c.at("instructions"), value.instructions);
  checkSchedule(c.at("schedule"), value.schedule);
  checkAgent(c.at("agent"), value.agent, { nullable: true });
  checkEnum(c.at("catch_up"), value.catch_up, CATCH_UP_VALUES, { nullable: true });
  checkDuration(c.at("max_delay"), value.max_delay, { nullable: true });
  checkDuration(c.at("timeout"), value.timeout, { nullable: true });
  if (value.retries !== undefined && !(Number.isInteger(value.retries) && (value.retries as number) >= 0)) {
    c.at("retries").fail("must be an integer >= 0");
  }
  checkEnum(c.at("keep_open"), value.keep_open, KEEP_OPEN_VALUES, { nullable: true });
  checkNotify(c.at("notify"), value.notify, { nullable: true });
  if (typeof value.enabled !== "boolean") c.at("enabled").fail("must be a boolean");
  checkTimestamp(c.at("created_at"), value.created_at);
  checkTimestamp(c.at("updated_at"), value.updated_at);
  checkTimestamp(c.at("schedule_since"), value.schedule_since, { optional: true, nullable: true });
  if (value.created_by !== undefined && value.created_by !== null && !isObject(value.created_by)) {
    c.at("created_by").fail("must be an object or null");
  }
  return c.errors;
}

export function validateTask(value: unknown): Task {
  const errors = taskErrors(value);
  if (errors.length > 0) throw new ValidationError("task", errors);
  return value as Task;
}

const RUN_FIELDS = ["task_id", "slot", "trigger", "status", "reason", "attempts", "events"] as const;
const ATTEMPT_FIELDS = ["n", "started_at", "finished_at", "session", "agent", "status", "summary", "log", "reason", "output"] as const;

function checkObjectOrNull(c: Checker, value: unknown): void {
  if (value !== null && !isObject(value)) c.fail("must be an object or null");
}

function checkStringOrNull(c: Checker, value: unknown): void {
  if (value !== null && typeof value !== "string") c.fail("must be a string or null");
}

/** Returns the list of problems with a run (occurrence); empty when valid. */
export function runErrors(value: unknown): string[] {
  const c = new Checker();
  if (!isObject(value)) {
    c.fail("a run must be a JSON object");
    return c.errors;
  }
  checkUnknownKeys(c, value, RUN_FIELDS);
  if (typeof value.task_id !== "string" || !TASK_ID_RE.test(value.task_id)) c.at("task_id").fail("must be a task id");
  checkTimestamp(c.at("slot"), value.slot);
  checkEnum(c.at("trigger"), value.trigger ?? null, TRIGGERS);
  checkEnum(c.at("status"), value.status ?? null, RUN_STATUSES);
  checkStringOrNull(c.at("reason"), value.reason);

  if (!Array.isArray(value.attempts)) {
    c.at("attempts").fail("must be an array");
  } else {
    value.attempts.forEach((attempt, i) => {
      const a = c.at(`attempts[${i}]`);
      if (!isObject(attempt)) {
        a.fail("must be an object");
        return;
      }
      checkUnknownKeys(a, attempt, ATTEMPT_FIELDS);
      if (!Number.isInteger(attempt.n) || (attempt.n as number) < 1) a.at("n").fail("must be an integer >= 1");
      checkTimestamp(a.at("started_at"), attempt.started_at);
      checkTimestamp(a.at("finished_at"), attempt.finished_at, { nullable: true });
      checkObjectOrNull(a.at("session"), attempt.session ?? null);
      checkObjectOrNull(a.at("agent"), attempt.agent ?? null);
      checkEnum(a.at("status"), attempt.status ?? null, RUN_STATUSES);
      checkStringOrNull(a.at("summary"), attempt.summary ?? null);
      checkStringOrNull(a.at("log"), attempt.log ?? null);
      checkStringOrNull(a.at("reason"), attempt.reason ?? null);
      checkStringOrNull(a.at("output"), attempt.output ?? null);
    });
  }

  if (!Array.isArray(value.events)) {
    c.at("events").fail("must be an array");
  } else {
    value.events.forEach((event, i) => {
      const e = c.at(`events[${i}]`);
      if (!isObject(event)) {
        e.fail("must be an object");
        return;
      }
      checkTimestamp(e.at("at"), event.at);
      checkString(e.at("event"), event.event);
    });
  }
  return c.errors;
}

export function validateRun(value: unknown): Run {
  const errors = runErrors(value);
  if (errors.length > 0) throw new ValidationError("run", errors);
  return value as Run;
}

export function isFinalStatus(status: RunStatus): boolean {
  return FINAL_STATUSES.includes(status);
}
