import { parseCommandArgs } from "../args.ts";
import { output } from "../context.ts";
import { AgentTasksError } from "../errors.ts";
import { newRun, stamp, startAttempt } from "../execution.ts";
import { runRef, runSlotId } from "../slot.ts";
import { claimRun, readTask } from "../store.ts";
import { formatEvent } from "../tick.ts";
import type { Command } from "./types.ts";

const run: Command = {
  name: "run",
  summary: "Run a task now (manual run), outside its schedule",
  usage: `Usage: agent-tasks run <task-id>

Creates a manual occurrence (trigger: manual, slot manual-<time>) and
launches it right away with the task's launcher. Works for paused tasks too.

Arguments:
  <task-id>  The id of a saved task`,
  run(ctx, args) {
    const { positionals } = parseCommandArgs(args, {}, { minPositionals: 1, maxPositionals: 1 });
    const task = readTask(ctx.paths, positionals[0]!);
    const resolution = ctx.resolveFor(task);
    const occurrence = newRun(task.id, ctx.now, resolution.timezone, "manual", "running", null, { event: "claimed", by: "run" }, stamp(ctx, resolution.timezone));
    const ref = runRef(task.id, runSlotId(occurrence));
    if (!claimRun(ctx.paths, occurrence)) throw new AgentTasksError("conflict", `${ref} already exists: a manual run of ${task.id} started this same second`);
    const events = startAttempt(ctx, task, ref, "run");
    output(ctx, { run_ref: ref, events }, () => events.map(formatEvent).join("\n"));
    return events.some((e) => e.type === "failed") ? 1 : 0;
  },
};

export default run;
