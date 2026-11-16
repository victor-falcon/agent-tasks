import { parseCommandArgs } from "../args.ts";
import { formatSource } from "../config.ts";
import { output } from "../context.ts";
import { latestRuns, listRuns } from "../store.ts";
import { findTask, nextRuns, runView, table, taskState, warnCorrupt } from "../task-info.ts";
import { formatInZone } from "../time.ts";
import type { Command } from "./types.ts";

const show: Command = {
  name: "show",
  summary: "Show a task's definition, resolved settings and latest occurrences",
  usage: `Usage: agent-tasks show <id>

Prints the task definition, the agent, launcher, skill and run settings it
resolves to (and where each one comes from), the next 3 runs and the last
10 occurrences. Archived tasks can be shown too.`,
  run(ctx, args) {
    const { positionals } = parseCommandArgs(args, {}, { minPositionals: 1, maxPositionals: 1 });
    const { task, archived } = findTask(ctx, positionals[0]!);
    const all = listRuns(ctx.paths, task.id);
    const state = taskState(task, all.items.map((r) => r.run), archived);
    const resolution = ctx.resolveFor(task);
    const next = nextRuns(task, state, resolution, ctx.now, 3);
    const recent = latestRuns(ctx.paths, task.id, 10).items.map(runView);
    const { sources, profile, ...resolved } = resolution;
    const tz = resolution.timezone;

    warnCorrupt(ctx, all.errors);
    output(ctx, { task, state, resolved, profile, sources, next_runs: next, runs: recent, errors: all.errors.map((e) => e.message) }, () => {
      const s = task.schedule;
      const lines = [
        `${task.title} (${task.id}) — ${state}`,
        ...(task.description ? [task.description] : []),
        "",
        `cwd:          ${task.cwd}`,
        `schedule:     ${s.type === "once" ? `once at ${s.at}` : `cron "${s.cron}"${s.timezone ? ` in ${s.timezone}` : ""}${s.starts_at ? `, from ${s.starts_at}` : ""}${s.until ? `, until ${s.until}` : ""}`}`,
        `created:      ${task.created_at}${task.created_by?.session ? ` from terminal ${task.created_by.session}` : ""}`,
        `updated:      ${task.updated_at}`,
        ...(task.schedule_since ? [`schedule set: ${task.schedule_since}`] : []),
        "",
        "Resolved settings:",
        table([
          ["SETTING", "VALUE", "SOURCE"],
          ["agent", [resolution.agent.command, ...resolution.agent.args].join(" ") + (resolution.agent.shell ? " (shell)" : ""), formatSource(sources.agent)],
          ["launcher", JSON.stringify(resolution.launcher), formatSource(sources.launcher)],
          ["skill", resolution.skill, formatSource(sources.skill)],
          ["catch_up", resolution.catch_up, formatSource(sources.catch_up)],
          ["max_delay", resolution.max_delay, formatSource(sources.max_delay)],
          ["timeout", resolution.timeout, formatSource(sources.timeout)],
          ["retries", String(resolution.retries), formatSource(sources.retries)],
          ["keep_open", resolution.keep_open, formatSource(sources.keep_open)],
          ["timezone", tz, formatSource(sources.timezone)],
        ]).replace(/^/gm, "  "),
        "",
        "Instructions:",
        task.instructions.replace(/^/gm, "  "),
        "",
        next.length > 0 ? `Next runs:\n${next.map((t) => `  ${t}`).join("\n")}` : "Next runs: none",
        "",
        recent.length > 0
          ? `Last occurrences:\n${table([
              ["SLOT", "TRIGGER", "STATUS", "REASON", "SUMMARY"],
              ...recent.map((r) => [formatInZone(new Date(r.slot), tz), r.trigger, r.status, r.reason ?? "-", r.summary ?? "-"]),
            ]).replace(/^/gm, "  ")}`
          : "Last occurrences: none",
      ];
      return lines.join("\n");
    });
  },
};

export default show;
