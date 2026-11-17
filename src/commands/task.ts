import { parseCommandArgs } from "../args.ts";
import { output } from "../context.ts";
import { taskContext } from "../task-context.ts";
import type { Command } from "./types.ts";

const task: Command = {
  name: "task",
  summary: "Print what a subagent must do for a run, and how to finish it",
  usage: `Usage: agent-tasks task <run_ref>

Called by the subagent when it starts. Prints the task's title, slot,
attempt, working directory, instructions, the user's personal instructions
(instructions.subagent and the matching profile's) and the exact finish
command. The text can be replaced with templates/task.md in the config folder.

Arguments:
  <run_ref>  <task-id>/<slot>, e.g. weekly-report/20261117T080000Z`,
  run(ctx, args) {
    const { positionals } = parseCommandArgs(args, {}, { minPositionals: 1, maxPositionals: 1 });
    const result = taskContext(ctx, positionals[0]!);
    for (const file of result.missing_instructions) ctx.stderr.write(`agent-tasks: warning: instructions file not found: ${file}\n`);
    for (const warning of result.warnings) ctx.stderr.write(`agent-tasks: warning: ${warning}\n`);
    output(ctx, result, result.text);
  },
};

export default task;
