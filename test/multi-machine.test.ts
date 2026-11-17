import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTopLevelKeys } from "../src/config-edit.ts";
import type { Env } from "../src/paths.ts";
import { HUB_CONFIG, makeSetup, type Setup } from "./client-setup.ts";
import { at, DEMO_REF, execTask, FAKE_AGENT, REPO, waitFor } from "./exec-helpers.ts";
import { makeTask } from "./helpers.ts";

// t4 of multi-machine: protocol checks, `remote ping`, `machines …`,
// `init --join`, doctor, and attach / log --follow across machines. A hub
// ("wsl", ssh alias "hub") and a client ("mac", ssh alias "mac") live on one
// host through the fake `ssh` (test/fixtures/fake-ssh.ts).

setDefaultTimeout(30_000);

let s: Setup;
beforeEach(() => {
  s = makeSetup();
});
afterEach(() => {
  s.client.cleanup();
  s.hub.cleanup();
});

/** Runs the real `agent-tasks` binary with an env, as a child process with pipes (attach hands its stdio over). */
async function spawnAt(env: Env, cwd: string, args: string[], stdin = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn({ cmd: [join(REPO, "bin", "agent-tasks"), ...args], cwd, env: env as Record<string, string>, stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

/** Replaces the hub's `~/.local/bin/agent-tasks` with a script (an older or broken agent-tasks). */
function fakeHubCli(script: string): void {
  const bin = join(s.hub.root, ".local", "bin", "agent-tasks");
  rmSync(bin);
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
}

/** Adds ssh aliases to the fake ssh's hosts. */
function addHosts(hosts: Record<string, Env>): void {
  const file = join(s.sshDir, "hosts.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...hosts }));
}

const hubConfig = () => JSON.parse(readFileSync(s.hub.configFile, "utf8"));
const clientConfig = () => JSON.parse(readFileSync(s.client.configFile, "utf8"));

describe("protocol of forwarded commands", () => {
  test("the hub refuses a client that speaks another protocol", async () => {
    const r = await s.hub.cli("list", "--client-protocol=99", "--json");
    expect(r.code).toBe(1);
    expect(r.json().error.code).toBe("protocol_mismatch");
    expect(r.json().error.message).toContain("update agent-tasks on this hub");
    const older = await s.hub.cli("--client-protocol=0", "list", "--json");
    expect(older.json().error.message).toContain("update agent-tasks on the client");
    expect((await s.hub.cli("--client-protocol=1", "list", "--json")).code).toBe(0);
    expect((await s.hub.cli("--client-protocol=abc", "list", "--json")).json().error.message).toBe('--client-protocol must be a protocol number (got "abc")');
  });

  test("a hub too old to know the flag is reported as such, without its own error", async () => {
    // What an older agent-tasks prints for an unknown global flag.
    fakeHubCli(`for a in "$@"; do [ "$a" = --json ] && { printf '{\\n  "error": {\\n    "code": "usage",\\n    "message": "unknown command \\\\"--client-protocol=1\\\\""\\n  }\\n}\\n'; exit 2; }; done
echo 'agent-tasks: unknown command "--client-protocol=1"' >&2; echo 'Run "agent-tasks help" for usage.' >&2; exit 2`);
    const human = await s.cli("list");
    expect(human.code).toBe(1);
    expect(human.stdout).toBe("");
    expect(human.stderr).toBe(
      'agent-tasks: the hub "hub" runs an older agent-tasks that does not know this client\'s protocol (1); update agent-tasks on the hub (git pull in its agent-tasks checkout)\n',
    );
    const json = await s.cli("list", "--json");
    expect(json.code).toBe(1);
    // One JSON document: the hub's own usage error was dropped.
    expect(json.json().error.code).toBe("protocol_mismatch");
  });

  test("a command forwarded to another client is refused, not forwarded again", async () => {
    // The "hub" alias points at a machine that is a client itself (here: of itself).
    s.hub.writeConfig({ machine: "wsl", hub: { ssh: "hub" } });
    const r = await s.cli("list", "--json");
    expect(r.code).toBe(1);
    expect(r.json().error).toMatchObject({ code: "not_a_hub" });
    expect(s.sshCalls()).toHaveLength(1);
  });

  test("output the hub prints right away still streams once the window has passed", async () => {
    fakeHubCli(`echo first; sleep 1; echo second; exit 3`);
    const r = await s.cli("list");
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("first\nsecond\n");
  });
});

describe("remote ping", () => {
  test("says who this machine is, with its launcher", async () => {
    const r = await s.spawnCli(["remote", "ping", "--json"], JSON.stringify({ protocol: 1 }));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ protocol: 1, name: "agent-tasks", machine: "mac", hub: "hub", launcher: "process", launcher_problems: [] });
  });

  test("refuses another protocol", async () => {
    const r = await s.spawnCli(["remote", "ping", "--json"], JSON.stringify({ protocol: 2 }));
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("remote_protocol");
  });
});

describe("machines", () => {
  test("list shows the hub and its registry, also from a client", async () => {
    const r = await s.cli("machines", "list", "--json");
    expect(r.json().machines).toEqual([
      { name: "wsl", local: true, ssh: null },
      { name: "mac", local: false, ssh: "mac" },
    ]);
    expect((await s.hub.cli("machines", "list")).stdout).toBe("wsl  local (this hub)\nmac  ssh mac\n");
  });

  test("add edits the hub's config in place and checks the machine; unreachable is a warning", async () => {
    s.hub.writeConfig(`{\n  "timezone": "Europe/Madrid",\n\n  "machine": "wsl",\n  "machines": { "mac": { "ssh": "mac" } },\n  "agent": { "command": "bun", "args": [${JSON.stringify(FAKE_AGENT)}] }\n}\n`);
    const r = await s.hub.cli("machines", "add", "pc", "--ssh", "pc-lan", "--json");
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ machine: "pc", ssh: "pc-lan", action: "added", check: { status: "warn", message: "machine pc (ssh pc-lan) is unreachable" } });
    const text = readFileSync(s.hub.configFile, "utf8");
    expect(text).toContain('"timezone": "Europe/Madrid",\n\n  "machine": "wsl",');
    expect(hubConfig().machines).toEqual({ mac: { ssh: "mac" }, pc: { ssh: "pc-lan" } });

    const again = await s.hub.cli("machines", "add", "pc", "--ssh", "pc-lan", "--json");
    expect(again.json().action).toBe("unchanged");
    expect((await s.hub.cli("machines", "add", "wsl", "--json")).code).toBe(2);
  });

  test("add checks the machine answers with its own name, and is a client", async () => {
    // The mac calls itself "mac"; registered as "laptop" it does not match.
    const wrong = await s.hub.cli("machines", "add", "laptop", "--ssh", "mac", "--json");
    expect(wrong.code).toBe(1);
    expect(wrong.json().check).toMatchObject({ status: "error", message: 'machine laptop (ssh mac) calls itself "mac", not "laptop"' });

    s.client.writeConfig({ machine: "mac" });
    const notClient = await s.hub.cli("machines", "check", "mac", "--json");
    expect(notClient.code).toBe(1);
    expect(notClient.json().checks[0].message).toContain("has no `hub` in its config");
  });

  test("check reports each machine", async () => {
    const r = await s.hub.cli("machines", "check", "--json");
    expect(r.code).toBe(0);
    expect(r.json().checks).toEqual([expect.objectContaining({ id: "machines.reachable", status: "ok", message: expect.stringMatching(/^machine mac \(ssh mac\): reachable, agent-tasks .+, launcher process$/) })]);
    expect((await s.hub.cli("machines", "check", "nope", "--json")).json().error.code).toBe("not_found");
  });

  test("rm is refused while tasks run on the machine", async () => {
    s.hub.writeTask(makeTask({ id: "on-mac", machine: "mac", cwd: "~/project" }));
    const refused = await s.hub.cli("machines", "rm", "mac", "--json");
    expect(refused.code).toBe(1);
    expect(refused.json().error).toMatchObject({ code: "machine_in_use", details: ["on-mac"] });
    rmSync(join(s.hub.paths.tasksDir, "on-mac.json"));
    const removed = await s.hub.cli("machines", "rm", "mac", "--json");
    expect(removed.code).toBe(0);
    expect(hubConfig().machines).toEqual({});
  });
});

