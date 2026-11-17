import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Check, fail, ok, warn } from "./checks.ts";
import { BUILTIN_DEFAULTS, type LauncherConfig, type LoadedConfig, type UserConfig } from "./config.ts";
import type { Context } from "./context.ts";
import { AgentTasksError } from "./errors.ts";
import { PROMPT_TEMPLATE_VARIABLES } from "./execution.ts";
import { type CommandSpec, type LauncherSpec, resolveLauncher } from "./launcher.ts";
import { type Env, resolveConfigLocation, resolvePath, tildify } from "./paths.ts";
import type { AgentSpec } from "./schema.ts";
import { TASK_TEMPLATE_VARIABLES } from "./task-context.ts";
import { variablesIn } from "./template.ts";

// `agent-tasks config check`: everything in the user's config folder that
// would otherwise only fail at launch time, in the middle of the night.

/** Where a binary is: an absolute/relative path that is executable, or found on `PATH`. */
export function findExecutable(bin: string, env: Env): string | null {
  if (bin.includes("/")) {
    try {
      accessSync(bin, constants.X_OK);
      return bin;
    } catch {
      return null;
    }
  }
  return Bun.which(bin, { PATH: env.PATH ?? "" });
}

/**
 * The program a launcher command runs, or null when it comes from a variable
 * (e.g. `{{agent_argv}}`). For a shell string, only a plain first word is
 * taken; quoted or compound commands are not checked.
 */
export function commandProgram(cmd: CommandSpec): string | null {
  if (typeof cmd === "string") {
    const first = cmd.trim().split(/\s+/)[0] ?? "";
    return /^[\w./+-]+$/.test(first) ? first : null;
  }
  const first = cmd[0];
  return first && !first.includes("{{") ? first : null;
}

/** Every command of a launcher, including the `then` steps. */
export function launcherCommands(spec: LauncherSpec): CommandSpec[] {
  return [spec.launch, ...spec.then, spec.close, spec.status, spec.read, spec.attach].filter((c): c is CommandSpec => c !== null);
}

/** Whether any of the launcher's commands uses `{{name}}` (or `{{name_quoted}}`). */
function launcherUses(spec: LauncherSpec, name: string): boolean {
  const re = new RegExp(`\\{\\{\\s*${name}(_quoted)?\\s*\\}\\}`);
  return launcherCommands(spec).some((c) => re.test(JSON.stringify(c)));
}

/** Whether a launcher needs to run inside a Herdr terminal (`$HC_TERMINAL_ID`). */
export function launcherNeedsTerminal(spec: LauncherSpec): boolean {
  return launcherUses(spec, "runner_terminal") || launcherUses(spec, "runner_space");
}

/** The environment variables a launcher's commands read (`{{env.NAME}}`), sorted. */
export function launcherEnvVariables(spec: LauncherSpec): string[] {
  const re = /\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*?)(?:_quoted)?\s*\}\}/g;
  const names = launcherCommands(spec).flatMap((c) => [...JSON.stringify(c).matchAll(re)].map((m) => m[1]!));
  return [...new Set(names)].sort();
}

/** Whether a launcher opens runs in a Herdr space: the runner's, or the one named by its `space`. */
export function launcherUsesHerdrSpace(spec: LauncherSpec): boolean {
  return launcherUses(spec, "herdr_space");
}

/**
 * Whether a launcher types the agent command at an interactive shell's prompt
 * (`{{agent}}` in `then`, as the herdr, rex and tmux presets do) rather than
 * running it as an argv (`{{agent_argv}}`). There, shell aliases and functions
 * work, even ones loaded lazily at the first prompt.
 */
export function launcherTypesAgent(spec: LauncherSpec): boolean {
  return launcherUses(spec, "agent") && !launcherUses(spec, "agent_argv");
}

