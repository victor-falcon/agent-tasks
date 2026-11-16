import { existsSync } from "node:fs";
import { parseCommandArgs } from "../args.ts";
import type { Resolution, ResolvedKey } from "../config.ts";
import { type Context, output } from "../context.ts";
import { NotFoundError } from "../errors.ts";
import { resolvePath, tildify } from "../paths.ts";
import type { Task } from "../schema.ts";
import { readTask, readTaskFile, taskPath } from "../store.ts";
import type { Command } from "./types.ts";

function looksLikePath(arg: string): boolean {
  return arg.includes("/") || arg.endsWith(".json");
}

function loadTask(ctx: Context, arg: string): { task: Task; file: string } {
  if (looksLikePath(arg)) {
    const file = resolvePath(arg, ctx.env, ctx.cwd);
    if (!existsSync(file)) throw new NotFoundError(`task file not found: ${file}`);
    return { task: readTaskFile(file), file };
  }
  const task = readTask(ctx.paths, arg);
  return { task, file: taskPath(ctx.paths, arg) };
}

function formatValue(key: ResolvedKey, r: Resolution, ctx: Context): string {
  switch (key) {
    case "agent":
      return [r.agent.command, ...r.agent.args].join(" ") + (r.agent.shell ? " (shell)" : "");
    case "launcher":
      return JSON.stringify(r.launcher);
    case "env": {
      const entries = Object.entries(r.env);
      return entries.length > 0 ? entries.map(([k, v]) => `${k}=${v}`).join(" ") : "(none)";
    }
    case "instructions":
      return r.instructions.length > 0 ? r.instructions.map((f) => tildify(f, ctx.env)).join(", ") : "(none)";
    default:
      return String(r[key]);
  }
}

const KEYS: ResolvedKey[] = [
  "agent",
  "launcher",
  "skill",
  "env",
  "instructions",
  "timeout",
  "keep_open",
  "retries",
  "catch_up",
  "max_delay",
  "timezone",
  "runner_every",
];

const configResolve: Command = {
  name: "config resolve",
  summary: "Show the settings a task resolves to and where each one comes from",
  usage: `Usage: agent-tasks config resolve <task-id|path>

Resolves agent, launcher, skill, environment, instructions, timeouts and
schedule settings for a task, applying the precedence
task > first matching profile > config.json > built-in defaults.

Arguments:
  <task-id|path>  The id of a saved task, or the path of a task JSON file`,
  run(ctx, args) {
    const { positionals } = parseCommandArgs(args, {}, { minPositionals: 1, maxPositionals: 1 });
    const { task, file } = loadTask(ctx, positionals[0]!);
    const resolution = ctx.resolveFor(task);
    const { config } = ctx;
    const { sources, ...values } = resolution;
    output(
      ctx,
      {
        task_id: task.id,
        task_file: file,
        cwd: task.cwd,
        config_file: config.file,
        config_exists: config.exists,
        profile: resolution.profile,
        values,
        sources,
      },
      () => {
        const width = Math.max(...KEYS.map((k) => k.length));
        const rows = KEYS.map((k) => ({ key: k, value: formatValue(k, resolution, ctx), source: sources[k] }));
        const valueWidth = Math.min(48, Math.max(...rows.map((r) => r.value.length)));
        const lines = [
          `Task:    ${task.id} (${task.cwd})`,
          `Config:  ${tildify(config.file, ctx.env)}${config.exists ? "" : " (not found, using defaults)"}`,
          `Profile: ${resolution.profile ?? "(none matched)"}`,
          "",
          ...rows.map((r) => `${r.key.padEnd(width)}  ${r.value.padEnd(valueWidth)}  ${r.source}`),
        ];
        return lines.join("\n");
      },
    );
  },
};

export default configResolve;
