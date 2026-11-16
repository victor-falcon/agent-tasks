import { parseCommandArgs } from "../args.ts";
import { formatSource, type Resolution } from "../config.ts";
import { output } from "../context.ts";
import { describeNext, describeSchedule, findTask, runView, type RunView, table, type TaskOverview, taskOverview, warnCorrupt } from "../task-info.ts";
import { formatInZone } from "../time.ts";
import type { Command } from "./types.ts";


const RECENT = 10;

function formatAgent(agent: Resolution["agent"]): string {
  return [agent.command, ...agent.args].join(" ") + (agent.shell ? " (shell)" : "");
}

/** Plain text. Kept apart so the phase-2 renderer can replace it. */
export function renderTask({ task, state, resolution, next }: TaskOverview, recent: readonly RunView[]): string {
  const { sources } = resolution;
  const tz = resolution.timezone;
  const setting = (key: keyof typeof sources, value: string) => [key, value, formatSource(sources[key])];
  const indent = (text: string) => text.replace(/^/gm, "  ");
  return [
    `${task.title} (${task.id}) — ${state}`,
    ...(task.description ? [task.description] : []),
    "",
    `cwd:          ${task.cwd}`,
    `schedule:     ${describeSchedule(task)}`,
    `created:      ${task.created_at}${task.created_by?.session ? ` from terminal ${task.created_by.session}` : ""}`,
    `updated:      ${task.updated_at}`,
    ...(task.schedule_since ? [`slots from:   ${task.schedule_since}`] : []),
    "",
    "Resolved settings:",
    indent(
      table([
        ["SETTING", "VALUE", "SOURCE"],
        setting("agent", formatAgent(resolution.agent)),
        setting("launcher", JSON.stringify(resolution.launcher)),
        setting("skill", resolution.skill),
        setting("catch_up", resolution.catch_up),
        setting("max_delay", resolution.max_delay),
        setting("timeout", resolution.timeout),
        setting("retries", String(resolution.retries)),
        setting("keep_open", resolution.keep_open),
        setting("timezone", tz),
      ]),
    ),
    "",
    "Instructions:",
    indent(task.instructions),
    "",
    describeNext({ next, state, resolution }),
    "",
    recent.length === 0
      ? "Last occurrences: none"
      : `Last occurrences:\n${indent(
          table([
            ["SLOT", "TRIGGER", "STATUS", "REASON", "SUMMARY"],
            ...recent.map((r) => [formatInZone(new Date(r.slot), tz), r.trigger, r.status, r.reason ?? "-", r.summary ?? "-"]),
          ]),
        )}`,
  ].join("\n");
}

const show: Command = {
  name: "show",
  summary: "Show a task's definition, resolved settings and latest occurrences",
  usage: `Usage: agent-tasks show <id>

Prints the task definition, the agent, launcher, skill and run settings it
resolves to (and where each one comes from), the next 3 runs and the last
${RECENT} occurrences. Archived tasks can be shown too.`,
  run(ctx, args) {
    const { positionals } = parseCommandArgs(args, {}, { minPositionals: 1, maxPositionals: 1 });
    const { task, archived } = findTask(ctx, positionals[0]!);
    const overview = taskOverview(ctx, task, { archived });
    const recent = overview.runs.slice(-RECENT).reverse().map(runView);
    const { sources, profile, ...resolved } = overview.resolution;

    warnCorrupt(ctx, overview.errors);
    output(
      ctx,
      { task, state: overview.state, resolved, profile, sources, next_runs: overview.next, runs: recent, errors: overview.errors.map((e) => e.message) },
      () => renderTask(overview, recent),
    );
  },
};

export default show;
