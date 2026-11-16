import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { configErrors, formatSource, loadConfig, profileMatches, resolveFor, type UserConfig } from "../src/config.ts";
import { ConfigError } from "../src/errors.ts";
import { resolveConfigLocation, resolveDataDir } from "../src/paths.ts";
import { systemTimezone } from "../src/time.ts";
import { makeTask, makeTempHome, type TempHome } from "./helpers.ts";

let home: TempHome;
beforeEach(() => {
  home = makeTempHome();
});
afterEach(() => home.cleanup());

function load(config?: UserConfig | string) {
  if (config !== undefined) home.writeConfig(config);
  return loadConfig(home.configFile, home.configDir, home.env);
}

describe("paths", () => {
  test("AGENT_TASKS_CONFIG may be the file or the folder", () => {
    expect(resolveConfigLocation({ HOME: "/h", AGENT_TASKS_CONFIG: "/c/my.json" })).toEqual({ configDir: "/c", configFile: "/c/my.json", source: "env" });
    expect(resolveConfigLocation({ HOME: "/h", AGENT_TASKS_CONFIG: "~/cfg" })).toEqual({ configDir: "/h/cfg", configFile: "/h/cfg/config.json", source: "env" });
    expect(resolveConfigLocation({ HOME: "/h" })).toEqual({ configDir: "/h/.config/agent-tasks", configFile: "/h/.config/agent-tasks/config.json", source: "default" });
  });

  test("data dir: env > config data_dir > default", () => {
    expect(resolveDataDir({ HOME: "/h", AGENT_TASKS_HOME: "~/d" }, "/other", "/c")).toEqual({ dataDir: "/h/d", source: "env" });
    expect(resolveDataDir({ HOME: "/h" }, "~/notes/tasks", "/c")).toEqual({ dataDir: "/h/notes/tasks", source: "config" });
    expect(resolveDataDir({ HOME: "/h" }, "data", "/c")).toEqual({ dataDir: "/c/data", source: "config" });
    expect(resolveDataDir({ HOME: "/h" }, undefined, "/c")).toEqual({ dataDir: "/h/.local/share/agent-tasks", source: "default" });
  });
});

describe("loadConfig", () => {
  test("a missing config means built-in defaults", () => {
    const loaded = load();
    expect(loaded.exists).toBe(false);
    const r = resolveFor(makeTask({ retries: undefined, schedule: { type: "once", at: "2026-11-20T09:00:00+01:00" } }), loaded);
    expect(r.agent).toEqual({ command: "claude", args: [], shell: false });
    expect(r.launcher).toEqual({ preset: "process" });
    expect(r.skill).toBe("run-agent-task");
    expect(r.runner_every).toBe("5m");
    expect(r.catch_up).toBe("latest");
    expect(r.timeout).toBe("45m");
    expect(r.keep_open).toBe("on_failure");
    expect(r.max_delay).toBe("15m");
    expect(r.timezone).toBe(systemTimezone());
    expect(r.profile).toBeNull();
    expect(new Set(Object.values(r.sources).map((s) => s.layer))).toEqual(new Set(["default"]));
    expect(formatSource(r.sources.timezone)).toBe("default (system)");
  });

  test("invalid JSON is a clear error", () => {
    expect(() => load("{ nope")).toThrow(ConfigError);
    expect(() => load("{ nope")).toThrow(/not valid JSON/);
  });

  test("validation lists every problem with its path", () => {
    const errors = configErrors({
      timezone: "Mars/Olympus",
      runner: { every: "soon" },
      agent: { command: "" },
      profiles: [{ agent: "clc" }, { match: "~/x/**", keep_open: "sometimes", colour: "red" }],
      defaults: { catch_up: "first" },
      typo: true,
    });
    expect(errors).toEqual([
      "typo: unknown field (allowed: $schema, data_dir, timezone, runner, launcher, agent, skill, profiles, instructions, notifiers, supervisor, defaults)",
      'timezone: must be an IANA time zone such as Europe/Madrid (got "Mars/Olympus")',
      'runner.every: must be a duration such as 15m, 2h or 1d (got "soon")',
      "agent.command: must be a non-empty string",
      "profiles[0].match: must be a non-empty string",
      "profiles[1].colour: unknown field (allowed: match, agent, launcher, skill, env, instructions, catch_up, max_delay, timeout, keep_open)",
      "profiles[1].keep_open: must be one of: always, on_failure, never",
      "defaults.catch_up: must be one of: latest, all, none",
    ]);
    expect(() => load({ runner: { every: "soon" } } as never)).toThrow(/runner\.every/);
  });
});

