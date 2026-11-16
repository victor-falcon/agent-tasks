import { parseCommandArgs } from "../args.ts";
import { checksJson, hasErrors, renderChecks } from "../checks.ts";
import { configChecks } from "../config-check.ts";
import { output } from "../context.ts";
import type { Command } from "./types.ts";

const configCheck: Command = {
  name: "config check",
  summary: "Validate the config, profiles, templates, instruction files and launcher commands",
  usage: `Usage: agent-tasks config check

Checks the user config folder before anything runs:
  - config.json loads and is valid (profiles included);
  - templates/task.md and templates/prompt.md use only known variables, and
    task.md uses {{finish_command}};
  - every instruction file the config lists exists;
  - each launcher (root and per profile) resolves, and its commands are on PATH;
  - each agent command is on PATH (a warning; shell aliases are not checked).

Prints one line per check (✓ ok, ! warning, ✕ error). Exits with 1 when
there is any error.`,
  run(ctx, args) {
    parseCommandArgs(args, {}, { maxPositionals: 0 });
    const { checks } = configChecks(ctx);
    output(ctx, checksJson(checks), () => renderChecks(checks));
    return hasErrors(checks) ? 1 : 0;
  },
};

export default configCheck;
