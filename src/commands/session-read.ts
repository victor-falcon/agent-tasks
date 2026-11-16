import { parseCommandArgs } from "../args.ts";
import { output } from "../context.ts";
import { LauncherError, readSession } from "../launcher.ts";
import { loadSession } from "../execution.ts";
import type { Command } from "./types.ts";

const sessionRead: Command = {
  name: "session read",
  summary: "Print the last lines of a run's session, through the launcher",
  usage: `Usage: agent-tasks session read <run_ref>

Runs the launcher's \`read\` on the session of the run's latest attempt.

Arguments:
  <run_ref>  <task-id>/<slot>, e.g. weekly-report/20261117T080000Z`,
  run(ctx, args) {
    const { positionals } = parseCommandArgs(args, {}, { minPositionals: 1, maxPositionals: 1 });
    const ref = positionals[0]!;
    const s = loadSession(ctx, ref);
    const text = readSession(s.spec, s.input);
    if (text === null) throw new LauncherError(`the ${s.spec.name} launcher has no read command`);
    output(ctx, { run_ref: ref, attempt: s.attempt.n, handle: s.record.handle, output: text }, text);
  },
};

export default sessionRead;