/** The launchers a config can use: the root one, then each profile's own. */
export function configuredLaunchers(config: UserConfig): { where: string; launcher: LauncherConfig }[] {
  const list = [{ where: config.launcher ? "launcher" : "launcher (default)", launcher: config.launcher ?? BUILTIN_DEFAULTS.launcher }];
  config.profiles?.forEach((p, i) => {
    if (p.launcher) list.push({ where: `profiles[${i}].launcher (${p.match})`, launcher: p.launcher });
  });
  return list;
}

export function launcherName(launcher: LauncherConfig): string {
  return launcher.preset ? `preset "${launcher.preset}"` : "custom";
}

function allowedVariable(name: string, allowed: readonly string[]): boolean {
  return allowed.includes(name) || (name.endsWith("_quoted") && allowed.includes(name.slice(0, -"_quoted".length)));
}

function checkTemplateFile(file: string, allowed: readonly string[], env: Env, extra: (template: string) => Check | null): Check {
  const id = "config.template";
  const shown = tildify(file, env);
  const template = readFileSync(file, "utf8");
  const unknown = variablesIn(template).filter((v) => !allowedVariable(v, allowed));
  if (unknown.length > 0) {
    return fail(id, `${shown}: unknown variable${unknown.length > 1 ? "s" : ""} ${unknown.map((v) => `{{${v}}}`).join(", ")}`, `use only: ${allowed.map((v) => `{{${v}}}`).join(", ")} (add _quoted for a shell-quoted value)`);
  }
  return extra(template) ?? ok(id, `${shown}: valid`);
}

export function templateChecks(templatesDir: string, env: Env): Check[] {
  const checks: Check[] = [];
  const task = join(templatesDir, "task.md");
  if (existsSync(task)) {
    checks.push(
      checkTemplateFile(task, TASK_TEMPLATE_VARIABLES, env, (t) =>
        variablesIn(t).includes("finish_command")
          ? null
          : fail("config.template", `${tildify(task, env)}: does not use {{finish_command}}`, "add {{finish_command}}: without it the agent cannot report and every run ends as exited_without_report"),
      ),
    );
  }
  const prompt = join(templatesDir, "prompt.md");
  if (existsSync(prompt)) {
    checks.push(
      checkTemplateFile(prompt, PROMPT_TEMPLATE_VARIABLES, env, (t) =>
        t.trim() === "" ? fail("config.template", `${tildify(prompt, env)}: is empty`, 'write the start prompt, e.g. "/{{skill}} {{run_ref}}", or delete the file') : null,
      ),
    );
  }
  return checks;
}

/** Every instruction file a config lists, as written in it, with where it is listed. */
export function instructionRefs(config: UserConfig): { where: string; file: string }[] {
  const refs: { where: string; file: string }[] = [];
  for (const role of ["subagent", "supervisor"] as const) {
    for (const f of config.instructions?.[role] ?? []) refs.push({ where: `instructions.${role}`, file: f });
  }
  config.profiles?.forEach((p, i) => {
    for (const f of p.instructions ?? []) refs.push({ where: `profiles[${i}].instructions`, file: f });
  });
  return refs;
}

function instructionChecks(loaded: LoadedConfig): Check[] {
  const { env } = loaded;
  const dir = join(loaded.dir, "instructions");
  const refs = instructionRefs(loaded.config);
  if (refs.length === 0) return [];
  const missing = refs.filter((r) => !existsSync(resolvePath(r.file, env, dir)));
  if (missing.length === 0) return [ok("config.instructions", `instruction files: ${refs.length} found`)];
  return missing.map((r) =>
    fail("config.instructions", `${r.where}: instructions file not found: ${tildify(resolvePath(r.file, env, dir), env)}`, `create it (Markdown) or remove it from ${r.where}`),
  );
}

