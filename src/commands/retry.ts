import { parseCommandArgs } from "../args.ts";
import { output } from "../context.ts";
import { UsageError } from "../errors.ts";
import { readRunRef, requireTask, startAttempt } from "../execution.ts";
import type { RunStatus } from "../schema.ts";
import { formatEvent } from "../tick.ts";
import type { Command } from "./types.ts";

const RETRYABLE: readonly RunStatus[] = ["failed", "timed_out", "missed"];

const retry: Command = {
  name: "retry",
  summary: "Launch a new attempt of a failed, timed-out or missed run",
  usage: `Usage: agent-tasks retry <run_ref>

Adds an attempt to the occurrence and launches it right away.

Arguments:
  <run_ref>  <task-id>/<slot>, e.g. weekly-report/20261117T080000Z`,
  run(ctx, args) {
    const { positionals } = parseCommandArgs(args, {}, { minPositionals: 1, maxPositionals: 1 });
    const ref = positionals[0]!;
    const task = requireTask(ctx, readRunRef(ctx, ref).task_id);
    // Checked under the run's lock, in the same write that adds the attempt, so two retries never launch twice.
    const events = startAttempt(ctx, task, ref, {
      by: "retry",
      precheck: (r) => {
        if (!RETRYABLE.includes(r.status)) throw new UsageError(`${ref} is ${r.status}; only ${RETRYABLE.join(", ")} runs can be retried`);
      },
    });
    output(ctx, { run_ref: ref, events }, () => events.map(formatEvent).join("\n"));
    return events.some((e) => e.type === "failed") ? 1 : 0;
  },
};

export default retry;
