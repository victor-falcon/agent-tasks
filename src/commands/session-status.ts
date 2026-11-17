import { parseCommandArgs } from "../args.ts";
import { output } from "../context.ts";
import { LauncherError } from "../launcher.ts";
import { loadSession } from "../execution.ts";
import type { Command } from "./types.ts";

const sessionStatusCommand: Command = {
  name: "session status",
  summary: "Ask the launcher for the state of a run's session",
  usage: `Usage: agent-tasks session status <run_ref>

Runs the launcher's \`status\` on the session of the run's latest attempt and
prints its state: working, idle, blocked, exited or gone.

Arguments:
  <run_ref>  <task-id>/<slot>, e.g. weekly-report/20261117T080000Z`,
  run(ctx, args) {
    const { positionals } = parseCommandArgs(args, {}, { minPositionals: 1, maxPositionals: 1 });
    const ref = positionals[0]!;
    const s = loadSession(ctx, ref);
    const status = s.ops.status();
    if (!status) throw new LauncherError(`the ${s.ops.launcherName} launcher has no status command`);
    output(
      ctx,
      {
        run_ref: ref,
        attempt: s.attempt.n,
        launcher: s.ops.launcherName,
        machine: s.record.machine ?? null,
        handle: s.record.handle,
        state: status.state,
        raw: status.raw,
        closed_at: s.record.closed_at,
        kept_open: s.record.kept_open ?? false,
      },
      `${ref}: ${status.state} (session ${s.record.handle}, ${s.ops.launcherName}${s.record.machine ? ` on ${s.record.machine}` : ""})`,
    );
  },
};

export default sessionStatusCommand;
