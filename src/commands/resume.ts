import { parseCommandArgs } from "../args.ts";
import { setEnabled } from "../task-toggle.ts";
import type { Command } from "./types.ts";

const resume: Command = {
  name: "resume",
  summary: "Resume a paused task",
  usage: `Usage: agent-tasks resume <id>

Sets enabled to true. Slots before now are ignored, so the time the task
was paused doesn't show up as missed runs.`,
  run(ctx, args) {
    const { positionals } = parseCommandArgs(args, {}, { minPositionals: 1, maxPositionals: 1 });
    setEnabled(ctx, positionals[0]!, true);
  },
};

export default resume;
