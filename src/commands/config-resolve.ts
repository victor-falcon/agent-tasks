import { parseCommandArgs } from "../args.ts";
import { formatSource, type Resolution, type ResolvedKey } from "../config.ts";
import { type Context, output } from "../context.ts";
import { resolvePath, tildify } from "../paths.ts";
import { loadTaskArg } from "../store.ts";
import type { Command } from "./types.ts";

/** How each resolved value is shown, in display order. Typed so a new key cannot be forgotten. */
const FORMATTERS: Record<ResolvedKey, (r: Resolution, ctx: Context) => string> = {
  agent: (r) => [r.agent.command, ...r.agent.args].join(" ") + (r.agent.shell ? " (shell)" : ""),
  launcher: (r) => JSON.stringify(r.launcher),
  skill: (r) => r.skill,
  env: (r) => Object.entries(r.env).map(([k, v]) => `${k}=${v}`).join(" ") || "(none)",
  instructions: (r, ctx) => r.instructions.map((f) => tildify(f, ctx.env)).join(", ") || "(none)",
  timeout: (r) => r.timeout,
  keep_open: (r) => r.keep_open,
  retries: (r) => String(r.retries),
  catch_up: (r) => r.catch_up,
  max_delay: (r) => r.max_delay,
  timezone: (r) => r.timezone,
  runner_every: (r) => r.runner_every,
};

const configResolve: Command = {
  name: "config resolve",
  summary: "Show the settings a task resolves to and where each one comes from",
  usage: `Usage: agent-tasks config resolve <task-id|path>

Resolves agent, launcher, skill, environment, instructions, timeouts and
schedule settings for a task, applying the precedence
task > first matching profile > config.json > built-in defaults.

Arguments:
  <task-id|path>  The id of a saved task, or the path of a task JSON file
                  (anything containing "/" or ending in .json)`,
  run(ctx, args) {
    const { positionals } = parseCommandArgs(args, {}, { minPositionals: 1, maxPositionals: 1 });
    const { task, file } = loadTaskArg(ctx.paths, positionals[0]!, (p) => resolvePath(p, ctx.env, ctx.cwd));
    const resolution = ctx.resolveFor(task);
    const { config } = ctx;
    const { sources, profile, ...values } = resolution;
    output(
      ctx,
      {
        task_id: task.id,
        task_file: file,
        cwd: task.cwd,
        config_file: config.file,
        config_exists: config.exists,
        profile,
        values,
        sources,
      },
      () => {
        const rows = (Object.keys(FORMATTERS) as ResolvedKey[]).map((key) => ({
          key,
          value: FORMATTERS[key](resolution, ctx),
          source: formatSource(sources[key]),
        }));
        const keyWidth = Math.max(...rows.map((r) => r.key.length));
        const valueWidth = Math.min(48, Math.max(...rows.map((r) => r.value.length)));
        return [
          `Task:    ${task.id} (${task.cwd})`,
          `Config:  ${tildify(config.file, ctx.env)}${config.exists ? "" : " (not found, using defaults)"}`,
          `Profile: ${resolution.profile ?? "(none matched)"}`,
          "",
          ...rows.map((r) => `${r.key.padEnd(keyWidth)}  ${r.value.padEnd(valueWidth)}  ${r.source}`),
        ].join("\n");
      },
    );
  },
};

export default configResolve;
