import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractGlobalFlags } from "../src/cli.ts";
import { commands } from "../src/commands/index.ts";
import pkg from "../package.json" with { type: "json" };
import { makeTask, makeTempHome, runCli, type TempHome } from "./helpers.ts";

let home: TempHome;
beforeEach(() => {
  home = makeTempHome();
});
afterEach(() => home.cleanup());

describe("global flags", () => {
  test("are pulled out wherever they appear, until --", () => {
    expect(extractGlobalFlags(["config", "--json", "resolve", "--now", "2026-11-17T09:00:00Z", "x", "--", "--json"])).toEqual({
      json: true,
      now: "2026-11-17T09:00:00Z",
      help: false,
      clientProtocol: undefined,
      rest: ["config", "resolve", "x", "--", "--json"],
    });
    expect(extractGlobalFlags(["-h", "--now=2026-11-17T09:00:00Z"])).toMatchObject({ help: true, now: "2026-11-17T09:00:00Z", rest: [] });
  });
});

describe("help", () => {
  test("no arguments, --help and help list every command, exit 0", async () => {
    for (const args of [[], ["--help"], ["help"], ["-h"]]) {
      const r = await runCli(args, home);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Usage: agent-tasks <command>");
      for (const c of commands) {
        if (c.hidden) expect(r.stdout).not.toContain(c.name);
        else expect(r.stdout).toContain(c.name);
      }
    }
  });

  test("hidden commands (remote …) still have their own help", async () => {
    expect(commands.some((c) => c.name === "remote launch" && c.hidden)).toBe(true);
    const r = await runCli(["help", "remote", "launch"], home);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: agent-tasks remote launch");
  });

  test("help for one command, both forms", async () => {
    const a = await runCli(["help", "config", "resolve"], home);
    const b = await runCli(["config", "resolve", "--help"], home);
    expect(a.code).toBe(0);
    expect(a.stdout).toContain("Usage: agent-tasks config resolve <task-id|path>");
    expect(b.stdout).toBe(a.stdout);
  });

  test("no help text has an unexpanded ${…} placeholder", async () => {
    for (const c of commands) {
      const r = await runCli(["help", ...c.name.split(" ")], home);
      expect(r.stdout).not.toContain("${");
    }
    expect((await runCli(["help", "status"], home)).stdout).toContain("could be read; 1 otherwise");
  });

  test("help --json describes the commands", async () => {
    const r = await runCli(["help", "--json"], home);
    expect(r.code).toBe(0);
    expect(r.json().commands.map((c: { name: string }) => c.name)).toEqual(commands.filter((c) => !c.hidden).map((c) => c.name));
  });

  test("help works even with a broken config", async () => {
    home.writeConfig("{ broken");
    expect((await runCli(["--help"], home)).code).toBe(0);
    expect((await runCli(["version"], home)).code).toBe(0);
  });
});

