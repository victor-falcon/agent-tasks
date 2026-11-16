import { parseCommandArgs } from "../args.ts";
import { output } from "../context.ts";
import { formatEvent, tick } from "../tick.ts";
import type { Command } from "./types.ts";

const tickCommand: Command = {
  name: "tick",
  summary: "Run one scheduler pass: watch, reconcile, launch",
  usage: `Usage: agent-tasks tick

One pass of the scheduler, as the runner does every few minutes:
  1. watches running and blocked runs (blocked, exited without finish,
     timeout, sessions left open, retries);
  2. records slots nobody will run (missed, superseded, cancelled);
  3. launches what is due;
  4. appends a heartbeat line to state/ticks.jsonl.

Prints what happened, or the list of events with --json.`,
  run(ctx, args) {
    parseCommandArgs(args, {}, { maxPositionals: 0 });
    const result = tick(ctx, { mode: "manual" });
    output(ctx, result, () => (result.events.length === 0 ? "Nothing to do." : result.events.map(formatEvent).join("\n")));
  },
};

export default tickCommand;
