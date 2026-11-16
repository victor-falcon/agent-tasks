import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Check, fail, ok, warn } from "./checks.ts";
import { BUILTIN_DEFAULTS, type LoadedConfig } from "./config.ts";
import { configChecks, configuredLaunchers, findExecutable, launcherNeedsTerminal } from "./config-check.ts";
import type { Context } from "./context.ts";
import { defaultMaxDelay, formatDuration, parseDuration } from "./duration.ts";
import { CLI_BIN, type InstallDirs, installSources, linkStatus, samePath } from "./install.ts";
import { resolveLauncher } from "./launcher.ts";
import { type Paths, REPO_ROOT, resolveConfigLocation, tildify } from "./paths.ts";
import { listTasks, readTicks } from "./store.ts";

// `agent-tasks doctor`: is this machine ready to run scheduled tasks?

function bunCheck(ctx: Context): Check {
  const onPath = findExecutable("bun", ctx.env);
  if (!onPath) return fail("bun", `bun ${Bun.version} runs this command, but bun is not on PATH`, "add bun's folder to PATH: bin/agent-tasks starts with #!/usr/bin/env bun");
  return ok("bun", `bun ${Bun.version} (${tildify(onPath, ctx.env)})`);
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
  return checks;
}

function terminalChecks(ctx: Context, loaded: LoadedConfig): Check[] {
  const needing: string[] = [];
  for (const { where, launcher } of configuredLaunchers(loaded.config)) {
    try {
      if (launcherNeedsTerminal(resolveLauncher(launcher))) needing.push(where);
    } catch {
      // An invalid launcher is already reported by the config checks.
    }
  }
  if (needing.length === 0) return [];
  const terminal = ctx.env.HC_TERMINAL_ID;
  if (!terminal) {
    return [warn("herdr.terminal", `$HC_TERMINAL_ID is not set: ${needing.join(", ")} must run inside a Herdr terminal`, "start agent-tasks runner (and run doctor) from a Herdr terminal")];
  }
  return [ok("herdr.terminal", `$HC_TERMINAL_ID is ${terminal}`)];
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

export function doctorChecks(ctx: Context, dirs: InstallDirs): Check[] {
  const config = configChecks(ctx);
  const { loaded } = config;
  const checks = [bunCheck(ctx), cliOnPathCheck(ctx), ...config.checks];
  if (loaded) checks.push(...dataChecks(ctx, ctx.paths), ...terminalChecks(ctx, loaded));
  checks.push(...skillChecks(ctx, loaded, dirs));
  if (loaded) checks.push(heartbeatCheck(ctx, ctx.paths, loaded));
  return checks;
}
