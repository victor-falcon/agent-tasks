import { parseCommandArgs } from "../args.ts";
import { output } from "../context.ts";
import { LauncherError, sessionStatus } from "../launcher.ts";
import { commandEnv, loadSession } from "../execution.ts";
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
    const status = sessionStatus(s.spec, s.input, commandEnv(s.input));
    if (!status) throw new LauncherError(`the ${s.spec.name} launcher has no status command`);
    output(
      ctx,
      { run_ref: ref, attempt: s.attempt.n, launcher: s.spec.name, handle: s.record.handle, state: status.state, raw: status.raw, closed_at: s.record.closed_at, kept_open: s.record.kept_open ?? false },
      `${ref}: ${status.state} (session ${s.record.handle}, ${s.spec.name})`,
    );
  },
};

export default sessionStatusCommand;
