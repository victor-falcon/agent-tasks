import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ExecHome, FAKE_AGENT, FAKE_BIN, makeExecHome, REPO } from "./exec-helpers.ts";
import { makeTempHome, runCli, type TempHome } from "./helpers.ts";

// A hub ("wsl", reached as ssh alias "hub") and a client ("mac", reached as
// ssh alias "mac") on one host, through the fake `ssh` in test/fixtures/.

export const HUB_CONFIG = { timezone: "Europe/Madrid", machine: "wsl", machines: { mac: { ssh: "mac" } }, agent: { command: "bun", args: [FAKE_AGENT] }, launcher: { preset: "process" } };

export interface Setup {
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
export function makeSetup(): Setup {
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
  Object.assign(client.env, { PATH: [FAKE_BIN, dirname(process.execPath), process.env.PATH].join(":"), FAKE_SSH_DIR: sshDir });
  // The hub reaches the client back ("mac") to run `remote …` there, e.g. to check a task's cwd.
  mkdirSync(join(client.root, ".local", "bin"), { recursive: true });
  symlinkSync(join(REPO, "bin", "agent-tasks"), join(client.root, ".local", "bin", "agent-tasks"));
  // The hub's own commands reach the machines through the same fake ssh.
  hub.env.FAKE_SSH_DIR = sshDir;
  const { PATH: _, ...hubEnv } = hub.env;
  writeFileSync(join(sshDir, "hosts.json"), JSON.stringify({ hub: { ...hubEnv, PATH: hub.env.PATH, FAKE_SSH_DIR: sshDir }, mac: client.env }));

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

