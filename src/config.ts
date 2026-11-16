import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "./errors.ts";
import { type Env, expandHome, resolvePath } from "./paths.ts";
import {
  type AgentSpec,
  CATCH_UP_VALUES,
  type CatchUp,
  Checker,
  checkAgent,
  checkDuration,
  checkEnum,
  checkString,
  checkTimezone,
  checkUnknownKeys,
  isObject,
  KEEP_OPEN_VALUES,
  type KeepOpen,
  type Task,
} from "./schema.ts";
import { notifierErrors } from "./notifiers/config.ts";
import type { NotifierConfig } from "./notifiers/types.ts";
import { defaultMaxDelay, formatDuration, parseDuration } from "./duration.ts";
import { systemTimezone } from "./time.ts";

// ---------------------------------------------------------------------------
// Types (see doc/roadmap/user-config.md)
// ---------------------------------------------------------------------------

/**
 * A launcher: a preset name, optionally with some of its commands overridden,
 * or every command written by hand. The commands themselves are validated by
 * the launcher module, not here.
 */
export interface LauncherConfig {
  preset?: string;
  [key: string]: unknown;
}

export interface Profile {
  match: string;
  agent?: AgentSpec | string;
  launcher?: LauncherConfig;
  skill?: string;
  env?: Record<string, string>;
  instructions?: string[];
  catch_up?: CatchUp;
  max_delay?: string;
  timeout?: string;
  keep_open?: KeepOpen;
}

export interface UserConfig {
  $schema?: string;
  data_dir?: string;
  timezone?: string;
  runner?: { every?: string };
  launcher?: LauncherConfig;
  agent?: AgentSpec | string;
  skill?: string;
  profiles?: Profile[];
  instructions?: { subagent?: string[]; supervisor?: string[] };
  notifiers?: NotifierConfig[];
  supervisor?: Record<string, unknown>;
  defaults?: { catch_up?: CatchUp; max_delay?: string; timeout?: string; keep_open?: KeepOpen };
}

export interface LoadedConfig {
  /** Path of config.json, whether or not it exists. */
  file: string;
  /** Folder of config.json; relative paths in the config resolve against it. */
  dir: string;
  exists: boolean;
  config: UserConfig;
  env: Env;
}

/** The project's own defaults, used when neither the task nor the config sets a value. */
export const BUILTIN_DEFAULTS: Readonly<{
  agent: ResolvedAgent;
  launcher: LauncherConfig;
  skill: string;
  runner_every: string;
  catch_up: CatchUp;
  timeout: string;
  keep_open: KeepOpen;
  retries: number;
}> = {
  agent: { command: "claude", args: [], shell: false },
  launcher: { preset: "process" },
  skill: "run-agent-task",
  runner_every: "5m",
  catch_up: "latest",
  timeout: "45m",
  keep_open: "on_failure",
  retries: 0,
};

// ---------------------------------------------------------------------------
// Loading and validation
// ---------------------------------------------------------------------------

const ROOT_FIELDS = [
  "$schema",
  "data_dir",
  "timezone",
  "runner",
  "launcher",
  "agent",
  "skill",
  "profiles",
  "instructions",
  "notifiers",
  "supervisor",
  "defaults",
] as const;

const PROFILE_FIELDS = [
  "match",
  "agent",
  "launcher",
  "skill",
  "env",
  "instructions",
  "catch_up",
  "max_delay",
  "timeout",
  "keep_open",
] as const;

function checkStringArray(c: Checker, value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.trim() !== "")) {
    c.fail("must be an array of non-empty strings");
  }
}

function checkLauncher(c: Checker, value: unknown): void {
  if (value === undefined) return;
  if (!isObject(value)) {
    c.fail('must be an object, e.g. { "preset": "process" }');
    return;
  }
  checkString(c.at("preset"), value.preset, { optional: true });
}

function checkProfile(c: Checker, value: unknown): void {
  if (!isObject(value)) {
    c.fail("must be an object with a `match` glob");
    return;
  }
  checkUnknownKeys(c, value, PROFILE_FIELDS);
  checkString(c.at("match"), value.match);
  checkAgent(c.at("agent"), value.agent);
  checkLauncher(c.at("launcher"), value.launcher);
  checkString(c.at("skill"), value.skill, { optional: true });
  if (value.env !== undefined) {
    if (!isObject(value.env) || !Object.values(value.env).every((v) => typeof v === "string")) {
      c.at("env").fail("must be an object of string values");
    }
  }
  checkStringArray(c.at("instructions"), value.instructions);
  checkEnum(c.at("catch_up"), value.catch_up, CATCH_UP_VALUES);
  checkDuration(c.at("max_delay"), value.max_delay);
  checkDuration(c.at("timeout"), value.timeout);
  checkEnum(c.at("keep_open"), value.keep_open, KEEP_OPEN_VALUES);
}

