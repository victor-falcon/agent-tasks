import { parseCommandArgs } from "../args.ts";
import { setEnabled } from "../task-toggle.ts";
import type { Command } from "./types.ts";

const pause: Command = {
  name: "pause",
  summary: "Pause a task (its slots are recorded as cancelled)",
  usage: `Usage: agent-tasks pause <id>

Sets enabled to false. While paused, the runner records each slot as
cancelled (reason: paused). Undo with "agent-tasks resume <id>".`,
  run(ctx, args) {
    const { positionals } = parseCommandArgs(args, {}, { minPositionals: 1, maxPositionals: 1 });
    setEnabled(ctx, positionals[0]!, false);
  },
};

export default pause;