describe("profile matching", () => {
  const env = { HOME: "/home/me" };
  test("globs with ~ match the task cwd", () => {
    expect(profileMatches("~/Projects/**", "~/Projects/foo/bar", env)).toBe(true);
    expect(profileMatches("~/Projects/**", "/home/me/Projects/foo", env)).toBe(true);
    expect(profileMatches("~/Projects/**", "~/Projects", env)).toBe(true);
    expect(profileMatches("~/Projects/**", "~/Other/foo", env)).toBe(false);
    expect(profileMatches("~/Projects/*", "~/Projects/foo/bar", env)).toBe(false);
    expect(profileMatches("~/Projects/foo/", "~/Projects/foo", env)).toBe(true);
  });
});

describe("resolveFor precedence: task > first matching profile > config root > defaults", () => {
  const config: UserConfig = {
    timezone: "Europe/Madrid",
    runner: { every: "10m" },
    launcher: { preset: "herdr" },
    agent: { command: "claude", args: ["--verbose"] },
    skill: "run-agent-task",
    instructions: { subagent: ["subagent.md"] },
    profiles: [
      { match: "~/Projects/work/**", agent: { command: "clc", shell: true }, env: { SOME_FLAG: "1" }, instructions: ["work.md"], timeout: "2h" },
      { match: "~/Projects/**", agent: "clc", skill: "my-skill", launcher: { preset: "tmux" } },
    ],
    defaults: { catch_up: "all", timeout: "30m", keep_open: "never" },
  };

  test("first matching profile wins over later ones and the root", () => {
    const r = resolveFor(makeTask({ cwd: "~/Projects/work/api" }), load(config));
    expect(r.profile).toBe("~/Projects/work/**");
    expect(r.agent).toEqual({ command: "clc", args: [], shell: true });
    expect(formatSource(r.sources.agent)).toBe("profile ~/Projects/work/**");
    expect(r.env).toEqual({ SOME_FLAG: "1" });
    expect(r.timeout).toBe("2h");
    expect(formatSource(r.sources.timeout)).toBe("profile ~/Projects/work/**");
    // Not set by the first profile: falls through to the root, not to the second profile.
    expect(r.skill).toBe("run-agent-task");
    expect(formatSource(r.sources.skill)).toBe("config");
    expect(r.launcher).toEqual({ preset: "herdr" });
    expect(r.instructions).toEqual([join(home.configDir, "instructions", "subagent.md"), join(home.configDir, "instructions", "work.md")]);
    expect(formatSource(r.sources.instructions)).toBe("profile ~/Projects/work/** (after config)");
  });

  test("second profile applies when the first does not match", () => {
    const r = resolveFor(makeTask({ cwd: "~/Projects/side" }), load(config));
    expect(r.profile).toBe("~/Projects/**");
    expect(r.agent).toEqual({ command: "clc", args: [], shell: false });
    expect(r.skill).toBe("my-skill");
    expect(r.launcher).toEqual({ preset: "tmux" });
    expect(r.timeout).toBe("30m");
    expect(formatSource(r.sources.timeout)).toBe("config defaults");
    expect(r.env).toEqual({});
  });

  test("no profile: config root, then built-in defaults", () => {
    const r = resolveFor(makeTask({ cwd: "/srv/app" }), load(config));
    expect(r.profile).toBeNull();
    expect(r.agent).toEqual({ command: "claude", args: ["--verbose"], shell: false });
    expect(formatSource(r.sources.agent)).toBe("config");
    expect(r.catch_up).toBe("all");
    expect(r.keep_open).toBe("never");
    expect(r.runner_every).toBe("10m");
    expect(r.max_delay).toBe("30m");
    expect(formatSource(r.sources.max_delay)).toBe("default (3 × runner.every, at least 15m)");
    expect(r.timezone).toBe("Europe/Madrid");
  });

  test("the task beats everything", () => {
    const task = makeTask({
      cwd: "~/Projects/work/api",
      agent: "codex",
      timeout: "5m",
      catch_up: "none",
      keep_open: "always",
      max_delay: "1h",
      retries: 2,
      schedule: { type: "cron", cron: "0 9 * * *", timezone: "America/New_York" },
    });
    const r = resolveFor(task, load(config));
    expect(r.agent).toEqual({ command: "codex", args: [], shell: false });
    expect(r.timeout).toBe("5m");
    expect(r.catch_up).toBe("none");
    expect(r.keep_open).toBe("always");
    expect(r.max_delay).toBe("1h");
    expect(r.retries).toBe(2);
    expect(r.timezone).toBe("America/New_York");
    for (const key of ["agent", "timeout", "catch_up", "keep_open", "max_delay", "retries", "timezone"] as const) {
      expect(formatSource(r.sources[key])).toBe("task");
    }
  });
});