export function launcherChecks(loaded: LoadedConfig): Check[] {
  const checks: Check[] = [];
  for (const { where, launcher } of configuredLaunchers(loaded.config)) {
    let spec: LauncherSpec;
    try {
      spec = resolveLauncher(launcher);
    } catch (err) {
      if (!(err instanceof AgentTasksError)) throw err;
      checks.push(fail("launcher.config", `${where}: ${err.message.split("\n")[0]}`, "fix the launcher in config.json (see doc/roadmap/launcher.md)", err.details));
      continue;
    }
    const programs = [...new Set(launcherCommands(spec).map(commandProgram).filter((p): p is string => p !== null))];
    const missing = programs.filter((p) => findExecutable(p, loaded.env) === null);
    if (missing.length > 0) {
      checks.push(fail("launcher.command", `${where} (${launcherName(launcher)}): not found on PATH: ${missing.join(", ")}`, `install ${missing.join(", ")} or add its folder to PATH`));
    } else {
      checks.push(ok("launcher.command", `${where} (${launcherName(launcher)}): ${programs.length > 0 ? `${programs.join(", ")} found` : "no commands to check"}`));
    }
  }
  return checks;
}

function agentChecks(loaded: LoadedConfig): Check[] {
  const { config } = loaded;
  const rootLauncher = config.launcher ?? BUILTIN_DEFAULTS.launcher;
  const agents: { where: string; agent: AgentSpec | string; launcher: LauncherConfig }[] = [
    { where: config.agent ? "agent" : "agent (default)", agent: config.agent ?? BUILTIN_DEFAULTS.agent, launcher: rootLauncher },
  ];
  config.profiles?.forEach((p, i) => {
    if (p.agent) agents.push({ where: `profiles[${i}].agent (${p.match})`, agent: p.agent, launcher: p.launcher ?? rootLauncher });
  });
  return agents.map(({ where, agent, launcher }) => {
    const spec = typeof agent === "string" ? { command: agent, shell: false } : agent;
    if (spec.shell) return ok("agent.command", `${where}: ${spec.command} runs in an interactive shell (aliases are not checked)`);
    const found = findExecutable(spec.command, loaded.env);
    if (found) return ok("agent.command", `${where}: ${spec.command} found (${tildify(found, loaded.env)})`);
    let typed = false;
    try {
      typed = launcherTypesAgent(resolveLauncher(launcher));
    } catch {
      // An invalid launcher is reported by the launcher checks.
    }
    if (typed) {
      return warn(
        "agent.command",
        `${where}: ${spec.command} not found on PATH`,
        `fine if ${spec.command} is a shell alias or function: the ${launcherName(launcher)} launcher types it at an interactive shell's prompt (keep "shell": false); the smoke test proves it`,
      );
    }
    return warn("agent.command", `${where}: ${spec.command} not found on PATH`, `install it, or set "shell": true if ${spec.command} is a shell alias or function`);
  });
}

/** Loads the config, or returns the check that says why it can't be loaded. */
export function configLoadCheck(ctx: Context): { loaded: LoadedConfig | null; check: Check } {
  try {
    const loaded = ctx.config;
    const shown = tildify(loaded.file, ctx.env);
    if (!loaded.exists) return { loaded, check: warn("config.load", `config: ${shown} not found, using defaults`, "run agent-tasks init to create it") };
    return { loaded, check: ok("config.load", `config: ${shown} is valid`) };
  } catch (err) {
    if (!(err instanceof AgentTasksError)) throw err;
    const file = tildify(resolveConfigLocation(ctx.env).configFile, ctx.env);
    return { loaded: null, check: fail("config.load", `config: ${file} is invalid`, "fix the listed fields (see examples/config.example.json)", err.details.length > 0 ? err.details : [err.message]) };
  }
}

/** Every check of `config check`, in display order, and the config when it loads. */
export function configChecks(ctx: Context): { checks: Check[]; loaded: LoadedConfig | null } {
  const { loaded, check } = configLoadCheck(ctx);
  const checks = [check];
  checks.push(...templateChecks(join(resolveConfigLocation(ctx.env).configDir, "templates"), ctx.env));
  if (loaded) checks.push(...instructionChecks(loaded), ...launcherChecks(loaded), ...agentChecks(loaded));
  return { checks, loaded };
}
