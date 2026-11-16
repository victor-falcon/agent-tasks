import { join } from "node:path";
import { parseCommandArgs } from "../args.ts";
import { findProfile } from "../config.ts";
import { output } from "../context.ts";
import { UsageError } from "../errors.ts";
import { resolvePath } from "../paths.ts";
import { loadPersonalInstructions, personalSection } from "../task-context.ts";
import type { Command } from "./types.ts";

const ROLES = ["subagent", "supervisor"] as const;
type Role = (typeof ROLES)[number];

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

const configInstructions: Command = {
  name: "config instructions",
  summary: "Print the personal instructions added for a subagent or the supervisor",
  usage: `Usage: agent-tasks config instructions <subagent|supervisor> [--cwd <dir>]

Prints the personal instructions from the config folder that agent-tasks
adds for that role, in the same form the agent reads them:
  subagent    instructions.subagent, plus the instructions of the first
              profile that matches --cwd (default: the current folder)
  supervisor  instructions.supervisor

<!-- … --> comments are left out; a file with only comments adds nothing.
For subagent, the text has the "User instructions" header the subagent sees
in "agent-tasks task"; for supervisor, it is the files' content as is.

Options:
  --cwd <dir>  Folder of a task, to pick its profile (subagent only)`,
  run(ctx, args) {
    const { values, positionals } = parseCommandArgs(args, { cwd: { type: "string" } }, { minPositionals: 1, maxPositionals: 1 });
    const role = positionals[0]!;
    if (!isRole(role)) throw new UsageError(`unknown role "${role}" (use: ${ROLES.join(", ")})`);
    if (role === "supervisor" && values.cwd !== undefined) throw new UsageError("--cwd only applies to subagent");
    const loaded = ctx.config;
    const dir = join(loaded.dir, "instructions");
    const cwd = role === "subagent" ? resolvePath(values.cwd ?? ".", ctx.env, ctx.cwd) : null;
    const profile = cwd ? findProfile(loaded.config, cwd, ctx.env) : null;
    const names = [...(loaded.config.instructions?.[role] ?? []), ...(profile?.instructions ?? [])];
    const files = names.map((f) => resolvePath(f, ctx.env, dir));
    const { personal, missing } = loadPersonalInstructions(files);
    for (const file of missing) ctx.stderr.write(`agent-tasks: warning: instructions file not found: ${file}\n`);
    const text = role === "subagent" ? personalSection(personal) : personal.map((p) => p.content).join("\n\n");
    output(
      ctx,
      { role, cwd, profile: profile?.match ?? null, files, missing, instructions: personal, text },
      () => text || `(no personal ${role} instructions${files.length === 0 ? "; none configured" : ""})`,
    );
  },
};

export default configInstructions;