function checkSection(c: Checker, value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (value === undefined) return false;
  if (!isObject(value)) {
    c.fail("must be an object");
    return false;
  }
  checkUnknownKeys(c, value, fields);
  return true;
}

/** Returns the list of problems with a config object; empty when valid. */
export function configErrors(value: unknown): string[] {
  const c = new Checker();
  if (!isObject(value)) {
    c.fail("the config must be a JSON object");
    return c.errors;
  }
  checkUnknownKeys(c, value, ROOT_FIELDS);
  checkString(c.at("data_dir"), value.data_dir, { optional: true });
  checkTimezone(c.at("timezone"), value.timezone);

  if (checkSection(c.at("runner"), value.runner, ["every"])) {
    checkDuration(c.at("runner").at("every"), value.runner.every);
  }
  checkLauncher(c.at("launcher"), value.launcher);
  checkAgent(c.at("agent"), value.agent);
  checkString(c.at("skill"), value.skill, { optional: true });

  if (value.profiles !== undefined) {
    if (!Array.isArray(value.profiles)) c.at("profiles").fail("must be an array");
    else value.profiles.forEach((p, i) => checkProfile(c.at(`profiles[${i}]`), p));
  }

  if (checkSection(c.at("instructions"), value.instructions, ["subagent", "supervisor"])) {
    checkStringArray(c.at("instructions").at("subagent"), value.instructions.subagent);
    checkStringArray(c.at("instructions").at("supervisor"), value.instructions.supervisor);
  }

  c.errors.push(...notifierErrors(value.notifiers));
  if (value.supervisor !== undefined && !isObject(value.supervisor)) c.at("supervisor").fail("must be an object");

  if (checkSection(c.at("defaults"), value.defaults, ["catch_up", "max_delay", "timeout", "keep_open"])) {
    const d = c.at("defaults");
    checkEnum(d.at("catch_up"), value.defaults.catch_up, CATCH_UP_VALUES);
    checkDuration(d.at("max_delay"), value.defaults.max_delay);
    checkDuration(d.at("timeout"), value.defaults.timeout);
    checkEnum(d.at("keep_open"), value.defaults.keep_open, KEEP_OPEN_VALUES);
  }
  return c.errors;
}

/** Loads config.json. A missing file means "all defaults"; an invalid one is an error. */
export function loadConfig(file: string, dir: string, env: Env): LoadedConfig {
  if (!existsSync(file)) return { file, dir, exists: false, config: {}, env };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(file, [`not valid JSON: ${(err as Error).message}`]);
  }
  const errors = configErrors(parsed);
  if (errors.length > 0) throw new ConfigError(file, errors);
  return { file, dir, exists: true, config: parsed as UserConfig, env };
}

// ---------------------------------------------------------------------------
// Resolution: task > first matching profile > config root > built-in defaults
// ---------------------------------------------------------------------------

export interface ResolvedAgent {
  command: string;
  args: string[];
  shell: boolean;
}

export interface Resolved {
  agent: ResolvedAgent;
  launcher: LauncherConfig;
  skill: string;
  env: Record<string, string>;
  /** Absolute paths of the personal instruction files, in reading order. */
  instructions: string[];
  catch_up: CatchUp;
  max_delay: string;
  timeout: string;
  keep_open: KeepOpen;
  retries: number;
  timezone: string;
  runner_every: string;
  /** The `match` of the profile that applied, or null. */
  profile: string | null;
}

export type ResolvedKey = Exclude<keyof Resolved, "profile">;

export type SourceLayer = "task" | "profile" | "config" | "default";

/** Where a value came from: the layer, plus a detail such as the profile's `match`. */
export interface Source {
  layer: SourceLayer;
  detail?: string;
}

export type Sources = Record<ResolvedKey, Source>;

/** `task`, `profile ~/Projects/**`, `config defaults`, `default (…)`. */
export function formatSource(source: Source): string {
  if (!source.detail) return source.layer;
  return source.layer === "default" ? `default (${source.detail})` : `${source.layer} ${source.detail}`;
}

export interface Resolution extends Resolved {
  sources: Sources;
}

