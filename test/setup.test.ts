import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { makeTempHome, runCli, type TempHome } from "./helpers.ts";

const REPO = resolve(import.meta.dir, "..");
const NOW = "2026-11-17T09:00:00+01:00";

let home: TempHome;
let binDir: string;
let skillsDir: string;
let fakeBin: string;

/** A folder of stub programs, put first on PATH. */
function stub(name: string, script = "#!/bin/sh\nexit 0\n"): void {
  const file = join(fakeBin, name);
  writeFileSync(file, script);
  chmodSync(file, 0o755);
}

beforeEach(() => {
  home = makeTempHome();
  binDir = join(home.root, "bin");
  skillsDir = join(home.root, "skills");
  fakeBin = join(home.root, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  home.env.PATH = [fakeBin, dirname(process.execPath), "/usr/bin", "/bin"].join(":");
});
afterEach(() => home.cleanup());

const cli = (...args: string[]) => runCli(args, home);
const installArgs = () => ["install", "--bin-dir", binDir, "--skills-dir", skillsDir];

describe("install", () => {
  test("fresh: links the bin and both skills", async () => {
    const r = await cli(...installArgs());
    expect(r.code).toBe(0);
    expect(readlinkSync(join(binDir, "agent-tasks"))).toBe(join(REPO, "bin", "agent-tasks"));
    expect(readlinkSync(join(skillsDir, "run-agent-task"))).toBe(join(REPO, "skills", "run-agent-task"));
    expect(readlinkSync(join(skillsDir, "schedule-agent-task"))).toBe(join(REPO, "skills", "schedule-agent-task"));
    expect(r.stdout).toContain("linked");
  });

  test("idempotent: a second run changes nothing", async () => {
    await cli(...installArgs());
    const r = await cli(...installArgs(), "--json");
    expect(r.code).toBe(0);
    expect(r.json().steps.map((s: any) => s.action)).toEqual(["unchanged", "unchanged", "unchanged"]);
  });

  test("refuses a real file and a foreign link, and changes nothing", async () => {
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(join(skillsDir, "run-agent-task"));
    symlinkSync("/somewhere/else", join(skillsDir, "schedule-agent-task"));
    const r = await cli(...installArgs());
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("not a symlink");
    expect(r.stdout).toContain("a symlink to /somewhere/else");
    expect(r.stdout).toContain("--force");
    expect(existsSync(join(binDir, "agent-tasks"))).toBe(false);
    expect(lstatSync(join(skillsDir, "run-agent-task")).isDirectory()).toBe(true);
    expect(readlinkSync(join(skillsDir, "schedule-agent-task"))).toBe("/somewhere/else");
  });

  test("--force replaces a foreign link and moves a real folder aside", async () => {
    mkdirSync(join(skillsDir, "run-agent-task"), { recursive: true });
    writeFileSync(join(skillsDir, "run-agent-task", "SKILL.md"), "mine");
    symlinkSync("/somewhere/else", join(skillsDir, "schedule-agent-task"));
    const r = await cli(...installArgs(), "--force", "--now", NOW);
    expect(r.code).toBe(0);
    expect(readlinkSync(join(skillsDir, "run-agent-task"))).toBe(join(REPO, "skills", "run-agent-task"));
    expect(readlinkSync(join(skillsDir, "schedule-agent-task"))).toBe(join(REPO, "skills", "schedule-agent-task"));
    expect(readFileSync(join(home.configDir, "backups", "run-agent-task-20261117T080000Z", "SKILL.md"), "utf8")).toBe("mine");
  });

  test("a step that fails is reported and the others still run", async () => {
    writeFileSync(skillsDir, "not a folder");
    const r = await cli(...installArgs(), "--json");
    expect(r.code).toBe(1);
    expect(r.json().steps.map((s: any) => s.action)).toEqual(["created", "failed", "failed"]);
    expect(readlinkSync(join(binDir, "agent-tasks"))).toBe(join(REPO, "bin", "agent-tasks"));
  });

  test("--dry-run prints the plan and creates nothing", async () => {
    const r = await cli(...installArgs(), "--dry-run");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("would link");
    expect(existsSync(binDir)).toBe(false);
    expect(existsSync(skillsDir)).toBe(false);
  });

  test("links the user's own skills from the config folder; one with a repo skill's name wins", async () => {
    for (const name of ["my-skill", "run-agent-task"]) {
      mkdirSync(join(home.configDir, "skills", name), { recursive: true });
      writeFileSync(join(home.configDir, "skills", name, "SKILL.md"), "---\nname: x\n---\n");
    }
    expect((await cli(...installArgs())).code).toBe(0);
    expect(readlinkSync(join(skillsDir, "my-skill"))).toBe(join(home.configDir, "skills", "my-skill"));
    expect(readlinkSync(join(skillsDir, "run-agent-task"))).toBe(join(home.configDir, "skills", "run-agent-task"));
  });

  test("--uninstall removes only its own links", async () => {
    await cli(...installArgs());
    symlinkSync("/somewhere/else", join(skillsDir, "other"));
    mkdirSync(join(skillsDir, "mine"));
    const r = await cli(...installArgs(), "--uninstall");
    expect(r.code).toBe(0);
    expect(existsSync(join(binDir, "agent-tasks"))).toBe(false);
    expect(existsSync(join(skillsDir, "run-agent-task"))).toBe(false);
    expect(existsSync(join(skillsDir, "schedule-agent-task"))).toBe(false);
    expect(readlinkSync(join(skillsDir, "other"))).toBe("/somewhere/else");
    expect(existsSync(join(skillsDir, "mine"))).toBe(true);
  });

  test("--uninstall keeps a foreign file with a skill's name", async () => {
    mkdirSync(join(skillsDir, "run-agent-task"), { recursive: true });
    const r = await cli(...installArgs(), "--uninstall", "--json");
    expect(r.code).toBe(0);
    expect(r.json().steps).toEqual([{ name: "run-agent-task", target: join(skillsDir, "run-agent-task"), action: "kept", reason: "not a symlink" }]);
    expect(existsSync(join(skillsDir, "run-agent-task"))).toBe(true);
  });
});

describe("init", () => {
  test("fresh: creates config.json, subagent.md and the other referenced instruction files", async () => {
    const r = await cli("init");
    expect(r.code).toBe(0);
    const config = JSON.parse(readFileSync(home.configFile, "utf8"));
    expect(config.launcher).toEqual({ preset: "process" });
    // No terminal with the process preset: the agent runs in print mode, prompt last.
    expect(config.agent.command).toBe("claude");
    expect(config.agent.args.at(-1)).toBe("--print");
    expect(r.stdout).toContain("Launcher: process (no Herdr, Rex or tmux found)");
    expect(readFileSync(join(home.configDir, "instructions", "subagent.md"), "utf8")).toContain("<!--");
    for (const f of ["supervisor.md", "work.md"]) expect(existsSync(join(home.configDir, "instructions", f))).toBe(true);
    expect(r.stdout).toContain("Next steps:");
    // The fresh config passes its own check (the agent command may be missing: only a warning).
    const check = await cli("config", "check", "--json");
    expect(check.json().checks.filter((c: any) => c.status === "error")).toEqual([]);
  });

  for (const [variable, preset] of [["HC_TERMINAL_ID", "herdr"], ["REX_SESSION", "rex"], ["TMUX", "tmux"]] as const) {
    test(`picks the ${preset} preset when $${variable} is set, with the interactive agent`, async () => {
      home.env[variable] = "x";
      for (const program of ["hc", "rex", "jq", "tmux"]) stub(program);
      const r = await cli("init", "--json");
      expect(r.code).toBe(0);
      expect(r.json().launcher).toEqual({ preset, reason: `found $${variable}` });
      const config = JSON.parse(readFileSync(home.configFile, "utf8"));
      expect(config.launcher).toEqual({ preset });
      expect(config.agent).toEqual({ command: "claude", args: [], shell: false });
      const check = await cli("config", "check", "--json");
      expect(check.json().checks.filter((c: any) => c.status === "error")).toEqual([]);
    });
  }

  test("Herdr wins over tmux, as in RECIPE.md", async () => {
    Object.assign(home.env, { TMUX: "x", HC_TERMINAL_ID: "t1" });
    expect((await cli("init", "--json")).json().launcher.preset).toBe("herdr");
  });

  test("--launcher overrides the detection; an unknown preset is a usage error", async () => {
    home.env.HC_TERMINAL_ID = "t1";
    const r = await cli("init", "--launcher", "process", "--json");
    expect(r.json().launcher).toEqual({ preset: "process", reason: "--launcher" });
    expect(JSON.parse(readFileSync(home.configFile, "utf8")).launcher).toEqual({ preset: "process" });
    // With the config already there, the flag changes nothing and says so.
    const again = await cli("init", "--launcher", "tmux");
    expect(again.stdout).toContain("--launcher tmux ignored");
    expect(JSON.parse(readFileSync(home.configFile, "utf8")).launcher).toEqual({ preset: "process" });
    const bad = await cli("init", "--launcher", "screen");
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("--launcher must be one of herdr, rex, tmux, process");
  });

  test("never overwrites existing files", async () => {
    home.writeConfig({ timezone: "UTC" });
    mkdirSync(join(home.configDir, "instructions"));
    writeFileSync(join(home.configDir, "instructions", "subagent.md"), "my rules");
    const r = await cli("init", "--json");
    expect(r.code).toBe(0);
    expect(r.json().files.map((f: any) => f.action)).toEqual(["kept", "kept"]);
    expect(r.json().launcher).toBeNull();
    expect(JSON.parse(readFileSync(home.configFile, "utf8"))).toEqual({ timezone: "UTC" });
    expect(readFileSync(join(home.configDir, "instructions", "subagent.md"), "utf8")).toBe("my rules");
    expect(existsSync(join(home.configDir, "instructions", "work.md"))).toBe(false);
  });
});

function writeTemplate(name: string, content: string): void {
  mkdirSync(join(home.configDir, "templates"), { recursive: true });
  writeFileSync(join(home.configDir, "templates", name), content);
}

function writeInstructions(name: string, content: string): void {
  mkdirSync(join(home.configDir, "instructions"), { recursive: true });
  writeFileSync(join(home.configDir, "instructions", name), content);
}

async function errorsOf(): Promise<{ code: number; errors: any[] }> {
  const r = await cli("config", "check", "--json");
  return { code: r.code, errors: r.json().checks.filter((c: any) => c.status === "error") };
}

describe("config check", () => {
  test("a good config passes", async () => {
    stub("claude");
    home.writeConfig({
      launcher: { preset: "process" },
      agent: { command: "claude" },
      instructions: { subagent: ["subagent.md"] },
      profiles: [{ match: "~/work/**", agent: { command: "clc", shell: true }, instructions: ["work.md"] }],
    });
    writeInstructions("subagent.md", "Be brief.");
    writeInstructions("work.md", "Use the work account.");
    writeTemplate("task.md", "{{title}} in {{cwd}}\n{{instructions}}\n{{personal_instructions}}\n{{finish_command}}\n");
    writeTemplate("prompt.md", "Run: agent-tasks task {{run_ref_quoted}} and follow it.");
    const r = await cli("config", "check");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("All checks passed.");
    expect(r.stdout).not.toContain("✕");
  });

  test("an unknown template variable is an error", async () => {
    writeTemplate("prompt.md", "/{{skill}} {{run_reff}}");
    const { code, errors } = await errorsOf();
    expect(code).toBe(1);
    expect(errors[0].message).toContain("{{run_reff}}");
  });

  test("task.md without {{finish_command}} is an error", async () => {
    writeTemplate("task.md", "{{title}}\n{{instructions}}\n");
    const { code, errors } = await errorsOf();
    expect(code).toBe(1);
    expect(errors[0].message).toContain("does not use {{finish_command}}");
  });

  test("a missing instruction file is an error", async () => {
    home.writeConfig({ profiles: [{ match: "~/work/**", instructions: ["work.md"] }] });
    const { code, errors } = await errorsOf();
    expect(code).toBe(1);
    expect(errors[0].message).toContain("profiles[0].instructions: instructions file not found");
  });

  test("a launcher binary that is not on PATH is an error", async () => {
    home.writeConfig({ launcher: { preset: "herdr" } });
    const { code, errors } = await errorsOf();
    expect(code).toBe(1);
    expect(errors.map((e) => e.message)).toEqual([expect.stringContaining("not found on PATH: hc")]);
  });

  test("an invalid config is reported with every problem", async () => {
    home.writeConfig({ launcher: { preset: 3 }, bogus: true });
    const { code, errors } = await errorsOf();
    expect(code).toBe(1);
    expect(errors[0].details.join("\n")).toContain("bogus");
  });

  test("a missing agent command is only a warning", async () => {
    home.writeConfig({ agent: { command: "no-such-agent" } });
    const r = await cli("config", "check", "--json");
    expect(r.code).toBe(0);
    expect(r.json().checks.find((c: any) => c.id === "agent.command").status).toBe("warn");
  });

  test("a missing agent command: the hint depends on whether the launcher types it at a shell prompt", async () => {
    stub("hc");
    home.writeConfig({
      launcher: { preset: "herdr" },
      agent: { command: "my-alias" },
      profiles: [{ match: "~/work/**", launcher: { preset: "process" }, agent: { command: "other-alias" } }],
    });
    const checks = (await cli("config", "check", "--json")).json().checks.filter((c: any) => c.id === "agent.command");
    expect(checks.map((c: any) => [c.status, c.hint])).toEqual([
      ["warn", 'fine if my-alias is a shell alias or function: the preset "herdr" launcher types it at an interactive shell\'s prompt (keep "shell": false); the smoke test proves it'],
      ["warn", 'install it, or set "shell": true if other-alias is a shell alias or function'],
    ]);
  });
});

describe("config instructions", () => {
  test("subagent: config files plus the matching profile's, without comments", async () => {
    const work = join(home.root, "work", "app");
    mkdirSync(work, { recursive: true });
    home.writeConfig({ instructions: { subagent: ["subagent.md"] }, profiles: [{ match: "~/work/**", instructions: ["work.md"] }] });
    writeInstructions("subagent.md", "<!-- an example -->\nBe brief.");
    writeInstructions("work.md", "Use the work account.");
    const r = await cli("config", "instructions", "subagent", "--cwd", work);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Be brief.");
    expect(r.stdout).toContain("Use the work account.");
    expect(r.stdout).not.toContain("an example");
    const outside = await cli("config", "instructions", "subagent", "--json");
    expect(outside.json().files).toEqual([join(home.configDir, "instructions", "subagent.md")]);
  });

  test("supervisor, and an unknown role is a usage error", async () => {
    home.writeConfig({ instructions: { supervisor: ["supervisor.md"] } });
    writeInstructions("supervisor.md", "Notify me on Slack.");
    expect((await cli("config", "instructions", "supervisor")).stdout).toBe("Notify me on Slack.\n");
    expect((await cli("config", "instructions", "boss")).code).toBe(2);
  });
});

describe("doctor", () => {
  async function readyMachine(): Promise<void> {
    symlinkSync(join(REPO, "test", "fixtures", "bin", "hc"), join(fakeBin, "hc"));
    stub("claude");
    home.env.PATH = `${binDir}:${home.env.PATH}`;
    home.env.HC_TERMINAL_ID = "t1";
    home.writeConfig({ launcher: { preset: "herdr" }, agent: { command: "claude" } });
    expect((await cli(...installArgs())).code).toBe(0);
    mkdirSync(home.paths.stateDir, { recursive: true });
    writeFileSync(home.paths.ticksFile, `${JSON.stringify({ at: "2026-11-17T08:58:00Z", mode: "system" })}\n`);
  }
  const doctor = (...args: string[]) => cli("doctor", "--skills-dir", skillsDir, "--now", "2026-11-17T09:00:00Z", ...args);

  test("all good with a fake hc on PATH", async () => {
    await readyMachine();
    const r = await doctor();
    expect(r.stdout).not.toContain("✕");
    expect(r.stdout).not.toContain("! ");
    expect(r.stdout).toContain("✓ runner: last tick 2m ago");
    expect(r.stdout).toContain("$HC_TERMINAL_ID is t1");
    expect(r.code).toBe(0);
  });

  test("missing hc fails with a hint", async () => {
    await readyMachine();
    home.env.PATH = home.env.PATH!.replace(`${fakeBin}:`, "");
    stub("claude");
    const r = await doctor("--json");
    expect(r.code).toBe(1);
    const check = r.json().checks.find((c: any) => c.id === "launcher.command");
    expect(check.status).toBe("error");
    expect(check.message).toContain("hc");
    expect(check.hint).toContain("PATH");
  });

  test("no heartbeat and no $HC_TERMINAL_ID are warnings, not failures", async () => {
    await readyMachine();
    delete home.env.HC_TERMINAL_ID;
    writeFileSync(home.paths.ticksFile, "");
    const r = await doctor("--json");
    expect(r.code).toBe(0);
    const byId = Object.fromEntries(r.json().checks.map((c: any) => [c.id, c.status]));
    expect(byId["runner.heartbeat"]).toBe("warn");
    expect(byId["herdr.terminal"]).toBe("warn");
  });

  test("manual ticks don't count as a runner heartbeat", async () => {
    await readyMachine();
    writeFileSync(home.paths.ticksFile, `${JSON.stringify({ at: "2026-11-17T08:59:00Z", mode: "manual" })}\n`);
    const r = await doctor();
    expect(r.stdout).toContain("! no runner heartbeat yet (only manual ticks in state/ticks.jsonl)");
  });

  test("a data dir that is a file fails", async () => {
    await readyMachine();
    home.env.AGENT_TASKS_HOME = join(home.root, "a-file");
    writeFileSync(home.env.AGENT_TASKS_HOME, "x");
    const r = await doctor("--json");
    expect(r.code).toBe(1);
    expect(r.json().checks.find((c: any) => c.id === "data.writable").status).toBe("error");
  });

  test("a stale heartbeat is a warning", async () => {
    await readyMachine();
    const r = await cli("doctor", "--skills-dir", skillsDir, "--now", "2026-11-17T10:00:00Z");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("! runner: last tick 1h2m ago");
  });

  test("skills not installed and agent-tasks not on PATH fail", async () => {
    const r = await doctor("--json");
    expect(r.code).toBe(1);
    const failed = r.json().checks.filter((c: any) => c.status === "error").map((c: any) => c.id);
    expect(failed).toContain("path.cli");
    expect(failed).toContain("skills.installed");
  });
});

describe("skills", () => {
  for (const [name, mentions] of [
    ["run-agent-task", ["agent-tasks task", "agent-tasks finish"]],
    ["schedule-agent-task", ["agent-tasks add", "agent-tasks list"]],
  ] as const) {
    test(`${name}/SKILL.md has valid frontmatter and the commands it needs`, () => {
      const text = readFileSync(join(REPO, "skills", name, "SKILL.md"), "utf8");
      const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
      expect(match).not.toBeNull();
      const fields = Object.fromEntries(
        match![1]!.split("\n").map((line) => {
          const i = line.indexOf(":");
          return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
        }),
      );
      expect(Object.keys(fields).sort()).toEqual(["argument-hint", "description", "name"]);
      expect(fields.name).toBe(name);
      expect(fields.description!.length).toBeGreaterThan(40);
      for (const m of mentions) expect(text).toContain(m);
    });
  }
});
