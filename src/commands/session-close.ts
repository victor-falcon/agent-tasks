import { parseCommandArgs } from "../args.ts";
import { output } from "../context.ts";
import { closeSession, LauncherError } from "../launcher.ts";
import { commandEnv, loadSession, stamp, updateRun } from "../execution.ts";
import type { SessionRecord } from "../execution.ts";
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
    const result = closeSession(s.spec, s.input, commandEnv(s.input));
    if (!result) throw new LauncherError(`the ${s.spec.name} launcher has no close command`);
    if (!result.ok) throw new LauncherError(result.error ?? "close failed");
    const at = stamp(ctx, s.resolution.timezone);
    updateRun(ctx, ref, (r) => {
      const record = r.attempts[s.attempt.n - 1]!.session as unknown as SessionRecord;
      record.closed_at = at;
      record.kept_open = false;
      record.close_error = null;
      r.events.push({ at, event: "closed", attempt: s.attempt.n, by: "session close" });
    });
    output(ctx, { run_ref: ref, attempt: s.attempt.n, handle: s.record.handle, closed: true }, `Closed session ${s.record.handle} of ${ref}.`);
  },
};

export default sessionClose;
