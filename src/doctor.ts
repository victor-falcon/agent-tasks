import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Check, fail, ok, warn } from "./checks.ts";
import { callHub } from "./hub.ts";
import { BUILTIN_DEFAULTS, isHub, isKnownMachine, type LoadedConfig, localMachine, type UserConfig } from "./config.ts";
import { configChecks, configuredLaunchers, findExecutable, launcherEnvVariables, launcherNeedsTerminal, launcherUsesHerdrSpace } from "./config-check.ts";
import type { Context } from "./context.ts";
import { defaultMaxDelay, formatDuration, parseDuration } from "./duration.ts";
import { CLI_BIN, type InstallDirs, installSources, linkStatus, samePath } from "./install.ts";
import { AgentTasksError } from "./errors.ts";
import { herdrSpaceId, namedHerdrSpace, resolveLauncher } from "./launcher.ts";
import { checkRegisteredMachine, hubCheck, pingMachine, sshMachines } from "./machines.ts";
import { type Paths, REPO_ROOT, resolveConfigLocation, tildify } from "./paths.ts";
import { listTasks, readTicks } from "./store.ts";

// `agent-tasks doctor`: is this machine ready to run scheduled tasks?

function bunCheck(ctx: Context): Check {
  const onPath = findExecutable("bun", ctx.env);
  if (!onPath) return fail("bun", `bun ${Bun.version} runs this command, but bun is not on PATH`, "add bun's folder to PATH: bin/agent-tasks starts with #!/usr/bin/env bun");
  return ok("bun", `bun ${Bun.version} (${tildify(onPath, ctx.env)})`);
}

