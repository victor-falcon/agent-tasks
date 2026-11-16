import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseCommandArgs } from "../args.ts";
import { UsageError } from "../errors.ts";
import type { UserConfig } from "../config.ts";
import { instructionRefs } from "../config-check.ts";
import { output } from "../context.ts";
import { type Env, REPO_ROOT, resolveConfigLocation, resolvePath, tildify } from "../paths.ts";
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

export type InitPreset = "herdr" | "rex" | "tmux" | "process";
const INIT_PRESETS: InitPreset[] = ["herdr", "rex", "tmux", "process"];

export interface LauncherChoice {
  preset: InitPreset;
  /** Why this preset: the environment variable found, or the flag. */
  reason: string;
}

/** The launcher preset for the terminal `init` runs in, checked in the same order as RECIPE.md. */
export function detectLauncher(env: Env): LauncherChoice {
  if (env.HC_TERMINAL_ID) return { preset: "herdr", reason: "found $HC_TERMINAL_ID" };
  if (env.REX_SESSION) return { preset: "rex", reason: "found $REX_SESSION" };
  if (env.TMUX) return { preset: "tmux", reason: "found $TMUX" };
  return { preset: "process", reason: "no Herdr, Rex or tmux found" };
}

/** Replaces exactly one match of `re` in the example, or fails loudly when the example changed shape. */
function replaceOnce(text: string, re: RegExp, value: string, what: string): string {
  if (!re.test(text)) throw new Error(`${EXAMPLE_CONFIG} has no top-level ${what}`);
  return text.replace(re, value);
}

/**
 * The example config with the system time zone and the launcher for this
 * terminal. The example is written for the `process` preset (no terminal, so
 * the agent runs in print mode); the interactive presets type the agent
 * command into a shell, so they get the plain interactive agent.
 */
function exampleConfig(launcher: InitPreset): string {
  let text = readFileSync(EXAMPLE_CONFIG, "utf8");
  text = replaceOnce(text, /^(  "timezone":\s*)"[^"]*"/m, `$1${JSON.stringify(systemTimezone())}`, '"timezone" line');
  if (launcher === "process") return text;
  text = replaceOnce(text, /^  "launcher": \{[^\n]*\},$/m, `  "launcher": { "preset": "${launcher}" },`, '"launcher" line');
  return replaceOnce(text, /^  "agent": \{\n[\s\S]*?^  \},$/m, `  "agent": { "command": "claude", "args": [], "shell": false },`, '"agent" block');
}

interface InitFile {
  path: string;
  action: "created" | "kept";
}

const init: Command = {
  name: "init",
  summary: "Create your config folder from the example (never overwrites)",
  usage: `Usage: agent-tasks init [--launcher <preset>]

Creates the config folder (~/.config/agent-tasks, or $AGENT_TASKS_CONFIG) if
needed, with:
  config.json              copied from examples/config.example.json, with
                           your system time zone and the launcher for this
                           terminal
  instructions/subagent.md personal instructions for subagents, with
                           commented examples
  instructions/<file>.md   an empty (commented) file for every other
                           instruction file the new config.json lists

The launcher is picked from the terminal init runs in: herdr when
$HC_TERMINAL_ID is set, else rex with $REX_SESSION, else tmux with $TMUX.
These start an interactive shell per run and type the agent command into it
(agent: claude). With none of them it is process: the agent runs as a child
process of the runner with no terminal, so the agent is claude in print mode
(--print), allowed to edit files and run agent-tasks commands only.

Files that already exist are kept as they are. Prints the next steps.

Options:
  --launcher <preset>  herdr, rex, tmux or process, instead of detecting it`,
  run(ctx, args) {
    const { values } = parseCommandArgs(args, { launcher: { type: "string" } }, { maxPositionals: 0 });
    const asked = values.launcher as string | undefined;
    if (asked !== undefined && !INIT_PRESETS.includes(asked as InitPreset)) throw new UsageError(`--launcher must be one of ${INIT_PRESETS.join(", ")}`);
    const launcher: LauncherChoice = asked ? { preset: asked as InitPreset, reason: "--launcher" } : detectLauncher(ctx.env);
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

    const example = exampleConfig(launcher.preset);
    const createdConfig = write(configFile, example) === "created";
    write(join(instructionsDir, "subagent.md"), readFileSync(EXAMPLE_SUBAGENT, "utf8"));
    if (createdConfig) {
      for (const { file } of instructionRefs(JSON.parse(example) as UserConfig)) write(resolvePath(file, ctx.env, instructionsDir), placeholder(file));
    }

    const show = (p: string) => tildify(p, ctx.env);
    const where: Record<Exclude<InitPreset, "process">, { unit: string; place: string }> = {
      herdr: { unit: "tab", place: "Herdr" },
      rex: { unit: "window", place: "Rex session" },
      tmux: { unit: "window", place: "tmux server" },
    };
    const launcherNote = !createdConfig
      ? asked
        ? `--launcher ${asked} ignored: ${show(configFile)} already exists and was kept. Set "launcher" in it by hand.`
        : null
      : launcher.preset === "process"
        ? `Launcher: process (${launcher.reason}). Each run is a child process with no terminal, so the agent is claude in print mode, allowed to edit files and run agent-tasks only: add what your tasks need to --allowedTools (e.g. "Bash(git:*)"). Inside Herdr, Rex or tmux, run init there instead (or pass --launcher).`
        : `Launcher: ${launcher.preset} (${launcher.reason}). Each run gets its own ${where[launcher.preset].unit} with an interactive shell, so the agent command can be a shell alias. The agent asks for permissions there as usual, unless you add flags to agent.args. Start the runner in this ${where[launcher.preset].place}.`;
    const next = [
      `Edit ${show(configFile)}: the agent command, the launcher and the profiles.`,
      `Write your own rules for subagents in ${show(join(instructionsDir, "subagent.md"))}.`,
      "agent-tasks config check   # validate the config",
      "agent-tasks doctor         # check the whole setup",
    ];
    output(ctx, { config_dir: configDir, files, launcher: createdConfig ? launcher : null, next_steps: next }, () =>
      [
        ...files.map((f) => `${f.action === "created" ? "✓ created" : "· kept   "} ${show(f.path)}`),
        ...(launcherNote ? ["", launcherNote] : []),
        "",
        "Next steps:",
        ...next.map((n, i) => `  ${i + 1}. ${n}`),
      ].join("\n"),
    );
  },
};

export default init;
