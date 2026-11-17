import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Run } from "../src/schema.ts";
import { DEMO_REF, type ExecHome, execTask, FAKE_AGENT, FAKE_BIN, makeExecHome, pidAlive, REPO, settled, waitFor } from "./exec-helpers.ts";

// A hub and an execution machine ("mac") on one host: the fake `ssh`
// (test/fixtures/fake-ssh.ts) runs `~/.local/bin/agent-tasks remote …` with
// the mac's own HOME, config and data folder. The mac resolves its own
// launcher (the `process` preset), agent and skill.

setDefaultTimeout(30_000);

interface Mac {
  home: string;
  dataDir: string;
  configFile: string;
  /** The task folder, only on the mac. */
  work: string;
}

let hub: ExecHome;
let mac: Mac;
let sshDir: string;

function writeHosts(opts: { unreachable?: boolean } = {}): void {
  const env = {
    HOME: mac.home,
    AGENT_TASKS_HOME: mac.dataDir,
    AGENT_TASKS_CONFIG: mac.configFile,
    // No ~/.local/bin, like a non-interactive SSH shell; bun and the fake ssh are there.
    PATH: [FAKE_BIN, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    SHELL: "/bin/sh",
    FAKE_SSH_DIR: sshDir,
  };
  // A host missing from hosts.json fails like one that is down (exit 255).
  writeFileSync(join(sshDir, "hosts.json"), JSON.stringify(opts.unreachable ? {} : { "mac-mini": env }));
}

function sshCalls(): { alias: string; line: string; stdin: string }[] {
  const file = join(sshDir, "calls.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const remoteOps = () => sshCalls().map((c) => /remote (\S+)/.exec(c.line)?.[1]);

beforeEach(() => {
  hub = makeExecHome();
  sshDir = join(hub.root, "ssh");
  const home = join(hub.root, "mac-home");
  mac = { home, dataDir: join(home, "data"), configFile: join(home, "config", "config.json"), work: join(home, "work") };
  for (const dir of [sshDir, mac.dataDir, dirname(mac.configFile), mac.work, join(home, ".local", "bin")]) mkdirSync(dir, { recursive: true });
  symlinkSync(join(REPO, "bin", "agent-tasks"), join(home, ".local", "bin", "agent-tasks"));
  hub.env.FAKE_SSH_DIR = sshDir;
  writeHosts();

  hub.writeConfig({ timezone: "Europe/Madrid", machine: "hub", machines: { mac: { ssh: "mac-mini" } }, agent: "never-used-on-the-mac" });
  // The mac's own config: its launcher, agent and skill. The agent reports to the hub's
  // data (what a client's forwarding does, simulated with the hub's env vars).
  writeFileSync(
    mac.configFile,
    JSON.stringify({
      machine: "mac",
      launcher: { preset: "process" },
      skill: "mac-skill",
      agent: { command: "env", args: [`AGENT_TASKS_HOME=${hub.dataDir}`, `AGENT_TASKS_CONFIG=${hub.configFile}`, `PATH=${hub.env.PATH}`, "bun", FAKE_AGENT] },
    }),
  );
});
afterEach(() => hub.cleanup());

const macTask = (mode: string, overrides = {}) => execTask(hub, mode, { machine: "mac", cwd: "~/work", max_delay: "30m", ...overrides });
const finished = (n = 1) => settled(hub, DEMO_REF, n);
const pidOf = (run: Run, n = 1) => Number(run.attempts[n - 1]!.session!.pid);

describe("a run on another machine", () => {
  test("is launched there with that machine's launcher, agent and skill; finish closes it there", async () => {
    macTask("succeed");
    const first = await hub.tick(1);
    expect(first.events).toEqual([expect.objectContaining({ type: "launched", run_ref: DEMO_REF, attempt: 1 })]);

    const launched = hub.run(DEMO_REF).attempts[0]!;
    expect(launched.session).toMatchObject({ launcher: "process", machine: "mac", name: "task-demo-20261117t080000z" });
    expect(launched.agent).toMatchObject({ command: "env", from: "config" });

    const run = await waitFor(finished(), "finish");
    expect(run.status).toBe("succeeded");
    expect(run.attempts[0]!.summary).toBe("did it (attempt 1)");
    // The agent got the mac's folder (from `remote instructions`) and wrote its report there.
    expect(readFileSync(join(mac.work, "report-1.md"), "utf8")).toBe(`# Report for ${DEMO_REF}\n`);
    await waitFor(() => hub.run(DEMO_REF).attempts[0]!.session?.closed_at, "close");
    await waitFor(() => !pidAlive(pidOf(run)), "the agent to be killed");

    // The mac's log (background launcher) was copied into the hub's log.
    const log = readFileSync(join(hub.dataDir, run.attempts[0]!.log!), "utf8");
    expect(log).toContain(`prompt: /mac-skill ${DEMO_REF}`);
    expect(existsSync(join(mac.dataDir, "remote", "demo", "20261117T080000Z.log"))).toBe(true);

    const ops = remoteOps();
    expect(ops).toContain("launch");
    expect(ops).toContain("instructions");
    expect(ops).toContain("close");
    const call = sshCalls().find((c) => c.line.includes("remote launch"))!;
    expect(call.alias).toBe("mac-mini");
    expect(call.line).toBe("~/.local/bin/agent-tasks remote launch --json");
    expect(JSON.parse(call.stdin)).toMatchObject({ protocol: 1, machine: "mac", task: { id: "demo", cwd: "~/work", agent: null }, run_ref: DEMO_REF, attempt: 1 });

    expect((await hub.tick(6)).events).toEqual([expect.objectContaining({ type: "succeeded", run_ref: DEMO_REF })]);
  });

  test("tick watches the session there: an agent that exits without finish fails the run", async () => {
    macTask("exit");
    await hub.tick(1);
    const pid = pidOf(hub.run(DEMO_REF));
    await waitFor(() => !pidAlive(pid), "the agent to exit");
    const result = await hub.tick(2);
    expect(result.events).toEqual([expect.objectContaining({ type: "failed", run_ref: DEMO_REF, reason: "exited_without_report" })]);
    expect(remoteOps()).toContain("status");
  });

  test("session status, read and close go to the machine that runs it", async () => {
    macTask("hang");
    await hub.tick(1);
    const pid = pidOf(hub.run(DEMO_REF));
    await waitFor(() => readFileSync(join(mac.dataDir, "remote", "demo", "20261117T080000Z.log"), "utf8").includes("prompt:"), "the agent to start");

    const status = await hub.cli("session", "status", DEMO_REF, "--json");
    expect(status.json()).toMatchObject({ state: "working", launcher: "process", machine: "mac" });
    const read = await hub.cli("session", "read", DEMO_REF, "--json");
    expect(read.json().output).toContain(`prompt: /mac-skill ${DEMO_REF}`);
    const close = await hub.cli("session", "close", DEMO_REF, "--json");
    expect(close.code).toBe(0);
    await waitFor(() => !pidAlive(pid), "the agent to be killed");
    expect(hub.run(DEMO_REF).attempts[0]!.session!.closed_at).not.toBeNull();
  });

  test("an unreachable machine is not a gone session: the run keeps running, and times out later", async () => {
    macTask("hang", { timeout: "10m" });
    await hub.tick(1);
    const pid = pidOf(hub.run(DEMO_REF));
    writeHosts({ unreachable: true });

    expect((await hub.tick(2)).events).toEqual([]);
    expect(hub.run(DEMO_REF).status).toBe("running");
    // One event per outage says why the run is not being watched.
    await hub.tick(3);
    expect(hub.run(DEMO_REF).events.filter((e) => e.event === "machine_unreachable")).toEqual([expect.objectContaining({ attempt: 1, machine: "mac" })]);
    const status = await hub.cli("session", "status", DEMO_REF, "--json");
    expect(status.code).toBe(1);
    expect(status.json().error.code).toBe("machine_unreachable");

    // Past the timeout the run times out; the close waits for the machine (no failed close counted).
    const timedOut = await hub.tick(12);
    expect(timedOut.events).toEqual([expect.objectContaining({ type: "timed_out", run_ref: DEMO_REF })]);
    expect(timedOut.errors).toEqual([]);
    const session = hub.run(DEMO_REF).attempts[0]!.session!;
    expect(session).toMatchObject({ closed_at: null });
    expect(session.close_attempts ?? 0).toBe(0);
    expect(session.close_error).toContain("unreachable");
    expect(pidAlive(pid)).toBe(true);

    // Back online: a later tick closes it.
    writeHosts();
    await hub.tick(14);
    await waitFor(() => !pidAlive(pid), "the agent to be killed");
    expect(hub.run(DEMO_REF).attempts[0]!.session!.closed_at).not.toBeNull();
  });
});

describe("unreachable machine at launch", () => {
  test("the slot waits without using an attempt, and launches once the machine is back", async () => {
    macTask("succeed");
    writeHosts({ unreachable: true });
    expect((await hub.tick(1)).events).toEqual([]);
    let run = hub.run(DEMO_REF);
    expect(run).toMatchObject({ status: "running", reason: "machine_unreachable", attempts: [] });
    expect(run.events.map((e) => e.event)).toEqual(["claimed", "machine_unreachable"]);

    expect((await hub.tick(5)).events).toEqual([]);
    expect(hub.run(DEMO_REF).events.filter((e) => e.event === "machine_unreachable")).toHaveLength(1);

    writeHosts();
    expect((await hub.tick(10)).events).toEqual([expect.objectContaining({ type: "launched", run_ref: DEMO_REF, attempt: 1 })]);
    run = await waitFor(finished(), "finish");
    expect(run.status).toBe("succeeded");
    expect(run.attempts).toHaveLength(1);
  });

  test("past max_delay the slot is missed with reason machine_unreachable", async () => {
    macTask("succeed");
    writeHosts({ unreachable: true });
    await hub.tick(1);
    expect((await hub.tick(20)).events).toEqual([]);
    const result = await hub.tick(31);
    expect(result.events).toEqual([expect.objectContaining({ type: "missed", run_ref: DEMO_REF, reason: "machine_unreachable" })]);
    const run = hub.run(DEMO_REF);
    expect(run).toMatchObject({ status: "missed", reason: "machine_unreachable", attempts: [] });
    expect(run.events.at(-1)).toMatchObject({ event: "missed", reason: "machine_unreachable" });
    expect((await hub.tick(35)).events).toEqual([]);
  });

  test("a waiting slot of a task paused meanwhile is cancelled, not missed", async () => {
    macTask("succeed");
    writeHosts({ unreachable: true });
    await hub.tick(1);
    expect((await hub.cli("pause", "demo")).code).toBe(0);
    const result = await hub.tick(2);
    expect(result.events).toEqual([expect.objectContaining({ type: "cancelled", run_ref: DEMO_REF, reason: "paused" })]);
    expect(hub.run(DEMO_REF)).toMatchObject({ status: "cancelled", reason: "paused", attempts: [] });
  });

  test("a launch repeated after a broken connection reuses the live session", async () => {
    macTask("hang");
    await hub.tick(1);
    const first = hub.run(DEMO_REF).attempts[0]!.session!;
    const launch = sshCalls().find((c) => c.line.includes("remote launch"))!;
    const again = Bun.spawnSync({ cmd: ["ssh", "mac-mini", launch.line], env: hub.env as Record<string, string>, stdin: Buffer.from(launch.stdin) });
    expect(JSON.parse(again.stdout.toString())).toMatchObject({ handle: first.handle, reused: true });
    process.kill(Number(first.pid));
  });

  test("a manual run fails right away with reason machine_unreachable", async () => {
    macTask("succeed");
    writeHosts({ unreachable: true });
    const r = await hub.cli("run", "demo", "--json");
    expect(r.stdout).toContain("machine_unreachable");
  });
});

describe("cwd of a task on another machine", () => {
  const add = (...args: string[]) => hub.cli("add", "--title", "Remote", "--cron", "0 9 * * 1", "--instructions", "x", "--machine", "mac", ...args);

  test("is checked there and stored with ~", async () => {
    const r = await add("--cwd", join(mac.work), "--json");
    expect(r.code).toBe(0);
    expect(r.json().task).toMatchObject({ machine: "mac", cwd: "~/work" });
    expect(r.json().warnings).toBeUndefined();
    expect(remoteOps()).toEqual(["check-cwd"]);
  });

  test("a folder missing there is an error", async () => {
    const r = await add("--cwd", "~/nope", "--json");
    expect(r.code).toBe(1);
    expect(r.json().error).toMatchObject({ code: "invalid_cwd" });
    expect(r.json().error.message).toContain(join(mac.home, "nope"));
  });

  test("a relative folder cannot be checked there", async () => {
    const r = await add("--cwd", "work", "--json");
    expect(r.json().error).toMatchObject({ code: "invalid_cwd" });
  });

  test("an unreachable machine saves the task with a warning", async () => {
    writeHosts({ unreachable: true });
    const r = await add("--cwd", "~/work", "--json");
    expect(r.code).toBe(0);
    expect(r.json().task.cwd).toBe("~/work");
    expect(r.json().warnings).toEqual([expect.stringContaining("unreachable")]);
    expect(r.stderr).toContain("warning: cwd ~/work was not checked");
  });

  test("edit checks the folder there when the task moves to that machine", async () => {
    execTask(hub, "succeed", { cwd: "~/project" }); // only on the hub
    const missing = await hub.cli("edit", "demo", "--machine", "mac", "--json");
    expect(missing.json().error).toMatchObject({ code: "invalid_cwd" });
    const ok = await hub.cli("edit", "demo", "--machine", "mac", "--cwd", "~/work", "--json");
    expect(ok.code).toBe(0);
    expect(ok.json().task).toMatchObject({ machine: "mac", cwd: "~/work" });
  });
});

describe("remote protocol", () => {
  test("a payload with another protocol version is refused", async () => {
    const r = Bun.spawnSync({
      cmd: ["ssh", "mac-mini", "~/.local/bin/agent-tasks remote status --json"],
      env: hub.env as Record<string, string>,
      stdin: Buffer.from(JSON.stringify({ protocol: 2 })),
    });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout.toString()).error).toMatchObject({ code: "remote_protocol" });
  });

  test("tasks on the hub itself never use ssh", async () => {
    execTask(hub, "succeed", { machine: "hub" });
    hub.writeConfig({ timezone: "Europe/Madrid", machine: "hub", machines: { mac: { ssh: "mac-mini" } }, agent: { command: "bun", args: [FAKE_AGENT] } });
    await hub.tick(1);
    const run = await waitFor(finished(), "finish");
    expect(run.status).toBe("succeeded");
    expect(run.attempts[0]!.session).not.toHaveProperty("machine");
    expect(sshCalls()).toEqual([]);
  });
});