/** The installed version of a package in `<root>/node_modules`, or null when it is not there. */
function installedVersion(root: string, name: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/**
 * The checkout's dependencies are installed, at the versions package.json
 * pins. A `git pull` without `bun install` leaves them behind; the
 * dashboard (OpenTUI, with a native library per platform) is then the first
 * thing to break, so its platform package is checked too.
 */
export function dependenciesCheck(ctx: Context, root = REPO_ROOT): Check {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const wanted = Object.entries(pkg.dependencies ?? {});
  if (wanted.some(([name]) => name === "@opentui/core")) wanted.push([`@opentui/core-${process.platform}-${process.arch}`, "*"]);
  const problems: string[] = [];
  for (const [name, spec] of wanted) {
    const version = installedVersion(root, name);
    if (version === null) problems.push(`${name}: not installed`);
    // Only exact pins are compared: a range (^11.0.1) is bun's to resolve.
    else if (/^\d+\.\d+\.\d+$/.test(spec) && version !== spec) problems.push(`${name}: ${version} installed, ${spec} wanted`);
  }
  const shown = tildify(root, ctx.env);
  if (problems.length > 0) return fail("dependencies", `dependencies of ${shown} are missing or out of date`, `run: cd ${shown} && bun install`, problems);
  return ok("dependencies", `dependencies installed (${wanted.length})`);
}

function cliOnPathCheck(ctx: Context): Check {
  const found = findExecutable("agent-tasks", ctx.env);
  if (!found) return fail("path.cli", "agent-tasks is not on PATH", "run bin/agent-tasks install, and add its --bin-dir (default ~/.local/bin) to PATH");
  if (!samePath(found, CLI_BIN)) {
    return warn("path.cli", `agent-tasks on PATH (${tildify(found, ctx.env)}) is not this checkout (${tildify(REPO_ROOT, ctx.env)})`, "run bin/agent-tasks install --force from the checkout you want to use");
  }
  return ok("path.cli", `agent-tasks on PATH (${tildify(found, ctx.env)})`);
}

/** The closest folder that exists, starting at `path`. */
function existingAncestor(path: string): string {
  let dir = path;
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

function dataChecks(ctx: Context, paths: Paths): Check[] {
  const shown = tildify(paths.dataDir, ctx.env);
  if (existsSync(paths.dataDir) && !statSync(paths.dataDir).isDirectory()) {
    return [fail("data.writable", `data dir ${shown} is not a folder`, "remove that file, or set data_dir / $AGENT_TASKS_HOME to a folder")];
  }
  const base = existingAncestor(paths.dataDir);
  try {
    accessSync(base, constants.W_OK);
  } catch {
    return [fail("data.writable", `data dir ${shown} is not writable (${tildify(base, ctx.env)})`, "fix its permissions, or set data_dir / $AGENT_TASKS_HOME to a writable folder")];
  }
  const checks = [ok("data.writable", base === paths.dataDir ? `data dir ${shown} is writable` : `data dir ${shown} will be created (${tildify(base, ctx.env)} is writable)`)];
  const tasks = listTasks(paths);
  if (tasks.errors.length > 0) {
    checks.push(fail("data.tasks", `${tasks.errors.length} task file${tasks.errors.length > 1 ? "s" : ""} can't be read`, "fix or remove them (they are skipped by tick)", tasks.errors.map((e) => e.message)));
  } else {
    checks.push(ok("data.tasks", `${tasks.items.length} task${tasks.items.length === 1 ? "" : "s"} readable`));
  }
  // E.g. tasks migrated as `local` before `machine` was set in the config.
  const config = ctx.config.config;
  const strays = isHub(config) ? tasks.items.filter((t) => !isKnownMachine(config, t.machine)) : [];
  if (strays.length > 0) {
    const machines = [...new Set(strays.map((t) => t.machine))].sort();
    checks.push(
      warn(
        "data.machines",
        `${strays.length} task${strays.length > 1 ? "s run" : " runs"} on ${machines.length > 1 ? "machines" : "a machine"} not in the config: ${machines.join(", ")}`,
        "move them with agent-tasks edit <id> --machine <name>, or add the machine to `machines` in the config",
        strays.map((t) => `${t.id}: ${t.machine}`),
      ),
    );
  }
  return checks;
}

/**
 * Where Herdr launchers open runs. Inside a Herdr terminal (`$HC_TERMINAL_ID`,
 * the runner's), in its space; elsewhere, in the space named by the
 * launcher's `space`. A client runs no runner: the hub launches its sessions
 * over SSH, where `$HC_TERMINAL_ID` is never set, whatever this shell has.
 */
function terminalChecks(ctx: Context, loaded: LoadedConfig): Check[] {
  const client = Boolean(loaded.config.hub);
  const needing: string[] = [];
  const spaces: { where: string; space: string | null }[] = [];
  for (const { where, launcher } of configuredLaunchers(loaded.config)) {
    try {
      const spec = resolveLauncher(launcher);
      if (launcherNeedsTerminal(spec)) needing.push(where);
      else if (launcherUsesHerdrSpace(spec)) spaces.push({ where, space: spec.space });
    } catch {
      // An invalid launcher is already reported by the config checks.
    }
  }
  const checks: Check[] = [];
  const terminal = client ? undefined : ctx.env.HC_TERMINAL_ID;
  if (needing.length > 0) {
    if (client) {
      checks.push(warn("herdr.terminal", `${needing.join(", ")} need${needing.length > 1 ? "" : "s"} the runner's Herdr terminal ({{runner_terminal}}/{{runner_space}}), but the hub launches this machine's runs over SSH, without one`, 'use { "preset": "herdr" }: it opens runs in a space of their own here'));
    } else if (!terminal) {
      checks.push(warn("herdr.terminal", `$HC_TERMINAL_ID is not set: ${needing.join(", ")} must run inside a Herdr terminal`, "start agent-tasks runner (and run doctor) from a Herdr terminal"));
    } else {
      checks.push(ok("herdr.terminal", `$HC_TERMINAL_ID is ${terminal}`));
    }
  }
  if (spaces.length === 0) return checks;
  if (terminal) {
    if (needing.length === 0) checks.push(ok("herdr.terminal", `$HC_TERMINAL_ID is ${terminal}: runs open in its space, nested under it`));
    return checks;
  }
  const why = client ? "the hub launches this machine's runs over SSH" : "$HC_TERMINAL_ID is not set";
  const app = findExecutable("herdr-app", ctx.env);
  for (const { where, space } of spaces) {
    if (space === null) {
      checks.push(fail("herdr.space", `${where}: ${why} and the launcher has no "space" to open runs in`, 'set "space" in the launcher, e.g. { "preset": "herdr", "space": "Agent Tasks" }'));
      continue;
    }
    const label = `${where}: ${why}, so runs open in the Herdr space "${space}"`;
    if (!app) {
      checks.push(warn("herdr.space", `${label} (${herdrSpaceId(space)}), but herdr-app is not on PATH: the space can't be found by name or named`, "add Herdr's herdr-app to PATH (it comes with the Herdr app)"));
      continue;
    }
    const found = namedHerdrSpace(ctx.env, space);
    const state = { found: `found: ${found.id}`, missing: "created on the first run", unknown: `${found.id}; the Herdr window is not open, so whether it exists is unknown` }[found.state];
    checks.push(ok("herdr.space", `${label} (${state})`));
  }
  return checks;
}

/**
 * On a client, the hub launches this machine's runs over SSH: a launcher
 * that reads a variable of the runner's environment (`{{env.REX_SESSION}}`)
 * only works if SSH commands get it too.
 */
function clientEnvChecks(loaded: LoadedConfig): Check[] {
  if (!loaded.config.hub) return [];
  const checks: Check[] = [];
  for (const { where, launcher } of configuredLaunchers(loaded.config)) {
    let names: string[];
    try {
      names = launcherEnvVariables(resolveLauncher(launcher));
    } catch {
      continue; // Reported by the config checks.
    }
    if (names.length === 0) continue;
    const vars = names.map((n) => `$${n}`).join(", ");
    const plural = names.length > 1;
    checks.push(
      warn(
        "launcher.ssh_env",
        `${where} uses ${vars}, but the hub launches this machine's runs over SSH, where ${plural ? "they are" : "it is"} usually not set`,
        `make SSH commands get ${vars} (e.g. in ~/.zshenv), or use a launcher that works without ${plural ? "them" : "it"}: herdr, tmux or process`,
      ),
    );
  }
  return checks;
}

function skillChecks(ctx: Context, loaded: LoadedConfig | null, dirs: InstallDirs): Check[] {
  const { configDir } = resolveConfigLocation(ctx.env);
  const sources = installSources(configDir).filter((s) => s.kind === "skill");
  const checks: Check[] = [];
  for (const s of sources) {
    const status = linkStatus(s, dirs);
    const target = tildify(status.target, ctx.env);
    if (status.state === "linked") checks.push(ok("skills.installed", `skill ${s.name} installed (${target})`));
    else if (status.state === "missing") checks.push(fail("skills.installed", `skill ${s.name} is not installed in ${tildify(dirs.skillsDir, ctx.env)}`, "run agent-tasks install"));
    else checks.push(warn("skills.installed", `skill ${s.name}: ${target} is not a link to ${tildify(s.source, ctx.env)}`, "run agent-tasks install --force to replace it, or keep your own copy"));
  }
  // Skills named in the config that agent-tasks does not ship (level 3).
  const named = new Set([loaded?.config.skill ?? BUILTIN_DEFAULTS.skill, ...(loaded?.config.profiles ?? []).flatMap((p) => (p.skill ? [p.skill] : []))]);
  for (const name of named) {
    if (sources.some((s) => s.name === name)) continue;
    if (existsSync(join(dirs.skillsDir, name, "SKILL.md"))) checks.push(ok("skills.configured", `skill ${name} (from config) found`));
    else checks.push(fail("skills.configured", `skill ${name} (from config) not found in ${tildify(dirs.skillsDir, ctx.env)}`, `put it in ${tildify(join(configDir, "skills", name), ctx.env)} and run agent-tasks install`));
  }
  return checks;
}

function heartbeatCheck(ctx: Context, paths: Paths, loaded: LoadedConfig | null): Check {
  // A tick run by hand (`agent-tasks tick`, mode "manual") says nothing about the runner.
  const ticks = readTicks(paths).items;
  const last = ticks.filter((t) => t.mode !== "manual").at(-1);
  if (!last) {
    const why = ticks.length > 0 ? "only manual ticks in state/ticks.jsonl" : "state/ticks.jsonl is empty";
    return warn("runner.heartbeat", `no runner heartbeat yet (${why})`, "start agent-tasks runner in a terminal tab and leave it open");
  }
  const every = loaded?.config.runner?.every ?? BUILTIN_DEFAULTS.runner_every;
  const age = ctx.now.getTime() - Date.parse(last.at);
  const stale = defaultMaxDelay(parseDuration(every));
  if (age > stale) {
    return warn("runner.heartbeat", `runner: last tick ${formatDuration(age)} ago, at ${last.at} (runner.every is ${every})`, "the runner seems stopped: start agent-tasks runner again");
  }
  if (age < 0) return ok("runner.heartbeat", `runner: last tick at ${last.at} (after now)`);
  return ok("runner.heartbeat", `runner: last tick ${age > 0 ? `${formatDuration(age)} ago` : "just now"}`);
}

/**
 * On a client: the hub answers over SSH with the same protocol, and it
 * reaches this machine back (it runs the sessions of this machine's tasks).
 */
function hubChecks(ctx: Context, hubAlias: string): Check[] {
  const self = localMachine(ctx.config.config);
  const check = hubCheck(pingMachine({ machine: "hub", ssh: hubAlias }, ctx.env));
  if (check.status !== "ok") return [check];
  let back: Check;
  try {
    const answer = callHub(ctx, hubAlias, ["machines", "check", self]);
    const found = Array.isArray(answer.checks) ? (answer.checks[0] as Check | undefined) : undefined;
    back = found ? { ...found, id: "hub.reach_back", message: `hub → this machine: ${found.message}` } : fail("hub.reach_back", "the hub did not report whether it reaches this machine");
  } catch (err) {
    if (!(err instanceof AgentTasksError)) throw err;
    back =
      err.code === "not_found"
        ? fail("hub.reach_back", `this machine ("${self}") is not in the hub's \`machines\``, `run agent-tasks init --join ${hubAlias} --machine ${self} --ssh <alias the hub reaches this machine with>`)
        : fail("hub.reach_back", `the hub could not check this machine: ${err.message.split("\n")[0]}`);
  }
  return [check, back];
}

/** On the hub: every machine in `machines` answers. Unreachable ones are warnings: machines sleep. */
function machineChecks(ctx: Context, config: UserConfig): Check[] {
  return sshMachines(config).map((target) => checkRegisteredMachine(target, ctx.env).check);
}

export function doctorChecks(ctx: Context, dirs: InstallDirs): Check[] {
  const config = configChecks(ctx);
  const { loaded } = config;
  const checks = [bunCheck(ctx), dependenciesCheck(ctx), cliOnPathCheck(ctx), ...config.checks];
  // A client keeps no data and runs no runner: those are the hub's.
  const hub = loaded?.config.hub;
  if (loaded && !hub) checks.push(...dataChecks(ctx, ctx.paths));
  if (loaded) checks.push(...terminalChecks(ctx, loaded), ...clientEnvChecks(loaded));
  checks.push(...skillChecks(ctx, loaded, dirs));
  if (loaded && hub) checks.push(...hubChecks(ctx, hub.ssh));
  if (loaded && !hub) checks.push(...machineChecks(ctx, loaded.config), heartbeatCheck(ctx, ctx.paths, loaded));
  return checks;
}
