import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseCommandArgs } from "../args.ts";
import type { UserConfig } from "../config.ts";
import { instructionRefs } from "../config-check.ts";
import { output } from "../context.ts";
import { REPO_ROOT, resolveConfigLocation, resolvePath, tildify } from "../paths.ts";
import { systemTimezone } from "../time.ts";
import type { Command } from "./types.ts";

const EXAMPLE_CONFIG = join(REPO_ROOT, "examples", "config.example.json");
const EXAMPLE_SUBAGENT = join(REPO_ROOT, "examples", "instructions", "subagent.md");

function placeholder(name: string): string {
  return `<!--\nPersonal instructions (${name}), referenced from config.json. Write Markdown\noutside this comment; comments are left out of what the agent reads.\n-->\n`;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The example config, with the system time zone. */
function exampleConfig(): string {
  const text = readFileSync(EXAMPLE_CONFIG, "utf8");
  const withZone = text.replace(/^(\s*"timezone":\s*)"[^"]*"/m, `$1${JSON.stringify(systemTimezone())}`);
  if (withZone === text && !text.includes(`"timezone": ${JSON.stringify(systemTimezone())}`)) throw new Error(`${EXAMPLE_CONFIG} has no top-level "timezone" line`);
  return withZone;
}

interface InitFile {
  path: string;
  action: "created" | "kept";
}

const init: Command = {
  name: "init",
  summary: "Create your config folder from the example (never overwrites)",
  usage: `Usage: agent-tasks init

Creates the config folder (~/.config/agent-tasks, or $AGENT_TASKS_CONFIG) if
needed, with:
  config.json              copied from examples/config.example.json, with
                           your system time zone
  instructions/subagent.md personal instructions for subagents, with
                           commented examples
  instructions/<file>.md   an empty (commented) file for every other
                           instruction file the new config.json lists

Files that already exist are kept as they are. Prints the next steps.`,
  run(ctx, args) {
    parseCommandArgs(args, {}, { maxPositionals: 0 });
    const { configDir, configFile } = resolveConfigLocation(ctx.env);
    const instructionsDir = join(configDir, "instructions");
    const files: InitFile[] = [];
    const write = (path: string, content: string): InitFile["action"] => {
      if (files.some((f) => f.path === path)) return "kept";
      const action = exists(path) ? "kept" : "created";
      if (action === "created") {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content, { flag: "wx" });
      }
      files.push({ path, action });
      return action;
    };

    const example = exampleConfig();
    const createdConfig = write(configFile, example) === "created";
    write(join(instructionsDir, "subagent.md"), readFileSync(EXAMPLE_SUBAGENT, "utf8"));
    if (createdConfig) {
      for (const { file } of instructionRefs(JSON.parse(example) as UserConfig)) write(resolvePath(file, ctx.env, instructionsDir), placeholder(file));
    }

    const show = (p: string) => tildify(p, ctx.env);
    const next = [
      `Edit ${show(configFile)}: the agent command, the launcher ("preset": "herdr" inside Herdr, "process" otherwise) and the profiles.`,
      `Write your own rules for subagents in ${show(join(instructionsDir, "subagent.md"))}.`,
      "agent-tasks config check   # validate the config",
      "agent-tasks doctor         # check the whole setup",
    ];
    output(ctx, { config_dir: configDir, files, next_steps: next }, () =>
      [
        ...files.map((f) => `${f.action === "created" ? "✓ created" : "· kept   "} ${show(f.path)}`),
        "",
        "Next steps:",
        ...next.map((n, i) => `  ${i + 1}. ${n}`),
      ].join("\n"),
    );
  },
};

export default init;
