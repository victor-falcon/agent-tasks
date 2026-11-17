import { existsSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isKnownMachine, knownMachines } from "./config.ts";
import type { Context } from "./context.ts";
import { AgentTasksError, UsageError } from "./errors.ts";
import { parseCount, readFileArg } from "./input.ts";
import { homeDir, resolvePath, tildify } from "./paths.ts";
import { orderTaskKeys, type Schedule, type Task } from "./schema.ts";

/**
 * Flags shared by `add` and `edit` to set task fields. With `edit`, an empty
 * value (`--timeout ""`) clears a nullable field back to the default.
 */
export const TASK_FLAG_OPTIONS = {
  title: { type: "string" },
  description: { type: "string" },
  cwd: { type: "string" },
  machine: { type: "string" },
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
  notify: { type: "string" },
  agent: { type: "string" },
} as const;

export type TaskFlagValues = { [K in keyof typeof TASK_FLAG_OPTIONS]?: string };

export const TASK_FLAGS_USAGE = `  --title <text>              Title
  --description <text>        Why the task exists; read by a person
  --cwd <dir>                 Working directory (must exist)
  --machine <name>            Machine the task runs on (default: this one)
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
  --notify <events>           Run events every notifier sends for this task,
                              e.g. succeeded,failed (none: never notify)
  --agent <command>           Agent command for this task (normally from config)`;

/** Rejects a machine that is neither this one nor in the config's `machines`. */
export function checkTaskMachine(ctx: Context, machine: string): void {
  const config = ctx.config.config;
  if (isKnownMachine(config, machine)) return;
  const known = Object.keys(knownMachines(config)).sort().join(", ");
  throw new AgentTasksError("unknown_machine", `unknown machine "${machine}" (known: ${known}); add it to \`machines\` in the config`);
}

/** Resolves a task folder against the command's cwd, checks it exists and stores it with `~`. */
export function normalizeTaskCwd(ctx: Context, cwd: unknown): string {
  if (typeof cwd !== "string" || cwd.trim() === "") throw new AgentTasksError("invalid_cwd", "cwd must be a non-empty string");
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

/** `--timeout ""` resets a field to the default (null). */
function emptyToNull(value: string): string | null {
  return value.trim() === "" ? null : value;
}

/**
 * `--notify succeeded,failed` → a list, `--notify none` → `[]` (never),
 * `--notify ""` → null (each notifier's own events). The events are checked
 * with the whole task.
 */
export function parseNotify(value: string): Task["notify"] {
  if (value.trim() === "") return null;
  if (value.trim().toLowerCase() === "none") return [];
  return value.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean) as NonNullable<Task["notify"]>;
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
  if (values.description !== undefined) task.description = emptyToNull(values.description);
  if (values.cwd !== undefined) task.cwd = values.cwd;
  if (values.machine !== undefined) task.machine = values.machine;
  if (values.instructions !== undefined) task.instructions = values.instructions;
  if (values["instructions-file"] !== undefined) task.instructions = (await readFileArg(ctx, values["instructions-file"])).trim();
  if (values["catch-up"] !== undefined) task.catch_up = emptyToNull(values["catch-up"]) as Task["catch_up"];
  if (values["max-delay"] !== undefined) task.max_delay = emptyToNull(values["max-delay"]);
  if (values.timeout !== undefined) task.timeout = emptyToNull(values.timeout);
  if (values["keep-open"] !== undefined) task.keep_open = emptyToNull(values["keep-open"]) as Task["keep_open"];
  if (values.notify !== undefined) task.notify = parseNotify(values.notify);
  if (values.agent !== undefined) task.agent = emptyToNull(values.agent);
  if (values.retries !== undefined) task.retries = parseCount("--retries", values.retries, 0);

  const previous = task.schedule;
  if (values.at !== undefined) {
    if (values.timezone !== undefined) throw new UsageError("--timezone only applies to --cron schedules");
    task.schedule = { type: "once", at: values.at };
  } else if (values.cron !== undefined) {
    const old = previous?.type === "cron" ? previous : undefined;
    task.schedule = {
      type: "cron",
      cron: values.cron,
      timezone: values.timezone !== undefined ? emptyToNull(values.timezone) : (old?.timezone ?? null),
      starts_at: old?.starts_at ?? null,
      until: old?.until ?? null,
    };
  } else if (values.timezone !== undefined) {
    if (previous?.type !== "cron") throw new UsageError("--timezone only applies to --cron schedules");
    task.schedule = { ...previous, timezone: emptyToNull(values.timezone) } satisfies Schedule;
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
    notify: null,
    schedule_since: null,
    ...task,
    schedule,
  };
  return orderTaskKeys(filled) as unknown as Task;
}
