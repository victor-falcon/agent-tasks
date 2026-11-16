import type { Command } from "./commands/types.ts";
import { type LoadedConfig, loadConfig, type Resolution, type ResolvableTask, resolveFor } from "./config.ts";
import { withSchema } from "./output/json.ts";
import { buildPaths, type Env, type Paths, resolveConfigLocation, resolveDataDir } from "./paths.ts";

export interface Writer {
  write(text: string): void;
  /** Set by terminals (`process.stdout.isTTY`); decides whether output is colored. */
  isTTY?: boolean;
}

/** Everything a command needs; built once per CLI invocation. */
export interface Context {
  /** The clock: `--now` or the real time. Commands never call `new Date()` for "now". */
  now: Date;
  json: boolean;
  env: Env;
  cwd: string;
  stdout: Writer;
  stderr: Writer;
  /** The command registry (for `help`). */
  commands: readonly Command[];
  /** Resolved paths. Loads the config on first use (data_dir may come from it). */
  readonly paths: Paths;
  /** The user config. Loaded on first use, so `help` works even with a broken config. */
  readonly config: LoadedConfig;
  /** Resolves agent, launcher, skill, timeouts… for a task (see `resolveFor`). */
  resolveFor(task: ResolvableTask): Resolution;
}

export type ContextOptions = Pick<Context, "now" | "json" | "env" | "cwd" | "stdout" | "stderr" | "commands">;

export function createContext(opts: ContextOptions): Context {
  const configLocation = resolveConfigLocation(opts.env);
  let config: LoadedConfig | undefined;
  let paths: Paths | undefined;
  const ctx: Context = {
    ...opts,
    get config() {
      config ??= loadConfig(configLocation.configFile, configLocation.configDir, opts.env);
      return config;
    },
    get paths() {
      paths ??= buildPaths(configLocation, resolveDataDir(opts.env, ctx.config.config.data_dir, configLocation.configDir));
      return paths;
    },
    resolveFor(task) {
      return resolveFor(task, ctx.config);
    },
  };
  return ctx;
}

/** Prints `data` as JSON (with `"schema": 1`) with `--json`, otherwise the human text. */
export function output(ctx: Pick<Context, "json" | "stdout">, data: object, human: string | (() => string)): void {
  if (ctx.json) ctx.stdout.write(`${JSON.stringify(withSchema(data), null, 2)}\n`);
  else {
    const text = typeof human === "function" ? human() : human;
    ctx.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }
}
