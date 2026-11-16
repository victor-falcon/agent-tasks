import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type Env = Record<string, string | undefined>;

/** Root of the agent-tasks code (the folder that holds `src/` and `package.json`). */
export const REPO_ROOT = resolve(import.meta.dir, "..");

export const DEFAULT_DATA_DIR = "~/.local/share/agent-tasks";
export const DEFAULT_CONFIG_FILE = "~/.config/agent-tasks/config.json";

export function homeDir(env: Env): string {
  return env.HOME || homedir();
}

/** Expands a leading `~` or `~/` to the user's home. */
export function expandHome(path: string, env: Env): string {
  if (path === "~") return homeDir(env);
  if (path.startsWith("~/")) return join(homeDir(env), path.slice(2));
  return path;
}

/** Expands `~` and makes the path absolute (relative paths resolve against `base`). */
export function resolvePath(path: string, env: Env, base = process.cwd()): string {
  const expanded = expandHome(path, env);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

/** Replaces the home prefix with `~` for display. */
export function tildify(path: string, env: Env): string {
  const home = homeDir(env);
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

export interface ConfigLocation {
  /** Folder with `config.json`, `instructions/`, `templates/` and `skills/`. */
  configDir: string;
  configFile: string;
  source: "env" | "default";
}

/**
 * `$AGENT_TASKS_CONFIG` may point at the config file (`…/config.json`) or at
 * the config folder; anything not ending in `.json` is taken as the folder.
 */
export function resolveConfigLocation(env: Env): ConfigLocation {
  const fromEnv = env.AGENT_TASKS_CONFIG;
  if (fromEnv) {
    const path = resolvePath(fromEnv, env);
    if (path.endsWith(".json")) return { configDir: dirname(path), configFile: path, source: "env" };
    return { configDir: path, configFile: join(path, "config.json"), source: "env" };
  }
  const configFile = resolvePath(DEFAULT_CONFIG_FILE, env);
  return { configDir: dirname(configFile), configFile, source: "default" };
}

export interface DataDirLocation {
  dataDir: string;
  source: "env" | "config" | "default";
}

/** `$AGENT_TASKS_HOME` > `data_dir` in config.json (relative to the config folder) > default. */
export function resolveDataDir(env: Env, configDataDir: string | undefined, configDir: string): DataDirLocation {
  if (env.AGENT_TASKS_HOME) return { dataDir: resolvePath(env.AGENT_TASKS_HOME, env), source: "env" };
  if (configDataDir) return { dataDir: resolvePath(configDataDir, env, configDir), source: "config" };
  return { dataDir: resolvePath(DEFAULT_DATA_DIR, env), source: "default" };
}

/** Every location inside the data folder. */
export interface DataPaths {
  dataDir: string;
  tasksDir: string;
  runsDir: string;
  archiveDir: string;
  stateDir: string;
  ticksFile: string;
}

export function dataPaths(dataDir: string): DataPaths {
  const stateDir = join(dataDir, "state");
  return {
    dataDir,
    tasksDir: join(dataDir, "tasks"),
    runsDir: join(dataDir, "runs"),
    archiveDir: join(dataDir, "archive"),
    stateDir,
    ticksFile: join(stateDir, "ticks.jsonl"),
  };
}

export interface Paths extends DataPaths {
  repoRoot: string;
  configDir: string;
  configFile: string;
  instructionsDir: string;
  templatesDir: string;
  skillsDir: string;
  sources: { config: ConfigLocation["source"]; dataDir: DataDirLocation["source"] };
}

export function buildPaths(config: ConfigLocation, data: DataDirLocation): Paths {
  return {
    repoRoot: REPO_ROOT,
    configDir: config.configDir,
    configFile: config.configFile,
    instructionsDir: join(config.configDir, "instructions"),
    templatesDir: join(config.configDir, "templates"),
    skillsDir: join(config.configDir, "skills"),
    ...dataPaths(data.dataDir),
    sources: { config: config.source, dataDir: data.source },
  };
}