describe("init --join", () => {
  /** A third machine ("mini"): a fresh home with no config, reached by the hub as "mini-lan". */
  function freshMachine() {
    rmSync(s.client.configFile);
    addHosts({ "mini-lan": s.client.env });
    return s.client;
  }

  test("creates the config, registers the machine on the hub and checks the way back", async () => {
    const mini = freshMachine();
    const r = await s.cli("init", "--join", "hub", "--machine", "mini", "--ssh", "mini-lan", "--launcher", "process", "--json");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.json().join).toMatchObject({ hub: "hub", hub_machine: "wsl", machine: "mini", ssh: "mini-lan", registered: "added", check: { status: "ok" } });
    expect(r.json().next_steps.join("\n")).not.toContain("Start the runner");
    expect(r.json().next_steps.join("\n")).toContain('Never start "agent-tasks runner" here');
    // The example config, with this machine's name and the hub.
    expect(clientConfig()).toMatchObject({ machine: "mini", hub: { ssh: "hub" }, timezone: expect.any(String) });
    expect(existsSync(join(mini.configDir, "instructions", "subagent.md"))).toBe(true);
    expect(hubConfig().machines).toEqual({ mac: { ssh: "mac" }, mini: { ssh: "mini-lan" } });

    const human = await s.cli("init", "--join", "hub", "--machine", "mini", "--ssh", "mini-lan");
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('✓ hub "hub" answers: machine wsl, agent-tasks');
    expect(human.stdout).toContain("(unchanged)");
    expect(human.stdout).toContain("✓ hub → this machine: machine mini (ssh mini-lan): reachable");
  });

  test("edits only machine and hub in an existing config", async () => {
    freshMachine();
    const before = `{\n  "timezone": "Europe/Madrid",\n\n  "launcher": { "preset": "process" }\n}\n`;
    writeFileSync(s.client.configFile, before);
    const r = await s.cli("init", "--join", "hub", "--machine", "mini", "--ssh", "mini-lan", "--json");
    expect(r.code).toBe(0);
    expect(readFileSync(s.client.configFile, "utf8")).toBe(`{\n  "machine": "mini",\n  "hub": { "ssh": "hub" },\n  "timezone": "Europe/Madrid",\n\n  "launcher": { "preset": "process" }\n}\n`);
  });

  test("says what it changed in an existing config", async () => {
    freshMachine();
    writeFileSync(s.client.configFile, `{\n  "machine": "local"\n}\n`);
    const r = await s.cli("init", "--join", "hub", "--machine", "mini", "--ssh", "mini-lan");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`✓ set "machine": "mini" (was "local") and "hub": { "ssh": "hub" } in ~/config/config.json`);
  });

  test("a hub that can't reach this machine back is an error, with how to fix the alias", async () => {
    freshMachine();
    const r = await s.cli("init", "--join", "hub", "--machine", "mini", "--ssh", "wrong-alias", "--json");
    expect(r.code).toBe(1);
    expect(r.json().join.check).toMatchObject({
      status: "error",
      message: "hub → this machine: machine mini (ssh wrong-alias) is unreachable",
      hint: 'the hub must reach this machine as "wrong-alias": fix its SSH alias, then re-run with --ssh <the alias the hub uses for this machine>',
    });
    // It is joined and registered: re-running with the right alias fixes it.
    expect(clientConfig()).toMatchObject({ machine: "mini", hub: { ssh: "hub" } });
    const fixed = await s.cli("init", "--join", "hub", "--machine", "mini", "--ssh", "mini-lan", "--json");
    expect(fixed.code).toBe(0);
    expect(fixed.json().join).toMatchObject({ registered: "updated", check: { status: "ok" } });
  });

  test("a registration that fails on the hub says how to finish", async () => {
    freshMachine();
    chmodSync(s.hub.configDir, 0o555);
    try {
      const r = await s.cli("init", "--join", "hub", "--machine", "mini", "--ssh", "mini-lan", "--json");
      expect(r.code).toBe(1);
      expect(r.json().error.code).toBe("config_write");
      expect(r.json().error.message).toStartWith('~/config/config.json now has "machine" and "hub", but registering this machine on the hub failed: could not write');
      expect(r.json().error.message).toEndWith("Fix that, then finish with: agent-tasks machines add mini --ssh mini-lan");
    } finally {
      chmodSync(s.hub.configDir, 0o755);
    }
  });

  test("an unreachable hub writes nothing", async () => {
    freshMachine();
    const r = await s.cli("init", "--join", "nowhere", "--machine", "mini", "--json");
    expect(r.code).toBe(1);
    expect(r.json().error).toMatchObject({ code: "hub_unreachable", message: 'cannot reach the hub "nowhere" over SSH: ssh: connect to host nowhere port 22: Connection refused' });
    expect(existsSync(s.client.configFile)).toBe(false);
  });

  test("refuses a hub that is a client, the hub's own name, and a machine that is a hub", async () => {
    freshMachine();
    // "relay" is a client of "hub", not a hub.
    const relayConfig = join(s.client.root, "relay.json");
    writeFileSync(relayConfig, JSON.stringify({ machine: "relay", hub: { ssh: "hub" } }));
    addHosts({ relay: { ...s.client.env, AGENT_TASKS_CONFIG: relayConfig } });
    const viaClient = await s.cli("init", "--join", "relay", "--machine", "mini", "--json");
    expect(viaClient.json().error).toMatchObject({ code: "not_a_hub" });
    const sameName = await s.cli("init", "--join", "hub", "--machine", "wsl", "--json");
    expect(sameName.json().error.message).toBe('"wsl" is the hub\'s own name; pick another --machine');
    s.client.writeConfig({ machine: "mini", machines: { other: { ssh: "other" } } });
    const isHub = await s.cli("init", "--join", "hub", "--machine", "mini", "--json");
    expect(isHub.json().error.code).toBe("is_hub");
    expect(hubConfig().machines).toEqual(HUB_CONFIG.machines);
  });

  test("needs --machine, and --machine/--ssh need --join", async () => {
    expect((await s.cli("init", "--join", "hub", "--json")).json().error.message).toContain("--join needs --machine <name>");
    expect((await s.cli("init", "--machine", "mini", "--json")).json().error.message).toBe("--machine and --ssh go with --join <hub-ssh-alias>");
    expect((await s.cli("init", "--join", "hub", "--machine", "Bad_Name", "--json")).code).toBe(2);
  });
});

