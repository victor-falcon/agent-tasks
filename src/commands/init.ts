import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseCommandArgs } from "../args.ts";
import { type Check, fail, renderCheck } from "../checks.ts";
import { callHub, oldHubError } from "../client.ts";
import { formatJson, setTopLevelKeys } from "../config-edit.ts";
import { AgentTasksError, HubUnreachableError, UsageError } from "../errors.ts";
import { writeConfigKeys } from "../machines.ts";
import { Checker, checkMachineName, isObject } from "../schema.ts";
import { callRemote, MachineUnreachableError } from "../ssh.ts";
import type { UserConfig } from "../config.ts";
import { instructionRefs } from "../config-check.ts";
import { type Context, output } from "../context.ts";
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
       agent-tasks init --join <hub-ssh-alias> --machine <name> [--ssh <alias>] [--launcher <preset>]

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

With --join, this machine becomes a client of a hub (see "Multiple
machines" in RECIPE.md): after the above, it checks that the hub answers
over SSH with the same protocol, sets "machine" and "hub" in this machine's
config.json (only those two keys; the rest of the file is kept), registers
the machine on the hub ("agent-tasks machines add" there) and checks that
the hub reaches this machine back. A client never runs the runner.

Options:
  --launcher <preset>  herdr, rex, tmux or process, instead of detecting it
  --join <alias>       The SSH host alias this machine reaches the hub with
  --machine <name>     This machine's name (with --join), e.g. mac
  --ssh <alias>        The SSH host alias the HUB reaches this machine with
                       (with --join; default: the machine's name)`,
  run(ctx, args) {
    const { values } = parseCommandArgs(
      args,
      { launcher: { type: "string" }, join: { type: "string" }, machine: { type: "string" }, ssh: { type: "string" } },
      { maxPositionals: 0 },
    );
    const join_ = joinRequest(values);
    const asked = values.launcher as string | undefined;
    if (asked !== undefined && !INIT_PRESETS.includes(asked as InitPreset)) throw new UsageError(`--launcher must be one of ${INIT_PRESETS.join(", ")}`);
    const launcher: LauncherChoice = asked ? { preset: asked as InitPreset, reason: "--launcher" } : detectLauncher(ctx.env);
    const { configDir, configFile } = resolveConfigLocation(ctx.env);
    // Before writing anything: the config can take the keys, and the hub answers.
    const hub = join_ ? checkHub(ctx, configFile, join_) : null;
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

    const joined = join_ && hub ? joinHub(ctx, configFile, join_, hub) : null;

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
        : `Launcher: ${launcher.preset} (${launcher.reason}). Each run gets its own ${where[launcher.preset].unit} with an interactive shell, so the agent command can be a shell alias. The agent asks for permissions there as usual, unless you add flags to agent.args.${joined ? "" : ` Start the runner in this ${where[launcher.preset].place}.`}`;
    const next = joined
      ? [
          `Edit ${show(configFile)}: the agent command, the launcher and the profiles for sessions on this machine (time zone, notifiers and scheduling are the hub's).`,
          `Write your own rules for subagents on this machine in ${show(join(instructionsDir, "subagent.md"))}.`,
          "agent-tasks doctor         # check this machine, the hub, and that the hub reaches it",
          `Never start "agent-tasks runner" here: the hub's runner launches this machine's tasks over SSH.`,
        ]
      : [
          `Edit ${show(configFile)}: the agent command, the launcher and the profiles.`,
          `Write your own rules for subagents in ${show(join(instructionsDir, "subagent.md"))}.`,
          "agent-tasks config check   # validate the config",
          "agent-tasks doctor         # check the whole setup",
        ];
    output(ctx, { config_dir: configDir, files, launcher: createdConfig ? launcher : null, ...(joined ? { join: joined.json } : {}), next_steps: next }, () =>
      [
        ...files.map((f) => `${f.action === "created" ? "✓ created" : "· kept   "} ${show(f.path)}`),
        ...(joined ? joined.lines : []),
        ...(launcherNote ? ["", launcherNote] : []),
        "",
        "Next steps:",
        ...next.map((n, i) => `  ${i + 1}. ${n}`),
      ].join("\n"),
    );
    return joined?.check.status === "error" ? 1 : 0;
  },
};

// ---------------------------------------------------------------------------
// --join: make this machine a client of a hub
// ---------------------------------------------------------------------------

interface JoinRequest {
  /** How this machine reaches the hub. */
  hub: string;
  machine: string;
  /** How the hub reaches this machine. */
  ssh: string;
}

function joinRequest(values: Record<string, string | boolean | undefined>): JoinRequest | null {
  const hub = values.join as string | undefined;
  const machine = values.machine as string | undefined;
  const ssh = values.ssh as string | undefined;
  if (hub === undefined) {
    if (machine !== undefined || ssh !== undefined) throw new UsageError("--machine and --ssh go with --join <hub-ssh-alias>");
    return null;
  }
  if (hub.trim() === "") throw new UsageError("--join needs the SSH host alias of the hub");
  if (machine === undefined) throw new UsageError("--join needs --machine <name>: this machine's name, as the hub will know it");
  const c = new Checker();
  checkMachineName(c, machine);
  if (c.errors.length > 0) throw new UsageError(`--machine ${c.errors[0]}`);
  if (ssh !== undefined && ssh.trim() === "") throw new UsageError("--ssh must not be empty");
  return { hub, machine, ssh: ssh ?? machine };
}

const joinKeys = (req: JoinRequest) => ({ machine: req.machine, hub: { ssh: req.hub } });

/**
 * Checks, before anything is written, that this machine can become a client
 * of the hub: its config can take the keys, and the hub answers over SSH with
 * the same protocol. Returns the hub's ping answer.
 */
function checkHub(ctx: Context, configFile: string, req: JoinRequest): Record<string, unknown> {
  if (existsSync(configFile)) {
    const config = ctx.config.config;
    if (config.machines && Object.keys(config.machines).length > 0) {
      throw new AgentTasksError(
        "is_hub",
        `this machine is a hub: ${tildify(configFile, ctx.env)} has \`machines\` (${Object.keys(config.machines).join(", ")}); a hub can't join another hub`,
      );
    }
    if (setTopLevelKeys(readFileSync(configFile, "utf8"), joinKeys(req)) === null) {
      const lines = Object.entries(joinKeys(req)).map(([k, v]) => `"${k}": ${formatJson(v, "  ")},`);
      throw new AgentTasksError("config_not_edited", `could not edit ${configFile} safely; set these top-level keys in it by hand, then run this again:`, lines);
    }
  }
  let answer: Record<string, unknown>;
  try {
    answer = callRemote({ machine: "hub", ssh: req.hub }, "ping", {}, ctx.env);
  } catch (err) {
    if (err instanceof MachineUnreachableError) throw new HubUnreachableError(req.hub, err.message.replace(/^.*? is unreachable:? ?/, "") || "ssh failed");
    if (err instanceof AgentTasksError && err.code === "usage") throw oldHubError(req.hub);
    throw err;
  }
  if (answer.hub !== null && answer.hub !== undefined) {
    throw new AgentTasksError("not_a_hub", `"${req.hub}" is not a hub: it is a client of "${String(answer.hub)}" itself; join that one`);
  }
  if (answer.machine === req.machine) throw new UsageError(`"${req.machine}" is the hub's own name; pick another --machine`);
  return answer;
}

/** Writes `machine` and `hub`, registers this machine on the hub and reports whether the hub reaches it back. */
function joinHub(ctx: Context, configFile: string, req: JoinRequest, hub: Record<string, unknown>) {
  writeConfigKeys(configFile, joinKeys(req));
  const added = callHub(ctx, req.hub, ["machines", "add", req.machine, "--ssh", req.ssh]);
  const check = (isObject(added.check) ? added.check : fail("machines.reachable", "the hub did not report whether it reaches this machine")) as Check;
  const show = tildify(configFile, ctx.env);
  const json = { hub: req.hub, hub_machine: hub.machine, hub_version: hub.version, machine: req.machine, ssh: req.ssh, registered: added.action, check };
  const lines = [
    `✓ hub "${req.hub}" answers: machine ${String(hub.machine)}, agent-tasks ${String(hub.version)}`,
    `✓ set "machine": "${req.machine}" and "hub": { "ssh": "${req.hub}" } in ${show}`,
    `✓ registered on the hub as machines.${req.machine} = { "ssh": "${req.ssh}" } (${String(added.action)})`,
    ...renderCheck(check).map((l) => l.replace(/^([✓!✕]) /, "$1 hub → this machine: ")),
  ];
  return { json, lines, check };
}

export default init;
