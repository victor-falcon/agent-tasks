import { existsSync, readFileSync } from "node:fs";
import { parseCommandArgs } from "../args.ts";
import { formatSource, type LauncherConfig, type Resolution, type Source } from "../config.ts";
import { type Context, output } from "../context.ts";
import { runnerBanner } from "../output/banner.ts";
import { renderRunsTable } from "../output/runs-table.ts";
import { scheduleText } from "../output/schedule-text.ts";
import { stdoutStyle, type Style } from "../output/style.ts";
import { paintMark, TASK_MARKS, taskMarkKind } from "../output/symbols.ts";
import { renderTable } from "../output/table.ts";
import { absoluteTime, whenTime } from "../output/time.ts";
import { tildify } from "../paths.ts";
import type { StoredRun } from "../store.ts";
import { describeSchedule, displayTimezone, findTask, runView, type TaskOverview, taskOverview, warnCorrupt } from "../task-info.ts";
import type { Command } from "./types.ts";

const RECENT = 10;

export function formatAgent(agent: Resolution["agent"]): string {
  return [agent.command, ...agent.args].join(" ") + (agent.shell ? " (shell)" : "");
}

/** `herdr`, `herdr (launch, close overridden)`, or `custom (launch, close)`. */
export function formatLauncher(launcher: LauncherConfig): string {
  const commands = Object.keys(launcher).filter((k) => k !== "preset");
  if (launcher.preset === undefined) return `custom (${commands.join(", ") || "no commands"})`;
  return commands.length === 0 ? launcher.preset : `${launcher.preset} (${commands.join(", ")} overridden)`;
}

/** The personal instruction files, each with where it was configured. */
export interface PersonalInstructions {
  path: string;
  source: string;
  /** Null when the file does not exist. */
  content: string | null;
}

function personalInstructions(ctx: Context, resolution: Resolution): PersonalInstructions[] {
  const fromConfig = ctx.config.config.instructions?.subagent?.length ?? 0;
  return resolution.instructions.map((path, i) => ({
    path,
    source: i < fromConfig ? "config" : `profile ${resolution.profile}`,
    content: existsSync(path) ? readFileSync(path, "utf8") : null,
  }));
}

/** The task's instructions followed by the personal ones, each under a heading that says where it comes from. */
export function instructionsText(ctx: Context, overview: TaskOverview, personal: readonly PersonalInstructions[]): string {
  const { task } = overview;
  const sections = [`# Task: ${task.title} (${task.id})\n\n${task.instructions.trimEnd()}`];
  for (const p of personal) {
    const body = p.content === null ? "(file not found)" : p.content.trimEnd();
    sections.push(`# Personal instructions (${p.source}): ${tildify(p.path, ctx.env)}\n\n${body}`);
  }
  return sections.join("\n\n");
}

interface ShowView {
  overview: TaskOverview;
  recent: StoredRun[];
  personal: PersonalInstructions[];
}