describe("doctor across machines", () => {
  const byId = (checks: { id: string }[], id: string) => checks.filter((c) => c.id === id);

  test("on a client: the hub answers and reaches this machine back; no data or heartbeat checks", async () => {
    const r = await s.cli("doctor", "--json");
    const checks = r.json().checks;
    expect(byId(checks, "hub.reachable")).toEqual([expect.objectContaining({ status: "ok", message: expect.stringMatching(/^hub wsl \(ssh hub\): reachable, agent-tasks .+, protocol 1$/) })]);
    expect(byId(checks, "hub.reach_back")).toEqual([expect.objectContaining({ status: "ok", message: expect.stringContaining("hub → this machine: machine mac (ssh mac): reachable") })]);
    expect(byId(checks, "runner.heartbeat")).toEqual([]);
    expect(byId(checks, "data.writable")).toEqual([]);
  });

  test("on a client not registered on the hub: how to join", async () => {
    s.hub.writeConfig({ ...HUB_CONFIG, machines: {} });
    const checks = (await s.cli("doctor", "--json")).json().checks;
    expect(byId(checks, "hub.reach_back")).toEqual([
      expect.objectContaining({ status: "error", message: 'this machine ("mac") is not in the hub\'s `machines`', hint: "run agent-tasks init --join hub --machine mac --ssh <alias the hub reaches this machine with>" }),
    ]);
  });

  test("on a client whose hub is down: an error", async () => {
    s.client.writeConfig({ machine: "mac", hub: { ssh: "down" } });
    const r = await s.cli("doctor", "--json");
    expect(r.code).toBe(1);
    expect(byId(r.json().checks, "hub.reachable")).toEqual([expect.objectContaining({ status: "error", message: "the hub (ssh down) is unreachable" })]);
  });

  test("on the hub: each machine; an unreachable one is a warning", async () => {
    s.hub.writeConfig({ ...HUB_CONFIG, machines: { mac: { ssh: "mac" }, pc: { ssh: "pc" } } });
    const checks = (await s.hub.cli("doctor", "--json")).json().checks;
    expect(byId(checks, "machines.reachable").map((c: any) => [c.status, c.message.replace(/agent-tasks [^,]+/, "agent-tasks X")])).toEqual([
      ["ok", "machine mac (ssh mac): reachable, agent-tasks X, launcher process"],
      ["warn", "machine pc (ssh pc) is unreachable"],
    ]);
  });
});