function normalizeAgent(agent: AgentSpec | string): ResolvedAgent {
  if (typeof agent === "string") return { command: agent, args: [], shell: false };
  return { command: agent.command, args: [...(agent.args ?? [])], shell: agent.shell ?? false };
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** Whether a profile `match` glob fits a task folder. `dir/**` also matches `dir` itself. */
export function profileMatches(pattern: string, cwd: string, env: Env): boolean {
  const glob = stripTrailingSlash(expandHome(pattern, env));
  const path = stripTrailingSlash(resolvePath(cwd, env));
  if (new Bun.Glob(glob).match(path)) return true;
  return glob.endsWith("/**") && glob.slice(0, -3) === path;
}

export function findProfile(config: UserConfig, cwd: string, env: Env): Profile | null {
  return config.profiles?.find((p) => profileMatches(p.match, cwd, env)) ?? null;
}

/** The candidate values of one setting, strongest first. Missing layers are skipped. */
interface Layers<T> {
  task?: T | null;
  profile?: T | null;
  config?: T | null;
  /** Detail for the config layer, e.g. `defaults` for `config.defaults.*`. */
  configDetail?: string;
  builtin: T;
  builtinDetail?: string;
}

/** The fields `resolveFor` needs; a full Task works, and so does a partial one. */
export type ResolvableTask = Pick<Task, "cwd"> & Partial<Pick<Task, "agent" | "catch_up" | "max_delay" | "timeout" | "retries" | "keep_open" | "schedule">>;

/** Resolves every per-task setting and records where each one came from. */
export function resolveFor(task: ResolvableTask, loaded: LoadedConfig): Resolution {
  const { config, env } = loaded;
  const profile = findProfile(config, task.cwd, env);
  const profileSource: Source = profile ? { layer: "profile", detail: profile.match } : { layer: "profile" };
  const sources = {} as Sources;
  const take = <T>(key: ResolvedKey, l: Layers<T>): T => {
    const candidates: [T | null | undefined, Source][] = [
      [l.task, { layer: "task" }],
      [l.profile, profileSource],
      [l.config, l.configDetail ? { layer: "config", detail: l.configDetail } : { layer: "config" }],
    ];
    for (const [value, source] of candidates) {
      if (value !== undefined && value !== null) {
        sources[key] = source;
        return value;
      }
    }
    sources[key] = l.builtinDetail ? { layer: "default", detail: l.builtinDetail } : { layer: "default" };
    return l.builtin;
  };
  const builtin = structuredClone(BUILTIN_DEFAULTS);
  const defaults = config.defaults;

  const agent = normalizeAgent(take<AgentSpec | string>("agent", { task: task.agent, profile: profile?.agent, config: config.agent, builtin: builtin.agent }));
  const launcher = structuredClone(take("launcher", { profile: profile?.launcher, config: config.launcher, builtin: builtin.launcher }));
  const skill = take("skill", { profile: profile?.skill, config: config.skill, builtin: builtin.skill });
  const catch_up = take("catch_up", { task: task.catch_up, profile: profile?.catch_up, config: defaults?.catch_up, configDetail: "defaults", builtin: builtin.catch_up });
  const timeout = take("timeout", { task: task.timeout, profile: profile?.timeout, config: defaults?.timeout, configDetail: "defaults", builtin: builtin.timeout });
  const keep_open = take("keep_open", { task: task.keep_open, profile: profile?.keep_open, config: defaults?.keep_open, configDetail: "defaults", builtin: builtin.keep_open });
  const retries = take("retries", { task: task.retries, builtin: builtin.retries });
  const runner_every = take("runner_every", { config: config.runner?.every, builtin: builtin.runner_every });
  const timezone = take("timezone", {
    task: task.schedule?.type === "cron" ? task.schedule.timezone : undefined,
    config: config.timezone,
    builtin: systemTimezone(),
    builtinDetail: "system",
  });
  const max_delay = take("max_delay", {
    task: task.max_delay,
    profile: profile?.max_delay,
    config: defaults?.max_delay,
    configDetail: "defaults",
    builtin: formatDuration(defaultMaxDelay(parseDuration(runner_every))),
    builtinDetail: "3 × runner.every, at least 15m",
  });

  // Environment and instructions add up instead of replacing each other.
  const envVars = { ...(profile?.env ?? {}) };
  sources.env = profile?.env ? profileSource : { layer: "default" };

  const instructionsDir = join(loaded.dir, "instructions");
  const rootInstructions = config.instructions?.subagent ?? [];
  const profileInstructions = profile?.instructions ?? [];
  const instructions = [...rootInstructions, ...profileInstructions].map((f) => resolvePath(f, env, instructionsDir));
  if (profileInstructions.length > 0) {
    sources.instructions = rootInstructions.length > 0 ? { ...profileSource, detail: `${profileSource.detail} (after config)` } : profileSource;
  } else {
    sources.instructions = rootInstructions.length > 0 ? { layer: "config" } : { layer: "default" };
  }

  return {
    agent,
    launcher,
    skill,
    env: envVars,
    instructions,
    catch_up,
    max_delay,
    timeout,
    keep_open,
    retries,
    timezone,
    runner_every,
    profile: profile?.match ?? null,
    sources,
  };
}
