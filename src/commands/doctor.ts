import { parseCommandArgs } from "../args.ts";
import { checksJson, hasErrors, renderChecks } from "../checks.ts";
import { output } from "../context.ts";
import { doctorChecks } from "../doctor.ts";
import { DEFAULT_SKILLS_DIR, installDirs } from "../install.ts";
import type { Command } from "./types.ts";

const doctor: Command = {
  name: "doctor",
  summary: "Check that this machine is ready to run scheduled tasks",
  usage: `Usage: agent-tasks doctor [--skills-dir <dir>]

Checks, one line each (✓ ok, ! warning, ✕ error, with how to fix it):
  - bun is on PATH, and so is agent-tasks (pointing at this checkout);
  - everything "agent-tasks config check" checks: the config, templates,
    instruction files, and that the launcher and agent commands exist
    (hc for the herdr preset);
  - the data dir is writable and its task files can be read;
  - for launchers that need a Herdr terminal, that $HC_TERMINAL_ID is set;
  - the skills are installed (agent-tasks install), and so is any skill the
    config names;
  - the runner's heartbeat (state/ticks.jsonl): a warning if there is none
    yet or it is older than 3 × runner.every (at least 15m);
  - on a hub with \`machines\`: each one answers over SSH (remote ping) with
    the same protocol, calls itself by its registry name, is a client and
    has a launcher that is ready ("agent-tasks machines check"). An
    unreachable machine is a warning: machines sleep.

On a client (config with \`hub\`), the data and heartbeat checks are the
hub's and are left out; instead: the hub answers over SSH with the same
protocol, and the hub reaches this machine back.

Exits with 1 when any check is an error; warnings don't change the exit code.

Options:
  --skills-dir <dir>  Where the skills should be (default ${DEFAULT_SKILLS_DIR})`,
  run(ctx, args) {
    const { values } = parseCommandArgs(args, { "skills-dir": { type: "string" } }, { maxPositionals: 0 });
    const checks = doctorChecks(ctx, installDirs(ctx.env, { skillsDir: values["skills-dir"] }, ctx.cwd));
    output(ctx, checksJson(checks), () => renderChecks(checks));
    return hasErrors(checks) ? 1 : 0;
  },
};

export default doctor;
