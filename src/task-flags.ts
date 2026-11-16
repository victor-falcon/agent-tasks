import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Context } from "./context.ts";
import { AgentTasksError, NotFoundError, UsageError } from "./errors.ts";
import { homeDir, resolvePath, tildify } from "./paths.ts";
import { isObject, type Schedule, type Task, TASK_FIELDS } from "./schema.ts";
import { systemTimezone, formatInZone } from "./time.ts";

/**
 * Flags shared by `add` and `edit` to set task fields. With `edit`, an empty
 * value (`--timeout ""`) clears a nullable field back to the default.
 */
export const TASK_FLAG_OPTIONS = {
  title: { type: "string" },
  description: { type: "string" },
  cwd: { type: "string" },
  at: { type: "string" },
  cron: { type: "string" },
  timezone: { type: "string" },
  instructions: { type: "string" },
  "instructions-file": { type: "string" },
  "catch-up": { type: "string" },
  "max-delay": { type: "string" },
  timeout: { type: "string" },
  retries: { type: "string" },
  "keep-open": { type: "string" },
  agent: { type: "string" },
} as const;

export type TaskFlagValues = { [K in keyof typeof TASK_FLAG_OPTIONS]?: string };

export const TASK_FLAGS_USAGE = `  --title <text>              Title (the id is derived from it)
  --description <text>        Why the task exists; read by a person
  --cwd <dir>                 Working directory (must exist)
  --at <iso>                  Run once at this time, e.g. 2026-11-20T09:00:00+01:00
  --cron <expr>               Run on a 5-field cron expression, e.g. "0 9 * * 1"
  --timezone <tz>             Time zone for --cron, e.g. Europe/Madrid
  --instructions <text>       Prompt for the subagent
  --instructions-file <path>  Read the prompt from a file ("-" for stdin)
  --catch-up <mode>           latest | all | none
  --max-delay <duration>      How late a slot can still run, e.g. 2h
  --timeout <duration>        Stop the subagent after this long, e.g. 45m
  --retries <n>               Extra attempts after a failure
  --keep-open <mode>          always | on_failure | never
  --agent <command>           Agent command for this task (normally from config)`;

/** Reads all of stdin as text. */
export async function readStdin(): Promise<string> {
  return await Bun.stdin.text();
}

/** Parses JSON read from stdin or a file, as an object. */
export function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new AgentTasksError("invalid_json", `${what} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isObject(value)) throw new AgentTasksError("invalid_json", `${what} must be a JSON object`);
  return value;
}

/** Reads a file argument relative to the command's cwd, or stdin for "-". */
export async function readFileArg(ctx: Context, path: string): Promise<string> {
  if (path === "-") return await readStdin();
  const file = resolvePath(path, ctx.env, ctx.cwd);
  if (!existsSync(file)) throw new NotFoundError(`file not found: ${file}`);
  return readFileSync(file, "utf8");
}

/** Resolves a task folder against the command's cwd, checks it exists and stores it with `~`. */
export function normalizeTaskCwd(ctx: Context, cwd: string): string {
  const abs = resolvePath(cwd, ctx.env, ctx.cwd);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new AgentTasksError("invalid_cwd", `cwd does not exist or is not a folder: ${abs}`);
  }
  return displayPath(ctx, abs);
}

/**
 * An existing folder with the home replaced by `~`. Symlinks are resolved on
 * both sides, so a process cwd reported as its real path (`/private/var/…` on
 * macOS) still matches a `$HOME` that goes through a symlink.
 */
export function displayPath(ctx: Context, path: string): string {
  const home = homeDir(ctx.env);
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
  const realPath = real(path);
  const realHome = real(home);
  if (realPath === realHome || realPath.startsWith(`${realHome}/`)) return tildify(join(home, relative(realHome, realPath)), ctx.env);
  return tildify(path, ctx.env);
}

/** "Now" as an ISO timestamp with offset, in the configured (or system) time zone. */
export function nowIso(ctx: Context): string {
  return formatInZone(ctx.now, ctx.config.config.timezone ?? systemTimezone());
}

function orNull(value: string): string | null {
  return value.trim() === "" ? null : value;
}

/**
 * Applies the field flags to a (possibly partial) task, in place. Reads
 * `--instructions-file` (stdin for "-"). Validation happens later, on the
 * whole task, so only flag combinations are checked here.
 */
export async function applyTaskFlags(ctx: Context, task: Partial<Task>, values: TaskFlagValues): Promise<void> {
  if (values.at !== undefined && values.cron !== undefined) throw new UsageError("use either --at or --cron, not both");
  if (values.instructions !== undefined && values["instructions-file"] !== undefined) {
    throw new UsageError("use either --instructions or --instructions-file, not both");
  }

  if (values.title !== undefined) task.title = values.title;
  if (values.description !== undefined) task.description = orNull(values.description);
  if (values.cwd !== undefined) task.cwd = values.cwd;
  if (values.instructions !== undefined) task.instructions = values.instructions;
  if (values["instructions-file"] !== undefined) task.instructions = (await readFileArg(ctx, values["instructions-file"])).trim();
  if (values["catch-up"] !== undefined) task.catch_up = orNull(values["catch-up"]) as Task["catch_up"];
  if (values["max-delay"] !== undefined) task.max_delay = orNull(values["max-delay"]);
  if (values.timeout !== undefined) task.timeout = orNull(values.timeout);
  if (values["keep-open"] !== undefined) task.keep_open = orNull(values["keep-open"]) as Task["keep_open"];
  if (values.agent !== undefined) task.agent = orNull(values.agent);
  if (values.retries !== undefined) {
    if (!/^\d+$/.test(values.retries)) throw new UsageError(`--retries must be an integer >= 0 (got "${values.retries}")`);
    task.retries = Number(values.retries);
  }

  const previous = task.schedule;
  if (values.at !== undefined) {
    if (values.timezone !== undefined) throw new UsageError("--timezone only applies to --cron schedules");
    task.schedule = { type: "once", at: values.at };
  } else if (values.cron !== undefined) {
    const old = previous?.type === "cron" ? previous : undefined;
    task.schedule = {
      type: "cron",
      cron: values.cron,
      timezone: values.timezone !== undefined ? orNull(values.timezone) : (old?.timezone ?? null),
      starts_at: old?.starts_at ?? null,
      until: old?.until ?? null,
    };
  } else if (values.timezone !== undefined) {
    if (previous?.type !== "cron") throw new UsageError("--timezone only applies to --cron schedules");
    task.schedule = { ...previous, timezone: orNull(values.timezone) } satisfies Schedule;
  }
}

/**
 * A new task with every optional field present (null meaning "resolve from the
 * config"), keys in the documented order. Unknown keys are kept, at the end,
 * so validation still reports them.
 */
export function completeTask(task: Partial<Task>): Task {
  const schedule = task.schedule?.type === "cron" ? { timezone: null, starts_at: null, until: null, ...task.schedule } : task.schedule;
  const filled: Record<string, unknown> = {
    description: null,
    agent: null,
    catch_up: null,
    max_delay: null,
    timeout: null,
    retries: 0,
    keep_open: null,
    schedule_since: null,
    ...task,
    schedule,
  };
  return orderTaskKeys(filled) as unknown as Task;
}

/** Same object with the task fields first, in `TASK_FIELDS` order. */
export function orderTaskKeys(task: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of TASK_FIELDS) if (key in task) ordered[key] = task[key];
  for (const [key, value] of Object.entries(task)) if (!(key in ordered)) ordered[key] = value;
  return ordered;
}
