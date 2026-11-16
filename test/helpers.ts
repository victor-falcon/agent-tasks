import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import type { UserConfig } from "../src/config.ts";
import { dataPaths, type DataPaths, type Env } from "../src/paths.ts";
import type { Task } from "../src/schema.ts";

export interface TempHome {
  /** Fake `$HOME`. */
  root: string;
  dataDir: string;
  configDir: string;
  configFile: string;
  paths: DataPaths;
  /** Environment pointing every agent-tasks location at the temp folder. */
  env: Env;
  writeConfig(config: UserConfig | Record<string, unknown> | string): void;
  writeTask(task: Task): string;
  cleanup(): void;
}

/**
 * Creates a throwaway home with its own data and config folders, and points
 * `$HOME`, `$AGENT_TASKS_HOME` and `$AGENT_TASKS_CONFIG` at it (in the
 * returned env and in process.env), so no test touches the real home.
 */
export function makeTempHome(): TempHome {
  const root = mkdtempSync(join(tmpdir(), "agent-tasks-test-"));
  const dataDir = join(root, "data");
  const configDir = join(root, "config");
  const configFile = join(configDir, "config.json");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const env: Env = { HOME: root, AGENT_TASKS_HOME: dataDir, AGENT_TASKS_CONFIG: configFile, PATH: process.env.PATH };
  const previous = { HOME: process.env.HOME, AGENT_TASKS_HOME: process.env.AGENT_TASKS_HOME, AGENT_TASKS_CONFIG: process.env.AGENT_TASKS_CONFIG };
  Object.assign(process.env, { HOME: root, AGENT_TASKS_HOME: dataDir, AGENT_TASKS_CONFIG: configFile });
  const paths = dataPaths(dataDir);
  return {
    root,
    dataDir,
    configDir,
    configFile,
    paths,
    env,
    writeConfig(config) {
      writeFileSync(configFile, typeof config === "string" ? config : JSON.stringify(config, null, 2));
    },
    writeTask(task) {
      mkdirSync(paths.tasksDir, { recursive: true });
      const file = join(paths.tasksDir, `${task.id}.json`);
      writeFileSync(file, JSON.stringify(task, null, 2));
      return file;
    },
    cleanup() {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "weekly-report",
    title: "Weekly report",
    description: null,
    cwd: "~/Projects/foo",
    instructions: "Write the report.",
    schedule: { type: "cron", cron: "0 9 * * 1", timezone: "Europe/Madrid", starts_at: null, until: null },
    agent: null,
    catch_up: null,
    max_delay: null,
    timeout: null,
    retries: 0,
    keep_open: null,
    enabled: true,
    created_at: "2026-11-01T00:00:00Z",
    created_by: null,
    updated_at: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json<T = any>(): T;
}

/** Runs the CLI in-process with captured output. */
export async function runCli(args: string[], home: TempHome, cwd = home.root): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    env: home.env,
    cwd,
    stdout: { write: (t) => void (stdout += t) },
    stderr: { write: (t) => void (stderr += t) },
  });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}