describe("attach and log --follow across machines", () => {
  /** The client runs its sessions with the process preset, with an attach command that says where it runs. */
  function macLauncher(): void {
    s.client.writeConfig({
      machine: "mac",
      hub: { ssh: "hub" },
      agent: { command: "bun", args: [FAKE_AGENT] },
      launcher: { preset: "process", attach: ["/bin/sh", "-c", "echo attached to {{handle}} on $AGENT_TASKS_TEST_MACHINE; exit 7"] },
    });
    addHosts({ mac: { ...s.client.env, AGENT_TASKS_TEST_MACHINE: "mac" } });
    s.client.env.AGENT_TASKS_TEST_MACHINE = "mac";
  }

  async function runOnMac(mode: string) {
    execTask(s.hub, mode, { machine: "mac", cwd: "~/project" });
    await s.hub.tick(1);
    return s.hub.run(DEMO_REF).attempts[0]!.session!;
  }

  test("from the hub: ssh -tt to the machine, which runs its own launcher's attach", async () => {
    macLauncher();
    const session = await runOnMac("hang");
    const r = await spawnAt(s.hub.env, s.hub.project, ["attach", "demo", "--json"]);
    expect(r.code).toBe(7);
    expect(r.stdout).toStartWith(`attached to ${session.handle} on mac\n`);
    const json = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    expect(json).toMatchObject({ run_ref: DEMO_REF, attempt: 1, machine: "mac", launcher: "process", handle: session.handle, exit_code: 7 });
    expect(json.command.slice(0, 7)).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-tt", "--"]);
    const call = s.sshCalls().find((c) => c.line.includes("remote attach"))!;
    expect(call.alias).toBe("mac");
    expect(call.options).toContain("-tt");
    await s.hub.cli("session", "close", DEMO_REF);
  });

  test("from the client, for a session on the client: attaches here, without going through the hub and back", async () => {
    macLauncher();
    const session = await runOnMac("hang");
    const before = s.sshCalls().length;
    const r = await spawnAt(s.client.env, s.project, ["attach", DEMO_REF, "--json"]);
    expect(r.code).toBe(7);
    expect(r.stdout).toStartWith(`attached to ${session.handle} on mac\n`);
    expect(JSON.parse(r.stdout.slice(r.stdout.indexOf("{")))).toMatchObject({ run_ref: DEMO_REF, machine: "mac", launcher: "process", exit_code: 7 });
    const calls = s.sshCalls().slice(before);
    // The client asks the hub where the session runs (the hub checks it is alive on the mac); no `remote attach`.
    expect(calls.filter((c) => c.line.includes(" attach ")).map((c) => [c.alias, c.line])).toEqual([["hub", `~/.local/bin/agent-tasks --client-protocol=1 --json attach ${DEMO_REF} --resolve`]]);
    expect(calls.some((c) => c.alias === "mac" && c.line.includes("remote status"))).toBe(true);
    await s.hub.cli("session", "close", DEMO_REF);
  });

  test("from the client, for a session on the hub: the hub attaches", async () => {
    execTask(s.hub, "hang", { machine: "wsl" });
    s.hub.writeConfig({ ...HUB_CONFIG, launcher: { preset: "process", attach: ["/bin/sh", "-c", "echo attached on the hub; exit 5"] } });
    await s.hub.tick(1);
    const r = await spawnAt(s.client.env, s.project, ["attach", DEMO_REF]);
    expect(r.code).toBe(5);
    expect(r.stdout).toBe("attached on the hub\n");
    expect(s.sshCalls().map((c) => c.alias)).toEqual(["hub", "hub"]);
    await s.hub.cli("session", "close", DEMO_REF);
  });

  test("a session that is gone is reported from the client like on the hub", async () => {
    macLauncher();
    await runOnMac("hang");
    await s.hub.cli("session", "close", DEMO_REF);
    const r = await s.cli("attach", DEMO_REF, "--json");
    expect(r.code).toBe(1);
    expect(r.json().error.code).toBe("session_gone");
  });

  test("log --follow from the client follows a run on the client to its end", async () => {
    macLauncher();
    await runOnMac("hang");
    const follow = spawnAt(s.client.env, s.project, ["log", DEMO_REF, "--follow"]);
    await waitFor(() => existsSync(join(s.client.dataDir, "remote", "demo")), "the session's log on the mac");
    await Bun.sleep(1500);
    expect((await s.cli("finish", DEMO_REF, "--status", "succeeded", "--summary", "done on mac", "--now", at(5))).code).toBe(0);
    const r = await follow;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("prompt: /run-agent-task demo/20261117T080000Z");
    expect(r.stdout).toMatch(/ok\s+demo\/20261117T080000Z · done on mac\n$/);
  });
});

describe("config-edit", () => {
  test("sets top-level keys in place and refuses what it can't edit safely", () => {
    expect(setTopLevelKeys('{\n  "a": 1,\n  "b": { "c": [1, "}"] }\n}\n', { b: 2, z: { ssh: "x" } })).toBe('{\n  "z": { "ssh": "x" },\n  "a": 1,\n  "b": 2\n}\n');
    expect(setTopLevelKeys("{}", { a: 1 })).toBe('{\n  "a": 1\n}');
    expect(setTopLevelKeys('{"a":1}', { b: true })).toBe('{"b": true, "a":1}');
    expect(setTopLevelKeys("// comment\n{}", { a: 1 })).toBeNull();
    expect(setTopLevelKeys("[1]", { a: 1 })).toBeNull();
  });
});