describe("exit codes", () => {
  test("unknown command → 2", async () => {
    const r = await runCli(["frobnicate"], home);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown command "frobnicate"');
    const h = await runCli(["help", "frobnicate"], home);
    expect(h.code).toBe(2);
    expect(h.stderr).toContain('Run "agent-tasks help" for usage.');
  });

  test("group without subcommand → 2, with --help → 0", async () => {
    const r = await runCli(["config"], home);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"config" needs a subcommand: check, instructions, resolve');
    const h = await runCli(["config", "--help"], home);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("config resolve");
  });

  test("bad option or missing argument → 2", async () => {
    expect((await runCli(["version", "--bogus"], home)).code).toBe(2);
    expect((await runCli(["config", "resolve"], home)).code).toBe(2);
    expect((await runCli(["--now", "yesterday", "version"], home)).code).toBe(2);
    expect((await runCli(["version", "--now"], home)).code).toBe(2);
  });

  test("runtime error → 1, as JSON with --json", async () => {
    const r = await runCli(["config", "resolve", "nope", "--json"], home);
    expect(r.code).toBe(1);
    expect(r.json()).toEqual({ schema: 1, error: { code: "not_found", message: expect.stringContaining('task "nope" not found'), details: [] } });
  });

  test("invalid config → 1 with every problem listed", async () => {
    home.writeTask(makeTask());
    home.writeConfig({ runner: { every: "often" }, skill: "" });
    const r = await runCli(["config", "resolve", "weekly-report"], home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Invalid config in ${home.configFile}`);
    expect(r.stderr).toContain("runner.every");
    expect(r.stderr).toContain("skill: must be a non-empty string");
  });
});

describe("version", () => {
  test("text and JSON", async () => {
    expect((await runCli(["version"], home)).stdout).toBe(`agent-tasks ${pkg.version}\n`);
    expect((await runCli(["version", "--json"], home)).json()).toEqual({ schema: 1, name: "agent-tasks", version: pkg.version });
  });
});

describe("config resolve", () => {
  test("by task id, with sources", async () => {
    home.writeTask(makeTask({ cwd: "~/Projects/work/api", timeout: "10m" }));
    home.writeConfig({ launcher: { preset: "herdr" }, profiles: [{ match: "~/Projects/work/**", agent: { command: "clc", shell: true } }] });
    const r = await runCli(["config", "resolve", "weekly-report", "--json"], home);
    expect(r.code).toBe(0);
    const out = r.json();
    expect(out.profile).toBe("~/Projects/work/**");
    expect(out.values.agent).toEqual({ command: "clc", args: [], shell: true });
    expect(out.sources).toMatchObject({ agent: { layer: "profile", detail: "~/Projects/work/**" }, launcher: { layer: "config" }, timeout: { layer: "task" }, skill: { layer: "default" } });

    const text = await runCli(["config", "resolve", "weekly-report"], home);
    expect(text.stdout).toContain("Profile: ~/Projects/work/**");
    expect(text.stdout).toMatch(/agent\s+clc \(shell\)\s+profile ~\/Projects\/work\/\*\*/);
    expect(text.stdout).toMatch(/timeout\s+10m\s+task/);
  });

  test("by path, without a config file", async () => {
    const file = join(home.root, "draft.json");
    writeFileSync(file, JSON.stringify(makeTask({ id: "draft" })));
    const r = await runCli(["config", "resolve", "./draft.json"], home, home.root);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("(not found, using defaults)");
    expect(r.stdout).toMatch(/agent\s+claude\s+default/);
  });

  test("an invalid task file is reported", async () => {
    const file = join(home.root, "bad.json");
    writeFileSync(file, JSON.stringify({ ...makeTask(), schedule: { type: "cron", cron: "every monday" } }));
    const r = await runCli(["config", "resolve", file], home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("schedule.cron: must have 5 fields");
  });
});

describe("bin/agent-tasks", () => {
  test("runs through a symlink from another folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-tasks-bin-"));
    try {
      const link = join(dir, "agent-tasks");
      symlinkSync(resolve(import.meta.dir, "..", "bin", "agent-tasks"), link);
      const proc = Bun.spawn([link, "--help"], { cwd: dir, env: { ...home.env }, stdout: "pipe", stderr: "pipe" });
      const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      expect(code).toBe(0);
      expect(stdout).toContain("Usage: agent-tasks <command>");
      const bad = Bun.spawn([link, "nope"], { cwd: dir, env: { ...home.env }, stdout: "pipe", stderr: "pipe" });
      expect(await bad.exited).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("output past a pipe's buffer reaches a slow reader whole", async () => {
    // What bin/agent-tasks does before exiting (a `top --json` past 64 KiB came
    // out cut): the reader only starts reading once the writer has finished.
    const writer = join(home.root, "big-writer.ts");
    const flush = resolve(import.meta.dir, "..", "src", "flush.ts");
    writeFileSync(
      writer,
      `const { watchBackpressure, exitWhenFlushed } = await import(${JSON.stringify(flush)});\n` +
        `const streams = [watchBackpressure(process.stdout)];\n` +
        `process.stdout.write("x".repeat(200000) + "\\n");\n` +
        `await exitWhenFlushed(0, streams);\n`,
    );
    const proc = Bun.spawn(["sh", "-c", `${JSON.stringify(process.execPath)} ${JSON.stringify(writer)} | (sleep 1; wc -c)`], { stdout: "pipe" });
    expect((await new Response(proc.stdout).text()).trim()).toBe("200001");
  });
});
