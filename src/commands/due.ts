import { parseCommandArgs } from "../args.ts";
import { output } from "../context.ts";
import type { SlotRef } from "../schedule.ts";
import { listRuns, listTasks } from "../store.ts";
import { planTask, warnCorrupt } from "../task-info.ts";
import { formatInZone } from "../time.ts";
import type { Command } from "./types.ts";

interface DueSlot {
  slot: string;
  id: string;
  reason?: string;
}

interface DueTask {
  task_id: string;
  candidates: DueSlot[];
  missed: DueSlot[];
  superseded: DueSlot[];
  cancelled: DueSlot[];
}

const KINDS = ["candidates", "missed", "superseded", "cancelled"] as const;
const LABELS: Record<(typeof KINDS)[number], string> = {
  candidates: "would launch",
  missed: "would mark missed",
  superseded: "would mark superseded",
  cancelled: "would mark cancelled",
};

const due: Command = {
  name: "due",
  summary: "Show what tick would do now, without changing anything",
  usage: `Usage: agent-tasks due

For each task, lists the slots that tick would launch now and the ones it
would record as missed, superseded or cancelled. Reads tasks, runs and the
heartbeat; writes nothing.`,
  run(ctx, args) {
    parseCommandArgs(args, {}, { maxPositionals: 0 });
    const tasks = listTasks(ctx.paths);
    const errors: Error[] = [...tasks.errors];
    const result: DueTask[] = [];
    for (const task of tasks.items) {
      const runs = listRuns(ctx.paths, task.id);
      errors.push(...runs.errors);
      const resolution = ctx.resolveFor(task);
      const plan = planTask(ctx.paths, task, resolution, ctx.now, runs.items);
      const view = (s: SlotRef & { reason?: string }): DueSlot => ({ slot: formatInZone(s.at, resolution.timezone), id: s.id, ...(s.reason ? { reason: s.reason } : {}) });
      const entry: DueTask = {
        task_id: task.id,
        candidates: plan.candidates.map(view),
        missed: plan.missed.map(view),
        superseded: plan.superseded.map(view),
        cancelled: plan.cancelled.map(view),
      };
      if (KINDS.some((k) => entry[k].length > 0)) result.push(entry);
    }
    const totals = Object.fromEntries(KINDS.map((k) => [k, result.reduce((n, t) => n + t[k].length, 0)]));

    warnCorrupt(ctx, errors);
    output(ctx, { now: ctx.now.toISOString(), tasks: result, totals, errors: errors.map((e) => e.message) }, () => {
      if (result.length === 0) return "Nothing due.";
      const lines: string[] = [];
      for (const t of result) {
        lines.push(`${t.task_id}:`);
        for (const k of KINDS) for (const s of t[k]) lines.push(`  ${LABELS[k].padEnd(21)}  ${s.slot}${s.reason ? `  (${s.reason})` : ""}`);
      }
      return lines.join("\n");
    });
  },
};

export default due;
