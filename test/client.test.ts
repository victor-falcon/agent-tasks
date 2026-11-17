import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEMO_REF, type ExecHome, execTask, FAKE_BIN, makeExecHome, REPO, settled, waitFor } from "./exec-helpers.ts";
import { makeTask, makeTempHome, runCli, type TempHome } from "./helpers.ts";

const NOW = "--now=2026-11-17T09:00:00+01:00";
const HUB_CONFIG = { timezone: "Europe/Madrid", machine: "wsl", machines: { mac: { ssh: "mac" } } };

interface Setup {
  hub: ExecHome;
  client: TempHome;
  /** The client's current folder for commands. */
  project: string;
  sshDir: string;
  sshCalls(): { options: string[]; alias: string; line: string; stdin: string }[];
  cli(...args: string[]): ReturnType<typeof runCli>;
  /** Runs the real `agent-tasks` binary on the client, with stdin. */
  spawnCli(args: string[], stdin: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

/**
 * A hub (an exec home, with `~/.local/bin/agent-tasks` linked to this repo)
 * and a client whose config points at it through the fake `ssh` (alias "hub").
 */
function makeSetup(): Setup {
  const hub = makeExecHome();
  hub.writeConfig(HUB_CONFIG);
  mkdirSync(join(hub.root, ".local", "bin"), { recursive: true });
  symlinkSync(join(REPO, "bin", "agent-tasks"), join(hub.root, ".local", "bin", "agent-tasks"));

  const client = makeTempHome();
  client.writeConfig({ machine: "mac", hub: { ssh: "hub" } });
  const project = join(client.root, "project");
  mkdirSync(project, { recursive: true });
  const sshDir = join(client.root, "ssh");
  mkdirSync(sshDir, { recursive: true });
  const { PATH: _, ...hubEnv } = hub.env;
  writeFileSync(join(sshDir, "hosts.json"), JSON.stringify({ hub: { ...hubEnv, PATH: hub.env.PATH } }));
  Object.assign(client.env, { PATH: [FAKE_BIN, dirname(process.execPath), process.env.PATH].join(":"), FAKE_SSH_DIR: sshDir });

  return {
    hub,
    client,
    project,
    sshDir,
    sshCalls() {
      const file = join(sshDir, "calls.jsonl");
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
    cli: (...args) => runCli(args, client, project),
    async spawnCli(args, stdin) {
      const child = Bun.spawn({
        cmd: [join(REPO, "bin", "agent-tasks"), ...args],
        cwd: project,
        env: client.env as Record<string, string>,
        stdin: new TextEncoder().encode(stdin),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { code, stdout, stderr };
    },
  };
}

let s: Setup;
beforeEach(() => {
  s = makeSetup();
});
afterEach(() => {
  s.client.cleanup();
  s.hub.cleanup();
});

const addFlags = ["--cron", "0 9 * * 1", "--instructions", "Do it."];

describe("client mode: forwarding to the hub", () => {
  test("a data command runs on the hub, with its output and exit code", async () => {
    s.hub.writeTask(makeTask({ id: "on-hub", machine: "wsl" }));
    const list = await s.cli("list", "--json", NOW);
    expect(list.code).toBe(0);
    expect(list.json().tasks.map((t: { id: string }) => t.id)).toEqual(["on-hub"]);

    const [call] = s.sshCalls();
    expect(call!.alias).toBe("hub");
    expect(call!.options).toEqual(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-T"]);
    expect(call!.line).toBe("~/.local/bin/agent-tasks --json --now=2026-11-17T09:00:00+01:00 list");

    const missing = await s.cli("show", "nope", NOW);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("nope");
    const missingJson = await s.cli("show", "nope", "--json", NOW);
    expect(missingJson.code).toBe(1);
    expect(missingJson.json().error.code).toBe("not_found");
    // The client keeps no data.
    expect(existsSync(s.client.paths.tasksDir)).toBe(false);
  });

  test("help, version, init, install, doctor and config run on the client", async () => {
    expect((await s.cli("help")).code).toBe(0);
    expect((await s.cli("list", "--help")).code).toBe(0);
    expect((await s.cli("version")).code).toBe(0);
    const resolved = await s.cli("config", "check", "--json");
    expect(resolved.stdout).toContain("config");
    expect(s.sshCalls()).toEqual([]);
  });

  test("runner and tick are refused on a client", async () => {
    for (const args of [["runner", "--once"], ["tick"]]) {
      const r = await s.cli(...args, "--json");
      expect(r.code).toBe(1);
      expect(r.json().error).toMatchObject({ code: "hub_only", message: `"${args[0]}" runs on the hub ("hub"), not on a client; run it there` });
    }
    // `runner status` only reads the hub's state.
    const status = await s.cli("runner", "status", "--json");
    expect(status.json().running).toBe(false);
    expect(s.sshCalls().map((c) => c.line)).toEqual(["~/.local/bin/agent-tasks --json runner status"]);
  });

  test("an unreachable hub is a clear error", async () => {
    s.client.writeConfig({ machine: "mac", hub: { ssh: "gone" } });
    const human = await s.cli("list");
    expect(human.code).toBe(1);
    expect(human.stderr).toBe('agent-tasks: cannot reach the hub "gone" over SSH: ssh: connect to host gone port 22: Connection refused\n');
    const json = await s.cli("list", "--json");
    expect(json.code).toBe(1);
    expect(json.stderr).toBe("");
    expect(json.json().error).toEqual({ code: "hub_unreachable", message: 'cannot reach the hub "gone" over SSH: ssh: connect to host gone port 22: Connection refused', details: [] });
  });

  test("a hub without agent-tasks installed is a clear error", async () => {
    rmSync(join(s.hub.root, ".local", "bin", "agent-tasks"));
    const r = await s.cli("list", "--json");
    expect(r.code).toBe(1);
    expect(r.json().error.code).toBe("hub_unreachable");
    expect(r.json().error.message).toContain('cannot reach the hub "hub" over SSH: could not run ~/.local/bin/agent-tasks there: install agent-tasks on the hub');
  });

  test("a client must name itself", async () => {
    s.client.writeConfig({ hub: { ssh: "hub" } });
    const r = await s.cli("list", "--json");
    expect(r.code).toBe(1);
    expect(r.json().error.details).toEqual(['machine: a client (with `hub`) must name itself, e.g. "machine": "mac", as the hub\'s `machines` knows it']);
    expect(s.sshCalls()).toEqual([]);
  });
});

describe("client mode: add and edit", () => {
  test("add defaults to this client's machine and folder, and records where it was created", async () => {
    const r = await s.cli("add", "--title", "From mac", ...addFlags, "--json", NOW);
    expect(r.code).toBe(0);
    expect(r.json().task).toMatchObject({ id: "from-mac", machine: "mac", cwd: "~/project", created_by: { cwd: "~/project", session: null } });
    expect(existsSync(join(s.hub.paths.tasksDir, "from-mac.json"))).toBe(true);

    // The folder is the client's, so the hub doesn't look for it.
    mkdirSync(join(s.project, "only-on-mac"));
    const sub = await s.cli("add", "--title", "Sub", ...addFlags, "--cwd", "only-on-mac", "--json", NOW);
    expect(sub.code).toBe(0);
    expect(sub.json().task.cwd).toBe("~/project/only-on-mac");
  });

  test("add checks a folder of this client on the client", async () => {
    const r = await s.cli("add", "--title", "Bad", ...addFlags, "--cwd", "missing", "--json");
    expect(r.code).toBe(1);
    expect(r.json().error).toMatchObject({ code: "invalid_cwd", message: `cwd does not exist or is not a folder: ${join(s.project, "missing")}` });
    expect(s.sshCalls()).toEqual([]);
  });

  test("add for another machine needs --cwd", async () => {
    const r = await s.cli("add", "--title", "On hub", ...addFlags, "--machine", "wsl", "--json", NOW);
    expect(r.code).toBe(2);
    expect(r.json().error.message).toBe('a task on machine "wsl" needs --cwd: this folder is on this machine ("mac")');
    expect(s.sshCalls()).toEqual([]);
  });

  test("add for another machine keeps an absolute or ~ folder as given", async () => {
    const r = await s.cli("add", "--title", "On hub", ...addFlags, "--machine", "wsl", "--cwd", "~/project", "--json", NOW);
    expect(r.code).toBe(0);
    // ~/project exists on the hub (the exec home's project), where it was checked.
    expect(r.json().task).toMatchObject({ machine: "wsl", cwd: "~/project" });
  });

  test("add reads the task JSON and the instructions file on the client", async () => {
    writeFileSync(join(s.project, "prompt.md"), "  Prompt from a file.\n");
    const task = { title: "From stdin", schedule: { type: "cron", cron: "0 9 * * 1" }, cwd: "." };
    const r = await s.spawnCli(["add", "-", "--instructions-file", "prompt.md", "--json", NOW], JSON.stringify(task));
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).task).toMatchObject({ id: "from-stdin", machine: "mac", cwd: "~/project", instructions: "Prompt from a file." });
    const [call] = s.sshCalls();
    expect(JSON.parse(call!.stdin)).toEqual(task);
  });

  test("edit --cwd and a patch file are read on the client", async () => {
    s.hub.writeTask(makeTask({ id: "job", machine: "mac", cwd: "~/project" }));
    mkdirSync(join(s.project, "sub"));
    const moved = await s.cli("edit", "job", "--cwd", "sub", "--json", NOW);
    expect(moved.code).toBe(0);
    expect(moved.json().task.cwd).toBe("~/project/sub");

    writeFileSync(join(s.project, "patch.json"), JSON.stringify({ title: "Patched", cwd: "." }));
    const patched = await s.cli("edit", "job", "--file", "patch.json", "--json", NOW);
    expect(patched.code).toBe(0);
    expect(patched.json().task).toMatchObject({ title: "Patched", cwd: "~/project" });
  });
});

describe("client mode: a subagent on the client", () => {
  test("finish forwards the result, its output file and attempt to the hub", async () => {
    execTask(s.hub, "hang");
    await s.hub.tick(1);
    // Not valid UTF-8: the bytes must arrive as they are.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x0a]);
    writeFileSync(join(s.project, "report.png"), bytes);
    const r = await s.cli("finish", DEMO_REF, "--status", "succeeded", "--summary=- all done", "--output-file", "report.png", "--json");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ run_ref: DEMO_REF, status: "succeeded", summary: "- all done", output: "runs/demo/20261117T080000Z.output.png" });
    expect(new Uint8Array(readFileSync(join(s.hub.dataDir, "runs/demo/20261117T080000Z.output.png")))).toEqual(bytes);
    await waitFor(settled(s.hub), "the session to settle");
  });

  test("finish passes the launcher's attempt on to the hub", async () => {
    execTask(s.hub, "hang");
    await s.hub.tick(1);
    Object.assign(s.client.env, { AGENT_TASKS_RUN: DEMO_REF, AGENT_TASKS_ATTEMPT: "2" });
    const r = await s.cli("finish", DEMO_REF, "--status", "succeeded", "--summary", "Done", "--json");
    expect(r.code).toBe(1);
    expect(r.json().error.code).toBe("stale_attempt");
    expect(s.sshCalls()[0]!.line).toStartWith(`AGENT_TASKS_RUN=${DEMO_REF} AGENT_TASKS_ATTEMPT=2 ~/.local/bin/agent-tasks`);
    await s.hub.cli("session", "close", DEMO_REF);
  });

  test("task prints the hub's instructions for the run", async () => {
    execTask(s.hub, "hang");
    await s.hub.tick(1);
    const r = await s.cli("task", DEMO_REF, "--json");
    expect(r.code).toBe(0);
    expect(r.json().text).toContain("Demo task");
    await s.hub.cli("session", "close", DEMO_REF);
  });
});
