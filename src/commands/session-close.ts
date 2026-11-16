import { parseCommandArgs } from "../args.ts";
import { output } from "../context.ts";
import { LauncherError } from "../launcher.ts";
import { loadSession, settleSession } from "../execution.ts";
import type { Command } from "./types.ts";

const sessionClose: Command = {
  name: "session close",
  summary: "Close a run's session through the launcher",
  usage: `Usage: agent-tasks session close <run_ref>

Runs the launcher's \`close\` on the session of the run's latest attempt, also
when \`keep_open\` kept it open. The run's status does not change.

Arguments:
  <run_ref>  <task-id>/<slot>, e.g. weekly-report/20261117T080000Z`,
  run(ctx, args) {
    const { positionals } = parseCommandArgs(args, {}, { minPositionals: 1, maxPositionals: 1 });
    const ref = positionals[0]!;
    const s = loadSession(ctx, ref);
    if (!s.spec.close) throw new LauncherError(`the ${s.spec.name} launcher has no close command`);
    const result = settleSession(ctx, s.task, ref, { force: true });
    if (result.action === "close_failed") throw new LauncherError(result.error);
    output(ctx, { run_ref: ref, attempt: s.attempt.n, handle: s.record.handle, closed: true }, `Closed session ${s.record.handle} of ${ref}.`);
  },
};

export default sessionClose;