/** Definition, resolved settings with their sources, next runs and the latest occurrences. */
export function renderTask(ctx: Context, style: Style, { overview, recent, personal }: ShowView): string {
  const { task, state, resolution, next } = overview;
  const { sources } = resolution;
  const tz = displayTimezone(ctx);
  const now = ctx.now;
  const from = (source: Source) => style.paint("dim", `← ${formatSource(source)}`);
  const setting = (label: string, key: keyof typeof sources, value: string) => [label, value, from(sources[key])];
  const mark = TASK_MARKS[taskMarkKind(state, task.schedule.type === "once", overview.runs.map((r) => r.run.status))];
  const missing = personal.filter((p) => p.content === null).length;
  const instructionsValue =
    personal.length === 0
      ? "task only"
      : `task + ${personal.length} personal file${personal.length === 1 ? "" : "s"}${missing > 0 ? ` (${missing} missing)` : ""}`;

  const definition = renderTable(
    [
      ["Folder", task.cwd, ""],
      ["Schedule", `${scheduleText(task.schedule, resolution.timezone, now)}  ${style.paint("dim", `(${describeSchedule(task)})`)}`, ""],
      setting("Time zone", "timezone", resolution.timezone),
      setting("Grace", "max_delay", `${resolution.max_delay} (later than this, a slot is missed)`),
      setting("Catch up", "catch_up", resolution.catch_up),
      setting("Timeout", "timeout", resolution.timeout),
      setting("Retries", "retries", String(resolution.retries)),
      setting("Keep open", "keep_open", resolution.keep_open),
      [],
      setting("Agent", "agent", formatAgent(resolution.agent)),
      setting("Launcher", "launcher", formatLauncher(resolution.launcher)),
      setting("Skill", "skill", resolution.skill),
      setting("Instructions", "instructions", instructionsValue),
      ...(Object.keys(resolution.env).length > 0 ? [setting("Env", "env", Object.keys(resolution.env).join(", "))] : []),
      [],
      ["Created", `${absoluteTime(new Date(task.created_at), tz, now)}${task.created_by?.session ? ` from terminal ${task.created_by.session}` : ""}`, ""],
      ["Updated", absoluteTime(new Date(task.updated_at), tz, now), ""],
    ],
    { header: false },
  );

  const nextText =
    next.length === 0
      ? `Next runs: none (${state})`
      : `Next runs\n${renderTable(
          next.map((iso) => [absoluteTime(new Date(iso), tz, now), style.paint("dim", whenTime(new Date(iso), tz, now))]),
          { header: false, indent: "  " },
        )}`;
  const recentText =
    recent.length === 0
      ? "Last occurrences: none"
      : `Last ${recent.length === 1 ? "occurrence" : `${recent.length} occurrences`}\n${renderRunsTable(recent, {
          style,
          timezone: tz,
          now,
          showRef: true,
          maxAttempts: () => resolution.retries + 1,
          indent: "  ",
        })}`;

  return [
    `${paintMark(style, mark)} ${style.paint("bold", task.title)} (${task.id}) · ${state}`,
    ...(task.description ? [task.description] : []),
    "",
    definition,
    "",
    nextText,
    "",
    recentText,
    "",
    style.paint("dim", `Instructions as the agent gets them: agent-tasks show ${task.id} --instructions`),
  ].join("\n");
}

const show: Command = {
  name: "show",
  summary: "Show a task's definition, resolved settings and latest occurrences",
  usage: `Usage: agent-tasks show <id> [--instructions]

Prints the task definition, the agent, launcher, skill and run settings it
resolves to and where each one comes from (task, profile, config or the
built-in default), the next 3 runs and the last ${RECENT} occurrences.
Archived tasks can be shown too.

Options:
  --instructions  Print only the instructions: the task's, then the personal
                  files from the config (instructions.subagent) and from the
                  matching profile, in the order the agent reads them`,
  run(ctx, args) {
    const { values, positionals } = parseCommandArgs(args, { instructions: { type: "boolean" } }, { minPositionals: 1, maxPositionals: 1 });
    const { task, archived } = findTask(ctx, positionals[0]!);
    const overview = taskOverview(ctx, task, { archived });
    const personal = personalInstructions(ctx, overview.resolution);

    if (values.instructions) {
      for (const p of personal.filter((p) => p.content === null)) {
        if (!ctx.json) ctx.stderr.write(`warning: instructions file not found: ${p.path}\n`);
      }
      const text = instructionsText(ctx, overview, personal);
      output(ctx, { task_id: task.id, instructions: task.instructions, personal, text }, text);
      return;
    }

    const recent = overview.runs.slice(-RECENT).reverse();
    const { sources, profile, ...resolved } = overview.resolution;
    runnerBanner(ctx);
    warnCorrupt(ctx, overview.errors);
    output(
      ctx,
      {
        task,
        state: overview.state,
        resolved,
        profile,
        sources,
        next_runs: overview.next,
        runs: recent.map(runView),
        errors: overview.errors.map((e) => e.message),
      },
      () => renderTask(ctx, stdoutStyle(ctx), { overview, recent, personal }),
    );
  },
};

export default show;
